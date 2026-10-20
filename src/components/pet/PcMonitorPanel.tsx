import { Activity, Cpu, Gauge, HardDrive, LoaderCircle, Monitor, Play, RefreshCw, Square, Wifi } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../../lib/device";
import { BackgroundButton } from "../BackgroundButton";
import {
  loadMonitorConfig, monitorBytes, monitorConnectionLabel, monitorMemory, monitorPercent, monitorProcessCpu, monitorRate, MONITOR_INTERVALS,
  pcMonitorGateway, saveMonitorConfig, usePcMonitor, validMonitorIp,
} from "../../lib/pc-monitor";
import type { DesktopPreferences, MonitorConfig, MonitorDevices } from "../../lib/pc-monitor";
import "./PcMonitorPanel.css";

const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
const clampPercent = (value: number | null | undefined): number => value == null || !Number.isFinite(value) ? 0 : Math.max(0, Math.min(100, value));

function Metric({ label, value, detail, tone }: { label: string; value: number | null; detail: string; tone: string }) {
  return <article className={`pc-metric is-${tone}`}>
    <div><span>{label}</span>{label === "CPU" ? <Cpu size={19} /> : label === "RAM" ? <HardDrive size={19} /> : <Gauge size={19} />}</div>
    <strong>{monitorPercent(value)}</strong>
    <progress value={clampPercent(value)} max={100} aria-label={`${label} 占用率`} />
    <small>{detail}</small>
  </article>;
}

