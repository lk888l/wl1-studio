import { Cable, Check, LoaderCircle, Radio, RadioTower, RefreshCw, Usb, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { ConnectionSnapshot, SerialConfig, SerialPortOption } from "../types";
import { isTauriRuntime } from "../lib/device";
import { isRemoteConnection } from "../lib/connection";

const SERIAL_WRITE_CONFIRMATIONS = [
  "车轮已架空",
  "物理断电可用",
  "人员已远离机构",
  "目标设备已确认运行本工具复核的 Legacy WL1 双基线兼容协议（固件身份无法自动握手）",
] as const;

function formatPortDetails(port: SerialPortOption): string {
  const identity = port.product ?? port.manufacturer ?? port.portType;
  if (port.vid === undefined || port.pid === undefined) return identity;

  const usbId = `${port.vid.toString(16).padStart(4, "0")}:${port.pid.toString(16).padStart(4, "0")}`.toUpperCase();
  return `${identity} · VID:PID ${usbId}`;
}

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
  const [connectionTarget, setConnectionTarget] = useState<"robot" | "remote">("robot");
  const [selectedPort, setSelectedPort] = useState("");
  const [baudRate, setBaudRate] = useState(115200);
  const [safetyChecks, setSafetyChecks] = useState<boolean[]>(() => SERIAL_WRITE_CONFIRMATIONS.map(() => false));
  const dialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!loading && !ports.some((port) => port.name === selectedPort)) {
      setSelectedPort(ports[0]?.name ?? "");
      setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false));
    }
  }, [loading, ports, selectedPort]);

  useEffect(() => {
    if (open) setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const previousFocus = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previousFocus instanceof HTMLElement && previousFocus.isConnected) {
        previousFocus.focus({ preventScroll: true });
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!loading) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
        'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
      } else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement as HTMLElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [loading, onClose, open]);

  if (!open) return null;
  const connected = connection.mode !== "disconnected";
  const remote = connected
    ? isRemoteConnection(connection)
    : mode === "serial" && connectionTarget === "remote";
  const writesUnlocked = safetyChecks.every(Boolean);
  const selectedPortAvailable = ports.some((port) => port.name === selectedPort);
  const confirmations = SERIAL_WRITE_CONFIRMATIONS.map((label, index) => remote && index === 3
    ? "遥控器已刷入 WL1 Studio 串口桥接固件，小车运行已复核的 Legacy WL1 双基线兼容协议（无法自动握手确认）"
    : label);
  return (
    <div className="modal-backdrop">
      <section ref={dialogRef} tabIndex={-1} className="connection-modal glass-panel" role="dialog" aria-modal="true" aria-labelledby="connection-title">
        <header className="modal-header">
          <div>
            <span className="section-kicker">DEVICE LINK</span>
            <h2 id="connection-title">连接 WL1</h2>
            <p>直连小车，或通过遥控器串口进行无线调参。115200 · 8-N-1。</p>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" disabled={loading} onClick={onClose}><X size={20} /></button>
        </header>

        {connected ? (
          <div className="connected-device-card">
            <div className="connected-device-icon"><Check size={24} /></div>
            <div><small>{remote ? "遥控器串口已打开" : connection.mode === "serial" ? "小车串口已打开" : "已建立仿真连接"}</small><strong>{connection.label}</strong><span>{connection.mode === "mock" ? "仿真设备 · 写入已解锁" : `${connection.baudRate ?? 115200} baud · ${connection.writesUnlocked ? "写入已解锁" : "只读"}`}</span></div>
            {connection.mode === "mock" ? <Radio size={21} aria-hidden="true" /> : <Usb size={21} aria-hidden="true" />}
          </div>
        ) : (
          <>
            <fieldset className="mode-switch connection-method-picker" aria-label="连接方式" disabled={loading}>
              <button type="button" aria-pressed={mode === "mock"} className={mode === "mock" ? "is-active" : ""} onClick={() => { setMode("mock"); setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false)); }}><Radio size={18} /><span><strong>Mock 仿真</strong><small>{isTauriRuntime() ? "桌面后端事件链" : "浏览器本地预览"}</small></span></button>
              <button type="button" aria-pressed={mode === "serial"} className={mode === "serial" ? "is-active" : ""} onClick={() => { setMode("serial"); setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false)); }}><Usb size={18} /><span><strong>USB 串口</strong><small>{isTauriRuntime() ? "选择小车或遥控器" : "需要桌面端"}</small></span></button>
            </fieldset>

            {mode === "mock" ? (
              <div className="mock-device-preview">
                <div className="mock-orbit"><Cable size={26} /></div>
                <div><strong>WL1-MOCK-01</strong><p>生成 20 Hz 姿态、轮速、电池与链路质量数据；命令仅记录 TX，不伪造固件 ACK。</p></div>
              </div>
            ) : (
              <div className="serial-picker">
                <fieldset className="connection-target-picker" disabled={loading}>
                  <legend>串口连接目标</legend>
                  <div className="mode-switch">
                    <button type="button" aria-pressed={connectionTarget === "robot"} className={connectionTarget === "robot" ? "is-active" : ""} onClick={() => { setConnectionTarget("robot"); setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false)); }}><Cable size={18} /><span><strong>直连小车</strong><small>调参 · 遥测 · 实时控制</small></span></button>
                    <button type="button" aria-pressed={connectionTarget === "remote"} className={connectionTarget === "remote" ? "is-active" : ""} onClick={() => { setConnectionTarget("remote"); setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false)); }}><RadioTower size={18} /><span><strong>连接遥控器</strong><small>通过无线链路下发参数</small></span></button>
                  </div>
                </fieldset>
                {remote && <div className="connection-target-note"><strong>电脑 → 遥控器 → 无线 → 小车</strong><p>先为遥控器刷入配套串口桥接固件；原版 tele_firmware 不支持串口调参。运动和腿高仍由遥控器控制，此模式不提供小车遥测或参数回读。</p></div>}
                <div className="field-row field-row--heading">
                  <span>{remote ? "遥控器串口" : "小车串口"}</span>
                  <button className="text-button" type="button" disabled={loading} onClick={onRefresh}><RefreshCw size={15} />刷新</button>
                </div>
                <div className="port-list">
                  {ports.map((port) => (
                    <button key={port.name} type="button" aria-pressed={selectedPort === port.name} disabled={loading} className={`port-option${selectedPort === port.name ? " is-selected" : ""}`} onClick={() => { setSelectedPort(port.name); setSafetyChecks(SERIAL_WRITE_CONFIRMATIONS.map(() => false)); }}>
                      <Usb size={19} /><span><strong>{port.name}</strong><small>{formatPortDetails(port)}</small></span>{selectedPort === port.name && <Check size={17} />}
                    </button>
                  ))}
                  {!loading && ports.length === 0 && <div className="empty-list">{isTauriRuntime() ? "未发现串口，请检查数据线与驱动。" : "浏览器无法枚举本机串口，请使用 Mock 模式。"}</div>}
                </div>
                <label className="form-field"><span>波特率</span><select value={baudRate} disabled={loading} onChange={(event) => setBaudRate(Number(event.target.value))}><option value={115200}>115200 · 8 数据位 · 无校验 · 1 停止位</option></select></label>
                <div className="safety-confirmations">
                  <strong>危险写入安全确认 <small>可不勾选并以只读模式连接</small></strong>
                  {confirmations.map((label, index) => (
                    <label key={label}><input type="checkbox" disabled={loading} checked={safetyChecks[index] ?? false} onChange={(event) => setSafetyChecks((current) => current.map((value, itemIndex) => itemIndex === index ? event.target.checked : value))} /><span>{label}</span></label>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {remote && <div className="connection-delivery-note"><RadioTower size={17} /><span>串口打开和 TX 记录仅表示电脑端已发送；无线链路没有小车 ACK，不能据此确认小车在线或参数生效。</span></div>}
        {error && <div className="inline-error">{error}</div>}
        <footer className="modal-actions">
          <span><i className="safety-dot" />{remote ? "摇杆保持运动控制；断开串口不会使小车停车，始终准备物理断电" : "无法握手确认固件安全机制；真实设备始终准备物理断电"}</span>
          {connected ? (
            <button className="danger-button" type="button" disabled={loading} onClick={onDisconnect}>{loading && <LoaderCircle className="spin" size={17} />}断开连接</button>
          ) : (
            <button className="primary-button" type="button" disabled={loading || !startupReady || (mode === "serial" && !selectedPortAvailable)} onClick={() => onConnect({ mode, connectionTarget: mode === "serial" ? connectionTarget : "robot", portName: mode === "serial" ? selectedPort || undefined : undefined, baudRate, allowUnsafeWrites: mode === "mock" || writesUnlocked })}>{loading ? <LoaderCircle className="spin" size={17} /> : <Cable size={17} />}{!startupReady ? "等待安全初始化" : mode === "serial" && !writesUnlocked ? "只读连接" : remote ? "打开遥控器串口" : "建立连接"}</button>
          )}
        </footer>
      </section>
    </div>
  );
}
