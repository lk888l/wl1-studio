//! Native tray and settings survive destruction of the main WebView.
pub(crate) mod bridge;
pub(crate) mod lifecycle;
mod portable;
mod resources;
mod settings;
pub(crate) mod storage_api;
mod ui_process;
mod user_config;

use pc_monitor_core::{MonitorConfig, MonitorSnapshot};
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, WebviewWindowBuilder};

use resources::{ResourceSampler, ResourceUsage};
pub use settings::Preferences;
use settings::SettingsStore;
pub use ui_process::{confirm_quit, defer_exit_to_ui, is_worker as is_ui_worker, request_quit};

const TRAY_ID: &str = "studio-background";

struct TrayControls {
    start: MenuItem<tauri::Wry>,
    stop: MenuItem<tauri::Wry>,
}

#[derive(Default)]
pub struct DesktopState {
    settings: Mutex<SettingsStore>,
    user_config: Mutex<user_config::UserConfigStore>,
    resources: Mutex<ResourceSampler>,
    warning: Mutex<Option<String>>,
    tray: OnceLock<TrayControls>,
    tray_available: AtomicBool,
    foreground: AtomicBool,
    transitioning: AtomicBool,
    ui_ready: AtomicBool,
    exit_authorized: AtomicBool,
    close: Mutex<lifecycle::CloseState>,
    ui: ui_process::UiProcess,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DesktopSnapshot {
    pub preferences: Preferences,
    pub monitor_config: Option<MonitorConfig>,
    pub tray_available: bool,
    pub resources: ResourceUsage,
    pub warning: Option<String>,
}

impl DesktopState {
    pub fn tray_available(&self) -> bool {
        self.tray_available.load(Ordering::Acquire)
    }

    pub fn warning(&self) -> Option<String> {
        lock(&self.warning).clone()
    }

    pub fn ensure_foreground(&self) -> Result<(), String> {
        if self.foreground.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err("轻量后台仅保留电脑监控传输，请先从托盘打开控制中心".into())
        }
    }

    pub fn snapshot(&self, monitor: &MonitorSnapshot) -> DesktopSnapshot {
        let store = lock(&self.settings);
        let warning = [
            store.warning.clone(),
            lock(&self.user_config).warning.clone(),
            lock(&self.warning).clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        DesktopSnapshot {
            preferences: store.saved.preferences.clone(),
            monitor_config: store.saved.monitor_config.clone(),
            tray_available: self.tray_available(),
            resources: lock(&self.resources).sample(monitor),
            warning: (!warning.is_empty()).then(|| warning.join("；")),
        }
    }
}

/// Guard connection/flash entry points while holding ProductSessionLifecycle.
pub fn ensure_foreground(app: &AppHandle) -> Result<(), String> {
    app.state::<DesktopState>().ensure_foreground()
}

pub fn remember_monitor(app: &AppHandle, monitor: &MonitorSnapshot) {
    let desktop = app.state::<DesktopState>();
    {
        let mut store = lock(&desktop.settings);
        store.saved.monitor_enabled = monitor.running;
        if let Some(target_ip) = &monitor.target_ip {
            store.saved.monitor_config = Some(MonitorConfig {
                target_ip: target_ip.clone(),
                gpu_enabled: monitor.gpu_enabled,
                gpu_uuid: monitor.gpu_uuid.clone(),
                interval_ms: monitor.interval_ms,
            });
        }
        // The visible snapshot reports persistence failures without stopping UDP.
        let _ = store.save();
    }
    refresh_tray(app, monitor);
}

fn refresh_tray(app: &AppHandle, monitor: &MonitorSnapshot) {
    let desktop = app.state::<DesktopState>();
    if let Some(controls) = desktop.tray.get() {
        let configured = lock(&desktop.settings).saved.monitor_config.is_some();
        let _ = controls.start.set_enabled(!monitor.running && configured);
        let _ = controls.stop.set_enabled(monitor.running);
    }
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        let label = if monitor.running {
            format!(
                "WL1 Studio · Wi-Fi 发送中 → {}",
                monitor.target_ip.as_deref().unwrap_or("")
            )
        } else {
            "WL1 Studio · 传输已停止".into()
        };
        let _ = tray.set_tooltip(Some(label));
    }
}

/// Called on the event-loop thread. The monitor session is never replaced.
fn show_main(app: &AppHandle) -> Result<(), String> {
    let desktop = app.state::<DesktopState>();
    if !is_ui_worker() {
        return desktop.ui.show(app);
    }
    if desktop.transitioning.load(Ordering::Acquire) {
        return Err("正在释放工作台，请稍后从托盘重新打开".into());
    }
    if let Some(window) = app.get_webview_window("main") {
        window.unminimize().map_err(|error| error.to_string())?;
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
    } else {
        let config = app
            .config()
            .app
            .windows
            .iter()
            .find(|window| window.label == "main")
            .ok_or("找不到主窗口配置")?;
        WebviewWindowBuilder::from_config(app, config)
            .map_err(|error| error.to_string())?
            .visible(true)
            .build()
            .map_err(|error| format!("无法恢复控制中心：{error}"))?;
    }
    desktop.foreground.store(true, Ordering::Release);
    Ok(())
}

