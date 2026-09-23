import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { S3Snapshot } from "./sticks3";

const { invoke, runtime } = vi.hoisted(() => ({ invoke: vi.fn(), runtime: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./device", () => ({ isTauriRuntime: runtime, deviceGateway: { listSerialPorts: vi.fn(async () => []) } }));
import { S3Cancelled, StickS3Gateway, usedMemorySlots, wifiCredentialError } from "./sticks3";

const session: S3Snapshot = { connected: true, sessionId: 7, portName: "COM7", capabilities: { wifi: true, ble: true, memorySlots: 4 } };
const reply = (fields: Record<string, unknown>) => ({ v: 1, id: 1, ok: true, ...fields });
const wifi = { enabled: 1, scanning: 0, state: "connecting", ssid: "Home", ip: "", rssi: -40, reason: 0, remember_pending: 1, memory_error: 0 };
const ble = { enabled: 1, scanning: 0, connected: 0, connecting: 0, switching: 0, address: "", address_type: 0,
  identity: "", encrypted: 0, bonded: 0, error: 0, remember_pending: 0, memory_error: 0 };
type Request = { op: string; index?: number; ticket?: number; [key: string]: unknown };
function answer(request: Request) {
  switch (request.op) {
    case "status": return reply({ ap: "M5StickS3-test", ap_ip: "192.168.4.1", ble: "advertising", ble_secure: 0, uptime_s: 123 });
    case "wifi.status": return reply(wifi);
    case "ble.status": return reply(ble);
    case "wifi.saved": case "ble.saved": return reply({ used_mask: 0, preferred: -1, slot: request.index ?? 0, occupied: 0, count: 0 });
    case "command.result": return reply({ ticket: request.ticket, state: "applied", error_code: 0, error_name: "ESP_OK" });
    default: return reply({ result: "accepted", ticket: 19 });
  }
}
function backend(name: string, args?: { request: Request }) {
  if (name === "sticks3_connect") return { ...session };
  if (name === "sticks3_request" && args) return answer(args.request);
  return { connected: false };
}
beforeEach(() => {
  vi.clearAllMocks();
  runtime.mockReturnValue(true);
  invoke.mockImplementation(async (name: string, args?: { request: Request }) => backend(name, args));
});
afterEach(() => { vi.useRealTimers(); });

describe("StickS3 协议边界", () => {
  it("按 UTF-8 与转义后的 JSON 字节校验凭据", () => {
    expect(wifiCredentialError("我的网络", "hello世界12")).toBeUndefined();
    expect(wifiCredentialError("Open", "")).toBeUndefined();
    expect(wifiCredentialError("PSK", "a".repeat(64))).toBeUndefined();
    expect(wifiCredentialError("x", "z".repeat(64))).toBeDefined();
    expect(wifiCredentialError("网".repeat(11), "password")).toBeDefined();
    expect(wifiCredentialError("Open\0", "")).toBeDefined();
    expect(wifiCredentialError("Home", "\x01".repeat(63))).toContain("256");
  });
  it("按固定槽位的 used_mask 读取稀疏连接记忆", () => {
    expect(usedMemorySlots(10)).toEqual([1, 3]);
    expect(usedMemorySlots(0)).toEqual([]);
    for (const invalid of [-1, 16, 2.5, Number.NaN]) expect(() => usedMemorySlots(invalid)).toThrow();
  });
  it("浏览器不伪造真实连接", async () => {
    runtime.mockReturnValue(false);
    const gateway = new StickS3Gateway();
    await gateway.initialize();
    await expect(gateway.connect("COM7")).rejects.toThrow("桌面应用");
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe("StickS3 会话与异步命令", () => {
  it("accepted / applied 不会被当作已经连接或记忆成功", async () => {
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    const result = await gateway.execute({ op: "wifi.connect", ssid: "Home", password: "password", remember: true });
    expect(result.data?.wifi).toMatchObject({ state: "connecting", ip: "", rememberPending: true });
    expect(result.data?.wifiSaved).toEqual([]);
    const commands = invoke.mock.calls.filter(([name]) => name === "sticks3_request").map(([, args]) => args);
    expect(commands.filter((args) => args.request.op === "wifi.connect")).toHaveLength(1);
    expect(commands.find((args) => args.request.op === "command.result")?.request.ticket).toBe(19);
    expect(commands.every((args) => args.expectedSessionId === 7)).toBe(true);
  });
  it("等待命令 ticket 从 queued 转到 applied", async () => {
    vi.useFakeTimers();
    let polls = 0;
    invoke.mockImplementation(async (name: string, args?: { request: Request }) => {
      if (args?.request?.op === "command.result") return reply({ ticket: 19, state: ++polls < 3 ? "queued" : "applied" });
      return backend(name, args);
    });
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    const operation = gateway.execute({ op: "ble.enable" });
    await vi.runAllTimersAsync();
    await operation;
    expect(polls).toBe(3);
  });
  it("不会重发队列拒绝或驱动失败的修改命令", async () => {
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    invoke.mockImplementation(async (_name: string, { request }: { request: Request }) => {
      if (request.op === "wifi.enable") return reply({ ok: false, error: "busy" });
      return answer(request);
    });
    await expect(gateway.execute({ op: "wifi.enable" })).rejects.toThrow("队列已满");
    expect(invoke.mock.calls.filter(([, args]) => args?.request?.op === "wifi.enable")).toHaveLength(1);
    invoke.mockImplementation(async (_name: string, { request }: { request: Request }) => request.op === "command.result"
      ? reply({ ticket: 19, state: "failed", error_name: "ESP_ERR_NO_MEM", error_code: 257 }) : answer(request));
    await expect(gateway.execute({ op: "wifi.remember" })).rejects.toThrow("ESP_ERR_NO_MEM");
    expect(gateway.snapshot.connected).toBe(true);
  });
  it("串口超时后读取后端状态、清除旧数据且不重发修改", async () => {
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    await gateway.refresh();
    invoke.mockImplementation(async (name: string) => {
      if (name === "sticks3_request") throw new Error("响应超时，结果未知");
      return { connected: false };
    });
    await expect(gateway.execute({ op: "ble.disconnect" })).rejects.toThrow("结果未知");
    expect(gateway.snapshot).toEqual({ connected: false });
    expect(invoke.mock.calls.filter(([, args]) => args?.request?.op === "ble.disconnect")).toHaveLength(1);
  });
  it("断开立即取消排队的写操作", async () => {
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    const pending = gateway.execute({ op: "wifi.disconnect" });
    const rejected = expect(pending).rejects.toBeInstanceOf(S3Cancelled);
    await gateway.disconnect();
    await rejected;
    expect(invoke.mock.calls.some(([, args]) => args?.request?.op === "wifi.disconnect")).toBe(false);
    expect(invoke).toHaveBeenLastCalledWith("sticks3_disconnect", { expectedSessionId: 7 });
  });
  it("用户取消握手时释放迟到的新会话", async () => {
    let complete: (snapshot: S3Snapshot) => void = () => { throw new Error("未开始握手"); };
    invoke.mockImplementation((name: string) => name === "sticks3_connect"
      ? new Promise<S3Snapshot>((resolve) => { complete = resolve; }) : Promise.resolve({ connected: false }));
    const gateway = new StickS3Gateway();
    const connecting = gateway.connect("COM7");
    const rejected = expect(connecting).rejects.toBeInstanceOf(S3Cancelled);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("sticks3_connect", { portName: "COM7" }));
    const disconnecting = gateway.disconnect();
    complete(session);
    await rejected;
    await disconnecting;
    expect(invoke).toHaveBeenCalledWith("sticks3_disconnect", { expectedSessionId: 7 });
    expect(gateway.snapshot.connected).toBe(false);
  });
  it("断开失败仍保留会话，允许再次释放", async () => {
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    invoke.mockRejectedValueOnce(new Error("close failed"));
    await expect(gateway.disconnect()).rejects.toThrow("close failed");
    expect(gateway.snapshot.connected).toBe(true);
    await gateway.disconnect();
    expect(gateway.snapshot.connected).toBe(false);
  });
  it("记忆槽 1 和 3 不会被错误地当作连续的 0 和 1", async () => {
    invoke.mockImplementation(async (name: string, args?: { request: Request }) => {
      if (args?.request?.op === "wifi.saved") {
        const slot = args.request.index ?? 0;
        return reply({ used_mask: 10, preferred: 3, slot, occupied: slot === 1 || slot === 3 ? 1 : 0, ssid: `Network ${slot}` });
      }
      return backend(name, args);
    });
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    expect((await gateway.refresh()).data?.wifiSaved).toEqual([
      { slot: 1, label: "Network 1", preferred: false }, { slot: 3, label: "Network 3", preferred: true },
    ]);
  });
});

describe("StickS3 扫描一致性", () => {
  it("分页中途 generation 变化时重读，绝不混合两轮结果", async () => {
    vi.useFakeTimers();
    let heads = 0;
    invoke.mockImplementation(async (name: string, args?: { request: Request }) => {
      if (args?.request?.op === "wifi.scan.results") {
        const index = args.request.index ?? 0;
        if (index === 0) heads++;
        const generation = heads === 1 ? 1 : heads === 2 && index === 0 ? 2 : 3;
        return reply({ enabled: 1, scanning: 0, generation, error: 0, count: 2, total: 2,
          index, ssid: `Round${generation}-${index}`, bssid: `AA:BB:CC:DD:EE:0${index}`, rssi: -40, channel: 6, auth: 3 });
      }
      return backend(name, args);
    });
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    const pending = gateway.scan("wifi");
    await vi.runAllTimersAsync();
    const scan = await pending;
    expect(scan.generation).toBe(3);
    expect(scan.rows.map((row) => row.ssid)).toEqual(["Round3-0", "Round3-1"]);
    expect(invoke.mock.calls.filter(([, args]) => args?.request?.op === "wifi.scan")).toHaveLength(1);
  });
  it("旧 generation 不变时不会报告扫描成功", async () => {
    vi.useFakeTimers();
    invoke.mockImplementation(async (name: string, args?: { request: Request }) => args?.request?.op === "ble.scan.results"
      ? reply({ enabled: 1, scanning: 0, generation: 4, error: 0, count: 0, total: 0 }) : backend(name, args));
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    const pending = expect(gateway.scan("ble")).rejects.toThrow("25 秒");
    await vi.runAllTimersAsync();
    await pending;
  });
  it("BLE 地址类型和不可连接标志原样保留", async () => {
    let heads = 0;
    invoke.mockImplementation(async (name: string, args?: { request: Request }) => args?.request?.op === "ble.scan.results"
      ? reply({ enabled: 1, scanning: 0, generation: ++heads === 1 ? 0 : 1, error: 0, count: 1, total: 1,
        index: 0, name: "Beacon", address: "CA:11:22:33:44:55", address_type: 1, rssi: -70, connectable: 0 }) : backend(name, args));
    const gateway = new StickS3Gateway();
    await gateway.connect("COM7");
    expect((await gateway.scan("ble")).rows[0]).toMatchObject({ addressType: 1, connectable: false });
  });
});
