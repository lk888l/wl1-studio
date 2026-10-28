//! The whole WebView runtime lives in a disposable UI process. This also
//! releases WebKit's otherwise persistent Linux network process and caches.
use std::io::{BufRead, Write};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::{AppHandle, Manager};

use super::{bridge, DesktopState};

const QUIT_APPLICATION: i32 = 42;

#[derive(Clone, Copy)]
pub enum Control {
    Show,
    Background,
    Quit,
}

impl Control {
    fn line(self) -> &'static [u8] {
        match self {
            Self::Show => b"show\n",
            Self::Background => b"background\n",
            Self::Quit => b"quit\n",
        }
    }
}

struct Session {
    pid: u32,
    input: ChildStdin,
    quitting: Arc<AtomicBool>,
}

#[derive(Default)]
pub struct UiProcess {
    endpoint: OnceLock<bridge::Endpoint>,
    session: Mutex<Option<Session>>,
}

pub fn is_worker() -> bool {
    std::env::var_os(bridge::UI_ENDPOINT_ENV).is_some()
}

impl UiProcess {
    pub fn acknowledge_quit(&self) {
        if let Some(session) = super::lock(&self.session).as_ref() {
            session.quitting.store(true, Ordering::Release);
        }
    }
    pub fn initialize(&self, app: &AppHandle) -> Result<(), String> {
        self.endpoint
            .set(bridge::serve(app)?)
            .map_err(|_| "界面服务已启动".into())
    }

    pub fn send(&self, control: Control) -> Result<bool, String> {
        if let Some(session) = super::lock(&self.session).as_mut() {
            session
                .input
                .write_all(control.line())
                .and_then(|()| session.input.flush())
                .map_err(|error| format!("无法通知控制中心：{error}"))?;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn show(&self, app: &AppHandle) -> Result<(), String> {
        let mut session = super::lock(&self.session);
        if let Some(current) = session.as_mut() {
            return current
                .input
                .write_all(Control::Show.line())
                .and_then(|()| current.input.flush())
                .map_err(|error| format!("无法恢复控制中心：{error}"));
        }
        let endpoint = self.endpoint.get().ok_or("界面连接服务尚未就绪")?;
        let mut command = Command::new(std::env::current_exe().map_err(|error| error.to_string())?);
        command
            .env(
                bridge::UI_ENDPOINT_ENV,
                serde_json::to_string(endpoint).map_err(|error| error.to_string())?,
            )
            .stdin(Stdio::piped());
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // CREATE_NO_WINDOW, retain piped stdin.
        }
        let mut child = command
            .spawn()
            .map_err(|error| format!("无法启动控制中心：{error}"))?;
        let pid = child.id();
        let input = child.stdin.take().ok_or("无法创建界面控制连接")?;
        let quitting = Arc::new(AtomicBool::new(false));
        let quit_accepted = Arc::clone(&quitting);
        let app = app.clone();
        std::thread::Builder::new()
            .name("studio-ui-lifetime".into())
            .spawn(move || {
                let status = child.wait();
                let desktop = app.state::<DesktopState>();
                {
                    let mut session = super::lock(&desktop.ui.session);
                    if session.as_ref().is_some_and(|session| session.pid == pid) {
                        *session = None;
                    }
                }
                *super::lock(&desktop.resources) = super::ResourceSampler::default();
                match status {
                    Ok(_) if quit_accepted.load(Ordering::Acquire) => app.exit(0),
                    Ok(status) if status.success() => {}
                    _ => super::report_error(
                        &app,
                        "控制中心意外结束，Wi-Fi 传输继续；可从托盘重新打开".into(),
                    ),
                }
            })
            .map_err(|error| format!("无法管理界面进程：{error}"))?;
        *session = Some(Session {
            pid,
            input,
            quitting,
        });
        Ok(())
    }
}

/// Acknowledged only after the UI's hardware-busy exit guard accepts Quit.
/// Use explicit IPC: GTK/OS shutdown can normalize the child's exit status.
pub fn confirm_quit(app: &AppHandle, code: Option<i32>) -> bool {
    if !is_worker() || code != Some(QUIT_APPLICATION) {
        return true;
    }
    match bridge::call(bridge::Request::UiQuitAccepted) {
        Ok(bridge::Reply::Saved) => true,
        _ => {
            super::lifecycle::authorize_exit(app, false);
            super::report_error(app, "暂时无法通知后台退出，请稍后重试".into());
            super::request_show_main(app);
            false
        }
    }
}

pub fn listen(app: &AppHandle) -> Result<(), String> {
    let app = app.clone();
    std::thread::Builder::new()
        .name("studio-ui-control".into())
        .spawn(move || {
            for line in std::io::stdin().lock().lines() {
                match line.as_deref() {
                    Ok("show") => super::request_show_main(&app),
                    Ok("background") => super::request_background(&app),
                    Ok("quit") => {
                        super::lifecycle::request(&app, super::lifecycle::CloseAction::Quit)
                    }
                    _ => break,
                }
            }
        })
        .map_err(|error| format!("无法创建界面控制任务：{error}"))?;
    Ok(())
}

pub fn request_quit(app: &AppHandle) {
    if is_worker() {
        super::lifecycle::request(app, super::lifecycle::CloseAction::Quit);
        return;
    }
    match app.state::<DesktopState>().ui.send(Control::Quit) {
        Ok(true) => {}
        Ok(false) => app.exit(0),
        Err(error) => super::report_error(app, error),
    }
}

pub fn quit_now(app: &AppHandle) {
    super::lifecycle::authorize_exit(app, true);
    app.exit(if is_worker() { QUIT_APPLICATION } else { 0 });
}

pub fn defer_exit_to_ui(app: &AppHandle) -> bool {
    if is_worker() {
        return false;
    }
    match app.state::<DesktopState>().ui.send(Control::Quit) {
        Ok(active) => active,
        Err(error) => {
            super::report_error(app, error);
            true
        }
    }
}
