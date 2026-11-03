import { ArrowLeft, Cable, CircleStop, RotateCcw, Save, SlidersHorizontal, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LiquidGlass } from "../LiquidGlass";
import { isTauriRuntime } from "../../lib/device";
import { defaultKnobConfig, knobGateway, knobMessages, knobPortLabel, knobCurrentLimitMax, maxKnobCurrent, validateKnobConfig, type KnobConfig, type KnobOp, type KnobTelemetry } from "../../lib/knob";
import type { SerialPortOption } from "../../types";
import "./KnobStudio.css";

const modes = ["自由旋转", "虚拟档位", "有限行程", "弹簧回中"];
const states: Record<string, string> = { idle: "已停机", offsets: "采样零点", align: "电角度对齐", sweep: "测量方向", settle: "校准收敛", active: "力反馈运行中", fault: "故障停机" };
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const label = (s: string) => knobMessages[s] ?? s;
type FieldKey = keyof KnobConfig;
const fields: { key: FieldKey; label: string; unit: string; min: number; max: number; step: number; electrical?: boolean }[] = [
  { key: "width", label: "档位间距", unit: "°", min: 1, max: 180, step: 1 },
  { key: "strength", label: "档位 / 回中强度", unit: "A/rad", min: 0, max: 10, step: 0.05 },
  { key: "endstop", label: "端点强度", unit: "A/rad", min: 0, max: 20, step: 0.1 },
  { key: "damping", label: "旋转阻尼", unit: "A·s/rad", min: 0, max: 0.5, step: 0.005 },
  { key: "snap", label: "档位切换点", unit: "× 档距", min: 0.5, max: 1, step: 0.01 },
  { key: "current_limit", label: "运行电流上限", unit: "A", min: 0.02, max: maxKnobCurrent, step: 0.01 },
  { key: "min_position", label: "起始档位", unit: "", min: -10000, max: 10000, step: 1 },
  { key: "max_position", label: "结束档位", unit: "", min: -10000, max: 10000, step: 1 },
  { key: "bus_voltage", label: "实测母线电压", unit: "V", min: 4.5, max: 30, step: 0.01, electrical: true },
  { key: "voltage_limit", label: "控制电压限制", unit: "V", min: 0.05, max: 5, step: 0.05, electrical: true },
  { key: "current_kp", label: "电流环 Kp", unit: "V/A", min: 0, max: 20, step: 0.1, electrical: true },
  { key: "current_ki", label: "电流环 Ki", unit: "V/(A·s)", min: 0, max: 1000, step: 1, electrical: true },
];
function Dial({ angle, position, mode, width, connected }: { angle: number; position: number; mode: number; width: number; connected: boolean }) {
  const ticks = Math.min(120, Math.max(2, Math.round(2 * Math.PI / width)));
  return <div className="knob-dial">
    <svg viewBox="0 0 360 360" role="img" aria-label={`旋钮角度 ${(angle * 180 / Math.PI).toFixed(1)} 度，档位 ${position}`}>
      <defs><radialGradient id="knob-surface"><stop stopColor="#425767" /><stop offset="1" stopColor="#192833" /></radialGradient></defs>
      <circle cx="180" cy="180" r="160" fill="none" stroke="currentColor" strokeOpacity=".1" />
      {Array.from({ length: ticks }, (_, i) => <line key={i} x1="180" y1="20" x2="180" y2={i % 3 === 0 ? 33 : 28} transform={`rotate(${i * 360 / ticks} 180 180)`} stroke="currentColor" strokeOpacity=".4" strokeWidth="2" />)}
      <circle cx="180" cy="180" r="137" fill="url(#knob-surface)" stroke="#6b8494" strokeWidth="2" />
      <circle cx="180" cy="180" r="126" fill="none" stroke="#526977" strokeOpacity=".4" />
      <g transform={`rotate(${angle * 180 / Math.PI} 180 180)`}><path d="M180 58v21" stroke="#9ce8d4" strokeWidth="7" strokeLinecap="round" /></g>
      <text x="180" y="154" textAnchor="middle" className="knob-dial__label">{modes[mode]}</text>
      <text x="180" y="205" textAnchor="middle" className="knob-dial__number">{position.toString().padStart(2, "0")}</text>
      <text x="180" y="237" textAnchor="middle" className="knob-dial__label">{connected ? "实时反馈" : "界面预览"}</text>
    </svg>
  </div>;
}
export function KnobStudio({ onBack }: { onBack: () => void }) {
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [port, setPort] = useState("");
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<KnobTelemetry | null>(null);
  const [draft, setDraft] = useState<KnobConfig>({ ...defaultKnobConfig });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(0);
  const [trace, setTrace] = useState<{ iq: number; target: number }[]>([]);
  const alive = useRef(true);
  const running = status ? !["idle", "fault"].includes(status.state) : false;
  const currentLimitMax = knobCurrentLimitMax(connected ? status : null);
  const validation = validateKnobConfig(draft, currentLimitMax);
  const refresh = useCallback(async () => {
    try {
      const available = await knobGateway.ports();
      if (alive.current) { setPorts(available); setPort(previous => available.some(p => p.name === previous) ? previous : available[0]?.name ?? ""); }
    } catch (e) { if (alive.current) setError(errorText(e)); }
  }, []);
  useEffect(() => {
    alive.current = true; void refresh();
    return () => { alive.current = false; void knobGateway.disconnect().catch(() => undefined); };
  }, [refresh]);
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const sample = await knobGateway.request("status");
        if (cancelled) return;
        setStatus(sample);
        if (sample.current_valid) setTrace(values => [...values.slice(-119), { iq: sample.iq, target: sample.target * sample.calibration.direction }]);
        timer = setTimeout(() => { void poll(); }, 40);
      } catch (e) {
        if (!cancelled) { setError(errorText(e)); setConnected(false); setStatus(null); setTrace([]); }
      }
    };
    void poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [connected]);
  async function connect() {
    setBusy(true); setError(""); setNotice("");
    try {
      await knobGateway.connect(port);
      const sample = await knobGateway.request("status");
      if (!alive.current) { await knobGateway.disconnect(); return; }
      setStatus(sample); setDraft(sample.config); setDirty(false); setConnected(true); setTrace([]);
    } catch (e) { setError(errorText(e)); await knobGateway.disconnect().catch(() => undefined); }
    finally { if (alive.current) setBusy(false); }
  }
  async function disconnect(back = false) {
    setBusy(true); setConnected(false); setStatus(null); setTrace([]);
    try { await knobGateway.disconnect(); if (back) onBack(); }
    catch (e) { setError(errorText(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function command(op: KnobOp) {
    setBusy(true); setError(""); setNotice("");
    try {
      const sample = await knobGateway.request(op, op === "configure" ? draft : undefined);
      if (!alive.current) return;
      setStatus(sample);
      if (!sample.ok) throw new Error(label(sample.error ?? "请求被拒绝"));
      if (op === "configure") { setDraft(sample.config); setDirty(false); setNotice("设备已应用参数"); }
      if (op === "save") setNotice("参数与电角度校准已保存到设备 NVS");
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function switchMode(mode: number) {
    if (!connected || !status) { update("mode", mode); return; }
    if (busy || (running && status.state !== "active")) return;
    setBusy(true); setError(""); setNotice("");
    try {
      // Apply only the chosen mode to the actual device parameters. Keep any
      // pending strength/electrical edits in the form until Apply is pressed.
      const sample = await knobGateway.request("configure", { ...status.config, mode });
      if (!alive.current) return;
      setStatus(sample);
      if (!sample.ok) throw new Error(label(sample.error ?? "模式切换被拒绝"));
      setDraft(config => ({ ...config, mode: sample.config.mode }));
      setNotice(`已切换到${modes[sample.config.mode]}`);
    } catch (e) { if (alive.current) setError(errorText(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  const update = (key: FieldKey, value: number) => { setDraft(c => ({ ...c, [key]: value })); setDirty(true); };
  const visualConfig = connected && status ? status.config : draft;
  const angle = connected && status ? status.angle : preview;
  const position = connected && status ? status.position : Math.round(preview / draft.width);
  const points = (key: "iq" | "target") => trace.map((v, i) => `${i * 500 / 119},${80 - Math.max(-1, Math.min(1, v[key])) * 65}`).join(" ");
  return <div className="knob-studio">
    <LiquidGlass as="header" className="knob-header glass-panel">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => { void disconnect(true); }}><ArrowLeft size={17} />产品库</button>
      <div><span className="section-kicker">SMART KNOB / ESP32-S3</span><h1>智能旋钮</h1></div>
      <span className={`knob-state ${connected && status?.state === "active" ? "is-active" : ""}`}>{connected ? states[status?.state ?? "idle"] : "未连接"}</span>
      <button type="button" className="knob-stop" disabled={!connected} onClick={() => { void command("disable"); }}><CircleStop size={19} />停止力反馈</button>
    </LiquidGlass>
    <div className="knob-connection glass-panel">
      <Cable size={20} /><label htmlFor="knob-port">USB 设备</label>
      <select id="knob-port" value={port} disabled={connected || busy} onChange={e => setPort(e.target.value)}><option value="">选择串口</option>{ports.map(p => <option key={p.name} value={p.name}>{p.name} · {knobPortLabel(p)}</option>)}</select>
      <button type="button" className="secondary-button" disabled={connected || busy} onClick={() => { void refresh(); }}>刷新</button>
      <button type="button" className="primary-button" disabled={busy || (!connected && !port)} onClick={() => { void (connected ? disconnect() : connect()); }}>{connected ? "断开" : "连接旋钮"}</button>
      <span>{isTauriRuntime() ? (status?.transport === "uart0" ? "COM / UART0 · 115200 · 协议 v1" : "原生 USB · 协议 v1") : "浏览器预览 · USB 调参请打开桌面应用"}</span>
    </div>
    {!connected && <p className="knob-caption">当前固件请连接板上的 USB 口；COM 口用于选择 UART0 调参的固件。连接成功后才会读取设备参数。</p>}
    {error && <div className="knob-message is-error" role="alert">{error}</div>}
    {connected && status?.state === "fault" && <div className="knob-message is-error" role="alert">{label(status.fault)} <button type="button" disabled={busy} onClick={() => { void command("clear"); }}>清除故障</button></div>}
    {connected && status?.weak_magnet_allowed && (status.magnet & 0x10) !== 0 && <div className="knob-message" role="status">当前磁场偏弱，已按机械间隙限制允许调试；角度与手感精度以实测为准。</div>}
    {notice && <div className="knob-message" role="status">{notice}</div>}
    <main className="knob-layout">
      <section className="knob-live glass-panel">
        <div className="knob-heading"><div><span className="section-kicker">触觉与位置</span><h2>感受每一个档位</h2></div><span className="knob-chip">2804 · 7 极对</span></div>
        <Dial angle={angle} position={position} mode={visualConfig.mode} width={visualConfig.width} connected={connected} />
        {!connected && <label className="knob-preview">拖动预览旋钮<input aria-label="旋钮界面预览角度" type="range" min={-Math.PI} max={Math.PI} step={0.01} value={preview} onChange={e => setPreview(Number(e.target.value))} /></label>}
        <div className="knob-metrics"><div><small>机械角度</small><strong>{(angle * 180 / Math.PI).toFixed(1)}<em>°</em></strong></div><div><small>旋转速度</small><strong>{connected ? status?.velocity.toFixed(2) : "—"}<em>rad/s</em></strong></div><div><small>q 轴电流</small><strong>{connected && status?.current_valid ? status.iq.toFixed(3) : "—"}<em>A</em></strong></div></div>
        <div className="knob-actions">
          <button type="button" className="secondary-button" disabled={!connected || busy || status?.state !== "idle"} onClick={() => { void command("calibrate"); }}><RotateCcw size={16} />自动校准</button>
          <button type="button" className="primary-button" disabled={!connected || busy || status?.state !== "idle" || !status.calibration.valid} onClick={() => { void command("enable"); }}><Zap size={16} />启动力反馈</button>
          <button type="button" className="secondary-button" disabled={!connected || busy || status?.state !== "active"} onClick={() => { void command("pulse"); }}>触觉点击</button>
          <button type="button" className="secondary-button" disabled={!connected || busy || (running && status?.state !== "active")} onClick={() => { void command("zero"); }}>位置归零</button>
        </div>
        <p className="knob-caption">{status?.calibration.valid ? `电角度校准已就绪 · 方向 ${status.calibration.direction > 0 ? "+" : "−"} · 零点 ${status.calibration.electrical_zero.toFixed(3)} rad` : "首次使用先自动校准，采样零点时保持旋钮静止。校准结束后可启动力反馈。"}</p>
        <div className="knob-chart-heading"><h3>电流跟踪</h3><span><i />测量 Iq <i className="target" />目标 Iq</span></div>
        <svg className="knob-chart" viewBox="0 0 500 160" role="img" aria-label="q 轴电流与目标电流曲线，量程正负一安培">
          {[15, 80, 145].map(y => <line key={y} x1="0" y1={y} x2="500" y2={y} stroke="currentColor" strokeOpacity=".12" />)}
          <polyline points={points("target")} fill="none" stroke="#d3a56b" strokeWidth="1.5" strokeDasharray="5 3" />
          <polyline points={points("iq")} fill="none" stroke="#319b84" strokeWidth="2" />
        </svg>
        <div className="knob-chart-scale"><span>±1 A</span><span>{connected ? "最近 120 个有效电流采样" : "连接设备后显示实时曲线"}</span></div>
      </section>
      <section className="knob-settings glass-panel">
        <div className="knob-heading"><div><span className="section-kicker">触觉设计</span><h2>把手感调成你喜欢的样子</h2></div><SlidersHorizontal size={22} /></div>
        <div className="knob-modes">{modes.map((m, i) => <button type="button" className={visualConfig.mode === i ? "selected" : ""} aria-pressed={visualConfig.mode === i} key={m} disabled={busy || (running && status?.state !== "active")} onClick={() => { void switchMode(i); }}>{m}</button>)}</div>
        <div className="knob-presets"><span>起点</span>{[{ name: "清晰 12 档", mode: 1, width: Math.PI / 6, strength: 5 }, { name: "轻盈 24 档", mode: 1, width: Math.PI / 12, strength: 0.8 }, { name: "细腻 48 档", mode: 1, width: Math.PI / 24, strength: 1.5 }, { name: "音量旋钮", mode: 2, width: Math.PI / 18, strength: 0.6 }, { name: "弹簧回中", mode: 3, width: Math.PI / 12, strength: 0.3 }].map(p => <button type="button" key={p.name} disabled={busy || (running && status?.state !== "active")} onClick={() => { setDraft(c => ({ ...c, mode: p.mode, width: p.width, strength: p.strength })); setDirty(true); }}>{p.name}</button>)}</div>
        <div className="knob-fields">{fields.filter(f => !f.electrical).map(f => <label key={f.key}>{f.label}<div><input type="number" disabled={busy || (running && status?.state !== "active")} min={f.min} max={f.key === "current_limit" ? currentLimitMax : f.max} step={f.step} value={Number.isFinite(draft[f.key]) ? Number((draft[f.key] * (f.key === "width" ? 180 / Math.PI : 1)).toFixed(6)) : ""} onChange={e => update(f.key, e.target.value === "" ? Number.NaN : Number(e.target.value) * (f.key === "width" ? Math.PI / 180 : 1))} /><span>{f.unit}</span></div></label>)}</div>
        <p className="knob-caption">{connected && status ? `设备已生效的电流上限：${status.config.current_limit.toFixed(2)} A。${status.current_limited ? "正在收减扭矩以限制电流，力反馈保持运行。" : "应用参数后立即同步到电机控制。"}` : "运行电流上限支持 0.02–1 A，连接后按固件能力显示。"}</p>
        <details className="knob-electrical"><summary>电流环与硬件参数</summary>
          <div className="knob-fields">{fields.filter(f => f.electrical).map(f => <label key={f.key}>{f.label}<div><input type="number" disabled={running || busy} min={f.min} max={f.key === "current_limit" ? currentLimitMax : f.max} step={f.step} value={Number.isFinite(draft[f.key]) ? draft[f.key] : ""} onChange={e => update(f.key, e.target.value === "" ? Number.NaN : Number(e.target.value))} /><span>{f.unit}</span></div></label>)}
            <label>DRV8316CT 采样增益<select disabled={running || busy} value={draft.sense_gain} onChange={e => update("sense_gain", Number(e.target.value))}>{[0.15, 0.3, 0.6, 1.2].map(g => <option key={g} value={g}>{g} V/A</option>)}</select></label>
          </div><p className="knob-caption">当前 GAIN 接法未知，先使用最低增益 0.15 V/A 作保守限流。实际增益更高时电流显示会偏高；确认硬件后再修改。母线电压来自手动测量。</p>
        </details>
        {validation && <p className="knob-validation" role="alert">{validation}</p>}
        <div className="knob-apply"><span>{!connected ? "连接后读取设备参数" : dirty ? "有尚未应用的修改" : "参数已同步"}</span><button type="button" className="primary-button" disabled={!connected || busy || !!validation || (running && status?.state !== "active")} onClick={() => { void command("configure"); }}>应用参数</button><button type="button" className="secondary-button" disabled={!connected || busy || !dirty} onClick={() => { if (status) { setDraft(status.config); setDirty(false); } }}>还原设备参数</button><button type="button" className="secondary-button" disabled={!connected || busy || running || dirty} onClick={() => { void command("save"); }}><Save size={16} />保存到设备</button></div>
        <div className="knob-diagnostics"><h3>设备诊断</h3><dl>
          {connected && status?.transport && <div><dt>调参通道</dt><dd>{status.transport === "usb_serial_jtag" ? "原生 USB Serial/JTAG" : "COM / UART0"}</dd></div>}
          {!!status?.hardware_error && <div><dt>硬件初始化</dt><dd className="knob-hardware-error">0x{status.hardware_error.toString(16)} · {status.hardware_detail}</dd></div>}
          <div><dt>磁铁状态</dt><dd>{connected ? status && (status.magnet & 0x38) === 0x20 ? "磁场正常" : status && (status.magnet & 0x10) ? "磁场过弱" : status && (status.magnet & 0x08) ? "磁场过强" : "未检测到磁铁" : "—"}</dd></div>
          {connected && !!status?.encoder_error && <div><dt>编码器异常现场</dt><dd>错误 0x{status.encoder_error.toString(16)} · 磁铁 0x{(status.fault_magnet ?? 0).toString(16)}</dd></div>}
          <div><dt>编码器短暂重试次数</dt><dd>{connected ? status?.encoder_retries ?? 0 : "—"}</dd></div>
          <div><dt>编码器读取失败次数</dt><dd>{connected ? status?.encoder_failures ?? 0 : "—"}</dd></div>
          {connected && status?.current_trip_limit !== undefined && <div><dt>持续过流保护 / 2 ms</dt><dd>{status.current_trip_limit.toFixed(2)} A</dd></div>}
          {connected && status?.current_absolute_trip !== undefined && <div><dt>立即过流保护</dt><dd>{status.current_absolute_trip.toFixed(2)} A</dd></div>}
          {connected && status?.fault_current_valid && status.fault_currents && <div><dt>停机时三相电流 / A</dt><dd>{status.fault_currents.map(i => i.toFixed(3)).join(" / ")}</dd></div>}
          {connected && status?.fault_current_valid && status.fault_current_trip_limit !== undefined && <div><dt>停机时持续过流阈值</dt><dd>{status.fault_current_trip_limit.toFixed(2)} A</dd></div>}
          {connected && status?.current_target_limit !== undefined && <div><dt>限流后可用目标电流</dt><dd>{status.state === "active" ? `${status.current_target_limit.toFixed(3)} A` : "—"}</dd></div>}
          <div><dt>d 轴电流 / A</dt><dd>{connected && status?.current_valid ? status.id_current.toFixed(3) : "—"}</dd></div>
          <div><dt>最近三相电流 / A</dt><dd>{connected ? status?.currents.map(i => i.toFixed(3)).join(" / ") : "—"}</dd></div>
          <div><dt>CSA 零点 / V</dt><dd>{connected ? status?.offsets.map(i => i.toFixed(3)).join(" / ") : "—"}</dd></div>
          <div><dt>ADC 读取耗时</dt><dd>{connected ? `${status?.sample_us.toFixed(2)} μs` : "—"}</dd></div>
          <div><dt>控制计算耗时</dt><dd>{connected ? `${status?.loop_us.toFixed(0)} μs` : "—"}</dd></div>
          <div><dt>丢弃的采样窗口</dt><dd>{connected ? status?.rejected_samples : "—"}</dd></div>
        </dl></div>
      </section>
    </main>
  </div>;
}
