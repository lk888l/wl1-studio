use std::sync::atomic::Ordering;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use super::{bridge, lock, DesktopState};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum CloseAction {
    Close,
    Background,
    Quit,
}

#[derive(Clone, Copy, Serialize)]
struct PrepareClose {
    id: u64,
    action: CloseAction,
}

struct PendingClose {
    request: PrepareClose,
    executing: bool,
}

#[derive(Default)]
pub struct CloseState {
    next_id: u64,
    pending: Option<PendingClose>,
}

impl CloseState {
    fn prepare(&mut self, action: CloseAction) -> Option<PrepareClose> {
        if let Some(pending) = &mut self.pending {
            if !pending.executing && action == CloseAction::Quit {
                pending.request.action = CloseAction::Quit;
            }
            return None;
        }
        self.next_id = self.next_id.wrapping_add(1);
        let request = PrepareClose {
            id: self.next_id,
            action,
        };
        self.pending = Some(PendingClose {
            request,
            executing: false,
        });
        Some(request)
    }

    fn begin(&mut self, id: u64) -> Result<CloseAction, String> {
        let pending = self
            .pending
            .as_mut()
            .filter(|pending| pending.request.id == id)
            .ok_or("关闭请求已失效，请重新操作")?;
        if pending.executing {
            return Err("正在处理关闭请求".into());
        }
        pending.executing = true;
        Ok(pending.request.action)
    }

    fn finish(&mut self, id: u64, succeeded: bool) {
        if let Some(pending) = self
            .pending
            .as_mut()
            .filter(|pending| pending.request.id == id)
        {
            if succeeded {
                self.pending = None;
            } else {
                pending.executing = false;
            }
        }
    }

    fn cancel(&mut self, id: u64) -> Result<(), String> {
        let pending = self
            .pending
            .as_ref()
            .filter(|pending| pending.request.id == id)
            .ok_or("关闭请求已失效")?;
        if pending.executing {
            return Err("正在执行关闭请求，请稍后重试".into());
        }
        self.pending = None;
        Ok(())
    }
}

pub fn prepare(app: &AppHandle, action: CloseAction) -> Result<(), String> {
    let desktop = app.state::<DesktopState>();
    app.state::<crate::firmware::FirmwareState>()
        .ensure_idle()?;
    if !desktop.ui_ready.load(Ordering::Acquire) {
        return Err("界面尚未准备好保存配置，请稍后再关闭窗口".into());
    }
    let request = lock(&desktop.close).prepare(action);
    if let Some(request) = request {
        if let Err(error) = app.emit_to("main", "desktop-prepare-close", request) {
            lock(&desktop.close).finish(request.id, true);
            return Err(format!("无法通知界面保存配置，窗口将保持打开：{error}"));
        }
    }
    Ok(())
}

pub fn request(app: &AppHandle, action: CloseAction) {
    if let Err(error) = prepare(app, action) {
        super::report_error(app, error);
        super::request_show_main(app);
    }
}

pub fn exit_authorized(app: &AppHandle) -> bool {
    app.state::<DesktopState>()
        .exit_authorized
        .load(Ordering::Acquire)
}

pub fn authorize_exit(app: &AppHandle, authorized: bool) {
    app.state::<DesktopState>()
        .exit_authorized
        .store(authorized, Ordering::Release);
}

#[tauri::command]
pub fn desktop_ui_ready(app: AppHandle) -> Result<(), String> {
    let desktop = app.state::<DesktopState>();
    desktop.ui_ready.store(true, Ordering::Release);
    let request = lock(&desktop.close)
        .pending
        .as_ref()
        .filter(|pending| !pending.executing)
        .map(|pending| pending.request);
    if let Some(request) = request {
        app.emit_to("main", "desktop-prepare-close", request)
            .map_err(|error| format!("无法恢复待处理关闭请求：{error}"))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn desktop_complete_close(app: AppHandle, id: u64) -> Result<(), String> {
    let action = lock(&app.state::<DesktopState>().close).begin(id)?;
    let result = complete(app.clone(), action).await;
    lock(&app.state::<DesktopState>().close).finish(id, result.is_ok());
    if let Err(error) = &result {
        super::report_error(&app, error.clone());
        super::request_show_main(&app);
    }
    result
}

async fn complete(app: AppHandle, action: CloseAction) -> Result<(), String> {
    app.state::<crate::firmware::FirmwareState>()
        .ensure_idle()?;
    app.state::<crate::sticks3_network::StickS3NetworkState>()
        .ensure_idle()?;
    let action = if action == CloseAction::Close {
        let handle = app.clone();
        tauri::async_runtime::spawn_blocking(move || -> Result<CloseAction, String> {
            let reply = if super::is_ui_worker() {
                bridge::call(bridge::Request::CloseMain)
            } else {
                bridge::dispatch(&handle, bridge::Request::CloseMain)
            }?;
            match reply {
                bridge::Reply::CloseAction(action) => Ok(action),
                _ => Err("窗口关闭设置响应无效".into()),
            }
        })
        .await
        .map_err(|error| format!("窗口关闭任务中断：{error}"))??
    } else {
        action
    };
    match action {
        CloseAction::Background => super::enter_background(app).await,
        CloseAction::Quit => {
            app.state::<crate::firmware::FirmwareState>()
                .ensure_idle()?;
            super::ui_process::quit_now(&app);
            Ok(())
        }
        CloseAction::Close => Err("窗口关闭动作无效".into()),
    }
}

#[tauri::command]
pub fn desktop_cancel_close(app: AppHandle, id: u64) -> Result<(), String> {
    lock(&app.state::<DesktopState>().close).cancel(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_actions_deduplicate_and_survive_failure_for_retry_or_cancel() {
        let mut state = CloseState::default();
        let request = state.prepare(CloseAction::Close).unwrap();
        assert!(state.prepare(CloseAction::Background).is_none());
        assert_eq!(state.begin(request.id).unwrap(), CloseAction::Close);
        assert!(state.begin(request.id).is_err());
        state.finish(request.id, false);
        assert_eq!(state.begin(request.id).unwrap(), CloseAction::Close);
        state.finish(request.id, false);
        state.cancel(request.id).unwrap();
        let next = state.prepare(CloseAction::Quit).unwrap();
        assert_ne!(next.id, request.id);
        state.begin(next.id).unwrap();
        state.finish(next.id, true);
        assert!(state.begin(next.id).is_err());
        assert!(state.prepare(CloseAction::Background).is_some());
    }

    #[test]
    fn quit_upgrades_a_waiting_close_and_cannot_be_downgraded() {
        let mut state = CloseState::default();
        let request = state.prepare(CloseAction::Close).unwrap();
        assert!(state.prepare(CloseAction::Quit).is_none());
        assert!(state.prepare(CloseAction::Background).is_none());
        assert_eq!(state.begin(request.id).unwrap(), CloseAction::Quit);
        assert!(state.prepare(CloseAction::Close).is_none());
        state.finish(request.id, false);
        assert_eq!(state.begin(request.id).unwrap(), CloseAction::Quit);
    }
}
