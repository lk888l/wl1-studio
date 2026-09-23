use std::time::Duration;

use tauri::{AppHandle, Manager, State};

use crate::gamebox::{GameBoxSnapshot, GameBoxState};
use crate::mifare::CardDump;
use crate::nfc::{NfcSnapshot, NfcState, ReadOptions, WriteOptions, WriteReport};
use crate::state::AppState;
use crate::sticks3::{RadioRequest, StickS3Snapshot, StickS3State};
use crate::types::{
    BluetoothDeviceOption, ConnectionRequestMode, ConnectionSnapshot, ConnectionTarget,
    DeviceCapabilities, MotionTargetRequest, SerialConfig, SerialPortOption,
};

/// Upper bound for a whole-card operation. A full read of a 4K card whose keys
/// are all unknown sweeps the dictionary for every sector, which is slow but
/// cancellable; this only exists so a wedged port cannot hang a command forever.
const NFC_OPERATION_TIMEOUT: Duration = Duration::from_secs(600);

/// Serializes product switches across independently owned backends.
/// Order: product lifecycle -> one product's lifecycle -> its session state.
#[derive(Default)]
pub struct ProductSessionLifecycle(pub std::sync::Mutex<()>);

#[tauri::command]
pub fn list_serial_ports() -> Result<Vec<SerialPortOption>, String> {
    let ports = serialport::available_ports().map_err(|error| format!("无法枚举串口: {error}"))?;
    Ok(ports
        .into_iter()
        .map(|port| {
            let (port_type, vid, pid, manufacturer, product, serial_number) = match port.port_type {
                serialport::SerialPortType::UsbPort(info) => (
                    "usb".to_owned(),
                    Some(info.vid),
                    Some(info.pid),
                    info.manufacturer,
                    info.product,
                    info.serial_number,
                ),
                serialport::SerialPortType::BluetoothPort => {
                    ("bluetooth".to_owned(), None, None, None, None, None)
                }
                serialport::SerialPortType::PciPort => {
                    ("pci".to_owned(), None, None, None, None, None)
                }
                serialport::SerialPortType::Unknown => {
                    ("unknown".to_owned(), None, None, None, None, None)
                }
            };
            SerialPortOption {
                name: port.port_name,
                port_type,
                vid,
                pid,
                manufacturer,
                product,
                serial_number,
            }
        })
        .collect())
}

fn ensure_serial_port_available(port_name: &str) -> Result<(), String> {
    if list_serial_ports()?
        .iter()
        .any(|port| port.name == port_name)
    {
        Ok(())
    } else {
        Err("所选串口已不可用或不在系统串口枚举列表中；请刷新设备列表后重试".into())
    }
}

#[tauri::command]
pub async fn scan_bluetooth_devices(
    bluetooth: State<'_, crate::bluetooth::BluetoothState>,
) -> Result<Vec<BluetoothDeviceOption>, String> {
    bluetooth.scan().await
}

#[tauri::command]
pub async fn connect_device(
    app: AppHandle,
    config: SerialConfig,
) -> Result<ConnectionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || connect_device_blocking(&app, config))
        .await
        .map_err(|error| format!("设备连接任务中断: {error}"))?
}

