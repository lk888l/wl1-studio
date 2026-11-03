import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./device";
import type { SerialPortOption } from "../types";
export interface KnobConfig {
  bus_voltage: number; sense_gain: number; current_limit: number; voltage_limit: number;
  current_kp: number; current_ki: number; width: number; strength: number; endstop: number;
  damping: number; snap: number; min_position: number; max_position: number; mode: number;
}
export const defaultKnobConfig: KnobConfig = {
  bus_voltage: 11.62, sense_gain: 0.15, current_limit: 0.65, voltage_limit: 2.35,
  current_kp: 1.5, current_ki: 300, width: Math.PI / 6, strength: 5, endstop: 8,
  damping: 0.015, snap: 0.6, min_position: 0, max_position: 11, mode: 1,
};
export const maxKnobCurrent = 1;
export type KnobOp = "status" | "configure" | "calibrate" | "enable" | "disable" | "clear" | "zero" | "pulse" | "save";
export type KnobState = "idle" | "offsets" | "align" | "sweep" | "settle" | "active" | "fault";
export interface KnobTelemetry {
  device: "smartknob-s3"; protocol: 1; ok: boolean; error?: string; state: KnobState; fault: string;
  transport?: "usb_serial_jtag" | "uart0";
  current_limit_max?: number; current_trip_limit?: number; current_absolute_trip?: number; current_target_limit?: number; current_limited?: boolean;
  fault_current_valid?: boolean; fault_currents?: number[]; fault_current_trip_limit?: number;
  weak_magnet_allowed?: boolean; hardware_detail?: string; hardware_error?: number;
  encoder_error?: number; fault_magnet?: number; encoder_failures?: number; encoder_retries?: number; voltage_d?: number; voltage_q?: number;
  angle: number; velocity: number; position: number; sub_position: number; iq: number;
  id_current: number; target: number; magnet: number; rejected_samples: number; sample_us: number; loop_us: number;
  current_valid: boolean; currents: number[]; sense_volts: number[]; offsets: number[]; duty: number[]; config: KnobConfig;
  calibration: { valid: boolean; direction: number; pole_pairs: number; electrical_zero: number };
}
export function knobCurrentLimitMax(sample: KnobTelemetry | null): number {
  // Older firmware accepts at most 0.8 A; new firmware advertises its limit.
  return sample ? Math.min(maxKnobCurrent, sample.current_limit_max ?? 0.8) : maxKnobCurrent;
}
export function validateKnobConfig(c: KnobConfig, currentLimitMax = maxKnobCurrent): string | null {
  if (Object.values(c).some(v => !Number.isFinite(v))) return "所有参数必须是有限数值";
  if (c.bus_voltage < 4.5 || c.bus_voltage > 30) return "母线电压范围为 4.5–30 V";
  if (![0.15, 0.3, 0.6, 1.2].includes(c.sense_gain)) return "选择芯片支持的采样增益";
  if (c.current_limit < 0.02 || c.current_limit > currentLimitMax) return `电流限制范围为 0.02–${currentLimitMax} A`;
  if (c.voltage_limit < 0.05 || c.voltage_limit > Math.min(5, c.bus_voltage * 0.36 / Math.sqrt(3))) return "电压限制超出低侧采样窗口允许范围";
  if (c.current_kp < 0 || c.current_kp > 20 || c.current_ki < 0 || c.current_ki > 1000) return "电流 PI 参数超出范围";
  if (c.width < Math.PI / 180 || c.width > Math.PI || c.snap < 0.5 || c.snap > 1) return "档距须为 1–180°，切换点须为 0.5–1";
  if (c.strength < 0 || c.strength > 10 || c.endstop < 0 || c.endstop > 20 || c.damping < 0 || c.damping > 0.5) return "手感参数超出范围";
  if (!Number.isInteger(c.min_position) || !Number.isInteger(c.max_position) || c.min_position < -10000 || c.max_position > 10000 || c.min_position > c.max_position) return "行程端点须为有序整数，范围 ±10000";
  if (![0, 1, 2, 3].includes(c.mode)) return "无效的旋钮模式";
  return null;
}
export function parseKnobTelemetry(value: unknown): KnobTelemetry {
  if (!value || typeof value !== "object") throw new Error("旋钮回复不是 JSON 对象");
  const r = value as Record<string, unknown>;
  // Firmware cannot provide a real snapshot if its control task is unavailable.
  if (r.ok === false && r.error === "control_unavailable") throw new Error("旋钮控制任务不可用，请复位设备后重试");
  if (r.transport !== undefined && !["usb_serial_jtag", "uart0"].includes(String(r.transport))) throw new Error("未知旋钮调参通道");
  for (const key of ["current_limit_max", "current_trip_limit", "current_absolute_trip", "current_target_limit", "fault_current_trip_limit"]) {
    if (r[key] !== undefined && (typeof r[key] !== "number" || !Number.isFinite(r[key]) || r[key] < 0)) throw new Error(`无效限流状态：${key}`);
  }
  if (r.current_limit_max !== undefined && Number(r.current_limit_max) < 0.02) throw new Error("无效电流上限");
  if (r.current_limited !== undefined && typeof r.current_limited !== "boolean") throw new Error("无效限流标志");
  if (r.fault_current_valid !== undefined && typeof r.fault_current_valid !== "boolean") throw new Error("无效过流现场标志");
  if (r.fault_currents !== undefined || r.fault_current_valid === true) {
    if (!Array.isArray(r.fault_currents) || r.fault_currents.length !== 3 || r.fault_currents.some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error("无效过流现场电流");
  }
  if (r.device !== "smartknob-s3" || r.protocol !== 1 || typeof r.ok !== "boolean" ||
      !["idle", "offsets", "align", "sweep", "settle", "active", "fault"].includes(String(r.state)) || typeof r.fault !== "string") throw new Error("旋钮协议版本或设备身份不匹配");
  if (typeof r.current_valid !== "boolean") throw new Error("缺少电流有效性标志");
  for (const key of ["angle", "velocity", "position", "sub_position", "iq", "id_current", "target", "magnet", "rejected_samples", "sample_us", "loop_us"]) {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key])) throw new Error(`无效遥测：${key}`);
  }
  for (const key of ["currents", "sense_volts", "offsets", "duty"]) {
    if (!Array.isArray(r[key]) || r[key].length !== 3 || r[key].some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error(`无效采样：${key}`);
  }
  if (!r.config || typeof r.config !== "object") throw new Error("缺少设备参数");
  for (const key of Object.keys(defaultKnobConfig)) {
    const config = r.config as Record<string, unknown>;
    if (typeof config[key] !== "number" || !Number.isFinite(config[key])) throw new Error(`无效参数：${key}`);
  }
  const cal = r.calibration as Record<string, unknown> | undefined;
  if (!cal || typeof cal.valid !== "boolean" || typeof cal.direction !== "number" || ![-1, 1].includes(cal.direction) || cal.pole_pairs !== 7 || typeof cal.electrical_zero !== "number" || !Number.isFinite(cal.electrical_zero)) throw new Error("无效校准状态");
  const result = value as KnobTelemetry;
  const gain = [0.15, 0.3, 0.6, 1.2].find(v => Math.abs(v - result.config.sense_gain) < 1e-5);
  if (gain === undefined) throw new Error("无效采样增益");
  // Firmware stores float32. Normalize display/validation artifacts such as
  // 0.8000000119 A and 180.000005 degrees without changing user-entered limits.
  const config = { ...result.config, sense_gain: gain };
  for (const key of Object.keys(defaultKnobConfig) as (keyof KnobConfig)[]) {
    if (key !== "width") config[key] = Number(config[key].toFixed(6));
  }
  for (const boundary of [Math.PI / 180, Math.PI]) {
    if (Math.abs(config.width - boundary) < 1e-6) config.width = boundary;
  }
  const voltageMax = Math.min(5, config.bus_voltage * 0.36 / Math.sqrt(3));
  if (Math.abs(config.voltage_limit - voltageMax) < 1e-6) config.voltage_limit = voltageMax;
  return { ...result, config };
}
export function sortKnobPorts(ports: SerialPortOption[]): SerialPortOption[] {
  const rank = (p: SerialPortOption) => p.vid === 0x303a && p.pid === 0x1001 ? 0 : p.portType === "usb" ? 1 : 2;
  return [...ports].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
export function knobPortLabel(port: SerialPortOption): string {
  return port.vid === 0x303a && port.pid === 0x1001 ? "ESP32 原生 USB" : port.product ?? port.manufacturer ?? port.portType;
}
interface Session { connected: boolean; sessionId: number | null; portName: string | null }
class KnobGateway {
  private sessionId: number | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  async initialize(): Promise<void> { if (isTauriRuntime()) await this.disconnect(); }
  ports(): Promise<SerialPortOption[]> { return isTauriRuntime() ? invoke<SerialPortOption[]>("list_serial_ports").then(sortKnobPorts) : Promise.resolve([]); }
  async connect(portName: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("USB 调参请使用桌面应用，当前为界面预览");
    const s = await invoke<Session>("knob_connect", { portName });
    if (!s.connected || s.sessionId === null) throw new Error("未建立旋钮会话");
    this.sessionId = s.sessionId;
  }
  async disconnect(): Promise<void> {
    const id = this.sessionId; this.sessionId = null;
    if (isTauriRuntime()) await invoke("knob_disconnect", { expectedSessionId: id });
  }
  request(op: KnobOp, config?: KnobConfig): Promise<KnobTelemetry> {
    const id = this.sessionId;
    const run = async (): Promise<KnobTelemetry> => {
      if (id === null || this.sessionId !== id) throw new Error("旋钮尚未连接或会话已改变");
      let response: unknown;
      try { response = await invoke("knob_request", { expectedSessionId: id, request: config ? { op, config } : { op } }); }
      catch (error) { if (this.sessionId === id) this.sessionId = null; throw error; }
      if (this.sessionId !== id) throw new Error("旋钮会话已改变");
      try { return parseKnobTelemetry(response); }
      catch (error) {
        if (this.sessionId === id) this.sessionId = null;
        await invoke("knob_disconnect", { expectedSessionId: id }).catch(() => undefined);
        throw error;
      }
    };
    const result = this.tail.then(run, run); this.tail = result; return result;
  }
}
export const knobGateway = new KnobGateway();
export const knobMessages: Record<string, string> = {
  none: "正常", hardware_init_failed: "硬件初始化失败，查看底层诊断后清除故障", encoder_magnet_or_i2c: "编码器通讯异常或磁铁强度不合适",
  encoder_i2c: "编码器 I²C 通讯失败，请查看错误码", encoder_missing_magnet: "编码器未检测到磁铁", encoder_magnet_strength: "编码器磁场强度超出允许范围",
  overcurrent: "异常过流超过保护阈值", overcurrent_isr: "采样中断检测到异常过流", control_watchdog: "控制任务超时",
  host_timeout: "上位机心跳超时，电机已停机", adc_window_or_control_deadline: "采样窗口或控制周期超时", adc_window_invalid: "电流采样窗口无效，禁止使能",
  invalid_current_offsets_check_mode_gain: "电流零点无效，请检查驱动器 MODE 和 SOA/B/C 连线", keep_rotor_still_for_offsets: "零点采样时旋钮发生转动，请静置重试",
  calibration_current_tracking: "校准电流未跟随目标，请检查采样相序、增益和电流 PI", calibration_motion_mismatch_7pp: "校准运动与 7 极对数不符，请检查相序和磁铁", alignment_unstable: "对齐未稳定", calibrate_first: "请先完成电机校准",
  disable_before_save: "停机后才能保存", disable_before_electrical_config: "请先停机，再修改电气参数", idle_required: "请先停止当前动作",
  clear_fault_first: "请先清除故障", overspeed: "转速超过手动旋钮范围", encoder_jump: "编码器角度跳变", adc_saturation: "电流 ADC 饱和",
};
