mod commands;
mod protocol;
mod state;
mod transport;
mod types;

use tauri::Manager;

pub fn run() {
    tauri::Builder::default()
        .manage(state::AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::list_serial_ports,
            commands::connect_device,
            commands::disconnect_device,
            commands::send_text_command,
            commands::send_motion_target,
            commands::set_telemetry,
            commands::connection_snapshot,
            commands::device_capabilities,
        ])
        .build(tauri::generate_context!())
        .expect("WL1 Studio 初始化失败")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                let state = app.state::<state::AppState>();
                let _ = state.disconnect(None);
            }
        });
}