fn connect_device_blocking(
    app: &AppHandle,
    config: SerialConfig,
) -> Result<ConnectionSnapshot, String> {
    let firmware = app.state::<crate::firmware::FirmwareState>();
    let state = app.state::<AppState>();
    let gamebox = app.state::<GameBoxState>();
    let nfc = app.state::<NfcState>();
    let sticks3 = app.state::<StickS3State>();
    let lifecycle = app.state::<ProductSessionLifecycle>();
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    firmware.ensure_idle()?;
    match config.mode {
        ConnectionRequestMode::Mock => {
            sticks3.disconnect(None)?;
            gamebox.disconnect(None)?;
            nfc.disconnect(None)?;
            state.connect_mock(app.clone())
        }
        ConnectionRequestMode::Serial => {
            if !matches!(config.baud_rate, 9_600 | 115_200)
                || (config.connection_target == ConnectionTarget::Remote
                    && config.baud_rate != 115_200)
            {
                return Err("小车支持 9600 / 115200 baud；遥控器桥接固定为 115200 baud".into());
            }
            let port_name = config
                .port_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or("请选择串口")?;
            ensure_serial_port_available(port_name)?;
            sticks3.disconnect(None)?;
            gamebox.disconnect(None)?;
            nfc.disconnect(None)?;
            state.connect_serial(app.clone(), port_name, &config)
        }
        ConnectionRequestMode::Ble => {
            if config.connection_target != ConnectionTarget::Robot {
                return Err("蓝牙 BLE 只支持直连小车".into());
            }
            let id = config
                .ble_device_id
                .as_deref()
                .filter(|id| !id.is_empty())
                .ok_or("请扫描并选择蓝牙设备")?;
            sticks3.disconnect(None)?;
            gamebox.disconnect(None)?;
            nfc.disconnect(None)?;
            state.connect_ble(
                app.clone(),
                &app.state::<crate::bluetooth::BluetoothState>(),
                id,
                config.allow_unsafe_writes,
            )
        }
    }
}

#[tauri::command]
pub async fn disconnect_device(
    app: AppHandle,
    expected_session_id: Option<u64>,
) -> Result<ConnectionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<ProductSessionLifecycle>();
        let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
        let state = app.state::<AppState>();
        state.disconnect(expected_session_id)?;
        state.snapshot()
    })
    .await
    .map_err(|error| format!("设备断开任务中断: {error}"))?
}

#[tauri::command]
pub fn gamebox_connect(
    app: AppHandle,
    firmware: State<'_, crate::firmware::FirmwareState>,
    state: State<'_, AppState>,
    gamebox: State<'_, GameBoxState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    port_name: String,
) -> Result<GameBoxSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    firmware.ensure_idle()?;
    let port_name = port_name.trim();
    if port_name.is_empty() {
        return Err("请选择游戏机串口".into());
    }
    ensure_serial_port_available(port_name)?;
    // Preserve the existing robot safety shutdown when switching products.
    // Its writes target only its previously owned WL1 port, never GameBox.
    state.disconnect(None)?;
    app.state::<StickS3State>().disconnect(None)?;
    app.state::<NfcState>().disconnect(None)?;
    gamebox.connect(app, port_name)
}

#[tauri::command]
pub fn gamebox_disconnect(
    gamebox: State<'_, GameBoxState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    expected_session_id: Option<u64>,
) -> Result<GameBoxSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    gamebox.disconnect(expected_session_id)?;
    gamebox.snapshot()
}

#[tauri::command]
pub fn gamebox_snapshot(gamebox: State<'_, GameBoxState>) -> Result<GameBoxSnapshot, String> {
    gamebox.snapshot()
}

#[tauri::command]
pub fn nfc_connect(
    app: AppHandle,
    firmware: State<'_, crate::firmware::FirmwareState>,
    state: State<'_, AppState>,
    nfc: State<'_, NfcState>,
    gamebox: State<'_, GameBoxState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    port_name: String,
) -> Result<NfcSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    firmware.ensure_idle()?;
    let port_name = port_name.trim();
    if port_name.is_empty() {
        return Err("请选择读卡器串口".into());
    }
    ensure_serial_port_available(port_name)?;
    // Only one product may own a serial port at a time. Each backend closes
    // only the port it previously owned, so switching never writes to the
    // device being abandoned.
    state.disconnect(None)?;
    gamebox.disconnect(None)?;
    app.state::<StickS3State>().disconnect(None)?;
    nfc.connect(app, port_name)
}

#[tauri::command]
pub async fn sticks3_connect(app: AppHandle, port_name: String) -> Result<StickS3Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<ProductSessionLifecycle>();
        let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
        app.state::<crate::firmware::FirmwareState>()
            .ensure_idle()?;
        let port_name = port_name.trim();
        ensure_serial_port_available(port_name)?;
        app.state::<AppState>().disconnect(None)?;
        app.state::<GameBoxState>().disconnect(None)?;
        app.state::<NfcState>().disconnect(None)?;
        app.state::<StickS3State>().connect(port_name)
    })
    .await
    .map_err(|error| format!("S3 连接任务中断：{error}"))?
}

