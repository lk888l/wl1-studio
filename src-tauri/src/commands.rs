use tauri::{AppHandle, State};

use crate::state::AppState;
use crate::types::{
    ConnectionRequestMode, ConnectionSnapshot, ConnectionTarget, DeviceCapabilities,
    MotionTargetRequest, SerialConfig, SerialPortOption,
};

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
    config: SerialConfig,
) -> Result<ConnectionSnapshot, String> {
    match config.mode {
        ConnectionRequestMode::Mock => state.connect_mock(app),
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
    expected_session_id: Option<u64>,
) -> Result<ConnectionSnapshot, String> {
    state.disconnect(expected_session_id)?;
    state.snapshot()
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
