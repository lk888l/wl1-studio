import { invoke } from "@tauri-apps/api/core";
import { deviceGateway, isTauriRuntime } from "./device";

export type Radio = "wifi" | "ble";
type RadioAction = "enable" | "disable" | "disconnect" | "reconnect" | "remember";
export type RadioMutation =
  | { op: `${Radio}.${RadioAction}` }
  | { op: `${Radio}.use` | `${Radio}.forget`; slot: number }
  | { op: "wifi.connect"; ssid: string; password: string; remember: boolean }
  | { op: "ble.connect"; address: string; address_type: number; remember: boolean };
type Request = RadioMutation | { op: `${Radio}.scan` }
  | { op: "status" | `${Radio}.status` }
  | { op: `${Radio}.scan.results` | `${Radio}.saved` | "ble.peer"; index?: number }
  | { op: "command.result"; ticket: number };
type Reply = Record<string, unknown>;
type Query = (request: Request) => Promise<Reply>;

export interface WifiStatus {
  enabled: boolean; scanning: boolean; state: string; ssid: string; ip: string;
  rssi: number; reason: number; rememberPending: boolean; memoryError: number;
}
export interface BleStatus {
  enabled: boolean; scanning: boolean; connected: boolean; connecting: boolean; switching: boolean;
  address: string; addressType: number; identity: string; encrypted: boolean; bonded: boolean;
  error: number; rememberPending: boolean; memoryError: number;
}
export interface RadioMemory {
  slot: number; label: string; preferred: boolean; addressType?: number;
}
export interface WifiNetwork {
  ssid: string; bssid: string; rssi: number; channel: number; auth: number;
}
export interface BlePeripheral {
  name: string; address: string; addressType: number; rssi: number; connectable: boolean;
}
export interface ScanResults<T> { generation: number; total: number; rows: T[] }
export interface RadioData {
  ap: string; apIp: string; bleServer: string; bleSecure: boolean; uptime: number;
  wifi?: WifiStatus; ble?: BleStatus;
  wifiSaved: RadioMemory[]; bleSaved: RadioMemory[];
  updatedAt: number;
}
export interface S3Snapshot {
  connected: boolean;
  sessionId?: number | null;
  portName?: string | null;
  capabilities?: { wifi: boolean; ble: boolean; memorySlots: number } | null;
  data?: RadioData;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const closed = (): S3Snapshot => ({ connected: false });
const number = (reply: Reply, key: string, min = -0x8000_0000, max = 0xffff_ffff): number => {
  const value = reply[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`S3 响应字段 ${key} 无效，请核对固件版本。`);
  }
  return value;
};
const text = (reply: Reply, key: string): string => {
  const value = reply[key];
  if (typeof value !== "string") throw new Error(`S3 响应缺少 ${key}，请核对固件版本。`);
  return value;
};
const flag = (reply: Reply, key: string): boolean => number(reply, key, 0, 1) === 1;

const errors: Record<string, string> = {
  busy: "设备命令队列已满，请稍后手动重试。",
  disabled: "该无线功能未启用或未编译进当前固件。",
  unavailable: "设备尚未准备好，请稍后重试。",
  unknown_ticket: "命令记录已过期或设备已重启；请查询当前状态，勿重复提交。",
  invalid_credentials: "Wi-Fi 名称或密码不符合固件要求。",
  invalid_peer: "BLE 目标地址或地址类型无效，请重新扫描。",
  unauthorized: "当前连接不是受支持的物理 USB 控制台。",
};

