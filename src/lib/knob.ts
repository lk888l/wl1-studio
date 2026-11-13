import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./device";
import type { SerialPortOption } from "../types";
export interface KnobConfig {
  bus_voltage: number; sense_gain: number; current_limit: number;
  /** Legacy device setting, read-only in the app. Automatic firmware omits it. */
  voltage_limit?: number;
  current_kp: number; current_ki: number; width: number; strength: number; endstop: number;
  damping: number; snap: number; min_position: number; max_position: number; mode: number;
  frictionless?: KnobFrictionlessConfig;
  reference_modes?: KnobReferenceModes;
}
export interface KnobReferenceModeConfig {
  bounded: boolean;
  position: number; min_position: number; max_position: number;
  width: number; endstop: number; snap: number; bias: number;
  strength: number; damping: number; scale: number; friction: number; click: number;
  magnetic_positions: number[];
  endstop_damping?: number; click_enabled?: boolean;
}
export type KnobReferenceModes = Record<string, KnobReferenceModeConfig>;
export interface KnobFrictionlessConfig {
  friction: number; viscous: number; scale: number; hold_kp: number; hold_ki: number;
}
export interface KnobFrictionlessTelemetry {
  phase: number; reference: number; correction: number; feedforward: number; angle_compensation?: boolean;
}
export interface KnobCalibrationQuality extends Record<string, unknown> {
  method?: string; verified: boolean; phase_check_passed?: boolean;
}
export interface KnobCalibrationReport extends Record<string, unknown> {
  stage: string; error: string; passed: boolean; cancelled?: boolean; elapsed_s?: number;
}
export const defaultKnobConfig: KnobConfig = {
  bus_voltage: 11.62, sense_gain: 0.15, current_limit: 0.8,
  current_kp: 0.4, current_ki: 200, width: Math.PI / 18, strength: 20, endstop: 8,
  damping: 0.003, snap: 0.55, min_position: 0, max_position: 11, mode: 1,
};
type EditableKnobKey = Exclude<keyof KnobConfig, "voltage_limit" | "frictionless" | "reference_modes">;
const editableKnobKeys = Object.keys(defaultKnobConfig) as EditableKnobKey[];
export function knobEditableConfig(config: KnobConfig): KnobConfig {
  const copy = structuredClone(config);
  delete copy.voltage_limit;
  return copy;
}
// Keep the original wire values separately from legacy display normalization.
// A mode-only change must not round an untouched device setting on its way back.
const wireConfigs = new WeakMap<KnobTelemetry, KnobConfig>();
const frictionlessBounds = { friction: .8, viscous: .02, scale: 10, hold_kp: 1, hold_ki: 5 } as const;
const referenceNumericBounds = {
  position: [-10000, 10000], min_position: [-10000, 10000], max_position: [-10000, 10000],
  width: [Math.PI / 180, Math.PI], endstop: [0, 20], snap: [.5, 2], bias: [0, 1.5],
  strength: [0, 100], damping: [0, 5], scale: [0, 1], friction: [0, .45], click: [0, .45],
} as const;
const referenceNumericKeys = Object.keys(referenceNumericBounds) as (keyof typeof referenceNumericBounds)[];
const referenceScalarKeys = [...referenceNumericKeys, "bounded", "endstop_damping", "click_enabled"] as const;
export const knobReferenceEditableKeys = [...referenceScalarKeys, "magnetic_positions"] as const;
const referenceModeIds = Array.from({ length: 12 }, (_, index) => String(index + 4));
export function validateKnobReferenceConfig(config: KnobReferenceModeConfig, mode: number, version = 1): string | null {
  if (!Number.isInteger(mode) || mode < 4 || mode > 15) return "无效的参考模式编号";
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.bounded !== "boolean") return "参考模式缺少有效的行程类型";
  for (const key of referenceNumericKeys) {
    const value = config[key], [min, max] = version === 2 && key === "strength" ? [0, 1000] : version === 2 && key === "damping" ? [0, .5] : referenceNumericBounds[key];
    if (typeof value !== "number" || !Number.isFinite(value) || Math.fround(value) < Math.fround(min) || Math.fround(value) > Math.fround(max)) return `参考参数 ${key} 超出范围`;
  }
  if (version === 2 && (typeof config.click_enabled !== "boolean" || typeof config.endstop_damping !== "number" || !Number.isFinite(config.endstop_damping) || config.endstop_damping < 0 || config.endstop_damping > .5)) return "新版参考模式需要点击开关和 0–0.5 的端点阻尼";
  for (const key of ["position", "min_position", "max_position"] as const) {
    if (!Number.isInteger(config[key])) return "参考模式的初始档位与行程端点须为整数";
  }
  if (config.bounded && (config.min_position > config.max_position || config.position < config.min_position || config.position > config.max_position)) return "有限行程须包含初始档位，且起点不大于终点";
  if (Math.fround(config.bias) > Math.fround(Math.fround(config.snap) - Math.fround(.05))) return "中心偏置须比切换点至少小 0.05";
  const magnets = config.magnetic_positions;
  if (!Array.isArray(magnets) || magnets.length > 8 || new Set(magnets).size !== magnets.length ||
      magnets.some(position => !Number.isInteger(position) || position < -10000 || position > 10000 ||
        (config.bounded && (position < config.min_position || position > config.max_position)))) return "磁吸档位须为不重复的整数，最多 8 个，且位于有效行程内";
  if (mode !== 14 && magnets.length !== 0) return "只有磁性档位模式支持磁吸档位列表";
  return null;
}
function validateReferenceBank(value: unknown, version = 1): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "参考模式参数不是有效对象";
  const bank = value as KnobReferenceModes;
  if (Object.keys(bank).length !== referenceModeIds.length || referenceModeIds.some(mode => !Object.hasOwn(bank, mode))) return "参考模式参数须完整包含模式 4–15";
  for (const mode of referenceModeIds) {
    const error = validateKnobReferenceConfig(bank[mode]!, Number(mode), version);
    if (error) return `模式 ${mode}：${error}`;
  }
  return null;
}
function referenceEntryChanged(left: KnobReferenceModeConfig | undefined, right: KnobReferenceModeConfig | undefined): boolean {
  if (!left || !right) return left !== right;
  if (!Array.isArray(left.magnetic_positions) || !Array.isArray(right.magnetic_positions)) return true;
  return referenceScalarKeys.some(key => left[key] !== right[key]) ||
    left.magnetic_positions.length !== right.magnetic_positions.length ||
    left.magnetic_positions.some((value, index) => value !== right.magnetic_positions[index]);
}
export function knobReferenceChanged(draft: KnobConfig, base: KnobConfig): boolean {
  return referenceModeIds.some(mode => referenceEntryChanged(draft.reference_modes?.[mode], base.reference_modes?.[mode]));
}
const legacyModeNames = ["自由旋转", "虚拟档位", "有限行程", "弹簧回中"];
export function knobModeCount(sample: KnobTelemetry | null): number {
  return sample?.mode_count ?? sample?.modes?.length ?? 4;
}
export function knobModeName(mode: number, sample: KnobTelemetry | null = null): string {
  return sample?.modes?.[mode] ?? (sample?.config.mode === mode ? sample.mode_name : undefined) ?? legacyModeNames[mode] ?? `模式 ${mode}`;
}
export function knobModeOptions(sample: KnobTelemetry | null): { value: number; label: string }[] {
  return Array.from({ length: knobModeCount(sample) }, (_, value) => ({ value, label: knobModeName(value, sample) }));
}
export const maxKnobCurrent = 4.5;
export const maxKnobStrength = 1000;
export type KnobOp = "status" | "configure" | "calibrate" | "enable" | "disable" | "clear" | "zero" | "pulse" | "save";
export type KnobState = "idle" | "offsets" | "align" | "sweep" | "settle" | "active" | "fault";
export interface KnobFaultSample {
  interval_us: number; age_us: number; start_tick: number; end_tick: number; duration_us: number; valid: boolean;
  adc_dma_words?: number[]; adc_raw?: number[]; adc_phase?: number[];
}
export interface KnobDiagnostic {
  busy: boolean; cancelled: boolean; stage: number; count: number; peak_speed: number; peak_current: number;
  muted_samples: number; recovered: boolean; offset?: number; samples?: number[][];
}
export interface KnobTelemetry {
  device: "smartknob-s3"; protocol: 1; ok: boolean; error?: string; state: KnobState; fault: string; id?: number;
  firmware?: string; current_sampling?: string; detent_profile?: string; pwm_profile?: string;
  mode_count?: number; modes?: string[]; mode_name?: string; reference_preset?: number;
  reference_config_version?: number; reference_current_limit?: number; reference_defaults?: KnobReferenceModes;
  live_haptics_config?: boolean;
  frictionless?: KnobFrictionlessTelemetry;
  calibration_quality?: KnobCalibrationQuality; calibration_report?: KnobCalibrationReport;
  control_nominal_hz?: number; encoder_nominal_hz?: number; pwm_hz?: number; pwm_actual_hz?: number;
  control_carrier_divider?: number; encoder_carrier_divider?: number;
  pwm_duty_floor?: number; pwm_duty_ceiling?: number; max_voltage_limit?: number;
  pwm_min_active_duty?: number; pwm_zero_clamp?: boolean;
  voltage_limit_automatic?: boolean;
  configured_max_voltage_limit?: number; available_voltage_limit?: number; effective_voltage_limit?: number;
  bus_voltage_sensing?: boolean; bus_voltage_source?: string; bus_voltage?: number; bus_voltage_valid?: boolean;
  bus_voltage_age_us?: number; bus_voltage_raw?: number; bus_voltage_adc_mv?: number;
  bus_voltage_measured?: number; bus_voltage_error?: number; bus_voltage_divider?: number;
  adc_sample_valid?: boolean; sampling_restart_required?: boolean; current_phase_skew_us?: number;
  host_lease_ms?: number; current_feedforward_ohms?: number;
  reset_reason?: number; uptime_ms?: number; minimum_free_heap?: number;
  transport?: "usb_serial_jtag" | "uart0";
  encoder?: string; encoder_interface?: string; encoder_resolution_bits?: number; encoder_dma?: boolean;
  current_limit_max?: number; current_trip_limit?: number; current_absolute_trip?: number; current_target_limit?: number; current_limited?: boolean;
  strength_max?: number; current_peak_trip?: number; current_peak_trip_ms?: number; current_overload_trip_ms?: number; current_trip_recovery_ratio?: number;
  quiet_output?: boolean; detent_quiet_velocity?: boolean; haptic_position_filter?: boolean; current_target_slew?: boolean;
  haptic_scale?: number; speed_limited?: boolean; haptic_paused?: boolean;
  haptic_fade_start?: number; haptic_speed_cutoff?: number; haptic_resume_speed?: number;
  haptic_resume_hold_ms?: number; haptic_fade_in_ms?: number;
  detent_assist_fade_start?: number; detent_assist_cutoff?: number; elastic_min_damping?: number;
  fault_current_valid?: boolean; fault_currents?: number[]; fault_current_trip_limit?: number;
  fault_motion?: { angle: number; velocity: number; velocity_fast: number }; fault_sample?: KnobFaultSample;
  weak_magnet_allowed?: boolean; hardware_detail?: string; hardware_error?: number;
  encoder_error?: number; fault_magnet?: number; encoder_failures?: number; encoder_retries?: number; voltage_d?: number; voltage_q?: number;
  velocity_fast?: number; reused_samples?: number; missed_samples?: number; control_cycles?: number;
  timing_skips?: number; sampling_recoveries?: number; pwm_deferred?: number;
  pwm_peak_duty?: number; pwm_full_duty_cycles?: number;
  control_hz?: number; control_interval_us?: number; control_max_us?: number; encoder_age_us?: number; encoder_age_max_us?: number;
  adc_dma_words?: number[]; sample_start_tick?: number; sample_end_tick?: number; encoder_us?: number; control_us?: number;
  diagnostic?: KnobDiagnostic;
  angle: number; velocity: number; position: number; sub_position: number; iq: number;
  id_current: number; target: number; magnet: number; rejected_samples: number; sample_us: number; loop_us: number;
  current_valid: boolean; currents: number[]; sense_volts: number[]; offsets: number[]; duty: number[]; config: KnobConfig;
  calibration: { valid: boolean; direction: number; pole_pairs: number; electrical_zero: number };
}
export function knobCurrentLimitMax(sample: KnobTelemetry | null): number {
  // Older firmware accepts at most 0.8 A; new firmware advertises its limit.
  return sample ? Math.min(maxKnobCurrent, Number((sample.current_limit_max ?? 0.8).toFixed(6))) : maxKnobCurrent;
}
export function knobStrengthMax(sample: KnobTelemetry | null): number {
  return sample ? Math.min(maxKnobStrength, Number((sample.strength_max ?? 10).toFixed(6))) : maxKnobStrength;
}
export interface KnobDetentPeak {
  requested: number;
  target: number;
  limited: boolean;
}
export function knobDetentPeak(config: KnobConfig, profile = "smart_knob"): KnobDetentPeak | null {
  if (![1, 2].includes(config.mode) ||
    [config.width, config.strength, config.current_limit, config.snap].some(value => !Number.isFinite(value)) ||
    config.width <= 0 || config.strength < 0 || config.current_limit <= 0 || config.snap < .5 || config.snap > 1) return null;
  let requested: number;
  if (profile === "smart_knob") {
    // Static restoring current immediately before snap, excluding velocity D.
    // Match v6/v7's geometric dead zone and current-center switching rule.
    const deadZone = Math.min(config.width * .2, Math.PI / 180);
    requested = config.strength * Math.max(config.width * config.snap - deadZone, 0);
  } else if (profile === "localized_barrier") {
    requested = config.strength * config.width / 2;
  } else return null;
  if (!Number.isFinite(requested)) return null;
  return { requested, target: Math.min(config.current_limit, requested), limited: requested >= config.current_limit };
}
export function knobVoltageLimitMax(busVoltage: number, sample: KnobTelemetry | null = null): number {
  if (!Number.isFinite(busVoltage) || busVoltage < 4.5 || busVoltage > 30) return 0;
  // Both duty bounds must be advertised before widening the legacy window.
  const span = sample?.pwm_duty_floor !== undefined && sample.pwm_duty_ceiling !== undefined
    ? sample.pwm_duty_ceiling - sample.pwm_duty_floor : .4 - .04;
  if (sample && hasModernVoltageLimits(sample)) {
    // The parser verifies this complete numeric contract, including its PWM
    // geometry. Live sag limits runtime output, not the nominal setting editor.
    const windowMax = busVoltage * Number(span.toFixed(6)) / Math.sqrt(3);
    const reportedMax = (sample.configured_max_voltage_limit as number) * busVoltage / sample.config.bus_voltage;
    return voltageTelemetryClose(reportedMax, windowMax) ? windowMax : Math.min(windowMax, reportedMax);
  }
  const windowMax = Math.min(5, busVoltage * Number(span.toFixed(6)) / Math.sqrt(3));
  if (sample?.max_voltage_limit !== undefined && sample.max_voltage_limit < 5 && sample.config.bus_voltage > 0) {
    // The advertised limit is for the device's current bus setting. Scale it
    // when editing that setting, retaining any lower device-reported limit.
    const reportedMax = sample.max_voltage_limit * busVoltage / sample.config.bus_voltage;
    // Normalize float32 telemetry only; entered voltage limits remain strict.
    if (Math.abs(reportedMax - windowMax) >= 1e-6) return Math.min(windowMax, reportedMax);
  }
  return windowMax;
}
export function knobMagnetStatus(sample: KnobTelemetry | null): string {
  if (!sample) return "—";
  // A transport/CRC failure can leave a zero or previous status byte in the
  // snapshot. Decode magnetic faults normally, but do not call stale data good.
  if (["encoder_crc", "encoder_transport", "encoder_stale", "hardware_init_failed", "encoder_i2c", "encoder_magnet_or_i2c"].includes(sample.fault)) {
    return "磁场状态未知（编码器数据无效）";
  }
  if (sample.encoder === "MT6701") {
    // MT6701 Mg[1:0]: 00 normal, 01 strong, 10 weak, 11 reserved.
    // Mg3 is loss of tracking; Mg2 reports a press and is not an angle fault.
    if (sample.magnet & 0x08) return "失去角度跟踪";
    switch (sample.magnet & 0x03) {
      case 1: return "磁场过强";
      case 2: return "磁场过弱";
      case 3: return "磁场状态异常（保留值）";
      default: return sample.magnet & 0x04 ? "磁场正常 · 检测到按压" : "磁场正常";
    }
  }
  if (sample.encoder !== undefined && sample.encoder !== "AS5600") return `${sample.encoder}：状态 0x${sample.magnet.toString(16)}`;
  // Legacy firmware predates the encoder field and uses AS5600 STATUS bits.
  if (!(sample.magnet & 0x20)) return "未检测到磁铁";
  if (sample.magnet & 0x08) return "磁场过强";
  if (sample.magnet & 0x10) return "磁场过弱";
  return "磁场正常";
}
export function validateKnobConfig(c: KnobConfig, currentLimitMax = maxKnobCurrent, strengthMax = maxKnobStrength,
  voltageLimitMax = knobVoltageLimitMax(c.bus_voltage), modeCount = 4, referenceVersion = 1): string | null {
  if (editableKnobKeys.some(key => !Number.isFinite(c[key])) ||
      (c.voltage_limit !== undefined && !Number.isFinite(c.voltage_limit))) return "所有参数必须是有限数值";
  if (!Number.isFinite(currentLimitMax) || currentLimitMax < 0.02 || !Number.isFinite(strengthMax) || strengthMax <= 0) return "设备参数上限无效";
  if (!Number.isFinite(voltageLimitMax) || voltageLimitMax < .05) return "设备电压上限无效";
  currentLimitMax = Math.min(maxKnobCurrent, currentLimitMax);
  strengthMax = Math.min(maxKnobStrength, strengthMax);
  if (c.bus_voltage < 4.5 || c.bus_voltage > 30) return "母线电压范围为 4.5–30 V";
  if (![0.15, 0.3, 0.6, 1.2].includes(c.sense_gain)) return "选择芯片支持的采样增益";
  if (c.current_limit < 0.02 || c.current_limit > currentLimitMax) return `电流限制范围为 0.02–${currentLimitMax} A`;
  if (c.voltage_limit !== undefined && (c.voltage_limit < 0.05 ||
      c.voltage_limit > Math.min(c.bus_voltage / Math.sqrt(3), voltageLimitMax))) return "旧固件电压限制超出允许范围";
  if (c.current_kp < 0 || c.current_kp > 20 || c.current_ki < 0 || c.current_ki > 1000) return "电流 PI 参数超出范围";
  if (c.width < Math.PI / 180 || c.width > Math.PI || c.snap < 0.5 || c.snap > 1) return "档距须为 1–180°，切换点须为 0.5–1";
  if (c.strength < 0 || c.strength > strengthMax) return `挡位强度范围为 0–${strengthMax}`;
  if (c.endstop < 0 || c.endstop > 20 || c.damping < 0 || c.damping > 0.5) return "手感参数超出范围";
  if (!Number.isInteger(c.min_position) || !Number.isInteger(c.max_position) || c.min_position < -10000 || c.max_position > 10000 || c.min_position > c.max_position) return "行程端点须为有序整数，范围 ±10000";
  if (!Number.isInteger(modeCount) || modeCount < 1 || modeCount > 256 || !Number.isInteger(c.mode) || c.mode < 0 || c.mode >= modeCount) return "无效的旋钮模式";
  if (c.frictionless !== undefined) {
    if (!c.frictionless || typeof c.frictionless !== "object" || Array.isArray(c.frictionless)) return "无效的无摩擦参数";
    for (const key of Object.keys(frictionlessBounds) as (keyof KnobFrictionlessConfig)[]) {
      const value = c.frictionless[key];
      // A readback at an inclusive float32 boundary must remain editable.
      if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || Math.fround(value) > Math.fround(frictionlessBounds[key])) return `无摩擦参数 ${key} 超出范围`;
    }
  }
  if (c.reference_modes !== undefined) {
    const error = validateReferenceBank(c.reference_modes, referenceVersion);
    if (error) return error;
  }
  return null;
}
function telemetryNumber(value: unknown, key: string, min = -Infinity, max = Infinity, integer = false): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`无效遥测：${key}`);
  }
}
function telemetryArray(value: unknown, key: string, length: number, min = -Infinity, max = Infinity, integer = false): void {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`无效采样：${key}`);
  for (const item of value) telemetryNumber(item, key, min, max, integer);
}
function telemetryObject(value: unknown, key: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`无效遥测：${key}`);
  return value as Record<string, unknown>;
}
const modernVoltageKeys = ["configured_max_voltage_limit", "available_voltage_limit", "effective_voltage_limit"] as const;
function hasModernVoltageLimits(r: Pick<KnobTelemetry, typeof modernVoltageKeys[number]>): boolean {
  return modernVoltageKeys.every(key => r[key] !== undefined);
}
function voltageTelemetryClose(a: number, b: number): boolean {
  // Only firmware float32 telemetry gets this tolerance; user input stays strict.
  return Math.abs(a - b) <= 2e-6 * Math.max(1, Math.abs(a), Math.abs(b));
}
function validateVoltageTelemetry(r: Record<string, unknown>, config: KnobConfig): void {
  const automatic = r.voltage_limit_automatic === true;
  const modern = automatic || modernVoltageKeys.some(key => r[key] !== undefined);
  if (automatic) {
    if ("voltage_limit" in config) throw new Error("无效遥测：自动电压模式仍包含可调电压上限");
  } else {
    telemetryNumber(config.voltage_limit, "config.voltage_limit", .05, 30);
  }
  const detailedPwm = r.pwm_min_active_duty !== undefined || r.pwm_zero_clamp !== undefined;
  if (detailedPwm || modern) {
    telemetryNumber(r.pwm_duty_floor, "pwm_duty_floor", 0, 1);
    telemetryNumber(r.pwm_duty_ceiling, "pwm_duty_ceiling", Number.MIN_VALUE, 1);
    telemetryNumber(r.pwm_min_active_duty, "pwm_min_active_duty", automatic ? 0 : Number.MIN_VALUE, 1);
    if (typeof r.pwm_zero_clamp !== "boolean") throw new Error("无效遥测：pwm_zero_clamp");
    const floor = r.pwm_duty_floor as number, ceiling = r.pwm_duty_ceiling as number;
    const minimum = r.pwm_min_active_duty as number;
    // Zero-clamping retains the full circular voltage range only when the
    // minimum positive pulse fits the fallback sector offset (firmware: <=9%).
    if (minimum > ceiling || (r.pwm_zero_clamp
      ? floor !== 0 || minimum > ceiling * .09
      : floor <= 0 || !voltageTelemetryClose(floor, minimum))) throw new Error("无效遥测：PWM 最小脉宽与零钳位能力不一致");
    for (const duty of r.duty as number[]) {
      if (duty < 0 || (duty > ceiling && !voltageTelemetryClose(duty, ceiling)) ||
          (duty > 0 && duty < minimum && !voltageTelemetryClose(duty, minimum))) throw new Error("无效遥测：PWM 占空比超出最小脉宽或上限");
    }
  } else if (r.pwm_duty_floor === 0) {
    throw new Error("无效遥测：零占空比缺少最小脉宽能力");
  }
  if (!modern) {
    if (r.max_voltage_limit !== undefined) telemetryNumber(r.max_voltage_limit, "max_voltage_limit", .05, 5);
    return;
  }
  for (const key of modernVoltageKeys) telemetryNumber(r[key], key, key === "configured_max_voltage_limit" ? .05 : 0, 30);
  telemetryNumber(r.max_voltage_limit, "max_voltage_limit", automatic ? 0 : .05, 30);
  telemetryNumber(config.bus_voltage, "config.bus_voltage", 4.5, 30);
  telemetryNumber(r.bus_voltage, "bus_voltage", 0, 30);
  if (typeof r.bus_voltage_valid !== "boolean" || typeof r.bus_voltage_sensing !== "boolean" ||
      typeof r.bus_voltage_source !== "string" || !r.bus_voltage_source.trim()) throw new Error("无效遥测：母线电压能力不完整");
  if ((r.bus_voltage_source === "configured") !== !r.bus_voltage_sensing) throw new Error("无效遥测：母线电压来源不一致");
  const bus = r.bus_voltage as number;
  if (r.bus_voltage_valid ? bus < 4.5 : bus !== 0) throw new Error("无效遥测：母线电压有效性不一致");
  if (r.bus_voltage_valid && !r.bus_voltage_sensing && !voltageTelemetryClose(bus, config.bus_voltage)) throw new Error("无效遥测：配置母线电压不一致");
  const span = (r.pwm_duty_ceiling as number) - (r.pwm_duty_floor as number);
  const configured = r.configured_max_voltage_limit as number, available = r.available_voltage_limit as number;
  const nominalMax = config.bus_voltage * span / Math.sqrt(3), liveMax = bus * span / Math.sqrt(3);
  if (automatic) {
    if (!voltageTelemetryClose(configured, nominalMax) || !voltageTelemetryClose(available, liveMax) ||
        !voltageTelemetryClose(r.max_voltage_limit as number, available) ||
        !voltageTelemetryClose(r.effective_voltage_limit as number, available)) throw new Error("无效遥测：自动电压能力与实时母线不一致");
  } else {
    if ((configured > nominalMax && !voltageTelemetryClose(configured, nominalMax)) ||
        (available > liveMax && !voltageTelemetryClose(available, liveMax)) ||
        !voltageTelemetryClose(r.max_voltage_limit as number, configured)) throw new Error("无效遥测：电压能力超过 PWM 范围或上限不一致");
    if (!voltageTelemetryClose(r.effective_voltage_limit as number, Math.min(config.voltage_limit as number, available))) throw new Error("无效遥测：实际电压上限不一致");
  }
  if (!r.bus_voltage_valid && (available !== 0 || r.effective_voltage_limit !== 0)) throw new Error("无效遥测：无效母线仍允许输出");
}
function validateOptionalKnobTelemetry(r: Record<string, unknown>): void {
  if (r.live_haptics_config !== undefined && typeof r.live_haptics_config !== "boolean") throw new Error("无效遥测：live_haptics_config");
  if (r.mode_count !== undefined) telemetryNumber(r.mode_count, "mode_count", 1, 256, true);
  if (r.modes !== undefined) {
    if (!Array.isArray(r.modes) || r.modes.length < 1 || r.modes.length > 256 || r.modes.some(mode => typeof mode !== "string" || !mode.trim())) throw new Error("无效遥测：modes");
    if (r.mode_count !== undefined && r.mode_count !== r.modes.length) throw new Error("无效遥测：mode_count/modes");
  }
  if (r.mode_name !== undefined && (typeof r.mode_name !== "string" || !r.mode_name.trim())) throw new Error("无效遥测：mode_name");
  if (r.reference_preset !== undefined) telemetryNumber(r.reference_preset, "reference_preset", -1, 255, true);
  if (r.frictionless !== undefined) {
    const hold = telemetryObject(r.frictionless, "frictionless");
    telemetryNumber(hold.phase, "frictionless.phase", 0, 255, true);
    for (const key of ["reference", "correction", "feedforward"]) telemetryNumber(hold[key], `frictionless.${key}`);
    if (hold.angle_compensation !== undefined && typeof hold.angle_compensation !== "boolean") throw new Error("无效遥测：frictionless.angle_compensation");
  }
  for (const field of ["calibration_quality", "calibration_report"]) {
    if (r[field] === undefined) continue;
    const calibration = telemetryObject(r[field], field);
    if (field === "calibration_quality" && typeof calibration.verified !== "boolean") throw new Error("无效遥测：calibration_quality.verified");
    if (field === "calibration_report" && (typeof calibration.stage !== "string" || !calibration.stage.trim() || typeof calibration.error !== "string" || !calibration.error.trim() || typeof calibration.passed !== "boolean")) throw new Error("无效遥测：calibration_report");
    for (const key of ["method", "stage", "error"]) {
      if (calibration[key] !== undefined && (typeof calibration[key] !== "string" || !calibration[key].trim())) throw new Error(`无效遥测：${field}.${key}`);
    }
    for (const key of ["verified", "passed", "cancelled", "phase_check_passed"]) {
      if (calibration[key] !== undefined && typeof calibration[key] !== "boolean") throw new Error(`无效遥测：${field}.${key}`);
    }
    for (const [key, item] of Object.entries(calibration)) {
      if (typeof item === "number") telemetryNumber(item, `${field}.${key}`);
    }
    if (calibration.elapsed_s !== undefined) telemetryNumber(calibration.elapsed_s, `${field}.elapsed_s`, 0);
    for (const key of ["offset_noise_a", "offset_sem_a", "offset_drift_a", "phase_a_response", "phase_b_response", "phase_c_response"]) {
      if (calibration[key] !== undefined) telemetryArray(calibration[key], `${field}.${key}`, 3);
    }
  }
  for (const key of ["pwm_duty_floor", "pwm_duty_ceiling"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, 0, 1);
  }
  if (typeof r.pwm_duty_floor === "number" && typeof r.pwm_duty_ceiling === "number" && r.pwm_duty_floor >= r.pwm_duty_ceiling) {
    throw new Error("无效遥测阈值：pwm_duty_floor/pwm_duty_ceiling");
  }
  for (const key of ["firmware", "current_sampling", "detent_profile", "pwm_profile", "bus_voltage_source", "encoder", "encoder_interface", "hardware_detail", "error"]) {
    if (r[key] !== undefined && (typeof r[key] !== "string" || !r[key].trim())) throw new Error(`无效遥测：${key}`);
  }
  for (const key of ["current_limited", "fault_current_valid", "weak_magnet_allowed", "encoder_dma", "quiet_output",
    "detent_quiet_velocity", "haptic_position_filter", "current_target_slew", "speed_limited", "haptic_paused",
    "pwm_zero_clamp", "voltage_limit_automatic", "bus_voltage_sensing", "bus_voltage_valid", "adc_sample_valid", "sampling_restart_required"]) {
    if (r[key] !== undefined && typeof r[key] !== "boolean") throw new Error(`无效遥测：${key}`);
  }
  for (const key of ["bus_voltage", "bus_voltage_measured", "bus_voltage_adc_mv", "current_phase_skew_us"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, 0);
  }
  if (r.bus_voltage_raw !== undefined) telemetryNumber(r.bus_voltage_raw, "bus_voltage_raw", 0, 4095, true);
  if (r.bus_voltage_divider !== undefined) telemetryNumber(r.bus_voltage_divider, "bus_voltage_divider", Number.MIN_VALUE);
  for (const key of ["current_trip_limit", "current_target_limit", "fault_current_trip_limit", "current_feedforward_ohms",
    "haptic_fade_start", "haptic_resume_speed", "detent_assist_fade_start", "elastic_min_damping",
    "control_hz", "control_interval_us", "control_max_us", "encoder_us", "control_us"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, 0);
  }
  for (const key of ["strength_max", "current_absolute_trip", "current_peak_trip", "current_peak_trip_ms", "current_overload_trip_ms",
    "haptic_speed_cutoff", "haptic_resume_hold_ms", "haptic_fade_in_ms", "detent_assist_cutoff"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, Number.MIN_VALUE);
  }
  for (const key of ["host_lease_ms", "reset_reason", "uptime_ms", "minimum_free_heap", "encoder_failures", "encoder_retries",
    "reused_samples", "missed_samples", "control_cycles", "encoder_age_us", "encoder_age_max_us", "bus_voltage_age_us",
    "timing_skips", "sampling_recoveries", "pwm_deferred", "pwm_full_duty_cycles"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, 0, Number.MAX_SAFE_INTEGER, true);
  }
  // Carrier-derived rates are fractional when the PWM timer cannot represent
  // the requested frequency exactly. Keep their precision from the device.
  for (const key of ["control_nominal_hz", "encoder_nominal_hz", "pwm_actual_hz"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, 1, Number.MAX_SAFE_INTEGER);
  }
  for (const key of ["pwm_hz", "control_carrier_divider", "encoder_carrier_divider", "current_trip_recovery_ratio"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, 1, Number.MAX_SAFE_INTEGER, true);
  }
  for (const key of ["id", "hardware_error", "encoder_error", "bus_voltage_error", "sample_start_tick", "sample_end_tick"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
  }
  for (const key of ["voltage_d", "voltage_q", "velocity_fast"]) {
    if (r[key] !== undefined) telemetryNumber(r[key], key);
  }
  if (r.current_limit_max !== undefined) telemetryNumber(r.current_limit_max, "current_limit_max", .02);
  if (r.encoder_resolution_bits !== undefined) telemetryNumber(r.encoder_resolution_bits, "encoder_resolution_bits", 1, 32, true);
  if (r.haptic_scale !== undefined) telemetryNumber(r.haptic_scale, "haptic_scale", 0, 1);
  if (r.pwm_peak_duty !== undefined) telemetryNumber(r.pwm_peak_duty, "pwm_peak_duty", 0, 1);
  if (r.fault_magnet !== undefined) telemetryNumber(r.fault_magnet, "fault_magnet", 0, r.encoder === "MT6701" ? 15 : 255, true);
  if (r.adc_dma_words !== undefined) telemetryArray(r.adc_dma_words, "adc_dma_words", 2, 0, 0xffffffff, true);
  if (r.fault_currents !== undefined || r.fault_current_valid === true) telemetryArray(r.fault_currents, "fault_currents", 3);
  // Check relationships only when both fields were actually advertised.
  for (const [lower, upper] of [["current_peak_trip", "current_absolute_trip"], ["haptic_fade_start", "haptic_speed_cutoff"],
    ["detent_assist_fade_start", "detent_assist_cutoff"]] as const) {
    if (typeof r[lower] === "number" && typeof r[upper] === "number" && r[lower] >= r[upper]) throw new Error(`无效遥测阈值：${lower}/${upper}`);
  }
  if (r.fault_motion !== undefined) {
    const motion = telemetryObject(r.fault_motion, "fault_motion");
    for (const key of ["angle", "velocity", "velocity_fast"]) telemetryNumber(motion[key], `fault_motion.${key}`);
  }
  if (r.fault_sample !== undefined) {
    const sample = telemetryObject(r.fault_sample, "fault_sample");
    if (typeof sample.valid !== "boolean") throw new Error("无效遥测：fault_sample.valid");
    for (const key of ["interval_us", "duration_us"]) telemetryNumber(sample[key], `fault_sample.${key}`, 0);
    // The task captures now before reading the latest ADC snapshot. A sample
    // published between those reads can have a negative age in a fault record.
    telemetryNumber(sample.age_us, "fault_sample.age_us");
    for (const key of ["start_tick", "end_tick"]) telemetryNumber(sample[key], `fault_sample.${key}`, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, true);
    if (sample.adc_dma_words !== undefined) telemetryArray(sample.adc_dma_words, "fault_sample.adc_dma_words", 2, 0, 0xffffffff, true);
    if (sample.adc_raw !== undefined) telemetryArray(sample.adc_raw, "fault_sample.adc_raw", 2, 0, 4095, true);
    if (sample.adc_phase !== undefined) telemetryArray(sample.adc_phase, "fault_sample.adc_phase", 2, 0, 2, true);
  }
  if (r.diagnostic !== undefined) {
    const diagnostic = telemetryObject(r.diagnostic, "diagnostic");
    for (const key of ["busy", "cancelled", "recovered"]) {
      if (typeof diagnostic[key] !== "boolean") throw new Error(`无效遥测：diagnostic.${key}`);
    }
    for (const key of ["stage", "count", "muted_samples"]) telemetryNumber(diagnostic[key], `diagnostic.${key}`, 0, Number.MAX_SAFE_INTEGER, true);
    for (const key of ["peak_speed", "peak_current"]) telemetryNumber(diagnostic[key], `diagnostic.${key}`, 0);
    if (diagnostic.offset !== undefined) telemetryNumber(diagnostic.offset, "diagnostic.offset", 0, Number.MAX_SAFE_INTEGER, true);
    if (diagnostic.samples !== undefined) {
      if (!Array.isArray(diagnostic.samples)) throw new Error("无效遥测：diagnostic.samples");
      for (const row of diagnostic.samples) {
        if (!Array.isArray(row) || ![12, 16, 17, 20].includes(row.length)) throw new Error("无效遥测：diagnostic.samples");
        for (const item of row) telemetryNumber(item, "diagnostic.samples");
      }
    }
  }
}
export function parseKnobTelemetry(value: unknown): KnobTelemetry {
  if (!value || typeof value !== "object") throw new Error("旋钮回复不是 JSON 对象");
  const r = value as Record<string, unknown>;
  // Firmware cannot provide a real snapshot if its control task is unavailable.
  if (r.ok === false && r.error === "control_unavailable") throw new Error("旋钮控制任务不可用，请复位设备后重试");
  if (r.transport !== undefined && !["usb_serial_jtag", "uart0"].includes(String(r.transport))) throw new Error("未知旋钮调参通道");
  validateOptionalKnobTelemetry(r);
  if (r.device !== "smartknob-s3" || r.protocol !== 1 || typeof r.ok !== "boolean" ||
      !["idle", "offsets", "align", "sweep", "settle", "active", "fault"].includes(String(r.state)) || typeof r.fault !== "string") throw new Error("旋钮协议版本或设备身份不匹配");
  if (typeof r.current_valid !== "boolean") throw new Error("缺少电流有效性标志");
  for (const key of ["angle", "velocity", "position", "sub_position", "iq", "id_current", "target", "magnet", "rejected_samples", "sample_us", "loop_us"]) {
    if (typeof r[key] !== "number" || !Number.isFinite(r[key])) throw new Error(`无效遥测：${key}`);
  }
  telemetryNumber(r.magnet, "magnet", 0, r.encoder === "MT6701" ? 15 : 255, true);
  for (const key of ["currents", "sense_volts", "offsets", "duty"]) {
    if (!Array.isArray(r[key]) || r[key].length !== 3 || r[key].some(v => typeof v !== "number" || !Number.isFinite(v))) throw new Error(`无效采样：${key}`);
  }
  if (!r.config || typeof r.config !== "object") throw new Error("缺少设备参数");
  for (const key of editableKnobKeys) {
    const config = r.config as Record<string, unknown>;
    if (typeof config[key] !== "number" || !Number.isFinite(config[key])) throw new Error(`无效参数：${key}`);
  }
  const cal = r.calibration as Record<string, unknown> | undefined;
  if (!cal || typeof cal.valid !== "boolean" || typeof cal.direction !== "number" || ![-1, 1].includes(cal.direction) || cal.pole_pairs !== 7 || typeof cal.electrical_zero !== "number" || !Number.isFinite(cal.electrical_zero)) throw new Error("无效校准状态");
  const result = value as KnobTelemetry;
  telemetryNumber(result.config.mode, "config.mode", 0, knobModeCount(result) - 1, true);
  if (result.config.frictionless !== undefined) {
    const frictionless = telemetryObject(result.config.frictionless, "config.frictionless");
    for (const key of Object.keys(frictionlessBounds) as (keyof KnobFrictionlessConfig)[]) {
      telemetryNumber(frictionless[key], `config.frictionless.${key}`, 0, Math.max(frictionlessBounds[key], Math.fround(frictionlessBounds[key])));
    }
  }
  if (result.reference_config_version !== undefined || result.config.reference_modes !== undefined || result.reference_defaults !== undefined) {
    telemetryNumber(result.reference_config_version, "reference_config_version", 1, 2, true);
    telemetryNumber(result.reference_current_limit, "reference_current_limit", Number.MIN_VALUE, result.reference_config_version === 2 ? maxKnobCurrent : Math.max(.45, Math.fround(.45)));
    const error = validateReferenceBank(result.config.reference_modes, result.reference_config_version);
    if (error) throw new Error(`无效遥测：config.reference_modes：${error}`);
    if (result.reference_defaults !== undefined) {
      const defaultsError = validateReferenceBank(result.reference_defaults, result.reference_config_version);
      if (defaultsError) throw new Error(`无效遥测：reference_defaults：${defaultsError}`);
    }
  } else if (result.reference_current_limit !== undefined) {
    telemetryNumber(result.reference_current_limit, "reference_current_limit", Number.MIN_VALUE, result.reference_config_version === 2 ? maxKnobCurrent : Math.max(.45, Math.fround(.45)));
  }
  validateVoltageTelemetry(r, result.config);
  const gain = [0.15, 0.3, 0.6, 1.2].find(v => Math.abs(v - result.config.sense_gain) < 1e-5);
  if (gain === undefined) throw new Error("无效采样增益");
  // Firmware stores float32. Normalize display/validation artifacts such as
  // 0.8000000119 A and 180.000005 degrees without changing user-entered limits.
  const config = { ...knobEditableConfig(result.config), sense_gain: gain };
  for (const key of editableKnobKeys) {
    if (key !== "width") config[key] = Number(config[key].toFixed(6));
  }
  if (result.config.voltage_limit !== undefined) config.voltage_limit = Number(result.config.voltage_limit.toFixed(6));
  for (const boundary of [Math.PI / 180, Math.PI]) {
    if (Math.abs(config.width - boundary) < 1e-6) config.width = boundary;
  }
  const voltageMax = knobVoltageLimitMax(config.bus_voltage, { ...result, config });
  if (config.voltage_limit !== undefined && Math.abs(config.voltage_limit - voltageMax) < 1e-6) config.voltage_limit = voltageMax;
  const parsed = { ...structuredClone(result), config };
  wireConfigs.set(parsed, structuredClone(result.config));
  return parsed;
}
export function knobConfigurePayload(config: KnobConfig, sample: KnobTelemetry): KnobConfig {
  // Validate the editor's numbers, then update the original device object.
  // Preserve unknown device fields and untouched float32 values while ignoring
  // arbitrary fields from an old PC cache. A retired voltage control is never sent.
  const candidate = knobEditableConfig(config);
  if (sample.voltage_limit_automatic !== true) {
    if (sample.config.voltage_limit === undefined) throw new Error("设备缺少已确认的电压能力，请重新读取状态");
    candidate.voltage_limit = sample.config.voltage_limit;
  }
  const error = validateKnobConfig(candidate, knobCurrentLimitMax(sample), knobStrengthMax(sample),
    knobVoltageLimitMax(candidate.bus_voltage, sample), knobModeCount(sample), sample.reference_config_version);
  if (error) throw new Error(error);
  const original = wireConfigs.get(sample) ?? sample.config;
  const payload = knobEditableConfig(original);
  for (const key of editableKnobKeys) {
    if (candidate[key] !== sample.config[key]) payload[key] = candidate[key];
  }
  delete payload.frictionless;
  if (candidate.frictionless !== undefined && (Object.keys(frictionlessBounds) as (keyof KnobFrictionlessConfig)[])
    .some(key => candidate.frictionless![key] !== sample.config.frictionless?.[key])) {
    const frictionless = structuredClone(original.frictionless ?? candidate.frictionless);
    for (const key of Object.keys(frictionlessBounds) as (keyof KnobFrictionlessConfig)[]) {
      if (candidate.frictionless[key] !== sample.config.frictionless?.[key]) frictionless[key] = candidate.frictionless[key];
    }
    payload.frictionless = frictionless;
  }
  // Each reference preset is stored independently by the device. A patch sends
  // only changed entries, so selecting another mode does not overwrite its bank
  // and a single edit stays within the firmware's 2047-byte input frame.
  delete payload.reference_modes;
  if (candidate.reference_modes !== undefined) {
    if (![1, 2].includes(sample.reference_config_version ?? 0) || !sample.config.reference_modes || !original.reference_modes) throw new Error("当前固件尚未开放参考预设参数，请更新固件后重连");
    const changes: KnobReferenceModes = {};
    for (const mode of referenceModeIds) {
      const edited = candidate.reference_modes[mode]!, previous = sample.config.reference_modes[mode]!;
      if (!referenceEntryChanged(edited, previous)) continue;
      const entry = structuredClone(original.reference_modes[mode]!);
      for (const key of referenceNumericKeys) if (edited[key] !== previous[key]) entry[key] = edited[key];
      if (sample.reference_config_version === 2) {
        if (edited.endstop_damping !== previous.endstop_damping) entry.endstop_damping = edited.endstop_damping;
        if (edited.click_enabled !== previous.click_enabled) entry.click_enabled = edited.click_enabled;
      }
      if (edited.bounded !== previous.bounded) entry.bounded = edited.bounded;
      if (edited.magnetic_positions.length !== previous.magnetic_positions.length || edited.magnetic_positions.some((value, index) => value !== previous.magnetic_positions[index])) entry.magnetic_positions = [...edited.magnetic_positions];
      changes[mode] = entry;
    }
    if (Object.keys(changes).length > 0) {
      if (sample.state !== "idle" && !(sample.state === "active" && sample.live_haptics_config === true)) throw new Error("此固件请先停机，再修改参考参数；升级固件可在线调参");
      payload.reference_modes = changes;
    }
  }
  if (sample.voltage_limit_automatic !== true) payload.voltage_limit = original.voltage_limit;
  return payload;
}
function validateKnobRequestSize(request: { op: KnobOp; config?: KnobConfig; reference_defaults?: boolean }): void {
  // Match Rust's 1900-byte request budget, leaving room for its request ID in
  // the firmware's 2047-byte frame. Unknown text fields count as UTF-8 bytes.
  if (new TextEncoder().encode(JSON.stringify(request)).byteLength > 1900) throw new Error("参数请求超过 USB 单帧容量，请分批应用参考模式参数");
}
export function knobConfigureRequestError(config: KnobConfig, sample: KnobTelemetry): string | null {
  try { validateKnobRequestSize({ op: "configure", config: knobConfigurePayload(config, sample) }); return null; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
export function sortKnobPorts(ports: SerialPortOption[]): SerialPortOption[] {
  const rank = (p: SerialPortOption) => p.vid === 0x303a && p.pid === 0x1001 ? 0 : p.portType === "usb" ? 1 : 2;
  return [...ports].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
export function knobPortLabel(port: SerialPortOption): string {
  return port.vid === 0x303a && port.pid === 0x1001 ? "ESP32 原生 USB" : port.product ?? port.manufacturer ?? port.portType;
}
interface Session { connected: boolean; sessionId: number | null; portName: string | null }
export interface KnobCalibrationOptions { current: number; max_current: number; voltage: number }
export class KnobGateway {
  private sessionId: number | null = null;
  private lastTelemetry: KnobTelemetry | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  private generation = 0;
  async initialize(): Promise<void> { if (isTauriRuntime()) await this.disconnect(); }
  isConnected(): boolean { return this.sessionId !== null; }
  ports(): Promise<SerialPortOption[]> { return isTauriRuntime() ? invoke<SerialPortOption[]>("list_serial_ports").then(sortKnobPorts) : Promise.resolve([]); }
  async connect(portName: string): Promise<void> {
    if (!isTauriRuntime()) throw new Error("USB 调参请使用桌面应用，当前为界面预览");
    const generation = ++this.generation;
    this.sessionId = null; this.lastTelemetry = null;
    const s = await invoke<Session>("knob_connect", { portName });
    if (!s.connected || s.sessionId === null) throw new Error("未建立旋钮会话");
    if (generation !== this.generation) {
      await invoke("knob_disconnect", { expectedSessionId: s.sessionId }).catch(() => undefined);
      throw new Error("旋钮会话已改变");
    }
    this.sessionId = s.sessionId;
  }
  async disconnect(): Promise<void> {
    ++this.generation;
    const id = this.sessionId; this.sessionId = null; this.lastTelemetry = null;
    // Never issue an unscoped detach from a stale/unmounted view. A connect
    // still in flight notices generation changed and closes its returned ID.
    if (isTauriRuntime() && id !== null) await invoke("knob_disconnect", { expectedSessionId: id });
  }
  request(op: KnobOp, config?: KnobConfig): Promise<KnobTelemetry> {
    return this.exchange(op, config);
  }
  calibrate(options: KnobCalibrationOptions): Promise<KnobTelemetry> {
    if (![options.current, options.max_current, options.voltage].every(Number.isFinite) ||
        options.current < .02 || options.current > options.max_current || options.max_current > .25 ||
        options.voltage < .05 || options.voltage > 3) return Promise.reject(new Error("自动校准参数超出范围"));
    return this.exchange("calibrate", undefined, false, { ...options });
  }
  async referenceDefaults(): Promise<KnobReferenceModes> {
    const sample = await this.exchange("status", undefined, true);
    if (!sample.ok) throw new Error(knobMessages[sample.error ?? ""] ?? sample.error ?? "读取参考默认参数失败");
    if (!sample.reference_defaults) throw new Error("设备没有提供参考默认参数");
    return structuredClone(sample.reference_defaults);
  }
  private exchange(op: KnobOp, config?: KnobConfig, referenceDefaults = false, calibration?: KnobCalibrationOptions): Promise<KnobTelemetry> {
    const id = this.sessionId;
    const requestedConfig = config ? structuredClone(config) : undefined;
    const run = async (): Promise<KnobTelemetry> => {
      if (id === null || this.sessionId !== id) throw new Error("旋钮尚未连接或会话已改变");
      let request: { op: KnobOp; config?: KnobConfig; reference_defaults?: boolean } = { op };
      if (op === "configure") {
        if (!requestedConfig) throw new Error("缺少旋钮参数");
        if (!this.lastTelemetry) throw new Error("请先读取设备状态，再修改旋钮参数");
        request = { op, config: knobConfigurePayload(requestedConfig, this.lastTelemetry) };
      } else if (requestedConfig) throw new Error("该操作不接受旋钮参数");
      if (calibration) request = { ...request, ...calibration };
      if (referenceDefaults) {
        if (![1, 2].includes(this.lastTelemetry?.reference_config_version ?? 0)) throw new Error("当前固件尚未开放参考预设参数，请更新固件后重连");
        request.reference_defaults = true;
      }
      validateKnobRequestSize(request);
      let response: unknown;
      try { response = await invoke("knob_request", { expectedSessionId: id, request }); }
      catch (error) {
        if (this.sessionId === id) { this.sessionId = null; this.lastTelemetry = null; }
        await invoke("knob_disconnect", { expectedSessionId: id }).catch(() => undefined);
        throw error;
      }
      if (this.sessionId !== id) throw new Error("旋钮会话已改变");
      try {
        const sample = parseKnobTelemetry(response);
        this.lastTelemetry = structuredClone(sample);
        wireConfigs.set(this.lastTelemetry, structuredClone(wireConfigs.get(sample) ?? sample.config));
        return sample;
      }
      catch (error) {
        if (this.sessionId === id) { this.sessionId = null; this.lastTelemetry = null; }
        await invoke("knob_disconnect", { expectedSessionId: id }).catch(() => undefined);
        throw error;
      }
    };
    const result = this.tail.then(run, run); this.tail = result; return result;
  }
}
export const knobGateway = new KnobGateway();
export const knobMessages: Record<string, string> = {
  idle_or_active_required: "当前正在校准或处于故障状态，暂时不能修改参数",
  none: "正常", hardware_init_failed: "硬件初始化失败，查看底层诊断后清除故障", encoder_magnet_or_i2c: "编码器通讯异常或磁铁强度不合适",
  encoder_i2c: "编码器 I²C 通讯失败，请查看错误码", encoder_missing_magnet: "编码器未检测到磁铁", encoder_magnet_strength: "编码器磁场强度超出允许范围",
  encoder_transport: "编码器接口通讯失败，请检查接线和错误码", encoder_crc: "编码器 SSI 数据 CRC 校验失败", encoder_loss_of_track: "编码器失去角度跟踪，请检查磁铁位置",
  encoder_not_ready: "编码器数据尚未就绪，请稍后重试", encoder_stale: "编码器角度数据过期，电机已停机",
  overcurrent: "异常过流超过保护阈值", overcurrent_isr: "采样中断检测到异常过流", control_watchdog: "控制任务超时",
  host_timeout: "上位机心跳超时，电机已停机", adc_window_or_control_deadline: "采样窗口或控制周期超时", adc_window_invalid: "电流采样窗口无效，禁止使能",
  invalid_current_offsets_check_mode_gain: "电流零点无效，请检查驱动器 MODE 和 SOA/B/C 连线", keep_rotor_still_for_offsets: "零点采样时旋钮发生转动，请静置重试",
  calibration_current_tracking: "校准电流未跟随目标，请检查采样相序、增益和电流 PI", calibration_motion_mismatch_7pp: "校准运动与 7 极对数不符，请检查相序和磁铁", alignment_unstable: "对齐未稳定", calibrate_first: "请先完成电机校准",
  disable_before_save: "停机后才能保存", disable_before_electrical_config: "请先停机，再修改电气参数", idle_required: "请先停止当前动作",
  clear_fault_first: "请先清除故障", overspeed: "转速超过手动旋钮范围", encoder_jump: "编码器角度跳变", adc_saturation: "电流 ADC 饱和",
  calibration_motion_too_fast: "校准时转速过高，请静置旋钮后重试", hardware_unavailable: "电机硬件尚未就绪", control_unavailable: "旋钮控制任务不可用，请复位设备",
  current_limit_range: "电流上限超出当前固件允许范围", voltage_limit_range: "电压超出低侧采样窗口允许范围", haptic_range: "手感参数超出当前固件允许范围",
  voltage_limit_automatic: "电压上限由实时母线自动确定，无需设置", adc_transport_failure: "电流采样传输持续失步，电机已停机",
  bus_voltage_invalid: "母线电压测量无效，电机已停机", bus_voltage_stale: "母线电压数据过期，电机已停机",
  bus_voltage_not_ready: "母线电压采样尚未就绪，请稍后重试", hardware_restart_failed: "采样硬件恢复失败，请查看硬件诊断",
  sense_gain_invalid: "采样增益不受驱动器支持", pi_range: "电流 PI 参数超出范围", detent_range: "档距或切换点超出范围",
  bus_voltage_range: "母线电压须为 4.5–30 V", position_range: "行程端点超出范围", mode_invalid: "无效的旋钮模式", non_finite: "参数必须是有限数值",
  enable_first: "请先启用旋钮", disable_first: "请先停机", busy: "设备正在执行其他动作", pwm_failure: "PWM 输出失败，电机已停机", save_failed: "保存设备参数失败",
  disable_before_reference_config: "请先停机，再修改参考模式参数",
  invalid_reference_mode: "参考模式编号无效", invalid_reference_positions: "参考模式初始档位或行程范围无效",
  invalid_reference_width: "参考模式档距须为 1–180°", invalid_reference_endstop: "参考模式端点增益须为 0–20",
  invalid_reference_snap: "参考模式切换点或中心偏置无效", invalid_reference_strength: "参考模式档位增益超出当前固件允许范围",
  invalid_reference_damping: "参考模式速度阻尼超出当前固件允许范围", invalid_reference_scale: "参考模式输出倍率须为 0–1",
  invalid_reference_friction: "参考模式摩擦补偿须为 0–0.45 A", invalid_reference_click: "参考模式点击电流须为 0–0.45 A",
  invalid_reference_magnets: "磁吸档位须为有效行程内不重复的整数，最多 8 个",
  invalid_reference_endstop_damping: "端点阻尼须为 0–0.5 A·s/rad", reference_click_enabled_required: "请明确设置切档点击开关",
  reference_modes_required: "缺少参考模式参数对象", reference_config_required: "缺少完整的参考模式参数",
  reference_duplicate_field: "参考模式参数包含重复字段", reference_field_missing: "参考模式参数字段不完整",
  reference_field_range: "参考模式参数值超出允许范围", reference_bounded_required: "参考模式需要明确指定行程类型",
};
