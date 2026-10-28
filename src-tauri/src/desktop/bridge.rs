//! Private, authenticated loopback RPC between the tray/driver and its UI child.
//! No serial, shell, filesystem or arbitrary Tauri commands are exposed here.
use pc_monitor_core::{GpuDevices, MonitorConfig};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::time::Duration;
use tauri::{AppHandle, Manager};

use super::{DesktopState, Preferences};
use crate::pc_monitor::{self, PcMonitorSnapshot, PcMonitorState};

pub const UI_ENDPOINT_ENV: &str = "WL1_STUDIO_UI_ENDPOINT";
const MAX_MESSAGE: usize = 16 * 1024;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Endpoint {
    pub address: std::net::SocketAddrV4,
    pub token: String,
    pub tray_available: bool,
}

#[derive(Deserialize, Serialize)]
#[serde(tag = "command", content = "args", deny_unknown_fields)]
pub enum Request {
    Snapshot,
    Start(MonitorConfig),
    Stop(Option<String>),
    Devices,
    SavePreferences(Preferences),
    UiQuitAccepted,
    CloseMain,
    UserConfigStatus,
    UserConfigGet(String),
    UserConfigSet {
        key: String,
        value: serde_json::Value,
    },
    UserConfigImport(BTreeMap<String, serde_json::Value>),
    UserConfigRetry,
    UserConfigReset(Option<Vec<String>>),
    UserConfigFlush,
}

impl Request {
    fn message_limit(&self) -> usize {
        match self {
            Self::UserConfigGet(_) | Self::UserConfigSet { .. } | Self::UserConfigImport(_) => {
                super::portable::MAX_CONFIG_MESSAGE
            }
            _ => MAX_MESSAGE,
        }
    }
}

#[derive(Deserialize, Serialize)]
pub enum Reply {
    Snapshot(Box<PcMonitorSnapshot>),
    Devices(GpuDevices),
    Saved,
    CloseAction(super::lifecycle::CloseAction),
    UserConfigStatus(super::storage_api::UserConfigStatus),
    UserConfig(Option<serde_json::Value>),
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    token: String,
    request: Request,
}

pub fn ui_endpoint() -> Result<Option<Endpoint>, String> {
    match std::env::var(UI_ENDPOINT_ENV) {
        Ok(value) => {
            let endpoint: Endpoint =
                serde_json::from_str(&value).map_err(|_| "后台传输连接参数无效".to_owned())?;
            if !endpoint.address.ip().is_loopback() || endpoint.token.len() != 64 {
                return Err("后台传输连接参数无效".into());
            }
            Ok(Some(endpoint))
        }
        Err(std::env::VarError::NotPresent) => Ok(None),
        Err(_) => Err("后台传输连接参数无效".into()),
    }
}

#[cfg(test)]
fn read_frame(stream: &TcpStream) -> Result<Vec<u8>, String> {
    read_frame_limit(stream, MAX_MESSAGE)
}

fn read_frame_limit(stream: &TcpStream, limit: usize) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    BufReader::new(stream.take((limit + 1) as u64))
        .read_until(b'\n', &mut bytes)
        .map_err(|error| format!("无法读取后台传输响应：{error}"))?;
    if bytes.len() > limit || bytes.last() != Some(&b'\n') {
        return Err("后台传输消息不完整或超过长度限制".into());
    }
    Ok(bytes)
}

fn write_frame_limit(
    mut stream: &TcpStream,
    value: &impl Serialize,
    limit: usize,
) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > limit {
        return Err("后台传输消息超过长度限制".into());
    }
    stream
        .write_all(&bytes)
        .map_err(|error| format!("无法写入后台传输连接：{error}"))
}

fn configure_stream(stream: &TcpStream) -> Result<(), String> {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .and_then(|()| stream.set_write_timeout(Some(Duration::from_secs(5))))
        .and_then(|()| stream.set_nodelay(true))
        .map_err(|error| error.to_string())
}

