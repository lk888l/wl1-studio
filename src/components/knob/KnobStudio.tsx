import { ArrowLeft, Cable, CircleStop, RotateCcw, Save, SlidersHorizontal, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { LiquidGlass } from "../LiquidGlass";
import { isTauriRuntime } from "../../lib/device";
import { knobGateway, knobMessages, knobPortLabel, knobCurrentLimitMax, knobStrengthMax, knobDetentPeak, knobMagnetStatus, knobModeCount, knobModeOptions, knobModeName, knobReferenceChanged, maxKnobCurrent, maxKnobStrength, validateKnobConfig, type KnobConfig, type KnobFrictionlessConfig, type KnobReferenceModeConfig, type KnobOp, type KnobTelemetry } from "../../lib/knob";
import { KnobWorkflow, selectKnobPort } from "../../lib/knob-workflow";
export { createKnobEditor, knobEditorConflict, knobEditorDirty, reconcileKnobEditor, sameKnobConfig } from "../../lib/knob-workflow";
import { KnobNumberInput } from "./KnobNumberInput";
import type { SerialPortOption } from "../../types";
import "./KnobStudio.css";

const states: Record<string, string> = { idle: "已停机", offsets: "采样零点", align: "电角度对齐", sweep: "测量方向", settle: "校准收敛", active: "力反馈运行中", fault: "故障停机" };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const label = (s: string) => knobMessages[s] ?? s;
type FieldKey = Exclude<keyof KnobConfig, "voltage_limit" | "frictionless" | "reference_modes">;
const fields: { key: FieldKey; label: string; unit: string; min: number; max?: number; step: number; electrical?: boolean }[] = [
  { key: "width", label: "档位间距", unit: "°", min: 1, max: 180, step: 1 },
  { key: "strength", label: "档位 / 回中强度", unit: "A/rad", min: 0, max: maxKnobStrength, step: 0.1 },
  { key: "endstop", label: "端点强度", unit: "A/rad", min: 0, max: 20, step: 0.1 },
  { key: "damping", label: "旋转阻尼", unit: "A·s/rad", min: 0, max: 0.5, step: 0.001 },
  { key: "snap", label: "档位切换点", unit: "× 档距", min: 0.5, max: 1, step: 0.01 },
  { key: "current_limit", label: "运行电流上限", unit: "A", min: 0.02, max: maxKnobCurrent, step: 0.01 },
  { key: "min_position", label: "起始档位", unit: "", min: -10000, max: 10000, step: 1 },
  { key: "max_position", label: "结束档位", unit: "", min: -10000, max: 10000, step: 1 },
  { key: "bus_voltage", label: "名义母线配置", unit: "V", min: 4.5, max: 30, step: 0.01, electrical: true },
  { key: "current_kp", label: "电流环 Kp", unit: "V/A", min: 0, max: 20, step: 0.1, electrical: true },
  { key: "current_ki", label: "电流环 Ki", unit: "V/(A·s)", min: 0, max: 1000, step: 1, electrical: true },
];
const presets = [
  { name: "清晰 36 档", mode: 1, width: Math.PI / 18, strength: 20, damping: 0.003, snap: 0.55 },
  { name: "清晰 12 档", mode: 1, width: Math.PI / 6, strength: 5, damping: 0.003, snap: 0.55 },
  { name: "轻盈 24 档", mode: 1, width: Math.PI / 12, strength: 0.8, damping: 0.003, snap: 0.55 },
  { name: "细腻 48 档", mode: 1, width: Math.PI / 24, strength: 1.5, damping: 0.003, snap: 0.55 },
  { name: "音量旋钮", mode: 2, width: Math.PI / 18, strength: 10, damping: 0.003, snap: 0.55 },
  { name: "弹簧回中", mode: 3, width: Math.PI / 12, strength: 0.3, damping: 0.04, snap: 0.55 },
];
function Dial({ angle, position, name, width, connected, snapshot }: { angle: number; position: number; name: string; width?: number; connected: boolean; snapshot: boolean }) {
  // Only the applied mode's reported geometry describes the live dial.
  const ticks = width !== undefined && Number.isFinite(width) && width > 0 ? Math.min(120, Math.max(2, Math.round(2 * Math.PI / width))) : 0;
  return <div className="knob-dial">
    <svg viewBox="0 0 360 360" role="img" aria-label={`旋钮角度 ${(angle * 180 / Math.PI).toFixed(1)} 度，档位 ${position}`}>
      <defs><radialGradient id="knob-surface"><stop stopColor="#425767" /><stop offset="1" stopColor="#192833" /></radialGradient></defs>
      <circle cx="180" cy="180" r="160" fill="none" stroke="currentColor" strokeOpacity=".1" />
      {Array.from({ length: ticks }, (_, i) => <line key={i} x1="180" y1="20" x2="180" y2={i % 3 === 0 ? 33 : 28} transform={`rotate(${i * 360 / ticks} 180 180)`} stroke="currentColor" strokeOpacity=".4" strokeWidth="2" />)}
      <circle cx="180" cy="180" r="137" fill="url(#knob-surface)" stroke="#6b8494" strokeWidth="2" />
      <circle cx="180" cy="180" r="126" fill="none" stroke="#526977" strokeOpacity=".4" />
      <g transform={`rotate(${angle * 180 / Math.PI} 180 180)`}><path d="M180 58v21" stroke="#9ce8d4" strokeWidth="7" strokeLinecap="round" /></g>
      <text x="180" y="154" textAnchor="middle" className="knob-dial__label">{name.length > 27 ? `${name.slice(0, 26)}…` : name}</text>
      <text x="180" y="205" textAnchor="middle" className="knob-dial__number">{position.toString().padStart(2, "0")}</text>
      <text x="180" y="237" textAnchor="middle" className="knob-dial__label">{connected ? "实时反馈" : snapshot ? "上次快照" : "界面预览"}</text>
    </svg>
  </div>;
}
export function KnobVoltageReadout({ status }: { status: KnobTelemetry | null }) {
  const sensing = status?.bus_voltage_sensing === true;
  const automatic = status?.voltage_limit_automatic === true;
  const bus = sensing ? status?.bus_voltage_valid ? status.bus_voltage : undefined : status?.config.bus_voltage;
  const magnitude = status?.voltage_d !== undefined && status.voltage_q !== undefined
    ? Math.hypot(status.voltage_d, status.voltage_q) : undefined;
  const available = status?.effective_voltage_limit ?? status?.available_voltage_limit;
  const legacyLimit = !automatic ? status?.config.voltage_limit : undefined;
  return <div className="knob-power-values">
    <div><small>{sensing ? "实测母线" : "母线配置"}</small><strong>{bus?.toFixed(2) ?? "—"}<em>V</em></strong><span>{sensing && status ? `名义参考 ${status.config.bus_voltage.toFixed(2)} V` : status ? "固件未提供实时测量" : "连接后读取"}</span></div>
    <div><small>电压指令幅值</small><strong>{magnitude?.toFixed(3) ?? "—"}<em>V</em></strong><span>由 d / q 电压指令计算</span></div>
    <div><small>{automatic || !status ? "自动可用电压" : "当前有效限压"}</small><strong>{available?.toFixed(3) ?? "—"}<em>V</em></strong><span>{automatic ? "随母线自动取最大值" : legacyLimit !== undefined ? `旧固件已存上限 ${legacyLimit.toFixed(3)} V · 只读` : status ? "固件未提供自动限压信息" : "连接后按固件能力显示"}</span></div>
  </div>;
}
export function KnobPwmDiagnostics({ status }: { status: KnobTelemetry }) {
  return <>
    {(status.pwm_actual_hz !== undefined || status.pwm_hz !== undefined) && <div><dt>{status.pwm_actual_hz !== undefined ? "PWM 载波频率（定时器）" : "PWM 频率"}</dt><dd>{status.pwm_actual_hz !== undefined ? `${status.pwm_actual_hz.toFixed(2)} Hz` : `${((status.pwm_hz as number) / 1000).toFixed(1)} kHz`}{status.pwm_profile ? ` · ${status.pwm_profile}` : ""}</dd></div>}
    {status.pwm_duty_floor !== undefined && status.pwm_duty_ceiling !== undefined && <div><dt>PWM 允许占空比</dt><dd>{(status.pwm_duty_floor * 100).toFixed(1)}–{(status.pwm_duty_ceiling * 100).toFixed(1)}%</dd></div>}
    {status.voltage_limit_automatic && status.pwm_duty_floor !== undefined && status.pwm_duty_ceiling !== undefined && <div><dt>SVPWM 电压利用率上限</dt><dd>{((status.pwm_duty_ceiling - status.pwm_duty_floor) * 100).toFixed(2)}% · 相对 Vbus / √3</dd></div>}
    {status.pwm_zero_clamp !== undefined && <div><dt>PWM 零相钳位</dt><dd>{status.pwm_zero_clamp ? "开启" : "关闭"}{status.pwm_min_active_duty !== undefined && status.pwm_min_active_duty > 0 ? ` · 非零 duty 至少 ${(status.pwm_min_active_duty * 100).toFixed(1)}%` : ""}</dd></div>}
    {status.pwm_peak_duty !== undefined && <div><dt>已记录峰值占空比</dt><dd>{(status.pwm_peak_duty * 100).toFixed(2)}%</dd></div>}
    {status.pwm_full_duty_cycles !== undefined && <div><dt>100% 占空比累计周期</dt><dd>{status.pwm_full_duty_cycles}</dd></div>}
    {status.adc_sample_valid !== undefined && <div><dt>电流 ADC 采样</dt><dd>{status.sampling_restart_required ? "需要重新初始化" : status.adc_sample_valid ? "最近突发有效" : status.state === "active" ? "本次跳过，等待有效采样" : "等待有效采样"}</dd></div>}
    {status.timing_skips !== undefined && <div><dt>采样 / 调度跳过次数</dt><dd>{status.timing_skips}</dd></div>}
    {status.sampling_recoveries !== undefined && <div><dt>采样自动恢复次数</dt><dd>{status.sampling_recoveries}</dd></div>}
    {status.pwm_deferred !== undefined && <div><dt>PWM 延后更新次数</dt><dd>{status.pwm_deferred}</dd></div>}
  </>;
}
export function KnobTimingDiagnostics({ status }: { status: KnobTelemetry }) {
  return <>
    {status.control_hz !== undefined && <div><dt>电流控制实测频率</dt><dd>{status.control_hz.toFixed(2)} Hz</dd></div>}
    {status.control_nominal_hz !== undefined && <div><dt>电流控制标称频率</dt><dd>{status.control_nominal_hz.toFixed(2)} Hz{status.control_carrier_divider !== undefined ? ` · 每 ${status.control_carrier_divider} 个 PWM 周期` : ""}</dd></div>}
    {status.encoder_nominal_hz !== undefined && <div><dt>编码器标称频率</dt><dd>{status.encoder_nominal_hz.toFixed(2)} Hz{status.encoder_carrier_divider !== undefined ? ` · 每 ${status.encoder_carrier_divider} 个 PWM 周期` : ""}</dd></div>}
    {status.current_phase_skew_us !== undefined && <div><dt>两相电流采样间隔</dt><dd>{status.current_phase_skew_us} μs</dd></div>}
  </>;
}
export function replaceKnobReferenceDraft(config: KnobConfig, mode: number, value: KnobReferenceModeConfig): KnobConfig {
  const current = config.reference_modes?.[String(mode)];
  if (!current || mode < 4 || mode > 15) return config;
  const keys: (keyof KnobReferenceModeConfig)[] = ["bounded", "magnetic_positions", "endstop_damping", "click_enabled", ...referenceFields.map(field => field.key)];
  const editable = Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, structuredClone(value[key])]));
  return { ...config, reference_modes: { ...config.reference_modes, [String(mode)]: { ...current, ...editable } } };
}
export function knobReferenceApplyBlocked(draft: KnobConfig, base: KnobConfig, state: KnobTelemetry["state"], live = false): boolean {
  return knobReferenceChanged(draft, base) && state !== "idle" && !(state === "active" && live);
}

