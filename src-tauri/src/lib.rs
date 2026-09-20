#![forbid(unsafe_code)]

mod commands;
mod firmware;
mod firmware_image;
mod firmware_usb;
mod gamebox;
mod mifare;
mod nfc;
mod pn532;
mod protocol;
mod state;
mod transport;
mod types;

use tauri::Manager;

#[cfg(target_os = "linux")]
fn linux_effective_uid(proc_status: &str) -> Option<u32> {
    let uid_line = proc_status.lines().find(|line| line.starts_with("Uid:"))?;
    let mut fields = uid_line.split_ascii_whitespace();
    if fields.next()? != "Uid:" {
        return None;
    }
    let _real_uid = fields.next()?;
    fields.next()?.parse().ok()
}

#[cfg(target_os = "linux")]
fn refuse_linux_root_execution() {
    let Ok(proc_status) = std::fs::read_to_string("/proc/self/status") else {
        return;
    };
    if linux_effective_uid(&proc_status) == Some(0) {
        eprintln!(
            "WL1 Studio refuses to run as root. Grant serial access through dialout or a precise udev rule."
        );
        std::process::exit(1);
    }
}

pub fn run() {
    #[cfg(target_os = "linux")]
    refuse_linux_root_execution();
    tauri::Builder::default()
        .manage(state::AppState::default())
        .manage(gamebox::GameBoxState::default())
        .manage(nfc::NfcState::default())
        .manage(commands::ProductSessionLifecycle::default())
        .manage(firmware::FirmwareState::default())
        .invoke_handler(tauri::generate_handler![
            firmware::firmware_status,
            firmware::firmware_list_probes,
            firmware::firmware_inspect,
            firmware::firmware_read,
            firmware::firmware_erase,
            firmware::firmware_flash,
            firmware_usb::firmware_usb_support,
            firmware_usb::firmware_install_usb_support,
            commands::list_serial_ports,
            commands::connect_device,
            commands::disconnect_device,
            commands::send_text_command,
            commands::send_motion_target,
            commands::set_telemetry,
            commands::connection_snapshot,
            commands::device_capabilities,
            commands::gamebox_connect,
            commands::gamebox_disconnect,
            commands::gamebox_snapshot,
            commands::nfc_connect,
            commands::nfc_disconnect,
            commands::nfc_snapshot,
            commands::nfc_cancel,
            commands::nfc_read_card,
            commands::nfc_write_card,
        ])
        .build(tauri::generate_context!())
        .expect("WL1 Studio 初始化失败")
        .run(|app, event| {
            // A normal close must not abort a flash sector halfway through.
            // Force-killing the process or power loss cannot be prevented here.
            if app.state::<firmware::FirmwareState>().snapshot().busy {
                match &event {
                    tauri::RunEvent::WindowEvent {
                        event: tauri::WindowEvent::CloseRequested { api, .. },
                        ..
                    } => {
                        api.prevent_close();
                    }
                    tauri::RunEvent::ExitRequested { api, .. } => api.prevent_exit(),
                    _ => {}
                }
                return;
            }
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let state = app.state::<state::AppState>();
                let gamebox = app.state::<gamebox::GameBoxState>();
                let nfc = app.state::<nfc::NfcState>();
                let lifecycle = app.state::<commands::ProductSessionLifecycle>();
                let _lifecycle = lifecycle
                    .0
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let _ = state.disconnect(None);
                let _ = gamebox.disconnect(None);
                let _ = nfc.disconnect(None);
            }
        });
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::linux_effective_uid;

    #[test]
    fn parses_linux_effective_uid() {
        let status = "Name:\twl1-studio\nUid:\t1000\t1001\t1002\t1003\n";
        assert_eq!(linux_effective_uid(status), Some(1001));
    }

    #[test]
    fn rejects_malformed_linux_uid_status() {
        assert_eq!(linux_effective_uid("Uid:\tinvalid\n"), None);
    }
}