export function wifiCredentialError(ssid: string, password: string): string | undefined {
  const bytes = (value: string) => new TextEncoder().encode(value).length;
  if (ssid.includes("\0") || bytes(ssid) < 1 || bytes(ssid) > 32) return "Wi-Fi 名称须为 1–32 个 UTF-8 字节。";
  if (password.includes("\0") || !(password === "" || (bytes(password) >= 8 && bytes(password) <= 63)
    || /^[0-9a-fA-F]{64}$/.test(password))) return "密码须为 8–63 个 UTF-8 字节或 64 位十六进制 PSK；开放网络留空。";
  const envelope = { v: 1, id: 2147483647, op: "wifi.connect", ssid, password, remember: true };
  if (bytes(JSON.stringify(envelope)) > 256) return "转义后的请求超过设备 256 字节上限，请缩短名称或密码。";
  return undefined;
}

export function usedMemorySlots(mask: number): number[] {
  if (!Number.isInteger(mask) || mask < 0 || mask > 15) throw new Error("设备记忆槽掩码无效。");
  return [0, 1, 2, 3].filter((slot) => (mask & (1 << slot)) !== 0);
}

export function wifiStateLabel(state?: string): string {
  const labels: Record<string, string> = { off: "已关闭", ap: "仅热点 / STA 未连接", connecting: "正在连接",
    connected: "已取得 IP", retry: "等待重试", failed: "连接失败" };
  return state ? labels[state] ?? `未知状态 (${state})` : "等待连接设备";
}
export function bleStateLabel(status?: BleStatus): string {
  if (!status) return "等待连接设备";
  if (!status.enabled) return "已关闭";
  if (status.switching) return "正在切换目标";
  if (status.connecting) return "正在连接";
  return status.connected ? "外设已连接" : status.error ? `连接错误 (${status.error})` : "未连接外设";
}
export function addressTypeLabel(type: number): string {
  return ["公共地址", "随机地址", "公共身份", "随机身份"][type] ?? "未知地址类型";
}

export class S3Cancelled extends Error {
  constructor() { super("S3 会话已结束，操作已取消。"); }
}