pub fn call(request: Request) -> Result<Reply, String> {
    let limit = request.message_limit();
    let endpoint = ui_endpoint()?.ok_or("当前进程没有连接后台传输服务")?;
    let stream = TcpStream::connect_timeout(&endpoint.address.into(), Duration::from_secs(2))
        .map_err(|error| format!("无法连接后台传输服务：{error}"))?;
    configure_stream(&stream)?;
    write_frame_limit(
        &stream,
        &Envelope {
            token: endpoint.token,
            request,
        },
        limit,
    )?;
    let response: Result<Reply, String> =
        serde_json::from_slice(&read_frame_limit(&stream, limit)?)
            .map_err(|error| format!("后台传输响应格式无效：{error}"))?;
    response
}

pub fn snapshot(request: Request) -> Result<PcMonitorSnapshot, String> {
    match call(request)? {
        Reply::Snapshot(snapshot) => Ok(*snapshot),
        _ => Err("后台传输服务未返回监控状态".into()),
    }
}

pub(super) fn dispatch(app: &AppHandle, request: Request) -> Result<Reply, String> {
    match request {
        Request::Snapshot => Ok(Reply::Snapshot(Box::new(pc_monitor::local_snapshot(app)))),
        Request::Start(config) => {
            pc_monitor::start(app, config)?;
            Ok(Reply::Snapshot(Box::new(pc_monitor::local_snapshot(app))))
        }
        Request::Stop(expected) => {
            pc_monitor::stop(app, expected.as_deref())?;
            Ok(Reply::Snapshot(Box::new(pc_monitor::local_snapshot(app))))
        }
        Request::Devices => Ok(Reply::Devices(app.state::<PcMonitorState>().0.devices())),
        Request::SavePreferences(preferences) => {
            super::storage_api::ensure_writable(app)?;
            let desktop = app.state::<DesktopState>();
            let mut store = super::lock(&desktop.settings);
            store.saved.preferences = preferences;
            store.save()?;
            Ok(Reply::Saved)
        }
        Request::UiQuitAccepted => {
            app.state::<DesktopState>().ui.acknowledge_quit();
            Ok(Reply::Saved)
        }
        Request::CloseMain => {
            let desktop = app.state::<DesktopState>();
            let close_behavior = super::lock(&desktop.settings)
                .saved
                .preferences
                .close_behavior;
            let action = if desktop.tray_available()
                && close_behavior == super::settings::CloseBehavior::Tray
            {
                super::lifecycle::CloseAction::Background
            } else {
                super::lifecycle::CloseAction::Quit
            };
            Ok(Reply::CloseAction(action))
        }
        Request::UserConfigStatus => Ok(Reply::UserConfigStatus(super::storage_api::status(app))),
        Request::UserConfigGet(key) => Ok(Reply::UserConfig(super::storage_api::get(app, &key)?)),
        Request::UserConfigSet { key, value } => {
            super::storage_api::set(app, key, value)?;
            Ok(Reply::Saved)
        }
        Request::UserConfigImport(entries) => {
            super::storage_api::import(app, entries)?;
            Ok(Reply::Saved)
        }
        Request::UserConfigRetry => Ok(Reply::UserConfigStatus(super::storage_api::retry(
            app, false, None,
        ))),
        Request::UserConfigReset(keys) => {
            if let Some(keys) = &keys {
                for key in keys {
                    super::user_config::validate_key(key)?;
                }
            }
            Ok(Reply::UserConfigStatus(super::storage_api::retry(
                app, true, keys,
            )))
        }
        Request::UserConfigFlush => {
            super::storage_api::flush(app)?;
            Ok(Reply::Saved)
        }
    }
}

fn authenticate(bytes: &[u8], token: &str) -> Result<Request, String> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "后台请求格式无效")?;
    if envelope.token != token {
        return Err("后台请求验证失败".into());
    }
    if bytes.len() > envelope.request.message_limit() {
        return Err("后台传输消息超过对应命令的长度限制".into());
    }
    Ok(envelope.request)
}

