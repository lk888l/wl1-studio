use std::time::Duration;

use tauri::{AppHandle, State};

use crate::gamebox::{GameBoxSnapshot, GameBoxState};
use crate::mifare::CardDump;
use crate::nfc::{NfcSnapshot, NfcState, ReadOptions, WriteOptions, WriteReport};
use crate::state::AppState;
use crate::types::{
    ConnectionRequestMode, ConnectionSnapshot, ConnectionTarget, DeviceCapabilities,
    MotionTargetRequest, SerialConfig, SerialPortOption,
};

/// Upper bound for a whole-card operation. A full read of a 4K card whose keys
/// are all unknown sweeps the dictionary for every sector, which is slow but
/// cancellable; this only exists so a wedged port cannot hang a command forever.
const NFC_OPERATION_TIMEOUT: Duration = Duration::from_secs(600);

/// Serializes product switches across both independently owned backends.
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
pub fn connect_device(
    app: AppHandle,
    state: State<'_, AppState>,
    gamebox: State<'_, GameBoxState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    config: SerialConfig,
) -> Result<ConnectionSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    match config.mode {
        ConnectionRequestMode::Mock => {
            gamebox.disconnect(None)?;
            state.connect_mock(app)
        }
        ConnectionRequestMode::Serial => {
            if config.baud_rate != 115_200 {
                return Err("WL1 Legacy 固件当前只验证了 115200 baud".into());
            }
            let port_name = config
                .port_name
                .as_deref()
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .ok_or("请选择串口")?;
            ensure_serial_port_available(port_name)?;
            gamebox.disconnect(None)?;
            state.connect_serial(
                app,
                port_name,
                config.baud_rate,
                config.allow_unsafe_writes,
                config.connection_target,
            )
        }
    }
}

#[tauri::command]
pub fn disconnect_device(
    state: State<'_, AppState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    expected_session_id: Option<u64>,
) -> Result<ConnectionSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    state.disconnect(expected_session_id)?;
    state.snapshot()
}

#[tauri::command]
pub fn gamebox_connect(
    app: AppHandle,
    state: State<'_, AppState>,
    gamebox: State<'_, GameBoxState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    port_name: String,
) -> Result<GameBoxSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    let port_name = port_name.trim();
    if port_name.is_empty() {
        return Err("请选择游戏机串口".into());
    }
    ensure_serial_port_available(port_name)?;
    // Preserve the existing robot safety shutdown when switching products.
    // Its writes target only its previously owned WL1 port, never GameBox.
    state.disconnect(None)?;
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
    state: State<'_, AppState>,
    nfc: State<'_, NfcState>,
    gamebox: State<'_, GameBoxState>,
    lifecycle: State<'_, ProductSessionLifecycle>,
    port_name: String,
) -> Result<NfcSnapshot, String> {
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
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
    nfc.connect(app, port_name)
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
pub fn send_text_command(
    app: AppHandle,
    state: State<'_, AppState>,
    command: String,
    expected_session_id: u64,
) -> Result<(), String> {
    state.send_command(&app, &command, expected_session_id)
}

#[tauri::command]
pub fn send_motion_target(
    app: AppHandle,
    state: State<'_, AppState>,
    target: MotionTargetRequest,
    expected_session_id: u64,
) -> Result<(), String> {
    state.send_motion(&app, &target, expected_session_id)
}

#[tauri::command]
pub fn set_telemetry(
    app: AppHandle,
    state: State<'_, AppState>,
    enabled: bool,
    expected_session_id: u64,
) -> Result<ConnectionSnapshot, String> {
    state.set_telemetry(&app, enabled, expected_session_id)?;
    state.snapshot()
}

#[tauri::command]
pub fn connection_snapshot(state: State<'_, AppState>) -> Result<ConnectionSnapshot, String> {
    state.snapshot()
}

#[tauri::command]
pub fn device_capabilities(connection_target: Option<ConnectionTarget>) -> DeviceCapabilities {
    DeviceCapabilities::for_target(connection_target.unwrap_or_default())
}