export class StickS3Gateway {
  private state = closed();
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private readonly listeners = new Set<(snapshot: S3Snapshot) => void>();
  get snapshot(): S3Snapshot { return structuredClone(this.state); }
  subscribe(listener: (snapshot: S3Snapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(state: S3Snapshot): S3Snapshot {
    this.state = state;
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async close(all: boolean): Promise<S3Snapshot> {
    if (isTauriRuntime() && (all || this.state.sessionId != null)) {
      await invoke("sticks3_disconnect", { expectedSessionId: all ? null : this.state.sessionId });
    }
    return this.publish(closed());
  }
  initialize(): Promise<S3Snapshot> {
    ++this.epoch;
    return this.serialize(() => this.close(true));
  }
  listSerialPorts() { return deviceGateway.listSerialPorts(); }
  connect(portName: string): Promise<S3Snapshot> {
    const epoch = ++this.epoch;
    return this.serialize(async () => {
      if (!isTauriRuntime()) throw new Error("真实 USB 连接需要在桌面应用中使用。");
      if (!portName.trim()) throw new Error("请选择 StickS3 的 USB 串口。");
      if (epoch !== this.epoch) throw new S3Cancelled();
      await this.close(false);
      const snapshot = await invoke<S3Snapshot>("sticks3_connect", { portName });
      if (epoch !== this.epoch) {
        await invoke("sticks3_disconnect", { expectedSessionId: snapshot.sessionId });
        throw new S3Cancelled();
      }
      return this.publish(snapshot);
    });
  }
  disconnect(): Promise<S3Snapshot> {
    // Cancel queued writes immediately, including scan/ticket polls between awaits.
    ++this.epoch;
    return this.serialize(() => this.close(false));
  }
  private withSession<T>(work: (query: Query) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const sessionId = this.state.sessionId;
    const assertCurrent = () => {
      if (epoch !== this.epoch || sessionId == null || sessionId !== this.state.sessionId || !this.state.connected) throw new S3Cancelled();
    };
    return this.serialize(async () => {
      assertCurrent();
      const query: Query = async (request) => {
        assertCurrent();
        let reply: Reply;
        try {
          reply = await invoke<Reply>("sticks3_request", { expectedSessionId: sessionId, request });
        } catch (error) {
          if (epoch === this.epoch) {
            try {
              const backend = await invoke<S3Snapshot>("sticks3_snapshot");
              if (epoch === this.epoch) this.publish(backend);
            } catch { /* Keep the session ID so explicit close can still release it. */ }
          }
          throw error;
        }
        assertCurrent();
        if (reply.v !== 1 || typeof reply.ok !== "boolean") throw new Error("S3 响应格式不兼容。");
        if (!reply.ok) {
          const code = typeof reply.error === "string" ? reply.error : "unknown_error";
          throw new Error(errors[code] ?? `S3 拒绝操作：${code}`);
        }
        return reply;
      };
      return work(query);
    });
  }
  private async apply(query: Query, request: RadioMutation | { op: `${Radio}.scan` }): Promise<void> {
    const accepted = await query(request);
    if (accepted.result !== "accepted") throw new Error("设备未确认接收命令，请查询状态后再操作。");
    const ticket = number(accepted, "ticket", 1);
    const deadline = Date.now() + 6000;
    do {
      const result = await query({ op: "command.result", ticket });
      if (number(result, "ticket", 1) !== ticket) throw new Error("设备返回了其他命令的执行结果。");
      if (result.state === "applied") return;
      if (result.state === "failed") throw new Error(`设备执行失败：${text(result, "error_name")} (${number(result, "error_code")})`);
      if (result.state !== "queued") throw new Error("设备命令状态无效。");
      await sleep(180);
    } while (Date.now() < deadline);
    throw new Error("设备尚未确认执行，操作结果未知。请刷新状态，命令不会自动重发。");
  }
  private async memories(query: Query, radio: Radio): Promise<RadioMemory[]> {
    const first = await query({ op: `${radio}.saved`, index: 0 });
    const slots = usedMemorySlots(number(first, "used_mask", 0, 15));
    const preferred = number(first, "preferred", -1, 3);
    const rows: RadioMemory[] = [];
    for (const slot of slots) {
      const row = slot === 0 ? first : await query({ op: `${radio}.saved`, index: slot });
      if (row.used_mask !== first.used_mask || row.preferred !== preferred || row.slot !== slot || !flag(row, "occupied")) {
        throw new Error("设备连接记忆已变化，请刷新后重试。");
      }
      rows.push({ slot, preferred: slot === preferred, label: text(row, radio === "wifi" ? "ssid" : "address"),
        ...(radio === "ble" ? { addressType: number(row, "address_type", 0, 3) } : {}) });
    }
    return rows;
  }
  private async refreshWith(query: Query): Promise<S3Snapshot> {
    const summary = await query({ op: "status" });
    const data: RadioData = { ap: text(summary, "ap"), apIp: text(summary, "ap_ip"), bleServer: text(summary, "ble"),
      bleSecure: flag(summary, "ble_secure"), uptime: number(summary, "uptime_s", 0), wifiSaved: [], bleSaved: [], updatedAt: Date.now() };
    if (this.state.capabilities?.wifi) {
      const wifi = await query({ op: "wifi.status" });
      data.wifi = { enabled: flag(wifi, "enabled"), scanning: flag(wifi, "scanning"), state: text(wifi, "state"),
        ssid: text(wifi, "ssid"), ip: text(wifi, "ip"), rssi: number(wifi, "rssi"), reason: number(wifi, "reason"),
        rememberPending: flag(wifi, "remember_pending"), memoryError: number(wifi, "memory_error") };
      data.wifiSaved = await this.memories(query, "wifi");
    }
    if (this.state.capabilities?.ble) {
      const ble = await query({ op: "ble.status" });
      data.ble = { enabled: flag(ble, "enabled"), scanning: flag(ble, "scanning"), connected: flag(ble, "connected"),
        connecting: flag(ble, "connecting"), switching: flag(ble, "switching"), address: text(ble, "address"),
        addressType: number(ble, "address_type", 0, 3), identity: text(ble, "identity"), encrypted: flag(ble, "encrypted"),
        bonded: flag(ble, "bonded"), error: number(ble, "error"), rememberPending: flag(ble, "remember_pending"), memoryError: number(ble, "memory_error") };
      data.bleSaved = await this.memories(query, "ble");
    }
    return this.publish({ ...this.state, data });
  }
  refresh(): Promise<S3Snapshot> { return this.withSession((query) => this.refreshWith(query)); }
  execute(request: RadioMutation): Promise<S3Snapshot> {
    if (request.op === "wifi.connect") {
      const error = wifiCredentialError(request.ssid, request.password);
      if (error) return Promise.reject(new Error(error));
    }
    return this.withSession(async (query) => {
      await this.apply(query, request);
      return this.refreshWith(query);
    });
  }
  scan(radio: "wifi"): Promise<ScanResults<WifiNetwork>>;
  scan(radio: "ble"): Promise<ScanResults<BlePeripheral>>;
  scan(radio: Radio): Promise<ScanResults<WifiNetwork | BlePeripheral>> {
    return this.withSession(async (query) => {
      const op = `${radio}.scan.results` as const;
      const previous = await query({ op });
      if (flag(previous, "scanning")) throw new Error("设备已有扫描正在进行，请等待完成后重试。");
      const generation = number(previous, "generation", 0);
      await this.apply(query, { op: `${radio}.scan` });
      const deadline = Date.now() + 25_000;
      do {
        const head = await query({ op });
        const current = number(head, "generation", 0);
        const error = number(head, "error");
        if (error && (current !== generation || error !== previous.error)) throw new Error(`设备扫描失败 (${error})，请确认无线已开启。`);
        if (!flag(head, "scanning") && current !== generation) {
          const count = number(head, "count", 0, 16);
          const rows: (WifiNetwork | BlePeripheral)[] = [];
          let stable = true;
          for (let index = 0; index < count; index++) {
            const row = index === 0 ? head : await query({ op, index });
            if (row.generation !== current || row.count !== count || flag(row, "scanning")) { stable = false; break; }
            if (number(row, "index", 0, 15) !== index) throw new Error("设备扫描分页索引不一致，请重新扫描。");
            rows.push(radio === "wifi"
              ? { ssid: text(row, "ssid"), bssid: text(row, "bssid"), rssi: number(row, "rssi"), channel: number(row, "channel", 0, 14), auth: number(row, "auth", 0, 255) }
              : { name: text(row, "name"), address: text(row, "address"), addressType: number(row, "address_type", 0, 3), rssi: number(row, "rssi"), connectable: flag(row, "connectable") });
          }
          const tail = await query({ op });
          if (stable && tail.generation === current && tail.count === count && !flag(tail, "scanning") && number(tail, "error") === 0) {
            return { generation: current, total: number(head, "total", 0), rows };
          }
        }
        await sleep(350);
      } while (Date.now() < deadline);
      throw new Error("扫描未在 25 秒内完成，或结果持续变化；请查看设备状态后重试。");
    });
  }
  services(): Promise<string[]> {
    return this.withSession(async (query) => {
      const head = await query({ op: "ble.peer" });
      if (!flag(head, "connected")) throw new Error("请先由 S3 主动连接一个 BLE 外设。");
      const count = number(head, "service_count", 0, 8);
      const services: string[] = [];
      for (let index = 0; index < count; index++) {
        const row = index === 0 ? head : await query({ op: "ble.peer", index });
        if (!flag(row, "connected") || row.address !== head.address || row.service_count !== count) throw new Error("BLE 连接已变化，请重新读取服务。");
        services.push(text(row, "service"));
      }
      return services;
    });
  }
}

export const sticks3Gateway = new StickS3Gateway();
