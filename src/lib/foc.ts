import { invoke } from "@tauri-apps/api/core";
import catalog from "../../src-tauri/crates/foc-drive/src/objects.csv?raw";
import { isTauriRuntime } from "./device";

export interface Link {
  channel: number;
  node: number;
  nominal: number;
  data: number;
}
export const defaultLink: Link = {
  channel: 0,
  node: 1,
  nominal: 1000000,
  data: 5000000,
};
export const modes = {
  velocity: "速度",
  torque: "力矩",
  single_turn: "单圈位置",
  multi_turn: "多圈位置",
  mit: "MIT · 浮点",
  packed_mit: "MIT · 压缩",
};
export type Mode = keyof typeof modes;
export const phases = {
  idle: "监视中",
  await_disabled: "等待关桥反馈",
  shutdown: "准备上电",
  switch_on: "等待接通",
  enable: "等待使能",
  running: "周期驱动中",
  position_low: "等待位置应答清零",
  position_high: "等待目标接受",
  halted: "Halt · 仍使能",
  quick_stop: "快速减速中",
  calibrating: "校准流程中",
  unconfirmed: "关桥或映射恢复未确认",
};
export interface Feedback {
  status: number;
  fault: number;
  position: number;
  velocity: number;
  id_ma: number;
  iq_ma: number;
  bus_mv: number;
  torque: number;
  temperature: number;
  mode: number;
  calibration: number;
}
export interface TracePoint {
  seq: number;
  time: number;
  feedback: Feedback;
  phase: keyof typeof phases;
  source: "SDO" | "TPDO4";
}
export interface Snapshot {
  session: number;
  link: Link;
  feedback: Feedback;
  phase: keyof typeof phases;
  mode: Mode | null;
  sample: number;
  age_ms: number;
  source: "SDO" | "TPDO4";
  error: string | null;
  io_error: string | null;
  reset: boolean;
  recent: TracePoint[];
}
export interface Discovery {
  nodes: [number, number][];
  ids: number[];
  health: string | null;
}
export type Target =
  | { kind: "velocity"; rev_s: number }
  | { kind: "torque"; permille: number }
  | { kind: "position"; rev: number; relative: boolean }
  | {
      kind: "mit";
      rev: number;
      rev_s: number;
      kp: number;
      kd: number;
      nm: number;
    };
export type Service =
  | "calibrate"
  | "slow_scan"
  | "compensation_on"
  | "compensation_off"
  | "save"
  | "restore"
  | "reset_communication"
  | "reboot"
  | "reset_fault";
export interface Pdo {
  slot: number;
  cob: number;
  transmission: number;
  timer_ms: number;
  inhibit: number;
  entries: number[];
}
export type Action =
  | { kind: "start"; mode: Mode; period_ms: number }
  | { kind: "target"; target: Target }
  | { kind: "halt" | "packed"; on: boolean }
  | { kind: "quick_stop" }
  | { kind: "service"; command: Service }
  | { kind: "read"; addresses: [number, number][] }
  | { kind: "write"; index: number; sub: number; value: number }
  | { kind: "read_pdo"; slot: number }
  | { kind: "write_pdo"; config: Pdo };
export type ResultOf<A extends Action> = A extends { kind: "read" }
  ? number[]
  : A extends { kind: "read_pdo" }
    ? Pdo
    : A extends { kind: "write" }
      ? number
      : null;
export const foc = {
  initialize: () => (isTauriRuntime() ? invoke<void>("foc_release") : Promise.resolve()),
  listen: (link: Link) => invoke<Discovery>("foc_listen", { link }),
  connect: (link: Link) => invoke<Snapshot>("foc_connect", { link }),
  snapshot: (session: number, afterSample = 0) => invoke<Snapshot>("foc_snapshot", { session, afterSample }),
  action: <A extends Action>(session: number, action: A) =>
    invoke<ResultOf<A>>("foc_action", { session, action }),
  stop: (session: number) => invoke<void>("foc_stop", { session }),
  release: (session: number, physicalOff = false) => invoke<void>("foc_release", { session, physicalOff }),
};

export function traceCsv(samples: TracePoint[]) {
  const columns = [
    "status",
    "fault",
    "mode",
    "calibration",
    "position",
    "velocity",
    "torque",
    "id_ma",
    "iq_ma",
    "bus_mv",
    "temperature",
  ] as const;
  const header =
    "sequence,session_ms,source,phase,statusword,fault,mode,calibration,position_rev,velocity_rev_s,torque_permille,id_mA,iq_mA,bus_mV,mcu_temp_dC";
  return (
    [
      header,
      ...samples.map((point) =>
        [point.seq, point.time, point.source, point.phase, ...columns.map((key) => point.feedback[key])].join(
          ",",
        ),
      ),
    ].join("\r\n") + "\r\n"
  );
}