pub fn request_show_main(app: &AppHandle) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || {
        if let Err(error) = show_main(&handle) {
            report_error(&handle, error);
        }
    }) {
        report_error(app, error.to_string());
    }
}

fn report_error(app: &AppHandle, error: String) {
    eprintln!("WL1 Studio: {error}");
    *lock(&app.state::<DesktopState>().warning) = Some(error);
}

/// Caller owns ProductSessionLifecycle. Attempt every release if one fails.
pub fn disconnect_products(app: &AppHandle) -> Result<(), String> {
    let errors = [
        app.state::<crate::state::AppState>().disconnect(None),
        app.state::<crate::gamebox::GameBoxState>().disconnect(None),
        app.state::<crate::nfc::NfcState>().disconnect(None),
        app.state::<crate::sticks3::StickS3State>()
            .disconnect(None)
            .map(|_| ()),
        app.state::<crate::deskpet::PetState>()
            .disconnect(None)
            .map(|_| ()),
    ]
    .into_iter()
    .filter_map(Result::err)
    .collect::<Vec<_>>();
    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join("；"))
    }
}

async fn enter_background(app: AppHandle) -> Result<(), String> {
    let desktop = app.state::<DesktopState>();
    if !desktop.tray_available() {
        return Err("系统托盘不可用，请保留或最小化窗口以继续传输".into());
    }
    if !is_ui_worker() {
        return Err("请先打开控制中心，再进入轻量后台".into());
    }
    if desktop.transitioning.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = handle.state::<crate::commands::ProductSessionLifecycle>();
        let _lifecycle = lock(&lifecycle.0);
        handle
            .state::<crate::firmware::FirmwareState>()
            .ensure_idle()?;
        handle
            .state::<crate::sticks3_network::StickS3NetworkState>()
            .ensure_idle()?;
        let desktop = handle.state::<DesktopState>();
        desktop.foreground.store(false, Ordering::Release);
        if let Err(error) = disconnect_products(&handle) {
            desktop.foreground.store(true, Ordering::Release);
            return Err(error);
        }
        if let Some(window) = handle.get_webview_window("main") {
            lifecycle::authorize_exit(&handle, true);
            if let Err(error) = window.destroy() {
                lifecycle::authorize_exit(&handle, false);
                desktop.foreground.store(true, Ordering::Release);
                return Err(format!("无法释放控制中心窗口：{error}"));
            }
        }
        *lock(&desktop.resources) = ResourceSampler::default();
        lifecycle::authorize_exit(&handle, true);
        // Exit the disposable UI runtime as well as its WebView. The tray
        // process keeps the same sampler/socket/session without interruption.
        handle.exit(0);
        Ok(())
    })
    .await
    .map_err(|error| format!("后台切换任务中断：{error}"));
    desktop.transitioning.store(false, Ordering::Release);
    match result {
        Ok(result) => result,
        Err(error) => {
            desktop.foreground.store(true, Ordering::Release);
            Err(error)
        }
    }
}

pub fn request_background(app: &AppHandle) {
    if is_ui_worker() {
        lifecycle::request(app, lifecycle::CloseAction::Background);
    } else if let Err(error) = app
        .state::<DesktopState>()
        .ui
        .send(ui_process::Control::Background)
    {
        report_error(app, error);
        request_show_main(app);
    }
}

pub fn request_close(app: &AppHandle) {
    lifecycle::request(app, lifecycle::CloseAction::Close);
}

#[tauri::command]
pub async fn desktop_enter_background(app: AppHandle) -> Result<(), String> {
    lifecycle::prepare(&app, lifecycle::CloseAction::Background)
}

#[tauri::command]
pub async fn desktop_save_preferences(
    app: AppHandle,
    preferences: Preferences,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if is_ui_worker() {
            return match bridge::call(bridge::Request::SavePreferences(preferences))? {
                bridge::Reply::Saved => Ok(()),
                _ => Err("后台设置保存响应无效".into()),
            };
        }
        storage_api::ensure_writable(&app)?;
        let desktop = app.state::<DesktopState>();
        let mut store = lock(&desktop.settings);
        store.saved.preferences = preferences;
        store.save()
    })
    .await
    .map_err(|error| format!("后台设置保存任务中断：{error}"))?
}

