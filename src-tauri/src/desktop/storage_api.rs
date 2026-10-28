use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use super::{
    bridge, lock, portable, settings::SettingsStore, user_config::UserConfigStore, DesktopState,
};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserConfigStatus {
    pub directory: Option<String>,
    pub warning: Option<String>,
    pub blocked: bool,
    pub legacy_import_completed: bool,
}

pub fn initialize(app: &AppHandle) {
    let desktop = app.state::<DesktopState>();
    match portable::resolve_directory(app) {
        Ok(directory) => {
            let legacy = app
                .path()
                .app_config_dir()
                .ok()
                .map(|directory| directory.join("background-v1.json"));
            *lock(&desktop.settings) =
                SettingsStore::load_migrating(directory.join("background-v1.json"), legacy);
            *lock(&desktop.user_config) =
                UserConfigStore::load(directory.join("user-config-v1.json"));
        }
        Err(warning) => {
            *lock(&desktop.settings) = SettingsStore::unavailable(warning.clone());
            *lock(&desktop.user_config) = UserConfigStore::unavailable(warning);
        }
    }
}

pub fn status(app: &AppHandle) -> UserConfigStatus {
    let desktop = app.state::<DesktopState>();
    let background = lock(&desktop.settings);
    let users = lock(&desktop.user_config);
    let warning = [background.warning.clone(), users.warning.clone()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
    UserConfigStatus {
        directory: users
            .path
            .as_deref()
            .and_then(std::path::Path::parent)
            .map(|path| path.to_string_lossy().into_owned()),
        warning: (!warning.is_empty()).then(|| warning.join("；")),
        blocked: background.blocked || users.blocked,
        legacy_import_completed: users.legacy_import_completed(),
    }
}

pub fn ensure_writable(app: &AppHandle) -> Result<(), String> {
    let status = status(app);
    if status.blocked {
        Err(status
            .warning
            .unwrap_or_else(|| "便携配置存储不可用，修改仅在本次会话有效".into()))
    } else {
        Ok(())
    }
}

pub fn get(app: &AppHandle, key: &str) -> Result<Option<Value>, String> {
    lock(&app.state::<DesktopState>().user_config).get(key)
}

pub fn set(app: &AppHandle, key: String, value: Value) -> Result<(), String> {
    ensure_writable(app)?;
    lock(&app.state::<DesktopState>().user_config).set(key, value)
}

pub fn import(app: &AppHandle, entries: BTreeMap<String, Value>) -> Result<(), String> {
    ensure_writable(app)?;
    lock(&app.state::<DesktopState>().user_config).import(entries)
}

pub fn flush(app: &AppHandle) -> Result<(), String> {
    ensure_writable(app)?;
    let desktop = app.state::<DesktopState>();
    lock(&desktop.settings).save()?;
    let result = lock(&desktop.user_config).flush();
    result
}

pub fn retry(app: &AppHandle, reset: bool, invalid_keys: Option<Vec<String>>) -> UserConfigStatus {
    if lock(&app.state::<DesktopState>().user_config)
        .path
        .is_none()
    {
        initialize(app);
    }
    let desktop = app.state::<DesktopState>();
    {
        let mut store = lock(&desktop.settings);
        let result = if reset {
            store.reset_corrupt()
        } else {
            store.retry()
        };
        if let Err(warning) = result {
            store.warning = Some(warning);
        }
    }
    {
        let mut store = lock(&desktop.user_config);
        let result = if reset {
            match invalid_keys {
                Some(keys) => store.reset_keys(keys),
                None => store.reset_corrupt(),
            }
        } else {
            store.retry()
        };
        if let Err(warning) = result {
            store.warning = Some(warning);
        }
    }
    status(app)
}

async fn call(app: AppHandle, request: bridge::Request) -> Result<bridge::Reply, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if super::is_ui_worker() {
            bridge::call(request)
        } else {
            bridge::dispatch(&app, request)
        }
    })
    .await
    .map_err(|error| format!("用户配置任务中断：{error}"))?
}

#[tauri::command]
pub async fn user_config_status(app: AppHandle) -> Result<UserConfigStatus, String> {
    match call(app, bridge::Request::UserConfigStatus).await? {
        bridge::Reply::UserConfigStatus(status) => Ok(status),
        _ => Err("用户配置状态响应无效".into()),
    }
}

#[tauri::command]
pub async fn user_config_get(app: AppHandle, key: String) -> Result<Option<Value>, String> {
    super::user_config::validate_key(&key)?;
    match call(app, bridge::Request::UserConfigGet(key)).await? {
        bridge::Reply::UserConfig(value) => Ok(value),
        _ => Err("用户配置读取响应无效".into()),
    }
}

#[tauri::command]
pub async fn user_config_set(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    super::user_config::validate_key(&key)?;
    saved(call(app, bridge::Request::UserConfigSet { key, value }).await?)
}

#[tauri::command]
pub async fn user_config_import(
    app: AppHandle,
    entries: BTreeMap<String, Value>,
) -> Result<(), String> {
    saved(call(app, bridge::Request::UserConfigImport(entries)).await?)
}

#[tauri::command]
pub async fn user_config_retry(app: AppHandle) -> Result<UserConfigStatus, String> {
    match call(app, bridge::Request::UserConfigRetry).await? {
        bridge::Reply::UserConfigStatus(status) => Ok(status),
        _ => Err("用户配置重试响应无效".into()),
    }
}

#[tauri::command]
pub async fn user_config_reset(
    app: AppHandle,
    invalid_keys: Option<Vec<String>>,
) -> Result<UserConfigStatus, String> {
    if let Some(keys) = &invalid_keys {
        for key in keys {
            super::user_config::validate_key(key)?;
        }
    }
    match call(app, bridge::Request::UserConfigReset(invalid_keys)).await? {
        bridge::Reply::UserConfigStatus(status) => Ok(status),
        _ => Err("用户配置重置响应无效".into()),
    }
}

#[tauri::command]
pub async fn user_config_flush(app: AppHandle) -> Result<(), String> {
    saved(call(app, bridge::Request::UserConfigFlush).await?)
}

fn saved(reply: bridge::Reply) -> Result<(), String> {
    match reply {
        bridge::Reply::Saved => Ok(()),
        _ => Err("用户配置保存响应无效".into()),
    }
}
