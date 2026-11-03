//! Versioned SmartKnob USB request/reply session. Only the UI's status polling
//! renews the firmware lease; backgrounding/crashing the UI cannot keep torque on.
use serde::Serialize;
use serde_json::{json, Value};
use serialport::SerialPort;
use std::io::{ErrorKind, Read, Write};
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Mutex,
};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
const DEADLINE: Duration = Duration::from_millis(450);
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(3);
const MAX_LINE: usize = 4096;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnobSnapshot {
    pub connected: bool,
    pub session_id: Option<u64>,
    pub port_name: Option<String>,
}
#[derive(Debug)]
enum RequestError {
    Timeout,
    Transport(String),
}
struct Session {
    port: Box<dyn SerialPort>,
    id: u64,
    sequence: u32,
    identified: bool,
    port_name: String,
}
fn valid_request(request: &Value) -> bool {
    request.is_object()
        && matches!(
            request.get("op").and_then(Value::as_str),
            Some(
                "status"
                    | "configure"
                    | "calibrate"
                    | "enable"
                    | "disable"
                    | "clear"
                    | "zero"
                    | "pulse"
                    | "save"
            )
        )
        && request.to_string().len() <= 1900
        && (request["op"] != "configure" || request["config"].is_object())
}
fn matching_reply(line: &[u8], id: u32) -> Option<Value> {
    let value: Value = serde_json::from_slice(line).ok()?;
    (value["device"] == "smartknob-s3"
        && value["protocol"] == 1
        && value["id"] == id
        && value["ok"].is_boolean())
    .then_some(value)
}
impl Session {
    fn request(&mut self, request: Value) -> Result<Value, String> {
        if !valid_request(&request) {
            return Err("无效的旋钮请求".into());
        }
        self.exchange(request).map_err(|error| match error {
            RequestError::Timeout => "旋钮响应超时；会话已关闭，固件将在心跳超时后停机".into(),
            RequestError::Transport(message) => message,
        })
    }

