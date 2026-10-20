//! Thin Tauri adapters. The core owns its worker independently of USB sessions.
use pc_monitor_core::{GpuDevices, Monitor, MonitorConfig, MonitorSnapshot};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::desktop::{self, bridge, DesktopSnapshot, DesktopState};

#[derive(Default)]
pub struct PcMonitorState(pub Monitor, std::sync::Mutex<()>);

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PcMonitorSnapshot {
    #[serde(flatten)]
    monitor: MonitorSnapshot,
    pub desktop: DesktopSnapshot,
}

pub fn local_snapshot(app: &AppHandle) -> PcMonitorSnapshot {
    let monitor = app.state::<PcMonitorState>().0.snapshot();
    PcMonitorSnapshot {
        desktop: app.state::<DesktopState>().snapshot(&monitor),
        monitor,
    }
}

fn remote_snapshot(app: &AppHandle, request: bridge::Request) -> Result<PcMonitorSnapshot, String> {
    let mut snapshot = bridge::snapshot(request)?;
    if let Some(warning) = app.state::<DesktopState>().warning() {
        snapshot.desktop.warning = Some(match snapshot.desktop.warning {
            Some(previous) => format!("{previous}；{warning}"),
            None => warning,
        });
    }
    Ok(snapshot)
}

pub fn start(app: &AppHandle, config: MonitorConfig) -> Result<MonitorSnapshot, String> {
    let state = app.state::<PcMonitorState>();
    let _operation = state.1.lock().unwrap_or_else(|error| error.into_inner());
    let monitor = state.0.start(config)?;
    desktop::remember_monitor(app, &monitor);
    Ok(monitor)
}

pub fn stop(app: &AppHandle, expected_session_id: Option<&str>) -> Result<MonitorSnapshot, String> {
    let state = app.state::<PcMonitorState>();
    let _operation = state.1.lock().unwrap_or_else(|error| error.into_inner());
    let monitor = state.0.stop(expected_session_id)?;
    desktop::remember_monitor(app, &monitor);
    Ok(monitor)
}

#[tauri::command]
pub async fn pc_monitor_start(
    app: AppHandle,
    config: MonitorConfig,
) -> Result<PcMonitorSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if desktop::is_ui_worker() {
            remote_snapshot(&app, bridge::Request::Start(config))
        } else {
            start(&app, config)?;
            Ok(local_snapshot(&app))
        }
    })
    .await
    .map_err(|error| format!("电脑监控启动任务中断：{error}"))?
}

#[tauri::command]
pub async fn pc_monitor_stop(
    app: AppHandle,
    expected_session_id: Option<String>,
) -> Result<PcMonitorSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if desktop::is_ui_worker() {
            remote_snapshot(&app, bridge::Request::Stop(expected_session_id))
        } else {
            stop(&app, expected_session_id.as_deref())?;
            Ok(local_snapshot(&app))
        }
    })
    .await
    .map_err(|error| format!("电脑监控停止任务中断：{error}"))?
}

#[tauri::command]
pub async fn pc_monitor_snapshot(app: AppHandle) -> Result<PcMonitorSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if desktop::is_ui_worker() {
            remote_snapshot(&app, bridge::Request::Snapshot)
        } else {
            Ok(local_snapshot(&app))
        }
    })
    .await
    .map_err(|error| format!("电脑监控状态任务中断：{error}"))?
}

#[tauri::command]
pub async fn pc_monitor_devices(app: AppHandle) -> Result<GpuDevices, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if desktop::is_ui_worker() {
            match bridge::call(bridge::Request::Devices)? {
                bridge::Reply::Devices(devices) => Ok(devices),
                _ => Err("显卡枚举响应无效".into()),
            }
        } else {
            Ok(app.state::<PcMonitorState>().0.devices())
        }
    })
    .await
    .map_err(|error| format!("显卡枚举任务中断：{error}"))?
}
