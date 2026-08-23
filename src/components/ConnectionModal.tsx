import { Cable, Check, LoaderCircle, Radio, RefreshCw, Usb, X } from "lucide-react";
import { useEffect, useState } from "react";

import type { ConnectionSnapshot, SerialConfig, SerialPortOption } from "../types";
import { isTauriRuntime } from "../lib/device";

const SERIAL_WRITE_CONFIRMATIONS = [
  "车轮已架空",
  "物理断电可用",
  "人员已远离机构",
  "目标设备已确认运行本工具复核的 Legacy WL1 双基线兼容协议（固件身份无法自动握手）",
] as const;

interface ConnectionModalProps {
  open: boolean;
  connection: ConnectionSnapshot;
  ports: readonly SerialPortOption[];
  loading: boolean;
  startupReady: boolean;
  error: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onConnect: (config: SerialConfig) => void;
  onDisconnect: () => void;
}

export function ConnectionModal({
  open,
  connection,
  ports,
  loading,
  startupReady,
  error,
  onClose,
  onRefresh,
  onConnect,
  onDisconnect,
}: ConnectionModalProps) {
  const [mode, setMode] = useState<SerialConfig["mode"]>(isTauriRuntime() ? "serial" : "mock");
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [safetyChecks, setSafetyChecks] = useState<boolean[]>(() => SERIAL_WRITE_CONFIRMATIONS.map(() => false));

  useEffect(() => {
    if (!selectedPort && ports[0]) setSelectedPort(ports[0].name);
  }, [ports, selectedPort]);

  useEffect(() => {
    if (open) setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !loading) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, onClose, open]);

  if (!open) return null;
  const connected = connection.mode !== "disconnected";
  const writesUnlocked = safetyChecks.every(Boolean);
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && !loading && onClose()}>
      <section className="connection-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <header className="modal-header">
          <div>
            <span className="section-kicker">DEVICE LINK</span>
            <h2 id="connection-title">连接 WL1</h2>
            <p>当前固件使用 115200 · 8-N-1 串口文本协议。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" disabled={loading} onClick={onClose}><X size={20} /></button>
        </header>

        {connected ? (
          <div className="connected-device-card">
            <div className="connected-device-icon"><Check size={24} /></div>
            <div><small>已建立连接</small><strong>{connection.label}</strong><span>{connection.mode === "mock" ? "后端仿真设备 · 写入已解锁" : `${connection.baudRate ?? 115200} baud · ${connection.writesUnlocked ? "写入已解锁" : "只读"}`}</span></div>
            <span className="signal-bars" aria-label="连接正常"><i /><i /><i /><i /></span>
          </div>
        ) : (
          <>
            <div className="mode-switch" role="tablist" aria-label="连接模式">
              <button type="button" className={mode === "mock" ? "is-active" : ""} onClick={() => setMode("mock")}><Radio size={18} /><span><strong>Mock 仿真</strong><small>{isTauriRuntime() ? "桌面后端事件链" : "浏览器本地预览"}</small></span></button>
              <button type="button" className={mode === "serial" ? "is-active" : ""} onClick={() => setMode("serial")}><Usb size={18} /><span><strong>USB 串口</strong><small>{isTauriRuntime() ? "连接真实 WL1" : "需要桌面端"}</small></span></button>
            </div>

            {mode === "mock" ? (
              <div className="mock-device-preview">
                <div className="mock-orbit"><Cable size={26} /></div>
                <div><strong>WL1-MOCK-01</strong><p>生成 20 Hz 姿态、轮速、电池与链路质量数据；命令仅记录 TX，不伪造固件 ACK。</p></div>
              </div>
            ) : (
              <div className="serial-picker">
                <div className="field-row field-row--heading">
                  <label>可用串口</label>
                  <button className="text-button" type="button" disabled={loading} onClick={onRefresh}><RefreshCw size={15} />刷新</button>
                </div>
                <div className="port-list">
                  {ports.map((port) => (
                    <button key={port.name} type="button" className={`port-option${selectedPort === port.name ? " is-selected" : ""}`} onClick={() => setSelectedPort(port.name)}>
                      <Usb size={19} /><span><strong>{port.name}</strong><small>{port.product ?? port.manufacturer ?? port.portType}</small></span>{selectedPort === port.name && <Check size={17} />}
                    </button>
                  ))}
                  {!loading && ports.length === 0 && <div className="empty-list">{isTauriRuntime() ? "未发现串口，请检查数据线与驱动。" : "浏览器无法枚举本机串口，请使用 Mock 模式。"}</div>}
                </div>
                <label className="form-field"><span>波特率</span><select value={baudRate} onChange={(event) => setBaudRate(Number(event.target.value))}><option value={115200}>115200（固件唯一支持）</option></select></label>
                <div className="safety-confirmations">
                  <strong>危险写入安全确认 <small>可不勾选并以只读模式连接</small></strong>
                  {SERIAL_WRITE_CONFIRMATIONS.map((label, index) => (
                    <label key={label}><input type="checkbox" checked={safetyChecks[index] ?? false} onChange={(event) => setSafetyChecks((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.checked : value))} /><span>{label}</span></label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {error && <div className="inline-error">{error}</div>}
        <footer className="modal-actions">
          <span><i className="safety-dot" />工作树有 250 ms R 超时，但无法握手确认；真实设备始终准备物理断电</span>
          {connected ? (
            <button className="danger-button" type="button" disabled={loading} onClick={onDisconnect}>{loading && <LoaderCircle className="spin" size={17} />}断开连接</button>
          ) : (
            <button className="primary-button" type="button" disabled={loading || !startupReady || (mode === "serial" && !selectedPort)} onClick={() => onConnect({ mode, portName: selectedPort || undefined, baudRate, allowUnsafeWrites: mode === "mock" || writesUnlocked })}>{loading ? <LoaderCircle className="spin" size={17} /> : <Cable size={17} />}{!startupReady ? "等待安全初始化" : mode === "serial" && !writesUnlocked ? "只读连接" : "建立连接"}</button>
          )}
        </footer>
      </section>
    </div>
  );
}