export function PcMonitorPanel() {
  const snapshot = usePcMonitor();
  const [config, setConfig] = useState<MonitorConfig>(loadMonitorConfig);
  const [devices, setDevices] = useState<MonitorDevices>({ gpus: [], warning: null });
  const [loadingDevices, setLoadingDevices] = useState(false);
  const [devicesLoaded, setDevicesLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(true);
  const [savingPreferences, setSavingPreferences] = useState(false);
  const tauri = isTauriRuntime();
  const [restoredNative, setRestoredNative] = useState(!tauri);
  const mounted = useRef(false);
  const operation = useRef(false);
  const refreshDevices = useCallback(async () => {
    setLoadingDevices(true);
    try {
      const next = await pcMonitorGateway.devices();
      if (mounted.current) { setDevices(next); setDevicesLoaded(true); }
    } catch (reason) { if (mounted.current) setDevices((current) => ({ ...current, warning: errorText(reason) })); }
    finally { if (mounted.current) setLoadingDevices(false); }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => { setSaved(saveMonitorConfig(config)); }, [config]);
  useEffect(() => {
    if (!snapshot.desktop || restoredNative) return;
    if (snapshot.desktop.monitorConfig) {
      const nativeConfig = snapshot.desktop.monitorConfig;
      setConfig((current) => current.targetIp ? current : nativeConfig);
    }
    setRestoredNative(true);
  }, [snapshot.desktop, restoredNative]);
  useEffect(() => {
    if (snapshot.running && snapshot.targetIp) {
      setConfig((current) => current.targetIp === snapshot.targetIp && current.gpuEnabled === snapshot.gpuEnabled && current.gpuUuid === snapshot.gpuUuid && current.intervalMs === snapshot.intervalMs
        ? current : { targetIp: snapshot.targetIp ?? "", gpuEnabled: snapshot.gpuEnabled, gpuUuid: snapshot.gpuUuid, intervalMs: snapshot.intervalMs });
    }
  }, [snapshot.running, snapshot.targetIp, snapshot.gpuEnabled, snapshot.gpuUuid, snapshot.intervalMs]);
  useEffect(() => {
    if (restoredNative && config.gpuEnabled) void refreshDevices();
  }, [restoredNative, config.gpuEnabled, refreshDevices]);

  async function toggle(): Promise<void> {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try {
      if (snapshot.running) await pcMonitorGateway.stop();
      else await pcMonitorGateway.start(config);
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  async function updatePreferences(patch: Partial<DesktopPreferences>): Promise<void> {
    if (!snapshot.desktop || savingPreferences) return;
    setSavingPreferences(true); setError("");
    try { await pcMonitorGateway.savePreferences({ ...snapshot.desktop.preferences, ...patch }); }
    catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { if (mounted.current) setSavingPreferences(false); }
  }
  async function updateGpuEnabled(gpuEnabled: boolean): Promise<void> {
    if (operation.current) return;
    const next = { ...config, gpuEnabled };
    if (!snapshot.running) { setConfig(next); return; }
    operation.current = true; setBusy(true); setError("");
    try {
      await pcMonitorGateway.start(next);
      if (mounted.current) setConfig(next);
    } catch (reason) { if (mounted.current) setError(errorText(reason)); }
    finally { operation.current = false; if (mounted.current) setBusy(false); }
  }
  const sample = snapshot.sample;
  const desktop = snapshot.desktop;
  const resources = desktop?.resources;
  const ramPct = sample && sample.ramTotal > 0 ? sample.ramUsed / sample.ramTotal * 100 : null;
  const savedGpuUnavailable = config.gpuUuid !== null && !devices.gpus.some((gpu) => gpu.uuid === config.gpuUuid);
  const gpuMissing = config.gpuEnabled && devicesLoaded && !loadingDevices && savedGpuUnavailable;
  const locked = snapshot.running || busy;

  return <div className="pet-content pc-monitor-panel">
    <div className="pet-heading"><div><span className="pet-eyebrow">YOUR COMPUTER, AT A GLANCE</span><h1>把电脑状态，放到小屏幕。</h1><p>通过 Wi-Fi 实时显示 CPU、内存与 GPU 占用，无需连接 USB。</p></div><span className="pet-fullscreen-tag"><Wifi size={13} />无线实时监控</span></div>
    {!tauri && <p className="pet-message"><Monitor size={18} /><span>浏览器可配置界面；采集本机指标与无线发送请使用 WL1 Studio 桌面应用。</span></p>}
    <section className="pet-card pc-monitor-setup" aria-labelledby="pc-monitor-setup-title">
      <div className="pet-section-title"><div><h2 id="pc-monitor-setup-title"><Wifi size={18} />连接你的 ESP32-C3</h2><p>电脑与设备接入同一网络，或将电脑连接到设备热点；在设备的网络页面查看 IP。</p></div><span className={`pc-monitor-badge${snapshot.connected ? " is-online" : ""}`} role="status"><i />{monitorConnectionLabel(snapshot)}</span></div>
      <div className="pc-monitor-fields">
        <label htmlFor="pc-monitor-ip">设备 IPv4 地址<input id="pc-monitor-ip" type="text" value={config.targetIp} placeholder="例如 192.168.4.1" spellCheck={false} autoComplete="off" maxLength={15} disabled={locked} onChange={(event) => setConfig((current) => ({ ...current, targetIp: event.target.value }))} /></label>
        <label htmlFor="pc-monitor-gpu">NVIDIA 显卡<div className="pc-monitor-gpu-field"><select id="pc-monitor-gpu" value={config.gpuUuid ?? ""} disabled={locked || loadingDevices || !tauri || !config.gpuEnabled} onChange={(event) => setConfig((current) => ({ ...current, gpuUuid: event.target.value || null }))}><option value="">{config.gpuEnabled ? "自动选择可用显卡" : "GPU 采集已关闭"}</option>{devices.gpus.map((gpu) => <option key={gpu.uuid} value={gpu.uuid}>{gpu.name}</option>)}{savedGpuUnavailable && <option value={config.gpuUuid ?? ""}>{config.gpuEnabled ? "已保存的显卡当前不可用" : "已保留上次选择的显卡"}</option>}</select><button type="button" className="pet-button" disabled={locked || loadingDevices || !tauri || !config.gpuEnabled} aria-label="刷新 NVIDIA 显卡" onClick={() => { setError(""); void refreshDevices(); }}><RefreshCw size={14} className={loadingDevices ? "pet-spin" : ""} /></button></div></label>
        <label htmlFor="pc-monitor-interval">更新频率<select id="pc-monitor-interval" value={config.intervalMs} disabled={locked} onChange={(event) => setConfig((current) => ({ ...current, intervalMs: Number(event.target.value) }))}>{MONITOR_INTERVALS.map((interval) => <option key={interval} value={interval}>{interval} ms{interval === 500 ? " · 实时" : interval === 1000 ? " · 均衡" : " · 节能"}</option>)}</select></label>
        <button type="button" className={`pet-button pc-monitor-toggle${snapshot.running ? "" : " is-primary"}`} disabled={!tauri || busy || (!snapshot.running && (!validMonitorIp(config.targetIp) || gpuMissing))} onClick={() => { void toggle(); }}>{busy ? <LoaderCircle size={16} className="pet-spin" /> : snapshot.running ? <Square size={15} /> : <Play size={16} />}{busy ? "处理中…" : snapshot.running ? "停止发送" : "开始监控"}</button>
      </div>
      <label className="pc-monitor-gpu-option" htmlFor="pc-monitor-gpu-enabled"><input id="pc-monitor-gpu-enabled" type="checkbox" checked={config.gpuEnabled} disabled={busy || !restoredNative} onChange={(event) => { void updateGpuEnabled(event.target.checked); }} /><span><strong>采集 NVIDIA GPU</strong><small>关闭后仅发送 CPU 与内存。运行中切换立即生效，设备连接会短暂刷新。</small></span></label>
      <div className="pc-monitor-setup-note"><span>{snapshot.running ? "停止后可以修改连接配置。" : "没有可用 NVIDIA 显卡时仍可显示 CPU 和内存，GPU 指标为 N/A。"}</span><span>{saved ? "配置已保存在本机" : "配置保存失败，下次启动需重新填写"}</span></div>
      {config.gpuEnabled && devices.warning && <p className="pc-monitor-warning">{devices.warning}</p>}
      {gpuMissing && <p className="pc-monitor-warning">请刷新显卡列表或选择“自动选择可用显卡”。</p>}
    </section>
    {(error || snapshot.lastError) && <p className="pet-message is-error" role="alert">{error || snapshot.lastError}</p>}
    {desktop?.warning && <p className="pc-monitor-warning" role="status">{desktop.warning}</p>}
    <section className="pet-card pc-monitor-background" aria-labelledby="pc-monitor-background-title">
      <div className="pet-section-title"><div><h2 id="pc-monitor-background-title"><Monitor size={18} />轻量后台</h2><p>关闭窗口后释放工作台界面，保留 Wi-Fi 采集和发送。从系统托盘打开控制中心即可恢复。</p></div><BackgroundButton compact /></div>
      <div className="pc-monitor-preferences">
        <label><input type="checkbox" checked={desktop?.preferences.startInBackground ?? true} disabled={!tauri || !desktop || savingPreferences} onChange={(event) => { void updatePreferences({ startInBackground: event.target.checked }); }} /><span><strong>启动时直接进入后台</strong><small>首次使用先打开配置界面；完成一次连接配置后生效。</small></span></label>
        <label><input type="checkbox" checked={desktop?.preferences.autoResume ?? true} disabled={!tauri || !desktop || savingPreferences} onChange={(event) => { void updatePreferences({ autoResume: event.target.checked }); }} /><span><strong>下次启动恢复上次传输</strong><small>主动停止后保持停止；退出程序时记住发送状态。</small></span></label>
      </div>
      <p className="pc-monitor-background-note">{desktop?.trayAvailable ? "关闭窗口进入后台 · 托盘菜单可恢复界面、停止发送或退出程序。其他产品的设备连接会先释放。" : tauri ? "系统托盘尚未就绪或不可用，请最小化窗口继续发送；关闭窗口将退出程序。" : "后台运行与启动设置需要桌面应用。"}</p>
    </section>
    <div className="pc-monitor-metrics">
      <Metric label="CPU" value={sample?.cpuPct ?? null} detail="整机处理器使用率" tone="cpu" />
      <Metric label="RAM" value={ramPct} detail={sample ? `${monitorBytes(sample.ramUsed)} / ${monitorBytes(sample.ramTotal)}` : "等待内存采样"} tone="ram" />
      <Metric label="GPU" value={config.gpuEnabled ? sample?.gpuPct ?? null : null} detail={config.gpuEnabled ? sample?.gpuName || "NVIDIA GPU · 未取得指标" : "GPU 采集已关闭"} tone="gpu" />
    </div>
    <section className="pet-card pc-monitor-overhead" aria-labelledby="pc-monitor-overhead-title">
      <div className="pet-section-title"><div><h2 id="pc-monitor-overhead-title"><Activity size={18} />本程序资源占用</h2><p>每秒刷新。CPU 按整机算力计；内存为后台进程及界面子进程的常驻内存合计。</p></div><span className="pc-monitor-resource-tag">{resources ? `${resources.processCount} 个进程` : "等待桌面采样"}</span></div>
      <dl className="pc-monitor-resource-grid">
        <div><dt>程序 CPU</dt><dd>{monitorProcessCpu(resources?.cpuPct)}</dd><small>后台进程 {monitorProcessCpu(resources?.backendCpuPct)}</small></div>
        <div><dt>程序内存</dt><dd>{monitorMemory(resources?.memoryBytes)}</dd><small>后台进程 {monitorMemory(resources?.backendMemoryBytes)}</small></div>
        <div><dt>Wi-Fi 发送速率</dt><dd>{monitorRate(resources?.txBytesPerSecond)}</dd><small>{resources?.packetsPerSecond == null ? "等待发送统计" : `${resources.packetsPerSecond.toFixed(1)} 包/秒 · UDP 数据净载荷`}</small></div>
      </dl>
      <p className="pc-monitor-background-note">上方 CPU / RAM / GPU 是发给设备的整机状态；这里显示 WL1 Studio 自身开销。进入轻量后台后停止界面与资源面板刷新。</p>
    </section>
    <div className="pc-monitor-details">
      <section className="pet-card"><div className="pet-section-title"><div><h2><Activity size={18} />采集与传输</h2><p>设备确认表示已收到数据，显示页面请在设备 Tools 中打开 PC Monitor。</p></div></div><dl className="pc-monitor-stats"><div><dt>电脑</dt><dd>{sample?.host || "等待采样"}</dd></div><div><dt>发送目标</dt><dd>{snapshot.targetIp ? `${snapshot.targetIp}:4443` : "尚未开始"}</dd></div><div><dt>已发送</dt><dd>{snapshot.samplesSent.toLocaleString()} 次</dd></div><div><dt>最近设备确认</dt><dd>{snapshot.ackAgeMs === null ? "尚未收到" : `${(snapshot.ackAgeMs / 1000).toFixed(1)} 秒前`}</dd></div><div><dt>显存</dt><dd>{!config.gpuEnabled ? "采集已关闭" : sample ? `${monitorBytes(sample.vramUsed)} / ${monitorBytes(sample.vramTotal)}` : "N/A"}</dd></div><div><dt>GPU 温度</dt><dd>{!config.gpuEnabled ? "采集已关闭" : sample?.gpuTempC == null ? "N/A" : `${sample.gpuTempC.toFixed(0)} °C`}</dd></div></dl></section>
      <section className="pet-card pc-monitor-guide"><h2><Monitor size={18} />随手一瞥，就知道</h2><p>设备使用最新一份数据刷新屏幕。超过 3 秒没有更新时，会提示数据过期。</p><ol><li>让电脑与 ESP32-C3 连入同一网络。</li><li>填写设备 IP，点击“开始监控”。</li><li>在设备 Tools 菜单中选择 PC Monitor。</li></ol><p className="pc-monitor-lifetime">切换页面、返回产品库或进入轻量后台，监控继续运行。托盘可恢复界面、停止发送或退出应用。</p></section>
    </div>
    <footer className="pet-footer"><span>实时采样仅保存在内存 · 不写入设备 Flash</span><span>CPU 首次采样需一个周期 · 不支持的指标显示 N/A</span></footer>
  </div>;
}

/** Remains mounted at the app level so every product retains a stop control. */
export function PcMonitorStatus() {
  const snapshot = usePcMonitor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const operation = useRef(false);
  async function stop(): Promise<void> {
    if (operation.current) return;
    operation.current = true; setBusy(true); setError("");
    try { await pcMonitorGateway.stop(); }
    catch (reason) { setError(errorText(reason)); }
    finally { operation.current = false; setBusy(false); }
  }
  if (!snapshot.running) return null;
  return <aside className="pc-monitor-status" aria-label="电脑监控运行状态">
    <span className={`pc-monitor-status-icon${snapshot.connected ? " is-online" : ""}`}><Wifi size={17} /></span>
    <div><strong>电脑监控运行中</strong><span>{snapshot.targetIp} · {monitorConnectionLabel(snapshot)}</span><span className="pc-monitor-live-resources">CPU {monitorProcessCpu(snapshot.desktop?.resources.cpuPct)} · {monitorMemory(snapshot.desktop?.resources.memoryBytes)} · {monitorRate(snapshot.desktop?.resources.txBytesPerSecond)}</span>{(error || snapshot.desktop?.warning) && <small role="alert">{error || snapshot.desktop?.warning}</small>}</div>
    <div className="pc-monitor-status-actions"><BackgroundButton compact /><button type="button" disabled={busy} onClick={() => { void stop(); }} aria-label="停止电脑监控">{busy ? <LoaderCircle className="pet-spin" size={14} /> : <Square size={13} />}停止</button></div>
  </aside>;
}