type ReferenceNumberKey = Exclude<keyof KnobReferenceModeConfig, "bounded" | "magnetic_positions" | "click_enabled">;
const referenceFields: { key: ReferenceNumberKey; label: string; unit: string; min: number; max: number; step: number; boundedOnly?: boolean; ordinaryOnly?: boolean }[] = [
  { key: "width", label: "参考档位间距", unit: "°", min: 1, max: 180, step: 1 },
  { key: "position", label: "初始逻辑档位", unit: "", min: -10000, max: 10000, step: 1 },
  { key: "min_position", label: "最小逻辑档位", unit: "", min: -10000, max: 10000, step: 1, boundedOnly: true },
  { key: "max_position", label: "最大逻辑档位", unit: "", min: -10000, max: 10000, step: 1, boundedOnly: true },
  { key: "strength", label: "档位增益", unit: "", min: 0, max: 100, step: .1 },
  { key: "damping", label: "速度阻尼增益", unit: "", min: 0, max: 5, step: .01 },
  { key: "endstop", label: "端点增益", unit: "", min: 0, max: 20, step: .1, boundedOnly: true },
  { key: "scale", label: "输出倍率", unit: "×", min: 0, max: 1, step: .01 },
  { key: "snap", label: "切档阈值", unit: "× 档距", min: .5, max: 2, step: .01 },
  { key: "bias", label: "中心偏置", unit: "× 档距", min: 0, max: 1.5, step: .01 },
  { key: "friction", label: "摩擦补偿电流", unit: "A", min: 0, max: .45, step: .001 },
  { key: "click", label: "点击脉冲电流", unit: "A", min: 0, max: .45, step: .01, ordinaryOnly: true },
];
const referenceV2Fields: typeof referenceFields = referenceFields.map(field => {
  if (field.key === "strength") return { ...field, label: "档位力度", unit: "A/rad", max: 1000 };
  if (field.key === "damping") return { ...field, label: "旋转阻尼", unit: "A·s/rad", max: .5, step: .001 };
  if (field.key === "endstop") return { ...field, label: "端点力度", unit: "A/rad" };
  if (field.key === "click") return { ...field, ordinaryOnly: false };
  return field;
}).concat([{ key: "endstop_damping", label: "端点阻尼", unit: "A·s/rad", min: 0, max: .5, step: .001, boundedOnly: true }]);
export function parseKnobMagneticPositions(value: string): number[] {
  if (!value.trim()) return [];
  // Preserve invalid tokens as an invalid draft, so they cannot silently become
  // an applied partial list. A trailing separator is allowed during typing.
  return value.trim().replace(/[,，;；\s]+$/, "").split(/[,，;；\s]+/).map(token => /^-?\d+$/.test(token) ? Number(token) : Number.NaN);
}
export function KnobReferenceEditor({ mode, config, disabled, canRestore, currentLimit, version = 1, live = false, onChange, onRestore, onCommit }: {
  mode: number; config?: KnobReferenceModeConfig; disabled: boolean; canRestore: boolean; currentLimit?: number; version?: number; live?: boolean;
  onChange: (value: KnobReferenceModeConfig) => void; onRestore: () => void; onCommit?: (delay?: number) => void;
}) {
  const [magneticText, setMagneticText] = useState(() => config?.magnetic_positions.join(", ") ?? "");
  const magneticFocused = useRef(false);
  useEffect(() => {
    if (!magneticFocused.current) setMagneticText(config?.magnetic_positions.join(", ") ?? "");
  }, [config?.magnetic_positions]);
  if (!config) return <p className="knob-caption knob-reference-note">当前固件未提供此模式的可调参数。升级支持参考模式参数的固件后，可分别调整档距、力度和行程；现在仍可选择预设与运行电流上限。</p>;
  const update = (key: ReferenceNumberKey, value: number) => onChange({ ...config, [key]: value });
  return <section className="knob-reference-editor" aria-label="参考模式参数">
    <div className="knob-reference-heading"><h3>模式 {mode} 参数 · {live ? "确认后自动生效" : "本地输入"}</h3><button type="button" className="secondary-button" disabled={disabled || !canRestore} onClick={onRestore}>恢复当前模式默认参数</button></div>
    <p className="knob-caption">每个模式独立保留参数。{live ? "确认输入后直接生效，恢复默认也会立即应用；断电保留请停机后保存。" : "停机后应用，再明确保存到设备；恢复默认只修改当前草稿。"}{mode === 4 && "Custom 也可按这些参数定义自己的手感。"}</p>
    <label className="knob-reference-bounded"><input type="checkbox" aria-label="启用行程边界" checked={config.bounded} disabled={disabled} onChange={event => { onChange({ ...config, bounded: event.target.checked }); onCommit?.(); }} />启用行程边界<span>{config.bounded ? "限制在最小与最大逻辑档位之间" : "允许连续旋转"}</span></label>
    {version === 2 && <label className="knob-reference-bounded"><input type="checkbox" aria-label="启用切档点击" checked={config.click_enabled === true} disabled={disabled} onChange={event => { onChange({ ...config, click_enabled: event.target.checked }); onCommit?.(); }} />启用切档点击<span>可选的短促反馈，关闭后保留点击电流设置</span></label>}
    <div className="knob-fields">{(version === 2 ? referenceV2Fields : referenceFields).filter(field => (!field.boundedOnly || config.bounded) && (!field.ordinaryOnly || mode !== 14)).map(field => <label key={field.key} htmlFor={`knob-reference-${mode}-${field.key}`}>{field.label}<div><KnobNumberInput id={`knob-reference-${mode}-${field.key}`}  aria-label={field.label} min={field.min} max={field.max} step={field.step} disabled={disabled || (version === 2 && field.key === "click" && !config.click_enabled)} value={Number.isFinite(config[field.key]) ? Number(((config[field.key] ?? Number.NaN) * (field.key === "width" ? 180 / Math.PI : 1)).toPrecision(7)) : Number.NaN} onChange={value => update(field.key, value * (field.key === "width" ? Math.PI / 180 : 1))} onCommit={onCommit} /><span>{field.unit}</span></div></label>)}</div>
    {mode === 14 && <label className="knob-magnetic-list">磁吸逻辑档位<input aria-label="磁吸逻辑档位" type="text" value={magneticText} placeholder="例如 2, 10, 21, 22" disabled={disabled} onFocus={() => { magneticFocused.current = true; }} onBlur={() => { magneticFocused.current = false; onCommit?.(); }} onKeyDown={event => { if (event.key === "Enter") onCommit?.(); }} onChange={event => { setMagneticText(event.target.value); onChange({ ...config, magnetic_positions: parseKnobMagneticPositions(event.target.value) }); }} /><span className="knob-caption">用逗号或空格分隔，最多 8 个不重复整数；留空表示不设置磁吸档位。启用边界时须位于行程内。</span></label>}
    <p className="knob-caption">{version === 2 ? "档位采用与原档位一致的弹力和阻尼计算，每个模式独立调节。端点力度与端点阻尼仅作用于行程边界；输出倍率同时缩放弹力和阻尼，默认 1。点击可单独开启，磁吸模式只在进入吸附档位时点击。最终输出受运行电流上限和设备保护约束。" : `旧版参考算法：档位、速度阻尼与端点增益由输出倍率缩放；摩擦补偿与点击脉冲直接使用安培。${currentLimit !== undefined ? `参考模式最终目标电流还受 ${currentLimit.toFixed(2)} A 上限和运行电流上限约束。` : ""}`}初始逻辑档位用于模式启动、切换与位置归零。</p>
  </section>;
}
export function KnobOwnershipNote({ status }: { status: KnobTelemetry | null }) {
  return <p className="knob-caption knob-ownership">{status?.host_lease_ms === 0
    ? "ESP32 独立运行触觉、电流环与保护。断开连接、返回产品库或退出软件只释放串口，设备继续保持当前运行状态；停止请点击「停止力反馈」。重新上电仍为停机。"
    : status?.host_lease_ms !== undefined
      ? `触觉控制在 ESP32 中运行。此设备启用了 ${status.host_lease_ms} ms 通讯租约，断开后由固件按租约停机；连接只读取状态，启动和停止需明确操作。`
      : "触觉控制在 ESP32 中运行，上位机负责配置和监测。连接只读取状态；断开后的运行策略以设备报告为准。"}</p>;
}
export function KnobModePicker({ status, mode, disabled, onChange }: { status: KnobTelemetry | null; mode: number; disabled: boolean; onChange: (mode: number) => void }) {
  return <label className="knob-mode-picker">运行模式 · 选择即切换<select aria-label="运行模式" value={mode} disabled={disabled} onChange={event => onChange(Number(event.target.value))}>
    {knobModeOptions(status).map(option => <option key={option.value} value={option.value}>{option.value} · {option.label}</option>)}
  </select></label>;
}
export function KnobFrictionlessState({ status }: { status: KnobTelemetry }) {
  if (status.config.mode !== 16 || !status.frictionless) return null;
  const hold = status.frictionless;
  return <section className="knob-hold" aria-label="无摩擦保持状态"><h3>无摩擦保持 · 设备状态</h3><dl>
    <div><dt>当前阶段</dt><dd>{["静止", "诊断观察", "速度保持", "让步", "起拨获取"][hold.phase] ?? `阶段 ${hold.phase}`}</dd></div>
    <div><dt>参考速度</dt><dd>{hold.reference.toFixed(3)} rad/s</dd></div>
    <div><dt>保持修正</dt><dd>{hold.correction.toFixed(4)} A</dd></div>
    <div><dt>平均摩擦前馈</dt><dd>{hold.feedforward.toFixed(4)} A</dd></div>
  </dl><p className="knob-caption">起拨、保持与让步由固件计算。静止时保持零 Iq 闭环；本模式不产生点击脉冲。</p></section>;
}
const frictionlessFields: { key: keyof KnobFrictionlessConfig; label: string; unit: string; max: number; step: number }[] = [
  { key: "friction", label: "平均摩擦补偿", unit: "A", max: .8, step: .001 },
  { key: "viscous", label: "粘性补偿", unit: "A·s/rad", max: .02, step: .00001 },
  { key: "scale", label: "补偿倍率", unit: "×", max: 10, step: .1 },
  { key: "hold_kp", label: "速度保持 Kp", unit: "A·s/rad", max: 1, step: .001 },
  { key: "hold_ki", label: "速度保持 Ki", unit: "A/rad", max: 5, step: .001 },
];
export function KnobStudio({ onBack }: { onBack: () => void }) {
  const [workflow] = useState(() => new KnobWorkflow(knobGateway));
  const view = useSyncExternalStore(workflow.subscribe, workflow.snapshot, workflow.snapshot);
  const { connected, busy, status, editor, notice, conflict } = view;
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [port, setPort] = useState("");
  const [portError, setPortError] = useState("");
  const [preview, setPreview] = useState(0);
  const [trace, setTrace] = useState<{ iq: number; target: number }[]>([]);
  const alive = useRef(true);
  const draft = editor.draft;
  const dirty = workflow.dirty();
  const error = view.error || portError;
  const running = connected && status ? !["idle", "fault"].includes(status.state) : false;
  const preparing = connected && status ? !["idle", "active"].includes(status.state) : false;
  const currentLimitMax = knobCurrentLimitMax(status);
  const strengthMax = knobStrengthMax(status);
  // Hidden invalid input in another mode is retained by the workflow. Validate
  // only the currently displayed mode, using device values for other records.
  const validationConfig = { ...draft, reference_modes: editor.base.reference_modes
    ? { ...editor.base.reference_modes, ...(draft.reference_modes?.[String(draft.mode)] ? { [String(draft.mode)]: draft.reference_modes[String(draft.mode)]! } : {}) }
    : undefined };
  const validation = validateKnobConfig(validationConfig, currentLimitMax, strengthMax, undefined, knobModeCount(status), status?.reference_config_version);
  const referenceApplyBlocked = status !== null && knobReferenceApplyBlocked(draft, editor.base, status.state, status.live_haptics_config);
  const electricalChanged = workflow.electricalDirty();
  const fieldMax = (key: FieldKey, fallback?: number) => key === "current_limit" ? currentLimitMax : key === "strength" ? strengthMax : fallback;
  const busSensing = connected && status?.bus_voltage_sensing === true;
  const busValid = busSensing && status?.bus_voltage_valid === true;
  const busAge = status?.bus_voltage_age_us;
  const hasBusAge = busAge !== undefined && busAge >= 0 && busAge < 1000000000;
  const busStale = busSensing && !busValid && (status?.fault === "bus_voltage_stale" || (hasBusAge && busAge > 100000));
  const samplingNeedsRestart = connected && status?.sampling_restart_required === true;
  const driveUnavailable = (busSensing && !busValid) || samplingNeedsRestart;
  const busState = !connected ? "未连接" : busSensing ? (busValid ? "采样有效" : busStale ? "采样已过期" : "等待有效采样") : "使用配置电压";
  const busSource = !connected ? "—" : status?.bus_voltage_source === "adc2_gpio11" ? "驱动板分压 · ADC2 / GPIO11" : status?.bus_voltage_source === "configured" ? "名义母线配置" : status?.bus_voltage_source ?? "旧固件未提供采样来源";
  const refresh = useCallback(async () => {
    try {
      const available = await knobGateway.ports();
      if (alive.current) { setPorts(available); setPort(previous => selectKnobPort(available, previous)); setPortError(""); }
    } catch (e) { if (alive.current) setPortError(errorText(e)); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    const timer = setInterval(() => { void workflow.poll(); }, 100);
    return () => { alive.current = false; clearInterval(timer); void workflow.disconnect().catch(() => undefined); };
  }, [refresh, workflow]);
  useEffect(() => {
    if (!connected || !status?.current_valid) { setTrace([]); return; }
    setTrace(values => [...values.slice(-119), { iq: status.iq, target: status.target * status.calibration.direction }]);
  }, [connected, status]);
  async function disconnect(back = false) {
    try { await workflow.disconnect(); if (back && alive.current) onBack(); }
    catch (e) { if (alive.current) setPortError(errorText(e)); }
  }
  const connect = () => workflow.connect(port);
  const command = (op: KnobOp) => {
    if (op === "enable") return workflow.start(port);
    if (op === "disable") return workflow.stop();
    if (op === "configure") return workflow.apply();
    if (op === "status") return workflow.poll();
    return workflow.command(op);
  };
  const update = (key: FieldKey, value: number) => workflow.edit(key, value);
  const updateFrictionless = (key: keyof KnobFrictionlessConfig, value: number) => workflow.editFrictionless(key, value);
  const updateReference = (value: KnobReferenceModeConfig) => workflow.editReference(value);
  const restoreReferenceDefaults = () => workflow.restoreReferenceDefaults();
  const applyPreset = ({ name: _name, ...preset }: (typeof presets)[number]) => workflow.preset({ ...preset, strength: Math.min(preset.strength, strengthMax) });
  const applyText = { editing: "正在输入 · 尚未生效", pending: "等待下发", applied: "设备已生效 · RAM", failed: "应用失败 · 保留输入" }[view.applyState];
  const visualConfig = status?.config ?? draft;
  const visualWidth = visualConfig.mode <= 3 ? visualConfig.width : visualConfig.reference_modes?.[String(visualConfig.mode)]?.width;
  const voltageMagnitude = connected && status?.voltage_d !== undefined && status.voltage_q !== undefined
    ? Math.hypot(status.voltage_d, status.voltage_q) : null;
  const angle = status?.angle ?? preview;
  const position = status?.position ?? Math.round(preview / draft.width);
  // Include measured peaks as well as the configured limit; a 4.5 A trace or
  // an observed transient must not be flattened into the former +/-1 A plot.
  const chartRange = Math.ceil(Math.max(1, Number.isFinite(visualConfig.current_limit) ? visualConfig.current_limit : 0, ...trace.flatMap(v => [Math.abs(v.iq), Math.abs(v.target)])) * 2) / 2;
  const points = (key: "iq" | "target") => trace.map((v, i) => `${i * 500 / 119},${80 - v[key] / chartRange * 65}`).join(" ");
  const detentPeak = !validation ? knobDetentPeak(draft, connected ? status?.detent_profile ?? "" : "smart_knob") : null;
  return <div className="knob-studio">
    <LiquidGlass as="header" className="knob-header glass-panel">
      <button type="button" className="secondary-button" onClick={() => { void disconnect(true); }}><ArrowLeft size={17} />产品库</button>
      <div><span className="section-kicker">SMART KNOB / ESP32-S3</span><h1>智能旋钮</h1></div>
      <span className={`knob-state ${connected && status?.state === "active" ? "is-active" : ""}`}>{connected ? status?.state === "active" && status.haptic_paused ? "高速力反馈暂停" : states[status?.state ?? "idle"] : "未连接"}</span>
      <button type="button" className="knob-stop" disabled={!connected && !busy} onClick={() => { void command("disable"); }}><CircleStop size={19} />停止力反馈</button>
    </LiquidGlass>
    <div className="knob-connection glass-panel">
      <Cable size={20} /><label htmlFor="knob-port">USB 设备</label>
      <select id="knob-port" value={port} disabled={connected || busy} onChange={e => setPort(e.target.value)}><option value="">选择串口</option>{ports.map(p => <option key={p.name} value={p.name}>{p.name} · {knobPortLabel(p)}</option>)}</select>
      <button type="button" className="secondary-button" disabled={connected || busy} onClick={() => { void refresh(); }}>刷新</button>
      <button type="button" className="primary-button" disabled={!connected && (busy || !port)} onClick={() => { void (connected ? disconnect() : connect()); }}>{connected ? status?.host_lease_ms === 0 ? "断开 · 保持运行" : "断开连接" : "仅连接"}</button>
      <span>{isTauriRuntime() ? (status?.transport === "uart0" ? "COM / UART0 · 115200 · 协议 v1" : "原生 USB · 协议 v1") : "浏览器预览 · USB 调参请打开桌面应用"}</span>
    </div>
    <KnobOwnershipNote status={status} />
    {view.phase && <div className="knob-message" role="status">{view.phase}</div>}
    {!connected && <p className="knob-caption">当前固件请连接板上的 USB 口；COM 口用于选择 UART0 调参的固件。连接只读取设备参数，运行中的旋钮不会因此停机。</p>}
    {!connected && status && <div className="knob-message" role="status">以下位置和设备信息是最后收到的快照，不代表设备当前状态。重新连接后读取；电流曲线已清空。</div>}
    {error && <div className="knob-message is-error" role="alert">{error}</div>}
    {connected && status?.state === "fault" && <div className="knob-message is-error" role="alert">{label(status.fault)} <button type="button" disabled={busy} onClick={() => { void command("clear"); }}>清除故障</button></div>}
    {connected && status?.encoder !== "MT6701" && status?.weak_magnet_allowed && (status.magnet & 0x10) !== 0 && <div className="knob-message" role="status">当前磁场偏弱，已按机械间隙限制允许调试；角度与手感精度以实测为准。</div>}
    {notice && <div className="knob-message" role="status">{notice}</div>}
    <main className="knob-layout">
      <section className="knob-live glass-panel">
        <div className="knob-heading"><div><span className="section-kicker">触觉与位置</span><h2>感受每一个档位</h2></div><span className="knob-chip">{connected && status?.encoder ? `${status.encoder} · ` : ""}{status?.calibration.pole_pairs ?? 7} 极对</span></div>
        <Dial angle={angle} position={position} name={knobModeName(visualConfig.mode, status)} width={visualWidth} connected={connected} snapshot={status !== null} />
        {!connected && !status && <label className="knob-preview">拖动预览旋钮<input aria-label="旋钮界面预览角度" type="range" min={-Math.PI} max={Math.PI} step={0.01} value={preview} onChange={e => setPreview(Number(e.target.value))} /></label>}
        <div className="knob-metrics"><div><small>机械角度</small><strong>{(angle * 180 / Math.PI).toFixed(1)}<em>°</em></strong></div><div><small>旋转速度</small><strong>{connected ? status?.velocity.toFixed(2) : "—"}<em>rad/s</em></strong></div><div><small>q 轴电流</small><strong>{connected && status?.current_valid ? status.iq.toFixed(3) : "—"}<em>A</em></strong></div></div>
        <section className="knob-power" aria-label="电源与输出电压">
          <div className="knob-power-heading"><h3>电源与输出</h3><span className={`knob-power-state ${busSensing ? busValid ? "is-valid" : "is-invalid" : ""}`}>{busState}</span></div>
          <KnobVoltageReadout status={connected ? status : null} />
          <p className="knob-caption">{!connected ? "连接后显示固件的自动电压能力与 PWM 范围。" : status?.voltage_limit_automatic ? busSensing ? "SVPWM 随实时母线自动使用最大可用电压，名义配置仅作参考，无需设置电压上限。" : "输出电压自动取母线最大可用值；没有实时采样时，请按实测值填写名义母线。" : busSensing ? "实时母线用于电压调制；旧固件保留已保存的电压上限，此处只读显示。" : "没有实时采样时，请将外部测得的母线电压填入名义配置。"}</p>
          {driveUnavailable && <p className="knob-validation">{samplingNeedsRestart ? "电流采样需要重新初始化；停机后清除故障，再重新启动。" : "母线采样当前不可用，暂时不能校准或启动力反馈。"}{samplingNeedsRestart && status?.state === "idle" && <button type="button" className="secondary-button" disabled={busy} onClick={() => { void command("clear"); }}>重新初始化采样</button>}</p>}
        </section>
        <div className="knob-actions">
          <button type="button" className="secondary-button" disabled={!connected || busy || dirty || driveUnavailable || status?.state !== "idle" || status.fault !== "none"} onClick={() => { void command("calibrate"); }}><RotateCcw size={16} />自动校准</button>
          <button type="button" className="primary-button" disabled={busy || (!connected && !port) || (connected && status?.state !== "idle")} onClick={() => { void command("enable"); }}><Zap size={16} />{connected ? "一键启动" : "一键连接并启动"}</button>
          <button type="button" className="secondary-button" disabled={!connected || busy || status?.state !== "active" || status.config.mode === 16} onClick={() => { void command("pulse"); }}>触觉点击</button>
          <button type="button" className="secondary-button" disabled={!connected || busy || (running && status?.state !== "active")} onClick={() => { void command("zero"); }}>位置归零</button>
        </div>
        {dirty && <p className="knob-caption">输入确认后自动更新手感；启动前会提交有效参数。电气设置需在高级设置中单独应用。</p>}
        <p className="knob-caption">{status?.calibration.valid ? `电角度校准已就绪 · 方向 ${status.calibration.direction > 0 ? "+" : "−"} · 零点 ${status.calibration.electrical_zero.toFixed(3)} rad` : "点击一键启动会按需校准、保存并启动，采样和校准期间保持旋钮静置。"}</p>
        {status?.calibration_quality && <p className="knob-caption">已接受校准：{status.calibration_quality.verified ? "质量已验证" : "未验证"}{status.calibration_quality.method ? ` · ${status.calibration_quality.method}` : ""}。一键启动执行新校准时会自动保存一次。</p>}
        {status?.calibration_report && status.calibration_report.stage !== "not_run" && <p className="knob-caption">最近校准：{status.calibration_report.stage} · {label(status.calibration_report.error)}{status.calibration_report.elapsed_s !== undefined ? ` · ${status.calibration_report.elapsed_s.toFixed(1)} s` : ""}。尝试失败不会替换已接受的校准。</p>}
        {connected && status && <KnobFrictionlessState status={status} />}
        <div className="knob-chart-heading"><h3>电流跟踪</h3><span><i />测量 Iq <i className="target" />目标 Iq</span></div>
        <svg className="knob-chart" viewBox="0 0 500 160" role="img" aria-label={`q 轴电流与目标电流曲线，量程正负 ${chartRange} 安培`}>
          {[15, 80, 145].map(y => <line key={y} x1="0" y1={y} x2="500" y2={y} stroke="currentColor" strokeOpacity=".12" />)}
          <polyline points={points("target")} fill="none" stroke="#d3a56b" strokeWidth="1.5" strokeDasharray="5 3" />
          <polyline points={points("iq")} fill="none" stroke="#319b84" strokeWidth="2" />
        </svg>
        <div className="knob-chart-scale"><span>±{chartRange} A · 自动量程</span><span>{connected ? "最近 120 份有效电流遥测" : "连接设备后显示实时曲线"}</span></div>
      </section>
      <section className="knob-settings glass-panel">
        <div className="knob-heading"><div><span className="section-kicker">触觉设计</span><h2>把手感调成你喜欢的样子</h2></div><SlidersHorizontal size={22} /></div>
        <KnobModePicker status={status} mode={draft.mode} disabled={busy || preparing} onChange={mode => update("mode", mode)} />
        {status && <p className="knob-caption">{connected ? "设备已生效" : "上次设备快照"}：{status.config.mode} · {knobModeName(status.config.mode, status)}。选择模式立即切换，参数确认后自动生效。</p>}
        {draft.mode <= 3 && <div className="knob-presets"><span>旧模式草稿起点</span>{presets.map(p => <button type="button" key={p.name} disabled={busy || preparing} onClick={() => applyPreset(p)}>{p.name}</button>)}</div>}
        <div className="knob-fields">{fields.filter(f => !f.electrical && (draft.mode <= 3 || f.key === "current_limit")).map(f => <label key={f.key} htmlFor={`knob-${f.key}`}>{f.label}<div><KnobNumberInput id={`knob-${f.key}`}  aria-label={f.label} disabled={busy || preparing} min={f.min} max={fieldMax(f.key, f.max)} step={f.step} value={Number.isFinite(draft[f.key]) ? Number((draft[f.key] * (f.key === "width" ? 180 / Math.PI : 1)).toFixed(6)) : Number.NaN} onChange={value => update(f.key, value * (f.key === "width" ? Math.PI / 180 : 1))} onCommit={delay => workflow.commit(delay)} /><span>{f.unit}</span></div></label>)}</div>
        {draft.mode >= 4 && draft.mode <= 15 && <KnobReferenceEditor key={draft.mode} mode={draft.mode} version={status?.reference_config_version} config={[1, 2].includes(status?.reference_config_version ?? 0) ? draft.reference_modes?.[String(draft.mode)] : undefined} disabled={busy || preparing} canRestore={connected} currentLimit={status?.reference_current_limit} live={status?.live_haptics_config === true} onChange={updateReference} onCommit={delay => workflow.commit(delay)} onRestore={() => { void restoreReferenceDefaults(); }} />}
        {draft.mode > 16 && <p className="knob-caption knob-reference-note">此模式由设备提供。当前上位机可选择模式与运行电流上限，专用参数编辑需要对应的协议支持。</p>}
        {draft.mode === 16 && <section className="knob-frictionless"><h3>无摩擦参数 · 设备内执行</h3><p className="knob-caption">平均损耗补偿和速度保持由 ESP32 独立计算。scale=0 为持续零 Iq 对照。参数确认后自动生效。</p>
          {draft.frictionless ? <div className="knob-fields">{frictionlessFields.map(field => <label key={field.key} htmlFor={`knob-frictionless-${field.key}`}>{field.label}<div><KnobNumberInput id={`knob-frictionless-${field.key}`}  aria-label={field.label} min={0} max={field.max} step={field.step} disabled={busy || preparing} value={Number.isFinite(draft.frictionless?.[field.key]) ? Number(draft.frictionless![field.key].toPrecision(7)) : Number.NaN} onChange={value => updateFrictionless(field.key, value)} onCommit={delay => workflow.commit(delay)} /><span>{field.unit}</span></div></label>)}</div> : <p className="knob-caption">当前设备没有提供无摩擦参数，保留设备现有配置。</p>}
        </section>}
        <p className="knob-caption">{connected && status ? `设备已生效的电流上限：${status.config.current_limit.toFixed(2)} A。可调至 ${currentLimitMax} A。${draft.mode <= 3 ? `旧模式强度可调范围 0–${strengthMax} A/rad。` : ""}${status.current_limited ? "正在按实测电流限制目标。" : "输入确认后自动生效。"}` : `运行电流上限支持 0.02–${currentLimitMax} A；连接后按固件能力显示。`}</p>
        {detentPeak !== null && <p className="knob-caption">待应用参数的静态挡位目标峰值约 {detentPeak.target.toFixed(3)} A（限流前计算值 {detentPeak.requested.toFixed(3)} A）。{detentPeak.limited && "已达到电流上限，继续增大强度不会再提高峰值。"}此值不含运动阻尼，实测电流还受电压能力限制。</p>}
        <details className="knob-electrical"><summary>电流环与硬件参数</summary>
          <div className="knob-fields">{fields.filter(f => f.electrical).map(f => <label key={f.key} htmlFor={`knob-${f.key}`}>{f.label}<div><KnobNumberInput id={`knob-${f.key}`}  aria-label={f.label} disabled={running || busy} min={f.min} max={fieldMax(f.key, f.max)} step={f.step} value={view.electrical[f.key as keyof typeof view.electrical]} onChange={value => update(f.key, value)} /><span>{f.unit}</span></div></label>)}
            <label>DRV8316CT 采样增益<select disabled={running || busy} value={view.electrical.sense_gain} onChange={e => update("sense_gain", Number(e.target.value))}>{[0.15, 0.3, 0.6, 1.2].map(g => <option key={g} value={g}>{g} V/A</option>)}</select></label>
          </div><p className="knob-caption">采样增益应与驱动器 GAIN 接法一致。{busSensing ? "名义母线仅作参考，运行时使用有效的实时采样。" : "无实时采样时，固件使用名义母线，请按外部测量填写。"}{status?.voltage_limit_automatic && "输出能力随母线自动更新，无需另设电压上限。"}电气参数须停机后应用。</p>
          <button type="button" className="secondary-button" disabled={!connected || busy || status?.state !== "idle" || !electricalChanged || conflict} onClick={() => { void workflow.applyElectrical(); }}>应用电气设置</button>
        </details>
        {validation && <p className="knob-validation" role="alert">{validation}</p>}
        {conflict && <p className="knob-validation" role="alert">设备配置已变化。先还原设备参数，再重新编辑，避免旧草稿覆盖设备。</p>}
        {electricalChanged && running && <p className="knob-validation">电气参数已修改，请先停止力反馈再应用。</p>}
        {referenceApplyBlocked && !validation && <p className="knob-validation">此固件的参考模式参数需要停机应用；升级固件后支持运行中自动生效。</p>}
        <div className="knob-apply" aria-live="polite"><span>{!connected ? "离线预览 · 连接后读取设备参数" : view.sending ? "正在下发" : applyText}</span>
          {view.applyState === "failed" && <button type="button" className="secondary-button" disabled={!connected || busy || conflict} onClick={() => { void workflow.apply(); }}>重新应用</button>}
          {status?.live_haptics_config !== true && <button type="button" className="secondary-button" disabled={!connected || busy || !dirty || conflict || !!validation || preparing || referenceApplyBlocked} onClick={() => { void workflow.apply(); }}>应用手感参数</button>}
          <button type="button" className="secondary-button" disabled={!connected || busy || view.sending || (!dirty && !conflict)} onClick={() => workflow.restore()}>还原设备参数</button>
          <button type="button" className="secondary-button" disabled={!connected || busy || status?.state !== "idle" || electricalChanged} onClick={() => { void command("save"); }}><Save size={16} />保存到设备 NVS</button>
        </div>
        <p className="knob-caption">实时调整更新设备 RAM。停机后保存可在断电后保留；一键启动新完成的校准会自动保存一次，上电仍等待启动。</p>
        <div className="knob-diagnostics"><h3>设备诊断</h3><dl>
          {connected && status?.firmware && <div><dt>固件版本</dt><dd>{status.firmware}</dd></div>}
          {connected && status?.transport && <div><dt>调参通道</dt><dd>{status.transport === "usb_serial_jtag" ? "原生 USB Serial/JTAG" : "COM / UART0"}</dd></div>}
          {connected && status?.encoder && <div><dt>编码器</dt><dd>{status.encoder}{status.encoder_resolution_bits !== undefined ? ` · ${status.encoder_resolution_bits} 位` : ""}{status.encoder_interface === "ssi_spi_dma" ? " · SSI" : status.encoder_interface === "i2c" ? " · I²C" : ""}{status.encoder_dma ? " · DMA" : ""}</dd></div>}
          {connected && status && <div><dt>母线电压来源</dt><dd>{busSource}</dd></div>}
          {busSensing && status && <div><dt>母线采样状态</dt><dd>{busState}{status.bus_voltage_error ? ` · 错误 0x${status.bus_voltage_error.toString(16)}` : ""}</dd></div>}
          {busSensing && <div><dt>母线样本年龄</dt><dd>{hasBusAge ? `${(busAge / 1000).toFixed(1)} ms` : "未取得样本"}</dd></div>}
          {busSensing && status?.bus_voltage_measured !== undefined && <div><dt>最近母线换算值</dt><dd>{status.bus_voltage_measured.toFixed(3)} V{busValid ? "" : " · 无效"}</dd></div>}
          {connected && status && <KnobPwmDiagnostics status={status} />}
          {!!status?.hardware_error && <div><dt>硬件初始化</dt><dd className="knob-hardware-error">0x{status.hardware_error.toString(16)} · {status.hardware_detail}</dd></div>}
          <div><dt>磁铁状态</dt><dd>{knobMagnetStatus(connected ? status : null)}</dd></div>
          {connected && !!status?.encoder_error && <div><dt>编码器异常现场</dt><dd>错误 0x{status.encoder_error.toString(16)} · 磁铁 0x{(status.fault_magnet ?? 0).toString(16)}</dd></div>}
          <div><dt>编码器短暂重试次数</dt><dd>{connected ? status?.encoder_retries ?? 0 : "—"}</dd></div>
          <div><dt>编码器读取失败次数</dt><dd>{connected ? status?.encoder_failures ?? 0 : "—"}</dd></div>
          {connected && status?.current_trip_limit !== undefined && <div><dt>持续过流保护{status.current_overload_trip_ms !== undefined ? ` / ${status.current_overload_trip_ms} ms` : ""}</dt><dd>{status.current_trip_limit.toFixed(2)} A</dd></div>}
          {connected && status?.current_peak_trip !== undefined && <div><dt>快速过流保护{status.current_peak_trip_ms !== undefined ? ` / ${status.current_peak_trip_ms} ms` : ""}</dt><dd>{status.current_peak_trip.toFixed(2)} A</dd></div>}
          {connected && status?.current_absolute_trip !== undefined && <div><dt>立即过流保护</dt><dd>{status.current_absolute_trip.toFixed(2)} A</dd></div>}
          {connected && status?.fault_current_valid && status.fault_currents && <div><dt>停机时三相电流 / A</dt><dd>{status.fault_currents.map(i => i.toFixed(3)).join(" / ")}</dd></div>}
          {connected && status?.fault_current_valid && status.fault_current_trip_limit !== undefined && <div><dt>停机时持续过流阈值</dt><dd>{status.fault_current_trip_limit.toFixed(2)} A</dd></div>}
          {connected && status?.current_target_limit !== undefined && <div><dt>限流后可用目标电流</dt><dd>{status.state === "active" ? `${status.current_target_limit.toFixed(3)} A` : "—"}</dd></div>}
          <div><dt>d 轴电流 / A</dt><dd>{connected && status?.current_valid ? status.id_current.toFixed(3) : "—"}</dd></div>
          <div><dt>最近三相电流 / A</dt><dd>{connected && status?.current_valid ? status.currents.map(i => i.toFixed(3)).join(" / ") : "—"}</dd></div>
          <div><dt>CSA 零点 / V</dt><dd>{connected ? status?.offsets.map(i => i.toFixed(3)).join(" / ") : "—"}</dd></div>
          {connected && status?.voltage_d !== undefined && <div><dt>d 轴电压指令</dt><dd>{status.voltage_d.toFixed(3)} V</dd></div>}
          {connected && status?.voltage_q !== undefined && <div><dt>q 轴电压指令</dt><dd>{status.voltage_q.toFixed(3)} V</dd></div>}
          {voltageMagnitude !== null && <div><dt>电压指令矢量幅值</dt><dd>{voltageMagnitude.toFixed(3)} V</dd></div>}
          {connected && status && !status.voltage_limit_automatic && status.config.voltage_limit !== undefined && <div><dt>旧固件已存电压上限 / 只读</dt><dd>{status.config.voltage_limit.toFixed(3)} V</dd></div>}
          {connected && status?.available_voltage_limit !== undefined && <div><dt>当前母线可用电压能力</dt><dd>{status.available_voltage_limit.toFixed(3)} V</dd></div>}
          {connected && status?.effective_voltage_limit !== undefined && <div><dt>{status.voltage_limit_automatic ? "自动可用电压" : "当前有效电压限制"}</dt><dd>{status.effective_voltage_limit.toFixed(3)} V</dd></div>}
          {connected && status && <KnobTimingDiagnostics status={status} />}
          <div><dt>ADC 读取耗时</dt><dd>{connected ? `${status?.sample_us.toFixed(2)} μs` : "—"}</dd></div>
          <div><dt>控制计算耗时</dt><dd>{connected && status ? `${(status.control_us ?? status.loop_us).toFixed(0)} μs` : "—"}</dd></div>
          <div><dt>丢弃的采样窗口</dt><dd>{connected ? status?.rejected_samples : "—"}</dd></div>
        </dl>
          {connected && (status?.voltage_d !== undefined || status?.voltage_q !== undefined) && <p className="knob-caption">电压指令由固件计算，绕组端电压未实测。</p>}
          {connected && status && <details className="knob-runtime"><summary>力反馈运行策略</summary><dl>
            {status.detent_profile !== undefined && <div><dt>档位曲线</dt><dd>{status.detent_profile === "localized_barrier" ? "跨档区阻挡与助推" : status.detent_profile}</dd></div>}
            {status.detent_assist_fade_start !== undefined && status.detent_assist_cutoff !== undefined && <div><dt>同向助推衰减区间</dt><dd>{status.detent_assist_fade_start}–{status.detent_assist_cutoff} rad/s</dd></div>}
            {status.haptic_fade_start !== undefined && status.haptic_speed_cutoff !== undefined && <div><dt>全局高速衰减区间</dt><dd>{status.haptic_fade_start}–{status.haptic_speed_cutoff} rad/s</dd></div>}
            {status.haptic_scale !== undefined && <div><dt>当前触觉力度系数</dt><dd>{(status.haptic_scale * 100).toFixed(0)}%{status.haptic_paused ? " · 等待减速" : status.speed_limited ? " · 衰减或恢复中" : ""}</dd></div>}
            {status.haptic_position_filter !== undefined && <div><dt>挡位位置平滑</dt><dd>{status.haptic_position_filter ? "开启" : "关闭"}</dd></div>}
            {status.detent_quiet_velocity !== undefined && <div><dt>挡位专用速度滤波</dt><dd>{status.detent_quiet_velocity ? "开启" : "关闭"}</dd></div>}
            {status.current_target_slew !== undefined && <div><dt>电流目标斜坡</dt><dd>{status.current_target_slew ? "开启" : "关闭"}</dd></div>}
            {status.quiet_output !== undefined && <div><dt>静止零目标静音</dt><dd>{status.quiet_output ? "正在静音" : "未触发"}</dd></div>}
            {status.host_lease_ms !== undefined && <div><dt>主机心跳租约</dt><dd>{status.host_lease_ms === 0 ? "关闭 · 可独立运行" : `${status.host_lease_ms} ms`}</dd></div>}
          </dl>{status.host_lease_ms === 0 && <p className="knob-caption">固件独立运行；上位机查询仅用于显示，断开和退出不发送停机命令。设备仍有电源时保持已启用状态。</p>}</details>}
        </div>
      </section>
    </main>
  </div>;
}
