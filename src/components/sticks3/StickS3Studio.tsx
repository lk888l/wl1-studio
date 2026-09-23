import { ArrowLeft, Bluetooth, Cable, ChevronRight, Cpu, Info, LoaderCircle, Radio, RefreshCw, Unplug, Wifi, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../../lib/device";
import { selectAvailablePort } from "../../lib/connection-preferences";
import { S3Cancelled, sticks3Gateway, wifiStateLabel, type S3Snapshot } from "../../lib/sticks3";
import type { SerialPortOption } from "../../types";
import { RadioConnections, type S3Run } from "./RadioConnections";
import { FirmwarePage } from "../pages/FirmwarePage";
import "./StickS3Studio.css";

const errorText = (reason: unknown) => reason instanceof Error ? reason.message : String(reason);
const portKey = "studio.sticks3.port.v1";
function preferredPort(): string { try { return localStorage.getItem(portKey) ?? ""; } catch { return ""; } }

export function StickS3Studio({ onBack }: { onBack: () => void }) {
  const [snapshot, setSnapshot] = useState(sticks3Gateway.snapshot);
  const [page, setPage] = useState<"radio" | "dap">("radio");
  const [dapVisited, setDapVisited] = useState(false);
  const [firmwareBusy, setFirmwareBusy] = useState(false);
  const firmwareBusyRef = useRef(false);
  const handleFirmwareBusy = useCallback((value: boolean) => {
    firmwareBusyRef.current = value;
    setFirmwareBusy(value);
  }, []);
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [portName, setPortName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const operation = useRef(0);
  const active = useRef(false);

  useEffect(() => sticks3Gateway.subscribe(setSnapshot), []);
  const run = useCallback<S3Run>(async (label, work, message = "") => {
    if (active.current || firmwareBusyRef.current) return false;
    active.current = true;
    const token = ++operation.current;
    setBusy(label); setError(""); setNotice("");
    try {
      await work();
      if (token !== operation.current) return false;
      setNotice(message);
      return true;
    } catch (reason) {
      if (token === operation.current && !(reason instanceof S3Cancelled)) setError(errorText(reason));
      return false;
    } finally {
      if (token === operation.current) { active.current = false; setBusy(""); }
    }
  }, []);

  const refreshPorts = useCallback(async () => {
    const next = await sticks3Gateway.listSerialPorts();
    setPorts(next);
    setPortName((current) => selectAvailablePort(next, current, preferredPort()));
  }, []);
  useEffect(() => { void run("正在查找 USB 串口", refreshPorts); }, [run, refreshPorts]);

  useEffect(() => {
    if (!snapshot.connected || busy) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await sticks3Gateway.refresh(); }
      catch (reason) { if (!cancelled && !(reason instanceof S3Cancelled)) setError(errorText(reason)); }
      if (!cancelled) timer = setTimeout(() => { void poll(); }, 3000);
    };
    timer = setTimeout(() => { void poll(); }, 3000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [snapshot.connected, busy]);

  const disconnect = async (back: boolean) => {
    if (firmwareBusyRef.current) return;
    // This path can cancel scan polling and queued actions without waiting for their UI lock.
    const token = ++operation.current;
    active.current = true; setBusy("正在释放 USB 连接"); setError(""); setNotice("");
    try {
      await sticks3Gateway.disconnect();
      if (back) onBack();
      else setNotice("USB 控制连接已断开，S3 上的无线连接继续保留。");
    } catch (reason) { setError(errorText(reason)); }
    finally { if (token === operation.current) { active.current = false; setBusy(""); } }
  };
  const connect = () => run("正在连接 S3 并确认固件", async () => {
    await sticks3Gateway.connect(portName);
    try { localStorage.setItem(portKey, portName); } catch { /* Port preference is optional. */ }
    await sticks3Gateway.refresh();
  }, "S3 已连接，可以管理设备的 Wi-Fi 和 BLE。");

  return <div className="s3-studio">
    <aside className="s3-sidebar">
      <button type="button" className="s3-back" onClick={() => { void disconnect(true); }} disabled={firmwareBusy || busy === "正在释放 USB 连接"}><ArrowLeft size={16} />返回产品库</button>
      <div className="s3-brand"><span><Cpu size={25} /></span><div><strong>StickS3</strong><small>多功能设备工作台</small></div></div>
      <nav aria-label="S3 功能导航">
        <button type="button" disabled={firmwareBusy} className={page === "radio" ? "is-active" : ""} aria-current={page === "radio" ? "page" : undefined} onClick={() => setPage("radio")}><Radio size={19} /><span>无线连接<small>Wi-Fi 与蓝牙设备</small></span></button>
        <button type="button" disabled={firmwareBusy} className={page === "dap" ? "is-active" : ""} aria-current={page === "dap" ? "page" : undefined} onClick={() => { setDapVisited(true); setPage("dap"); }}><Cpu size={19} /><span>SWD 调试器<small>Flash · 烧录 · 校验</small></span></button>
      </nav>
      <div className="s3-sidebar-note"><Cable size={22} /><strong>一个连接，多种用途</strong><p>通过 USB 管理无线网络。连接设置由 S3 保存，供调试器和后续无线功能共用。</p></div>
      <div className={`s3-link-state ${snapshot.connected ? "is-connected" : ""}`}><i /><div><strong>{snapshot.connected ? "USB 控制台已连接" : page === "dap" ? "USB DAP 独立连接" : "USB 控制台未连接"}</strong><small>{snapshot.portName ?? (page === "dap" ? "在右侧选择烧录器" : "选择串口后连接")}</small></div></div>
    </aside>
    <main className="s3-workspace">
      <header className="s3-topbar"><span>设备控制中心 <ChevronRight size={14} /> StickS3 <ChevronRight size={14} /><strong>{page === "radio" ? "无线连接" : "SWD 调试器"}</strong></span><span className="s3-chip">ESP32-S3</span></header>
      <div className="s3-content">
        {page === "radio" && <div className="s3-heading"><div><span className="s3-eyebrow">STICKS3 STUDIO</span><h1>连接你的无线世界</h1><p>为 S3 选择 Wi-Fi 和蓝牙外设，让连接服务于每一种功能。</p></div><span className={`s3-chip ${snapshot.connected ? "is-online" : ""}`}>{snapshot.connected ? "设备在线" : "等待 USB 连接"}</span></div>}
        {(page === "radio" || snapshot.connected) && <section className="s3-connectbar" aria-label="S3 USB 连接">
          <Cable size={22} /><label htmlFor="s3-port">USB 控制台</label>
          <select id="s3-port" value={portName} disabled={firmwareBusy || snapshot.connected || Boolean(busy) || !isTauriRuntime()} onChange={(event) => setPortName(event.target.value)}>
            <option value="">{ports.length ? "请选择 StickS3 串口" : "未发现可用串口"}</option>
            {ports.map((port) => <option key={port.name} value={port.name}>{port.name}{port.product ? ` · ${port.product}` : ""}</option>)}
          </select>
          <button type="button" className="s3-btn" disabled={firmwareBusy || snapshot.connected || Boolean(busy) || !isTauriRuntime()} onClick={() => { void run("正在刷新串口", refreshPorts); }} aria-label="刷新串口"><RefreshCw size={16} /></button>
          {snapshot.connected ? <button type="button" className="s3-btn" disabled={busy === "正在释放 USB 连接"} onClick={() => { void disconnect(false); }}><Unplug size={16} />断开 USB</button>
            : <button type="button" className="s3-btn is-primary" disabled={firmwareBusy || !portName || Boolean(busy) || !isTauriRuntime()} onClick={() => { void connect(); }}>连接 S3</button>}
        </section>}
        {page === "radio" && !isTauriRuntime() && <p className="s3-message"><Info size={17} />浏览器可浏览工作台；扫描、连接和保存需要使用桌面应用及真实 StickS3。</p>}
        {busy && <p className="s3-message" role="status"><LoaderCircle className="s3-spin" size={17} />{busy}…</p>}
        {error && <div className="s3-message is-error" role="alert"><Info size={17} /><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError("")}><X size={16} /></button></div>}
        {notice && <p className="s3-message is-success" role="status"><Info size={17} />{notice}</p>}
        {page === "radio" && <RadioConnections key={snapshot.sessionId ?? "offline"} snapshot={snapshot} busy={Boolean(busy) || firmwareBusy} run={run} />}
        {dapVisited && <div hidden={page !== "dap"}><FirmwarePage product="sticks3" connected={snapshot.connected} connectionBusy={Boolean(busy)} onBusyChange={handleFirmwareBusy} /><details className="s3-dap-guide"><summary>接线与其他调试方式</summary><DapGuide snapshot={snapshot} onRadio={() => { if (!firmwareBusyRef.current) setPage("radio"); }} /></details></div>}
        <footer className="s3-footer"><span>{page === "dap" ? "USB DAP 使用独立的烧录连接，无需连接配网串口。" : "断开 USB 控制台不会关闭 Wi-Fi / BLE。"}</span><span>{firmwareBusy ? "Flash 操作进行中，请保持连接" : "StickS3 多功能工作台"}</span></footer>
      </div>
    </main>
  </div>;
}

function DapGuide({ snapshot, onRadio }: { snapshot: S3Snapshot; onRadio: () => void }) {
  const data = snapshot.data;
  const ip = data?.wifi?.state === "connected" ? data.wifi.ip : data?.apIp;
  return <div className="s3-dap">
    <section className="s3-card s3-dap-intro"><div><h2>CMSIS-DAP / SWD</h2><p>上方提供 USB DAP 图形化烧录。Wi-Fi / BLE 调试可按下方说明使用 OpenOCD；传输模式由设备屏幕选择。</p></div><button type="button" className="s3-btn is-primary" onClick={onRadio}><Radio size={16} />管理无线连接</button></section>
    <div className="s3-dap-modes">
      <section className="s3-card"><Cable size={26} /><h2>USB DAP</h2><span className="s3-chip">有线直连</span><ol><li>先断开本工作台的 USB 控制连接。</li><li>在 S3 上进入 USB DAP，等待电脑识别 CMSIS-DAP 设备。</li><li>在上方点击“连接并识别”，自动读取芯片系列与容量；也可使用 OpenOCD / IDE 的 CMSIS-DAP v2 模式。</li></ol><p className="s3-hint">USB DAP 占用原生 USB，控制串口会消失。退出该页面后，刷新串口并重新连接。</p></section>
      <section className="s3-card"><Wifi size={26} /><h2>Wi-Fi DAP</h2><span className="s3-chip">{wifiStateLabel(data?.wifi?.state)}</span><ol><li>让 S3 与电脑接入同一网络，或让电脑连接 S3 热点。</li><li>在 S3 上进入 W-DAP；页面打开时才监听调试端口。</li><li>使用支持 CMSIS-DAP TCP 的 OpenOCD 连接设备。</li></ol><div className="s3-endpoint"><small>调试端点</small><strong>{ip ? `${ip}:4441` : "连接 S3 后显示 IP · TCP 4441"}</strong></div><p className="s3-hint">TCP 调试通道无加密或应用密码，请在可信局域网内使用。</p></section>
      <section className="s3-card"><Bluetooth size={26} /><h2>BLE DAP</h2><span className="s3-chip">电脑主动连接 S3</span><ol><li>在无线连接页开启 BLE，在 S3 上进入 B-DAP。</li><li>电脑运行固件仓库的 <code>tools/dap_bridge.py scan</code> 查找 S3。</li><li>运行桥接器的 <code>ble --address</code> 模式，完成系统配对。</li><li>桥接器显示 Ready 后，让 OpenOCD 连接本机 TCP 4441。</li></ol><p className="s3-hint">蓝牙外设列表用于 S3 向外连接；B-DAP 使用电脑向 S3 建立的加密连接。桥接器和 OpenOCD 需单独运行。</p></section>
    </div>
    <section className="s3-card"><h2>目标板接线</h2><div className="s3-wiring">{[["G6", "SWCLK"], ["G7", "SWDIO"], ["G8", "NRST"], ["GND", "GND"]].map(([pin, signal]) => <div key={pin}><span>StickS3 {pin}</span><ChevronRight size={17} /><strong>{signal}</strong></div>)}</div><p className="s3-hint">目标板自行供电并共地，只支持 3.3 V 逻辑。建议从 100–250 kHz 开始；复位下连接需要接上 NRST。</p></section>
  </div>;
}