#[cfg(target_os = "linux")]
fn tray_host_available() -> bool {
    // AppIndicator creation can succeed even when GNOME has no tray host.
    use dbus::blocking::stdintf::org_freedesktop_dbus::Properties;
    use dbus::blocking::Connection;
    let Ok(connection) = Connection::new_session() else {
        return false;
    };
    let proxy = connection.with_proxy(
        "org.freedesktop.DBus",
        "/org/freedesktop/DBus",
        std::time::Duration::from_secs(1),
    );
    let result: Result<(bool,), _> = proxy.method_call(
        "org.freedesktop.DBus",
        "NameHasOwner",
        ("org.kde.StatusNotifierWatcher",),
    );
    if !matches!(result, Ok((true,))) {
        return false;
    }
    let watcher = connection.with_proxy(
        "org.kde.StatusNotifierWatcher",
        "/StatusNotifierWatcher",
        std::time::Duration::from_secs(1),
    );
    watcher
        .get::<bool>(
            "org.kde.StatusNotifierWatcher",
            "IsStatusNotifierHostRegistered",
        )
        .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn tray_host_available() -> bool {
    true
}

fn build_tray(app: &AppHandle) -> Result<(), String> {
    let build = || -> tauri::Result<TrayControls> {
        let show = MenuItem::with_id(app, "show", "打开控制中心", true, None::<&str>)?;
        let background = MenuItem::with_id(app, "background", "轻量后台运行", true, None::<&str>)?;
        let start = MenuItem::with_id(app, "start", "恢复 Wi-Fi 传输", false, None::<&str>)?;
        let stop = MenuItem::with_id(app, "stop", "停止 Wi-Fi 传输", false, None::<&str>)?;
        let quit = MenuItem::with_id(app, "quit", "退出 WL1 Studio", true, None::<&str>)?;
        let separator = PredefinedMenuItem::separator(app)?;
        let menu = Menu::with_items(app, &[&show, &background, &separator, &start, &stop, &quit])?;
        let mut tray = TrayIconBuilder::with_id(TRAY_ID)
            .menu(&menu)
            .tooltip("WL1 Studio · 后台传输")
            .show_menu_on_left_click(false)
            .on_menu_event(|app, event| match event.id.as_ref() {
                "show" => request_show_main(app),
                "background" => request_background(app),
                "start" => {
                    let config = lock(&app.state::<DesktopState>().settings)
                        .saved
                        .monitor_config
                        .clone();
                    if let Some(config) = config {
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = crate::pc_monitor::start(&app, config) {
                                report_error(&app, error);
                                request_show_main(&app);
                            }
                        });
                    }
                }
                "stop" => {
                    let app = app.clone();
                    tauri::async_runtime::spawn_blocking(move || {
                        if let Err(error) = crate::pc_monitor::stop(&app, None) {
                            report_error(&app, error);
                            request_show_main(&app);
                        }
                    });
                }
                "quit" => ui_process::request_quit(app),
                _ => {}
            })
            .on_tray_icon_event(|tray, event| {
                if matches!(
                    event,
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                ) {
                    request_show_main(tray.app_handle());
                }
            });
        if let Some(icon) = app.default_window_icon() {
            tray = tray.icon(icon.clone());
        }
        tray.build(app)?;
        Ok(TrayControls { start, stop })
    };
    let controls = build().map_err(|error| format!("无法建立系统托盘：{error}"))?;
    let _ = app.state::<DesktopState>().tray.set(controls);
    Ok(())
}

pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle();
    let desktop = handle.state::<DesktopState>();
    if let Some(endpoint) = bridge::ui_endpoint()? {
        desktop
            .tray_available
            .store(endpoint.tray_available, Ordering::Release);
        ui_process::listen(handle)?;
        show_main(handle)?;
        return Ok(());
    }
    storage_api::initialize(handle);
    let tray_result = if tray_host_available() {
        build_tray(handle)
    } else {
        Err("系统未提供可用托盘，窗口将保持打开；关闭窗口会退出应用".into())
    };
    match tray_result {
        Ok(()) => desktop.tray_available.store(true, Ordering::Release),
        Err(error) => report_error(handle, error),
    }
    desktop.ui.initialize(handle)?;
    let saved = lock(&desktop.settings).saved.clone();
    let status = storage_api::status(handle);
    let mut startup_failed = status.warning.is_some() || status.blocked;
    if let Some(config) = (!status.blocked).then(|| saved.resume_config()).flatten() {
        if let Err(error) = crate::pc_monitor::start(handle, config) {
            report_error(handle, format!("无法恢复上次传输：{error}"));
            startup_failed = true;
        }
    }
    refresh_tray(
        handle,
        &handle
            .state::<crate::pc_monitor::PcMonitorState>()
            .0
            .snapshot(),
    );
    let args: Vec<_> = std::env::args().collect();
    if saved.should_show_window(
        desktop.tray_available(),
        args.iter().any(|arg| arg == "--show"),
        args.iter().any(|arg| arg == "--background"),
        startup_failed,
    ) {
        show_main(handle)?;
    }
    Ok(())
}
