//! Private, authenticated loopback RPC between the tray/driver and its UI child.
//! No serial, shell, filesystem or arbitrary Tauri commands are exposed here.
use pc_monitor_core::{GpuDevices, MonitorConfig};
use serde::{Deserialize, Serialize};
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
}

#[derive(Deserialize, Serialize)]
pub enum Reply {
    Snapshot(Box<PcMonitorSnapshot>),
    Devices(GpuDevices),
    Saved,
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

fn read_frame(stream: &TcpStream) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    BufReader::new(stream.take((MAX_MESSAGE + 1) as u64))
        .read_until(b'\n', &mut bytes)
        .map_err(|error| format!("无法读取后台传输响应：{error}"))?;
    if bytes.len() > MAX_MESSAGE || bytes.last() != Some(&b'\n') {
        return Err("后台传输消息不完整或超过长度限制".into());
    }
    Ok(bytes)
}

fn write_frame(mut stream: &TcpStream, value: &impl Serialize) -> Result<(), String> {
    let mut bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    if bytes.len() > MAX_MESSAGE {
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
    let endpoint = ui_endpoint()?.ok_or("当前进程没有连接后台传输服务")?;
    let stream = TcpStream::connect_timeout(&endpoint.address.into(), Duration::from_secs(2))
        .map_err(|error| format!("无法连接后台传输服务：{error}"))?;
    configure_stream(&stream)?;
    write_frame(
        &stream,
        &Envelope {
            token: endpoint.token,
            request,
        },
    )?;
    let response: Result<Reply, String> = serde_json::from_slice(&read_frame(&stream)?)
        .map_err(|error| format!("后台传输响应格式无效：{error}"))?;
    response
}

pub fn snapshot(request: Request) -> Result<PcMonitorSnapshot, String> {
    match call(request)? {
        Reply::Snapshot(snapshot) => Ok(*snapshot),
        _ => Err("后台传输服务未返回监控状态".into()),
    }
}

fn dispatch(app: &AppHandle, request: Request) -> Result<Reply, String> {
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
    }
}

fn authenticate(bytes: &[u8], token: &str) -> Result<Request, String> {
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| "后台请求格式无效")?;
    if envelope.token != token {
        return Err("后台请求验证失败".into());
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
                let result = read_frame(&stream)
                    .and_then(|bytes| authenticate(&bytes, &token))
                    .and_then(|request| dispatch(&app, request));
                let _ = write_frame(&stream, &result);
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
}