pub fn serve(app: &AppHandle) -> Result<Endpoint, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|error| format!("无法启动后台传输服务：{error}"))?;
    let std::net::SocketAddr::V4(address) =
        listener.local_addr().map_err(|error| error.to_string())?
    else {
        return Err("后台传输地址无效".into());
    };
    let mut secret = [0_u8; 32];
    getrandom::fill(&mut secret).map_err(|error| format!("无法创建后台连接凭据：{error}"))?;
    let token: String = secret.iter().map(|byte| format!("{byte:02x}")).collect();
    let endpoint = Endpoint {
        address,
        token: token.clone(),
        tray_available: app.state::<DesktopState>().tray_available(),
    };
    let app = app.clone();
    std::thread::Builder::new()
        .name("studio-ui-bridge".into())
        .spawn(move || {
            // Blocking accept has no timer or periodic wakeup when the UI is gone.
            for stream in listener.incoming() {
                let Ok(stream) = stream else {
                    break;
                };
                if configure_stream(&stream).is_err() {
                    continue;
                }
                let request = read_frame_limit(&stream, super::portable::MAX_CONFIG_MESSAGE)
                    .and_then(|bytes| authenticate(&bytes, &token));
                let limit = request.as_ref().map_or(MAX_MESSAGE, Request::message_limit);
                let result = request.and_then(|request| dispatch(&app, request));
                let _ = write_frame_limit(&stream, &result, limit);
            }
        })
        .map_err(|error| format!("无法启动后台连接任务：{error}"))?;
    Ok(endpoint)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_authenticated_typed_requests_reach_the_driver() {
        assert!(authenticate(
            br#"{"token":"wrong","request":{"command":"Snapshot"}}"#,
            "secret"
        )
        .is_err());
        assert!(authenticate(
            br#"{"token":"secret","request":{"command":"run_shell"}}"#,
            "secret"
        )
        .is_err());
        assert!(authenticate(
            br#"{"token":"secret","request":{"command":"Snapshot"},"extra":1}"#,
            "secret"
        )
        .is_err());
        assert!(matches!(
            authenticate(
                br#"{"token":"secret","request":{"command":"Snapshot"}}"#,
                "secret"
            ),
            Ok(Request::Snapshot)
        ));
    }

    #[test]
    fn framing_rejects_oversize_or_truncated_messages() {
        for payload in [
            vec![b'x'; MAX_MESSAGE + 1],
            b"{}".to_vec(),
            b"{}\n".to_vec(),
        ] {
            let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
            let mut sender = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
            let (receiver, _) = listener.accept().unwrap();
            sender.write_all(&payload).unwrap();
            sender.shutdown(std::net::Shutdown::Write).unwrap();
            assert_eq!(read_frame(&receiver).is_ok(), payload == b"{}\n");
        }
    }

    #[test]
    fn configuration_rpc_can_exceed_the_regular_limit_without_expanding_monitor_commands() {
        let config = serde_json::to_vec(&Envelope {
            token: "secret".into(),
            request: Request::UserConfigSet {
                key: super::super::user_config::KEYS[0].into(),
                value: serde_json::Value::String("a".repeat(64 * 1024)),
            },
        })
        .unwrap();
        assert!(config.len() > MAX_MESSAGE);
        assert!(authenticate(&config, "secret").is_ok());
        let snapshot = format!(
            r#"{{"token":"secret","request":{{"command":"Snapshot"}}}}{}"#,
            " ".repeat(MAX_MESSAGE)
        );
        assert!(authenticate(snapshot.as_bytes(), "secret").is_err());
        assert_eq!(Request::Snapshot.message_limit(), 16 * 1024);
        assert_eq!(
            Request::UserConfigGet(String::new()).message_limit(),
            16 * 1024 * 1024
        );
    }
}
