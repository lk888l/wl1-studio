#![forbid(unsafe_code)]

mod bluetooth;
mod commands;
mod deskpet;
mod desktop;
mod firmware;
mod firmware_image;
mod firmware_target;
mod firmware_usb;
mod gamebox;
mod mifare;
mod nfc;
mod pc_monitor;
mod pn532;
mod protocol;
mod state;
mod sticks3;
mod sticks3_network;
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
    let mut builder = tauri::Builder::default();
    if !desktop::is_ui_worker() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|arg| arg == "--show")
                || !args.iter().any(|arg| arg == "--background")
            {
                desktop::request_show_main(app);
            }
        }));
    }
    builder
        .manage(desktop::DesktopState::default())
        .manage(state::AppState::default())
        .manage(bluetooth::BluetoothState::default())
        .manage(gamebox::GameBoxState::default())
        .manage(deskpet::PetState::default())
        .manage(pc_monitor::PcMonitorState::default())
        .manage(nfc::NfcState::default())
        .manage(sticks3::StickS3State::default())
        .manage(sticks3_network::StickS3NetworkState::default())
        .manage(commands::ProductSessionLifecycle::default())
        .manage(firmware::FirmwareState::default())
        .setup(desktop::setup)
        .invoke_handler(tauri::generate_handler![
            desktop::desktop_enter_background,
            desktop::desktop_save_preferences,
            pc_monitor::pc_monitor_start,
            pc_monitor::pc_monitor_stop,
            pc_monitor::pc_monitor_snapshot,
            pc_monitor::pc_monitor_devices,
            firmware::firmware_status,
            firmware::firmware_list_probes,
            firmware::firmware_inspect,
            firmware::firmware_read,
            firmware::firmware_identify,
            firmware::firmware_verify,
            firmware::firmware_reset,
            firmware::firmware_erase,
            firmware::firmware_flash,
            firmware_usb::firmware_usb_support,
            firmware_usb::firmware_install_usb_support,
            commands::list_serial_ports,
            commands::scan_bluetooth_devices,
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
            commands::sticks3_connect,
            commands::sticks3_disconnect,
            commands::sticks3_snapshot,
            commands::sticks3_request,
            commands::pet_connect,
            commands::pet_disconnect,
            commands::pet_snapshot,
            commands::pet_command,
            sticks3_network::sticks3_network_discover,
            sticks3_network::sticks3_network_probe,
        ])
        .build(tauri::generate_context!())
        .expect("WL1 Studio 初始化失败")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if code.is_none()
                    && desktop::is_ui_worker()
                    && !app.state::<desktop::DesktopState>().tray_available()
                {
                    api.prevent_exit();
                    desktop::request_quit(app);
                    return;
                }
                // The UI owns hardware jobs; wait for its accepted shutdown
                // before the tray stops the sender and exits.
                if desktop::defer_exit_to_ui(app) {
                    api.prevent_exit();
                    return;
                }
            }
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
            if let tauri::RunEvent::ExitRequested { api, code, .. } = &event {
                if !desktop::confirm_quit(app, *code) {
                    api.prevent_exit();
                    return;
                }
            }
            if app.state::<desktop::DesktopState>().tray_available() {
                match &event {
                    tauri::RunEvent::WindowEvent {
                        label,
                        event: tauri::WindowEvent::CloseRequested { api, .. },
                        ..
                    } if label == "main" => {
                        api.prevent_close();
                        desktop::request_background(app);
                        return;
                    }
                    // Destruction of the last WebView must keep the native
                    // tray and sender alive. Explicit Quit uses Some(code).
                    tauri::RunEvent::ExitRequested {
                        code: None, api, ..
                    } => {
                        api.prevent_exit();
                        return;
                    }
                    _ => {}
                }
            }
            #[cfg(target_os = "macos")]
            if matches!(event, tauri::RunEvent::Reopen { .. }) {
                desktop::request_show_main(app);
            }
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let _ = app.state::<pc_monitor::PcMonitorState>().0.stop(None);
                let lifecycle = app.state::<commands::ProductSessionLifecycle>();
                let _lifecycle = lifecycle
                    .0
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let _ = desktop::disconnect_products(app);
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