    fn identify(&mut self) -> Result<(), String> {
        // Opening a serial port can overlap a reboot. Retry only this read-only
        // probe; motor commands and established sessions are never retried.
        let deadline = Instant::now() + HANDSHAKE_DEADLINE;
        loop {
            match self.exchange(json!({"op": "status"})) {
                Ok(reply) => {
                    self.identified = true;
                    if reply["ok"] != true {
                        return Err(format!("旋钮未就绪：{}", reply["error"].as_str().unwrap_or("未知错误")));
                    }
                    return Ok(());
                }
                Err(RequestError::Timeout) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(60));
                }
                Err(RequestError::Timeout) => return Err(
                    "串口已打开，但未收到 SmartKnob 协议 v1 回复。原生 USB 口需要 USB 调参固件；旧版 COM 固件请连接 COM 口。".into()
                ),
                Err(RequestError::Transport(message)) => return Err(message),
            }
        }
    }

    fn exchange(&mut self, mut request: Value) -> Result<Value, RequestError> {
        self.sequence = (self.sequence % 2_000_000_000) + 1;
        request["id"] = json!(self.sequence);
        let mut bytes =
            serde_json::to_vec(&request).map_err(|e| RequestError::Transport(e.to_string()))?;
        bytes.push(b'\n');
        self.port.write_all(&bytes).map_err(|e| {
            RequestError::Transport(format!(
                "旋钮 USB 写入失败：{e}；请确认固件启用了当前 USB/COM 调参通道"
            ))
        })?;
        let end = Instant::now() + DEADLINE;
        let mut line = Vec::with_capacity(2048);
        let mut overflow = false;
        let mut buffer = [0u8; 256];
        while Instant::now() < end {
            match self.port.read(&mut buffer) {
                Ok(count) => {
                    for byte in &buffer[..count] {
                        if *byte == b'\n' {
                            if !overflow {
                                if let Some(reply) = matching_reply(&line, self.sequence) {
                                    return Ok(reply);
                                }
                            }
                            line.clear();
                            overflow = false;
                        } else if line.len() < MAX_LINE && !overflow {
                            line.push(*byte);
                        } else {
                            overflow = true;
                        }
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) => {}
                Err(e) => return Err(RequestError::Transport(format!("旋钮 USB 读取失败：{e}"))),
            }
        }
        Err(RequestError::Timeout)
    }
}
impl Drop for Session {
    fn drop(&mut self) {
        // Best effort, including early identity/handshake failures; motors also
        // have a 1 s firmware lease. No automatic reconnect or command retry.
        if !self.identified {
            return;
        }
        let _ = self.port.write_all(b"{\"id\":0,\"op\":\"disable\"}\n");
    }
}
#[derive(Default)]
pub struct KnobState(Mutex<Option<Session>>);
impl KnobState {
    pub fn snapshot(&self) -> Result<KnobSnapshot, String> {
        let lock = self.0.lock().map_err(|_| "旋钮会话锁已损坏")?;
        Ok(lock
            .as_ref()
            .map_or_else(KnobSnapshot::default, |s| KnobSnapshot {
                connected: true,
                session_id: Some(s.id),
                port_name: Some(s.port_name.clone()),
            }))
    }
    fn connect(&self, name: &str) -> Result<KnobSnapshot, String> {
        self.disconnect(None)?;
        let port = serialport::new(name, 115200)
            .timeout(Duration::from_millis(20))
            .flow_control(serialport::FlowControl::None)
            .open()
            .map_err(|e| format!("无法打开旋钮串口：{e}"))?;
        let mut session = Session {
            port,
            id: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
            sequence: 0,
            identified: false,
            port_name: name.into(),
        };
        session.identify()?;
        let stopped = session.request(json!({"op":"disable"}))?;
        if stopped["ok"] != true || !matches!(stopped["state"].as_str(), Some("idle" | "fault")) {
            return Err("旋钮未确认停机".into());
        }
        *self.0.lock().map_err(|_| "旋钮会话锁已损坏")? = Some(session);
        self.snapshot()
    }
    pub fn disconnect(&self, expected: Option<u64>) -> Result<(), String> {
        let mut lock = self.0.lock().map_err(|_| "旋钮会话锁已损坏")?;
        if expected.is_some_and(|id| lock.as_ref().is_none_or(|s| id != s.id)) {
            return Ok(());
        }
        if let Some(mut session) = lock.take() {
            let response = session.request(json!({"op":"disable"}))?;
            if response["ok"] != true
                || !matches!(response["state"].as_str(), Some("idle" | "fault"))
            {
                return Err("未收到旋钮停机确认；等待固件心跳超时".into());
            }
        }
        Ok(())
    }
    fn request(&self, id: u64, request: Value) -> Result<Value, String> {
        if !valid_request(&request) {
            return Err("无效的旋钮请求".into());
        }
        let mut lock = self.0.lock().map_err(|_| "旋钮会话锁已损坏")?;
        let session = lock
            .as_mut()
            .filter(|s| s.id == id)
            .ok_or("旋钮会话已失效")?;
        let result = session.request(request);
        if result.is_err() {
            lock.take();
        }
        result
    }
}
#[tauri::command]
pub async fn knob_connect(app: AppHandle, port_name: String) -> Result<KnobSnapshot, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<crate::commands::ProductSessionLifecycle>();
        let _guard = lifecycle.0.lock().map_err(|_| "产品会话锁已损坏")?;
        crate::desktop::ensure_foreground(&app)?;
        app.state::<crate::firmware::FirmwareState>()
            .ensure_idle()?;
        let name = port_name.trim();
        if !crate::commands::list_serial_ports()?
            .iter()
            .any(|p| p.name == name)
        {
            return Err("串口不可用，请刷新列表".into());
        }
        crate::desktop::disconnect_products(&app)?;
        app.state::<KnobState>().connect(name)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn knob_disconnect(
    app: AppHandle,
    expected_session_id: Option<u64>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<crate::commands::ProductSessionLifecycle>();
        let _guard = lifecycle.0.lock().map_err(|_| "产品会话锁已损坏")?;
        app.state::<KnobState>().disconnect(expected_session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn knob_request(
    app: AppHandle,
    expected_session_id: u64,
    request: Value,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<KnobState>()
            .request(expected_session_id, request)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires SMARTKNOB_TEST_PORT and an attached commissioned ESP32-S3"]
    fn real_board_session_reads_parameters_and_stops() {
        let port = std::env::var("SMARTKNOB_TEST_PORT").expect("Set the dedicated hardware port");
        let state = KnobState::default();
        let connected = state.connect(&port).expect("Native serial handshake");
        let id = connected.session_id.unwrap();
        let reply = state.request(id, json!({"op":"status"})).unwrap();
        assert_eq!(reply["state"], "idle");
        assert_eq!(reply["fault"], "none");
        assert_eq!(reply["current_valid"], false);
        assert_eq!(reply["calibration"]["valid"], true);
        assert_eq!(reply["calibration"]["pole_pairs"], 7);
        assert_eq!(reply["duty"], json!([0, 0, 0]));
        let mut config = reply["config"].clone();
        config["current_limit"] = json!(1.01);
        let rejected = state
            .request(id, json!({"op":"configure", "config":config}))
            .unwrap();
        assert_eq!(rejected["ok"], false);
        assert_eq!(rejected["error"], "current_limit_range");
        assert_eq!(rejected["state"], "idle");
        assert_eq!(reply["current_limit_max"], 1);
        let mut config = reply["config"].clone();
        config["current_limit"] = json!(1);
        let accepted = state
            .request(id, json!({"op":"configure", "config":config}))
            .unwrap();
        assert_eq!(accepted["ok"], true);
        assert_eq!(accepted["config"]["current_limit"], 1);
        assert_eq!(accepted["current_trip_limit"], 1.25);
        state
            .request(id, json!({"op":"configure", "config":reply["config"]}))
            .unwrap();
        state.disconnect(Some(id)).unwrap();
        assert!(!state.snapshot().unwrap().connected);
    }
    #[test]
    fn rejects_wrong_identity_stale_ack_and_unknown_operations() {
        assert!(
            matching_reply(br#"{"device":"other","protocol":1,"id":1,"ok":true}"#, 1).is_none()
        );
        assert!(matching_reply(
            br#"{"device":"smartknob-s3","protocol":1,"id":2,"ok":true}"#,
            1
        )
        .is_none());
        assert!(matching_reply(
            br#"{"device":"smartknob-s3","protocol":1,"id":1,"ok":true}"#,
            1
        )
        .is_some());
        assert!(!valid_request(&json!({"op":"reboot"})));
        assert!(!valid_request(&json!({"op":"configure","config":null})));
        assert!(valid_request(&json!({"op":"disable"})));
    }
}

#[cfg(all(test, unix))]
mod serial_tests {
    use super::*;
    fn pair() -> (Session, serialport::TTYPort) {
        let (mut host, mut device) = serialport::TTYPort::pair().expect("PTY pair");
        host.set_timeout(Duration::from_millis(10)).unwrap();
        device.set_timeout(Duration::from_secs(1)).unwrap();
        (
            Session {
                port: Box::new(host),
                id: 1,
                sequence: 0,
                identified: false,
                port_name: "pty".into(),
            },
            device,
        )
    }
    #[test]
    fn reads_split_response_and_discards_boot_logs_and_stale_ids() {
        let (mut session, mut device) = pair();
        let worker = std::thread::spawn(move || {
            let mut command = Vec::new();
            loop {
                let mut byte = [0];
                device.read_exact(&mut byte).unwrap();
                if byte[0] == b'\n' {
                    break;
                }
                command.push(byte[0]);
            }
            let request: Value = serde_json::from_slice(&command).unwrap();
            assert_eq!(request["id"], 1);
            device.write_all(b"ESP-ROM:boot\n{\"device\":\"smartknob-s3\",\"protocol\":1,\"id\":999,\"ok\":true}\n").unwrap();
            // A frame longer than the bound must not poison the following frame.
            device.write_all(&vec![b'x'; MAX_LINE + 5]).unwrap();
            device.write_all(b"\n").unwrap();
            let reply = br#"{"device":"smartknob-s3","protocol":1,"id":1,"ok":true,"state":"idle"}
"#;
            for part in reply.chunks(13) {
                device.write_all(part).unwrap();
                std::thread::sleep(Duration::from_millis(1));
            }
            std::thread::sleep(Duration::from_millis(25));
        });
        let reply = session.request(json!({"op":"status"})).unwrap();
        assert_eq!(reply["state"], "idle");
        worker.join().unwrap();
    }
    #[test]
    fn initial_handshake_tolerates_boot_delay_without_retrying_motor_commands() {
        let (mut session, mut device) = pair();
        let worker = std::thread::spawn(move || {
            for attempt in 1..=2 {
                let mut line = Vec::new();
                loop {
                    let mut byte = [0];
                    device.read_exact(&mut byte).unwrap();
                    if byte[0] == b'\n' {
                        break;
                    }
                    line.push(byte[0]);
                }
                let request: Value = serde_json::from_slice(&line).unwrap();
                assert_eq!(request["op"], "status");
                assert_eq!(request["id"], attempt);
                if attempt == 2 {
                    let reply =
                        json!({"device": "smartknob-s3", "protocol": 1, "id": attempt, "ok": true});
                    writeln!(device, "{reply}").unwrap();
                    std::thread::sleep(Duration::from_millis(100));
                }
            }
        });
        session.identify().unwrap();
        assert!(session.identified);
        worker.join().unwrap();
    }

    #[test]
    fn established_command_timeout_does_not_resend_enable() {
        let (mut session, mut device) = pair();
        assert!(session.request(json!({"op": "enable"})).is_err());
        let mut buffer = [0; 256];
        let count = device.read(&mut buffer).unwrap();
        let commands = std::str::from_utf8(&buffer[..count]).unwrap();
        assert_eq!(commands.lines().count(), 1);
        assert_eq!(
            serde_json::from_str::<Value>(commands.trim()).unwrap()["op"],
            "enable"
        );
    }

    #[test]
    fn stale_session_cannot_send_motor_command_or_disconnect_new_session() {
        let (mut session, _device) = pair();
        session.id = 7;
        let state = KnobState(Mutex::new(Some(session)));
        assert!(state.request(6, json!({"op":"enable"})).is_err());
        state.disconnect(Some(6)).unwrap();
        assert_eq!(state.snapshot().unwrap().session_id, Some(7));
    }
}