#[tauri::command]
pub async fn sticks3_disconnect(
    app: AppHandle,
    expected_session_id: Option<u64>,
) -> Result<StickS3Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<ProductSessionLifecycle>();
        let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
        app.state::<StickS3State>().disconnect(expected_session_id)
    })
    .await
    .map_err(|error| format!("S3 断开任务中断：{error}"))?
}

#[tauri::command]
pub async fn sticks3_snapshot(app: AppHandle) -> Result<StickS3Snapshot, String> {
    tauri::async_runtime::spawn_blocking(move || app.state::<StickS3State>().snapshot())
        .await
        .map_err(|error| format!("S3 状态任务中断：{error}"))?
}

#[tauri::command]
pub async fn sticks3_request(
    app: AppHandle,
    expected_session_id: u64,
    request: RadioRequest,
) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<StickS3State>()
            .request(expected_session_id, request)
    })
    .await
    .map_err(|error| format!("S3 请求任务中断：{error}"))?
}

#[tauri::command]
pub fn nfc_disconnect(
    nfc: State<'_, NfcState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    expected_session_id: Option<u64>,
) -> Result<NfcSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    nfc.disconnect(expected_session_id)?;
    nfc.snapshot()
}

#[tauri::command]
pub fn nfc_snapshot(nfc: State<'_, NfcState>) -> Result<NfcSnapshot, String> {
    nfc.snapshot()
}

#[tauri::command]
pub fn nfc_cancel(nfc: State<'_, NfcState>) -> Result<(), String> {
    nfc.cancel()
}

#[tauri::command]
pub async fn nfc_read_card(
    app: AppHandle,
    nfc: State<'_, NfcState>,
    options: ReadOptions,
) -> Result<CardDump, String> {
    // State borrows the app; the session is cheap to clone because every field
    // behind it is reference counted, so the blocking work can move off the
    // async runtime without holding a borrow across the await.
    let nfc = nfc.inner().clone();
    tauri::async_runtime::spawn_blocking(move || nfc.read(app, options, NFC_OPERATION_TIMEOUT))
        .await
        .map_err(|error| format!("NFC 读取任务中断: {error}"))?
}

#[tauri::command]
pub async fn nfc_write_card(
    app: AppHandle,
    nfc: State<'_, NfcState>,
    dump: CardDump,
    options: WriteOptions,
) -> Result<WriteReport, String> {
    let nfc = nfc.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        nfc.write(app, dump, options, NFC_OPERATION_TIMEOUT)
    })
    .await
    .map_err(|error| format!("NFC 写入任务中断: {error}"))?
}

#[tauri::command]
pub async fn send_text_command(
    app: AppHandle,
    command: String,
    expected_session_id: u64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .send_command(&app, &command, expected_session_id)
    })
    .await
    .map_err(|error| format!("命令发送任务中断: {error}"))?
}

#[tauri::command]
pub async fn send_motion_target(
    app: AppHandle,
    target: MotionTargetRequest,
    expected_session_id: u64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<AppState>()
            .send_motion(&app, &target, expected_session_id)
    })
    .await
    .map_err(|error| format!("运动发送任务中断: {error}"))?
}

#[tauri::command]
pub async fn set_telemetry(
    app: AppHandle,
    enabled: bool,
    expected_session_id: u64,
) -> Result<ConnectionSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<AppState>();
        state.set_telemetry(&app, enabled, expected_session_id)?;
        state.snapshot()
    })
    .await
    .map_err(|error| format!("遥测切换任务中断: {error}"))?
}

#[tauri::command]
pub fn connection_snapshot(state: State<'_, AppState>) -> Result<ConnectionSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub fn device_capabilities(connection_target: Option<ConnectionTarget>) -> DeviceCapabilities {
    DeviceCapabilities::for_target(connection_target.unwrap_or_default())
}