export const hex = (value: number, width = 4) => value.toString(16).toUpperCase().padStart(width, "0");
export function numeric(text: string): number | null {
  const trimmed = text.trim();
  const value = Number(trimmed);
  return trimmed && Number.isFinite(value) ? value : null;
}
export function wireBytes(size: number) {
  return size <= 8 ? size : ([12, 16, 20, 24, 32, 48, 64].find((length) => length >= size) ?? null);
}
export function driveState(status: number) {
  return (
    (
      {
        64: "功率桥已关闭",
        33: "就绪",
        35: "已接通 · 未使能",
        39: "功率输出已使能",
        7: "快速停止中",
        8: "故障锁定",
      } as Record<number, string>
    )[status & 0x6f] ?? "未知驱动状态"
  );
}
export const calibrationStates = ["待校准", "对齐", "扫描", "停稳计算", "已校准", "校准失败"];
export function canConfigure(view: Snapshot | null) {
  return (
    !!view &&
    !view.reset &&
    view.phase === "idle" &&
    !view.io_error &&
    view.age_ms < 1000 &&
    view.feedback.fault === 0 &&
    (view.feedback.status & 0x6f) === 64 &&
    ![1, 2, 3].includes(view.feedback.calibration)
  );
}

const labels: Record<string, string> = {
  "1003:00": "清除错误历史（写 0）",
  "1005:00": "SYNC COB-ID",
  "1006:00": "SYNC 周期 · µs",
  "1007:00": "SYNC 窗口 · µs",
  "1014:00": "EMCY COB-ID",
  "1015:00": "EMCY 抑制 · 100 µs",
  "1016:01": "主站心跳监测 · (ID << 16) | 超时 ms",
  "1017:00": "心跳周期 · ms",
  "2001:01": "节点 ID · 1–127",
  "2001:02": "仲裁段速率 · bit/s",
  "2001:03": "数据段速率 · bit/s",
  "2001:04": "位速率切换 BRS",
  "2100:06": "基准电流 · (0, 4.9] A",
  "2100:07": "力矩常数 · (0.001, 1] Nm/A",
  "2003:06": "浮点格式附加限流 · 0–1000 ‰",
  "2004:0E": "压缩格式附加限流 · 0–1000 ‰",
  "6065:00": "跟随误差窗口 · rev",
  "6066:00": "跟随误差时间 · ms",
  "6072:00": "全局电流上限 · 0–1000 ‰",
  "6081:00": "轨迹速度上限 · (0, 40] rev/s",
  "6083:00": "加速度 · (0, 100] rev/s²",
  "6084:00": "减速度 · (0, 100] rev/s²",
  "6085:00": "快停减速度 · (0, 100] rev/s²",
  "2100:02": "校准状态",
  "2100:03": "极对数",
  "2100:04": "编码器方向",
  "2100:05": "电角偏置 · rad",
  "2100:08": "命令超时告警 · ms",
  "2100:09": "MCU 温度 · 0.1 °C",
  "2100:0A": "控制周期峰值 · cycles",
};
const mitRangeNames = ["位置 · rev", "速度 · rev/s", "Kp · Nm/rev", "Kd · Nm/(rev/s)", "前馈力矩 · Nm"];
export const objects = catalog
  .trim()
  .split(/\r?\n/)
  .slice(1)
  .map((line) => {
    const [address = "", name = "", scalar = "", access, map, initial] = line.split(",");
    const index = Number.parseInt(address.slice(0, 4), 16),
      sub = Number.parseInt(address.slice(5), 16);
    const pdo = index >= 0x1400 && index < 0x1b00;
    const dedicated =
      pdo ||
      [0x1010, 0x1011, 0x6040, 0x6060, 0x6071, 0x607a, 0x60ff].includes(index) ||
      (index === 0x2100 && sub === 1) ||
      (index === 0x2003 && sub <= 5) ||
      (index === 0x2004 && sub <= 3);
    const group = pdo
      ? "PDO"
      : index === 0x2003 || index === 0x2004
        ? "MIT"
        : index >= 0x6000 || index === 0x2100
          ? "驱动"
          : index < 0x2100
            ? "通信"
            : "诊断";
    const range =
      index === 0x2004 && sub >= 4 && sub <= 13
        ? `压缩${mitRangeNames[Math.floor((sub - 4) / 2)]} · ${sub % 2 ? "最大值" : "最小值"}`
        : null;
    return {
      address,
      index,
      sub,
      name,
      scalar,
      initial,
      group,
      mappable: map === "1",
      writable: access === "rw",
      editable: access === "rw" && !dedicated,
      title: labels[address] ?? range ?? name,
    };
  });
export function mapEntries(text: string, slot: number): number[] | null {
  if (!text.trim()) return [];
  const tokens = text.trim().split(/[\s,;]+/);
  if (tokens.length > 16) return null;
  let size = 0;
  const entries: number[] = [];
  for (const token of tokens) {
    if (!/^(?:0x)?[0-9a-f]{8}$/i.test(token)) return null;
    const word = Number.parseInt(token.replace(/^0x/i, ""), 16);
    const entry = objects.find((item) => item.index === word >>> 16 && item.sub === ((word >>> 8) & 255));
    if (!entry?.mappable || (slot <= 4 && !entry.writable) || (word & 255) !== Number(entry.scalar.slice(1)))
      return null;
    size += (word & 255) / 8;
    entries.push(word);
  }
  return size <= 64 ? entries : null;
}
