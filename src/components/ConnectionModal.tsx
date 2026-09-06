import { Cable, Check, ChevronDown, LoaderCircle, Radio, RadioTower, RefreshCw, Unplug, Usb } from "lucide-react";
import { useEffect, useState } from "react";

import type { ConnectionSnapshot, ConnectionTarget, SerialConfig, SerialPortOption } from "../types";
import { isTauriRuntime } from "../lib/device";
import { isRemoteConnection } from "../lib/connection";
import { loadConnectionPreferences, saveConnectionPreferences, selectAvailablePort } from "../lib/connection-preferences";
import "./ConnectionModal.css";

function formatPortDetails(port: SerialPortOption): string {
  const identity = port.product ?? port.manufacturer ?? port.portType;
  if (port.vid === undefined || port.pid === undefined) return identity;
  const usbId = `${port.vid.toString(16).padStart(4, "0")}:${port.pid.toString(16).padStart(4, "0")}`.toUpperCase();
  return `${identity} · VID:PID ${usbId}`;
}

interface ConnectionModalProps {
  // Retained for callers of the former dialog; the connection bar is always visible.
  open?: boolean;
  onClose?: () => void;
  connection: ConnectionSnapshot;
  ports: readonly SerialPortOption[];
  loading: boolean;
  startupReady: boolean;
  error: string | null;
  onRefresh: () => void;
  onConnect: (config: SerialConfig) => void;
  onDisconnect: () => void;
}

export function ConnectionModal({
  connection,
  ports,
  loading,
  startupReady,
  error,
  onRefresh,
  onConnect,
  onDisconnect,
}: ConnectionModalProps) {
  const desktop = isTauriRuntime();
  const [preferences, setPreferences] = useState(loadConnectionPreferences);
  const [choice, setChoice] = useState<ConnectionTarget | "mock">(() => desktop ? preferences.target : "mock");
  const [selectedPort, setSelectedPort] = useState(preferences.portName);

  useEffect(() => {
    if (!loading) {
      setSelectedPort((current) => selectAvailablePort(ports, current, preferences.portName));
    }
  }, [loading, ports, preferences.portName]);

  const connected = connection.mode !== "disconnected";
  const serial = choice !== "mock";
  const remote = connected ? isRemoteConnection(connection) : choice === "remote";
  const selectedPortOption = ports.find((port) => port.name === selectedPort);
  const canConnect = !loading && startupReady && (!serial || (desktop && !!selectedPortOption));

  function chooseTarget(target: ConnectionTarget | "mock") {
    setChoice(target);
    if (target === "mock") return;
    const next = { ...preferences, target };
    setPreferences(next);
    saveConnectionPreferences(next);
  }

  function choosePort(portName: string) {
    setSelectedPort(portName);
    const next = { ...preferences, portName };
    setPreferences(next);
    saveConnectionPreferences(next);
  }

  function connect() {
    if (!canConnect) return;
    if (serial) {
      const next = { target: choice, portName: selectedPort };
      setPreferences(next);
      saveConnectionPreferences(next);
    }
    onConnect({
      mode: serial ? "serial" : "mock",
      connectionTarget: serial ? choice : "robot",
      portName: serial ? selectedPort : undefined,
      baudRate: 115200,
      allowUnsafeWrites: !serial,
    });
  }

  return (
    <section id="device-connection" className={`device-link glass-panel${connected ? " is-connected" : ""}`} aria-label="设备连接">
      <div className="device-link__main">
        <div className="device-link__identity">
          <span className="device-link__icon" aria-hidden="true">{connected ? <Check size={20} /> : <Cable size={20} />}</span>
          <div>
            <strong>{connected ? connection.label : "连接 WL1"}</strong>
            <span>{connected
              ? connection.mode === "mock" ? "仿真已连接" : `${remote ? "遥控器" : "小车"}串口已打开 · ${connection.writesUnlocked ? "可调参" : "只读"}`
              : desktop ? "选择设备，一键连接" : "浏览器仿真预览"}</span>
          </div>
        </div>

        {connected ? (
          <>
            <div className="device-link__connected-note">{connection.mode === "mock" ? "仿真数据运行中" : `${connection.baudRate ?? 115200} baud`}</div>
            <button className="secondary-button device-link__disconnect" type="button" disabled={loading} onClick={onDisconnect}>
              {loading ? <LoaderCircle className="spin" size={17} /> : <Unplug size={17} />}断开连接
            </button>
          </>
        ) : (
          <>
            <fieldset className="device-link__choices" aria-label="连接方式" disabled={loading}>
              {desktop && <>
                <button type="button" aria-pressed={choice === "robot"} className={choice === "robot" ? "is-active" : ""} onClick={() => chooseTarget("robot")}><Usb size={16} />直连小车</button>
                <button type="button" aria-pressed={choice === "remote"} className={choice === "remote" ? "is-active" : ""} onClick={() => chooseTarget("remote")}><RadioTower size={16} />遥控器</button>
              </>}
              <button type="button" aria-pressed={choice === "mock"} className={choice === "mock" ? "is-active" : ""} onClick={() => chooseTarget("mock")}><Radio size={16} />仿真</button>
            </fieldset>

            {serial ? (
              <div className="device-link__port">
                <select aria-label={remote ? "遥控器串口" : "小车串口"} value={selectedPortOption ? selectedPort : ""} disabled={loading || ports.length === 0} onChange={(event) => choosePort(event.target.value)}>
                  <option value="" disabled>{loading ? "正在查找串口…" : ports.length === 0 ? "未发现串口" : "选择串口"}</option>
                  {ports.map((port) => <option key={port.name} value={port.name}>{port.name}{port.product ? ` · ${port.product}` : ""}</option>)}
                </select>
                <button className="icon-button" type="button" aria-label="刷新串口" title="刷新串口" disabled={loading} onClick={onRefresh}><RefreshCw size={16} className={loading ? "spin" : undefined} /></button>
              </div>
            ) : <span className="device-link__preview">无需设备即可体验调参</span>}

            <button className="primary-button device-link__connect" type="button" disabled={!canConnect} onClick={connect}>
              {loading ? <LoaderCircle className="spin" size={17} /> : <Cable size={17} />}
              {!startupReady ? "初始化中…" : loading ? "正在处理…" : error ? "重新连接" : serial ? "只读连接" : "启动仿真"}
            </button>
          </>
        )}
      </div>

      {!connected && serial && !loading && ports.length === 0 && <p className="device-link__hint">插入 USB 数据线后点击刷新；仍未发现设备时请检查数据线与串口驱动。</p>}
      {error && <div className="inline-error device-link__error" role="alert">{error}</div>}

      <details className="device-link__details">
        <summary><ChevronDown size={13} aria-hidden="true" />{remote ? "遥控器桥接说明" : "连接详情"}</summary>
        <div className="device-link__details-content">
          {(connected ? connection.mode === "mock" : !serial) ? (
            <p>仿真提供姿态、轮速和调参交互，命令不会发送到真实设备。</p>
          ) : (
            <>
              <p>串口固定使用 115200 · 8-N-1。{!connected && selectedPortOption ? ` ${selectedPortOption.name} · ${formatPortDetails(selectedPortOption)}` : ""}</p>
              {remote ? <p>需使用配套串口桥接固件；原版遥控器固件不支持串口调参。摇杆继续控制运动和腿高，此连接不提供小车遥测或参数回读；发送成功仅表示电脑已发送，无法确认小车已接收。</p>
                : <p>适用于 Legacy WL1 兼容固件；固件身份无法自动识别。当前串口连接使用只读模式。</p>}
            </>
          )}
        </div>
      </details>
    </section>
  );
}
