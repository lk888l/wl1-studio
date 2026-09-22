import { Bluetooth, Cable, Check, ChevronDown, LoaderCircle, Radio, RadioTower, RefreshCw, Unplug, Usb } from "lucide-react";
import { useEffect, useState } from "react";

import type { BluetoothDeviceOption, ConnectionChoice, ConnectionSnapshot, SerialConfig, SerialPortOption } from "../types";
import { isTauriRuntime } from "../lib/device";
import { isBluetoothConnection, isRemoteConnection } from "../lib/connection";
import { loadConnectionPreferences, saveConnectionPreferences, selectAvailablePort } from "../lib/connection-preferences";
import "./ConnectionModal.css";

interface ConnectionModalProps {
  connection: ConnectionSnapshot;
  ports: readonly SerialPortOption[];
  bluetoothDevices: readonly BluetoothDeviceOption[];
  loading: boolean;
  startupReady: boolean;
  error: string | null;
  onRefresh: () => void;
  onScanBluetooth: () => void;
  onConnect: (config: SerialConfig) => void;
  onDisconnect: () => void;
}

export function ConnectionModal({ connection, ports, bluetoothDevices, loading, startupReady, error, onRefresh, onScanBluetooth, onConnect, onDisconnect }: ConnectionModalProps) {
  const desktop = isTauriRuntime();
  const [preferences, setPreferences] = useState(loadConnectionPreferences);
  const [choice, setChoice] = useState<ConnectionChoice>(() => desktop ? preferences.target : "mock");
  const [selectedPort, setSelectedPort] = useState(preferences.portName);
  const [selectedBluetooth, setSelectedBluetooth] = useState(preferences.bleDeviceId);
  const [writePermission, setWritePermission] = useState<string | null>(null);
  const connected = connection.mode !== "disconnected";
  const real = choice !== "mock";
  const ble = choice === "ble";
  const remote = connected ? isRemoteConnection(connection) : choice === "remote";
  const bluetooth = connected ? isBluetoothConnection(connection) : ble;
  const permissionScope = JSON.stringify([choice, selectedPort, selectedBluetooth, connected]);
  const allowWrites = writePermission === permissionScope;

  useEffect(() => {
    if (!loading) setSelectedPort((current) => selectAvailablePort(ports, current, preferences.portName));
  }, [loading, ports, preferences.portName]);

  useEffect(() => {
    if (loading) return;
    setSelectedBluetooth((current) => bluetoothDevices.some((device) => device.id === current) ? current
      : bluetoothDevices.find((device) => device.id === preferences.bleDeviceId)?.id
        ?? (bluetoothDevices.length === 1 ? bluetoothDevices[0]?.id ?? "" : ""));
  }, [bluetoothDevices, loading, preferences.bleDeviceId]);

  useEffect(() => {
    // Permission belongs only to the selected device and this connection.
    setWritePermission((current) => current === permissionScope ? current : null);
  }, [permissionScope]);

  const port = ports.find((item) => item.name === selectedPort);
  const device = bluetoothDevices.find((item) => item.id === selectedBluetooth);
  const canConnect = !loading && startupReady && (!real || (desktop && (ble ? !!device : !!port)));

  function chooseTarget(target: ConnectionChoice) {
    setChoice(target);
    if (target === "mock") return;
    const next = { ...preferences, target, baudRate: target === "remote" ? 115200 as const : preferences.baudRate };
    setPreferences(next);
    saveConnectionPreferences(next);
  }

  function connect() {
    if (!canConnect) return;
    if (choice !== "mock") {
      const next = { ...preferences, target: choice, portName: selectedPort, bleDeviceId: selectedBluetooth };
      setPreferences(next);
      saveConnectionPreferences(next);
    }
    onConnect({
      mode: choice === "mock" ? "mock" : ble ? "ble" : "serial",
      connectionTarget: choice === "remote" ? "remote" : "robot",
      portName: real && !ble ? selectedPort : undefined,
      bleDeviceId: ble ? selectedBluetooth : undefined,
      baudRate: choice === "remote" ? 115200 : preferences.baudRate,
      allowUnsafeWrites: !real || allowWrites,
    });
  }

  return (
    <section id="device-connection" className={`device-link glass-panel${connected ? " is-connected" : ""}`} aria-label="设备连接">
      <div className="device-link__main">
        <div className="device-link__identity">
          <span className="device-link__icon" aria-hidden="true">{connected ? <Check size={20} /> : bluetooth ? <Bluetooth size={20} /> : <Cable size={20} />}</span>
          <div>
            <strong>{connected ? connection.label : "连接 WL1"}</strong>
            <span>{connected
              ? connection.mode === "mock" ? "仿真已连接" : `${bluetooth ? "蓝牙" : remote ? "遥控器串口" : "小车串口"}已连接 · ${connection.writesUnlocked ? "允许调参 / 控制" : "只读"}`
              : desktop ? "选择连接方式和设备" : "浏览器仿真预览"}</span>
          </div>
        </div>
        {connected ? <>
          <div className="device-link__connected-note">{connection.mode === "mock" ? "仿真数据运行中" : connection.mode === "ble" ? "ZX-D30 · BLE 透传" : `${connection.baudRate ?? 115200} baud`}</div>
          <button className="secondary-button device-link__disconnect" type="button" disabled={loading} onClick={onDisconnect}>
            {loading ? <LoaderCircle className="spin" size={17} /> : <Unplug size={17} />}断开连接
          </button>
        </> : <>
          <fieldset className="device-link__choices" aria-label="连接方式" disabled={loading}>
            {desktop && <>
              <button type="button" aria-pressed={choice === "ble"} className={ble ? "is-active" : ""} onClick={() => chooseTarget("ble")}><Bluetooth size={16} />蓝牙 BLE</button>
              <button type="button" aria-pressed={choice === "robot"} className={choice === "robot" ? "is-active" : ""} onClick={() => chooseTarget("robot")}><Usb size={16} />USB 串口</button>
              <button type="button" aria-pressed={choice === "remote"} className={choice === "remote" ? "is-active" : ""} onClick={() => chooseTarget("remote")}><RadioTower size={16} />遥控器</button>
            </>}
            <button type="button" aria-pressed={choice === "mock"} className={choice === "mock" ? "is-active" : ""} onClick={() => chooseTarget("mock")}><Radio size={16} />仿真</button>
          </fieldset>
          {real ? <div className="device-link__port">
            {ble ? <>
              <select aria-label="蓝牙设备" value={device ? selectedBluetooth : ""} disabled={loading || !bluetoothDevices.length} onChange={(event) => setSelectedBluetooth(event.target.value)}>
                <option value="" disabled>{loading ? "正在处理蓝牙…" : "扫描并选择蓝牙设备"}</option>
                {bluetoothDevices.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.address}{item.rssi == null ? "" : ` · ${item.rssi} dBm`}</option>)}
              </select>
              <button className="secondary-button device-link__scan" type="button" disabled={loading || !startupReady} onClick={onScanBluetooth}><RefreshCw size={15} className={loading ? "spin" : undefined} />扫描</button>
            </> : <>
              <select aria-label={remote ? "遥控器串口" : "小车串口"} value={port ? selectedPort : ""} disabled={loading || !ports.length} onChange={(event) => setSelectedPort(event.target.value)}>
                <option value="" disabled>{loading ? "正在查找串口…" : !ports.length ? "未发现串口" : "选择串口"}</option>
                {ports.map((item) => <option key={item.name} value={item.name}>{item.name}{item.product ? ` · ${item.product}` : ""}</option>)}
              </select>
              <button className="icon-button" type="button" aria-label="刷新串口" title="刷新串口" disabled={loading} onClick={onRefresh}><RefreshCw size={16} className={loading ? "spin" : undefined} /></button>
            </>}
          </div> : <span className="device-link__preview">无需设备即可体验调参和遥控</span>}
          <button className="primary-button device-link__connect" type="button" disabled={!canConnect} onClick={connect}>
            {loading ? <LoaderCircle className="spin" size={17} /> : bluetooth ? <Bluetooth size={17} /> : <Cable size={17} />}
            {!startupReady ? "初始化中…" : loading ? "正在处理…" : !real ? "启动仿真" : allowWrites ? "连接并允许控制" : "只读连接"}
          </button>
        </>}
      </div>

      {!connected && real && <div className="device-link__options">
        {!ble && !remote && <label className="device-link__baud">波特率
          <select aria-label="串口波特率" value={preferences.baudRate} disabled={loading} onChange={(event) => {
            const next = { ...preferences, baudRate: Number(event.target.value) as 9600 | 115200 };
            setPreferences(next); saveConnectionPreferences(next); setWritePermission(null);
          }}><option value={9600}>9600</option><option value={115200}>115200</option></select>
        </label>}
        <label className="device-link__write-permission"><input type="checkbox" checked={allowWrites} disabled={loading} onChange={(event) => setWritePermission(event.target.checked ? permissionScope : null)} /><span>允许本次连接{remote ? "调参" : "遥控与调参"}：已确认固件兼容、车轮架空、人员远离且可立即断电</span></label>
      </div>}
      {!connected && ble && <p className="device-link__hint">打开电脑蓝牙和小车电源，点击扫描并选择 ZX-D30 的实际广播名称；先断开微信或其他设备的连接。</p>}
      {!connected && real && !ble && !loading && !ports.length && <p className="device-link__hint">插入 USB 数据线后点击刷新；仍未发现设备时请检查数据线与串口驱动。</p>}
      {error && <div className="inline-error device-link__error" role="alert">{error}</div>}
      <details className="device-link__details">
        <summary><ChevronDown size={13} aria-hidden="true" />{bluetooth ? "蓝牙连接说明" : remote ? "遥控器桥接说明" : "连接详情"}</summary>
        <div className="device-link__details-content">
          {(connected ? connection.mode === "mock" : !real) ? <p>仿真提供姿态、轮速和遥控交互，命令不会发送到真实设备。</p> : bluetooth ? <>
            <p>适用于 ZX-D30 单模 BLE 和支持蓝牙分帧的 WL1 SoftEngine 固件。自动匹配 BLE 透传通道，不需要设置波特率；模块与小车之间的 UART 应匹配，当前配套固件为 9600 · 8-N-1。</p>
            <p>允许写入后，选择本次腿高并启用实时控制，使用 W/A/S/D、方向键或屏幕按钮按住移动；空格 / Esc 停止。蓝牙以 10 Hz 更新目标，松开保持腿高并归零速度、转向和横滚。</p>
            <p>连续遥测默认关闭；9600 baud 不适合同时传输固件全速 IMU / RPM。连接成功和发送成功均不代表小车已确认执行。</p>
          </> : <>
            <p>串口使用 {connected ? connection.baudRate : remote ? 115200 : preferences.baudRate} · 8-N-1。{!connected && port ? `${port.name} · ${port.product ?? port.manufacturer ?? port.portType}` : ""}</p>
            {remote ? <p>需配套串口桥接固件；实体摇杆控制运动和腿高，仅支持无线调参，无小车遥测回传。</p> : <p>适用于 Legacy WL1 兼容固件，固件身份无法自动识别。首次连接默认只读；写入许可不会跨连接保存。</p>}
          </>}
        </div>
      </details>
    </section>
  );
}
