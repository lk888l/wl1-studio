//! Versioned SmartKnob USB configuration and observation session.
//! The ESP32 owns its motor loop. Connecting only reads status; detaching,
//! dropping a session, or losing transport never sends a motor command.
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
const DEADLINE: Duration = Duration::from_millis(1800);
const HANDSHAKE_DEADLINE: Duration = Duration::from_secs(3);
// Per-mode settings plus an explicitly requested default bank can exceed 16 KiB.
const MAX_LINE: usize = 32768;

trait KnobTransport: Read + Write + Send {}
impl<T: Read + Write + Send> KnobTransport for T {}

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
    port: Box<dyn KnobTransport>,
    id: u64,
    sequence: u32,
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
struct ReplyDecoder {
    line: Vec<u8>,
    overflow: bool,
}
impl ReplyDecoder {
    fn new() -> Self {
        Self {
            line: Vec::with_capacity(2048),
            overflow: false,
        }
    }
    fn push(&mut self, byte: u8, id: u32) -> Option<Value> {
        if byte == b'\n' {
            let reply = (!self.overflow)
                .then(|| matching_reply(&self.line, id))
                .flatten();
            self.line.clear();
            self.overflow = false;
            reply
        } else {
            if self.line.len() < MAX_LINE && !self.overflow {
                self.line.push(byte);
            } else {
                self.overflow = true;
            }
            None
        }
    }
}
impl Session {
    fn request(&mut self, request: Value) -> Result<Value, String> {
        if !valid_request(&request) {
            return Err("无效的旋钮请求".into());
        }
        self.exchange(request).map_err(|error| match error {
            RequestError::Timeout => {
                "旋钮响应超时；连接已释放，设备运行状态和指令结果尚未确认。请重新连接读取状态"
                    .into()
            }
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
        let mut decoder = ReplyDecoder::new();
        let mut buffer = [0u8; 256];
        while Instant::now() < end {
            match self.port.read(&mut buffer) {
                Ok(count) => {
                    for byte in &buffer[..count] {
                        if let Some(reply) = decoder.push(*byte, self.sequence) {
                            return Ok(reply);
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
fn open_port(name: &str) -> Result<Box<dyn KnobTransport>, String> {
    let mut port = serialport::new(name, 115200)
        .timeout(Duration::from_millis(50))
        .flow_control(serialport::FlowControl::None)
        .dtr_on_open(false)
        .open_native()
        .map_err(|e| format!("无法打开旋钮串口：{e}"))?;
    // Do not pulse the ESP32 USB reset/boot control lines on attachment.
    port.write_data_terminal_ready(false)
        .map_err(|e| format!("无法设置旋钮 DTR：{e}"))?;
    port.write_request_to_send(false)
        .map_err(|e| format!("无法设置旋钮 RTS：{e}"))?;
    #[cfg(windows)]
    {
        // Extended firmware status exceeds Windows' default 4 KiB RX queue.
        serial_windows::configure_queues(&port, 65536, 8192)
            .map_err(|e| format!("无法设置旋钮 USB 接收缓冲：{e}"))?;
    }
    Ok(Box::new(port))
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
        let port = open_port(name)?;
        let session = Session {
            port,
            id: NEXT_SESSION.fetch_add(1, Ordering::Relaxed),
            sequence: 0,
            port_name: name.into(),
        };
        self.establish(session)
    }
    fn establish(&self, mut session: Session) -> Result<KnobSnapshot, String> {
        // Attaching observes the running device without changing its mode,
        // calibration, persistent configuration, or enable state.
        session.identify()?;
        *self.0.lock().map_err(|_| "旋钮会话锁已损坏")? = Some(session);
        self.snapshot()
    }
    pub fn disconnect(&self, expected: Option<u64>) -> Result<(), String> {
        let mut lock = self.0.lock().map_err(|_| "旋钮会话锁已损坏")?;
        if expected.is_some_and(|id| lock.as_ref().is_none_or(|s| id != s.id)) {
            return Ok(());
        }
        // Releasing a connection is independent of the firmware's run state.
        // The explicit `disable` operation remains the only host stop request.
        lock.take();
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
    use std::collections::VecDeque;
    use std::sync::Arc;

    #[derive(Default)]
    struct MockState {
        requests: Vec<Value>,
        reply: Option<Value>,
        incoming: VecDeque<u8>,
        fail_read: bool,
        dropped: bool,
    }
    struct MockPort(Arc<Mutex<MockState>>);
    impl Read for MockPort {
        fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
            let mut state = self.0.lock().unwrap();
            if state.fail_read {
                return Err(std::io::Error::new(ErrorKind::BrokenPipe, "USB removed"));
            }
            let count = bytes.len().min(137).min(state.incoming.len());
            for byte in &mut bytes[..count] {
                *byte = state.incoming.pop_front().unwrap();
            }
            Ok(count)
        }
    }
    impl Write for MockPort {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            let request: Value = serde_json::from_slice(bytes).unwrap();
            let mut state = self.0.lock().unwrap();
            let mut reply = state.reply.clone().unwrap_or_else(|| {
                json!({"device":"smartknob-s3","protocol":1,"ok":true,"state":"active",
                    "config":{"mode":16},"mode_count":17,"frictionless":{"phase":2}})
            });
            reply["id"] = request["id"].clone();
            state.incoming.extend(serde_json::to_vec(&reply).unwrap());
            state.incoming.push_back(b'\n');
            state.requests.push(request);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            panic!("serial flush may block indefinitely on Windows")
        }
    }
    impl Drop for MockPort {
        fn drop(&mut self) {
            self.0.lock().unwrap().dropped = true;
        }
    }
    fn mock_session(id: u64) -> (Session, Arc<Mutex<MockState>>) {
        let mock = Arc::new(Mutex::new(MockState::default()));
        (
            Session {
                port: Box::new(MockPort(mock.clone())),
                id,
                sequence: 0,
                port_name: "mock".into(),
            },
            mock,
        )
    }
    #[test]
    fn attach_observes_active_motor_and_detach_only_releases_port() {
        let (session, mock) = mock_session(7);
        let state = KnobState::default();
        assert!(state.establish(session).unwrap().connected);
        let reply = state.request(7, json!({"op":"status"})).unwrap();
        assert_eq!(reply["state"], "active");
        assert_eq!(reply["config"]["mode"], 16);
        state.disconnect(Some(7)).unwrap();
        assert!(!state.snapshot().unwrap().connected);
        let trace = mock.lock().unwrap();
        assert!(trace.dropped);
        assert_eq!(trace.requests.len(), 2);
        assert!(trace
            .requests
            .iter()
            .all(|request| request["op"] == "status"));
    }
    #[test]
    fn dropping_active_session_does_not_send_a_motor_command() {
        let (session, mock) = mock_session(7);
        let state = KnobState::default();
        state.establish(session).unwrap();
        drop(state);
        let trace = mock.lock().unwrap();
        assert!(trace.dropped);
        assert_eq!(trace.requests.len(), 1);
        assert_eq!(trace.requests[0]["op"], "status");
    }
    #[test]
    fn stale_session_cannot_mutate_or_detach_another_connection() {
        let (session, mock) = mock_session(7);
        let state = KnobState::default();
        state.establish(session).unwrap();
        assert!(state.request(6, json!({"op":"enable"})).is_err());
        state.disconnect(Some(6)).unwrap();
        assert_eq!(state.snapshot().unwrap().session_id, Some(7));
        assert_eq!(mock.lock().unwrap().requests.len(), 1);
    }
    #[test]
    fn transport_error_releases_without_retry_or_implicit_disable() {
        let (session, mock) = mock_session(7);
        let state = KnobState::default();
        state.establish(session).unwrap();
        mock.lock().unwrap().fail_read = true;
        assert!(state.request(7, json!({"op":"enable"})).is_err());
        assert!(!state.snapshot().unwrap().connected);
        let trace = mock.lock().unwrap();
        assert!(trace.dropped);
        assert_eq!(trace.requests.len(), 2);
        assert_eq!(trace.requests[1]["op"], "enable");
    }
    #[test]
    fn firmware_rejection_keeps_connection_and_unknown_configuration_fields() {
        let (session, mock) = mock_session(7);
        let state = KnobState::default();
        state.establish(session).unwrap();
        mock.lock().unwrap().reply = Some(json!({"device":"smartknob-s3","protocol":1,
            "ok":false,"error":"frictionless_range","state":"active","config":{"mode":16}}));
        let config = json!({"mode":16,"future_extension":{"keep":true},
            "frictionless":{"friction":0.022,"viscous":0.000304,"scale":1,"hold_kp":0.016,"hold_ki":0.024}});
        let reply = state
            .request(7, json!({"op":"configure","config":config}))
            .unwrap();
        assert_eq!(reply["ok"], false);
        assert!(state.snapshot().unwrap().connected);
        assert_eq!(mock.lock().unwrap().requests[1]["config"], config);
        assert!(state.request(7, json!({"op":"unknown"})).is_err());
        assert!(state.snapshot().unwrap().connected);
        assert_eq!(mock.lock().unwrap().requests.len(), 2);
    }
    #[test]
    fn only_explicit_motor_operations_are_written() {
        let (session, mock) = mock_session(7);
        let state = KnobState::default();
        state.establish(session).unwrap();
        state.request(7, json!({"op":"enable"})).unwrap();
        state.request(7, json!({"op":"disable"})).unwrap();
        state.disconnect(None).unwrap();
        let trace = mock.lock().unwrap();
        assert_eq!(
            trace
                .requests
                .iter()
                .map(|request| request["op"].as_str().unwrap())
                .collect::<Vec<_>>(),
            ["status", "enable", "disable"]
        );
    }

    // These tests only change legacy fields. Keep the full snapshot for
    // verification, but do not resend v21's unchanged reference-mode bank.
    fn legacy_hardware_config(config: &Value) -> Value {
        let mut request_config = config.clone();
        request_config
            .as_object_mut()
            .expect("Hardware status configuration must be an object")
            .remove("reference_modes");
        request_config
    }

    // Hardware tests must restore settings even if an assertion panics after
    // accepting the maximum limit. Reconnecting here is cleanup only; the
    // production session never retries motor commands or reconnects itself.
    struct RestoreHardwareConfig<'a> {
        state: &'a KnobState,
        port: &'a str,
        config: Value,
        restored: bool,
    }
    impl RestoreHardwareConfig<'_> {
        fn restore(&mut self) -> Result<(), String> {
            if self.restored {
                return Ok(());
            }
            let id = match self.state.snapshot()?.session_id {
                Some(id) => id,
                None => self
                    .state
                    .connect(self.port)?
                    .session_id
                    .ok_or("Cleanup connection has no session ID")?,
            };
            let stopped = self.state.request(id, json!({"op":"disable"}))?;
            if stopped["ok"] != true || !matches!(stopped["state"].as_str(), Some("idle" | "fault"))
            {
                return Err("Hardware cleanup did not confirm disable".into());
            }
            let restored = self.state.request(
                id,
                json!({"op":"configure", "config":legacy_hardware_config(&self.config)}),
            )?;
            if restored["ok"] != true || restored["config"] != self.config {
                return Err("Hardware cleanup did not restore the original configuration".into());
            }
            self.state.disconnect(Some(id))?;
            self.restored = true;
            Ok(())
        }
    }
    impl Drop for RestoreHardwareConfig<'_> {
        fn drop(&mut self) {
            for _ in 0..2 {
                match self.restore() {
                    Ok(()) => return,
                    Err(error) => eprintln!("SmartKnob hardware test cleanup: {error}"),
                }
            }
            let _ = self.state.disconnect(None);
        }
    }

    #[test]
    fn v21_legacy_hardware_requests_fit_limit_and_preserve_full_restore_snapshot() {
        let initial: Value = serde_json::from_str(include_str!(
            "../../src/lib/__fixtures__/knob-v21-status.json"
        ))
        .unwrap();
        let original = serde_json::to_vec(&initial).unwrap();
        assert_eq!(
            initial["config"]["reference_modes"]
                .as_object()
                .unwrap()
                .len(),
            12
        );
        assert!(!valid_request(
            &json!({"op":"configure", "config":initial["config"]})
        ));
        for (field, value) in [
            ("mode", json!(16)),
            ("current_limit", json!(4.51)),
            ("strength", json!(1000.01)),
            ("current_limit", json!(4.5)),
            ("strength", json!(1000)),
        ] {
            let mut config = legacy_hardware_config(&initial["config"]);
            config[field] = value;
            let request = json!({"op":"configure", "config":config});
            assert!(valid_request(&request));
            assert!(serde_json::to_vec(&request).unwrap().len() <= 1900);
            assert!(request["config"].get("reference_modes").is_none());
        }

        let (session, mock) = mock_session(7);
        mock.lock().unwrap().reply = Some(initial.clone());
        let state = KnobState::default();
        state.establish(session).unwrap();
        let mut restore = RestoreHardwareConfig {
            state: &state,
            port: "mock",
            config: initial["config"].clone(),
            restored: false,
        };
        restore.restore().unwrap();
        assert_eq!(restore.config, initial["config"]);
        assert_eq!(serde_json::to_vec(&initial).unwrap(), original);
        assert!(!state.snapshot().unwrap().connected);
        let trace = mock.lock().unwrap();
        assert_eq!(trace.requests.len(), 3);
        assert_eq!(trace.requests[1]["op"], "disable");
        assert_eq!(trace.requests[2]["op"], "configure");
        assert_eq!(
            trace.requests[2]["config"],
            legacy_hardware_config(&initial["config"])
        );
        assert!(valid_request(&trace.requests[2]));
    }

    #[test]
    #[ignore = "Requires SMARTKNOB_TEST_PORT, an idle calibrated unloaded ESP32, and lease=0"]
    fn real_board_keeps_running_while_detached() {
        let port = std::env::var("SMARTKNOB_TEST_PORT").expect("Set the dedicated hardware port");
        let state = KnobState::default();
        let id = state.connect(&port).unwrap().session_id.unwrap();
        let initial = state.request(id, json!({"op":"status"})).unwrap();
        // Do not interrupt a user-owned active session to prepare this test.
        assert_eq!(initial["state"], "idle", "hardware test requires idle");
        assert_eq!(initial["fault"], "none");
        assert_eq!(initial["host_lease_ms"], 0);
        assert_eq!(initial["calibration"]["valid"], true);
        let mut restore = RestoreHardwareConfig {
            state: &state,
            port: &port,
            config: initial["config"].clone(),
            restored: false,
        };
        let mut config = legacy_hardware_config(&initial["config"]);
        config["mode"] = json!(16);
        assert_eq!(
            state
                .request(id, json!({"op":"configure","config":config}))
                .unwrap()["ok"],
            true
        );
        assert_eq!(
            state.request(id, json!({"op":"enable"})).unwrap()["ok"],
            true
        );
        let deadline = Instant::now() + Duration::from_secs(2);
        let before = loop {
            let status = state.request(id, json!({"op":"status"})).unwrap();
            assert_eq!(status["fault"], "none");
            if status["state"] == "active" {
                break status;
            }
            assert!(Instant::now() < deadline, "enable did not reach active");
            std::thread::sleep(Duration::from_millis(30));
        };
        state.disconnect(Some(id)).unwrap();
        std::thread::sleep(Duration::from_secs(5));
        let attached = state.connect(&port).unwrap().session_id.unwrap();
        let after = state.request(attached, json!({"op":"status"})).unwrap();
        assert_eq!(after["state"], "active");
        assert_eq!(after["fault"], "none");
        assert_eq!(after["config"], before["config"]);
        assert!(after["uptime_ms"].as_u64().unwrap() > before["uptime_ms"].as_u64().unwrap());
        assert!(
            after["control_cycles"].as_u64().unwrap()
                > before["control_cycles"].as_u64().unwrap() + 5000
        );
        restore.restore().unwrap();
        let final_id = state.connect(&port).unwrap().session_id.unwrap();
        let final_state = state.request(final_id, json!({"op":"status"})).unwrap();
        state.disconnect(Some(final_id)).unwrap();
        assert_eq!(final_state["state"], "idle");
        assert_eq!(final_state["fault"], "none");
        assert_eq!(final_state["config"], initial["config"]);
        assert_eq!(final_state["calibration"], initial["calibration"]);
        assert_eq!(
            final_state["calibration_quality"],
            initial["calibration_quality"]
        );
        let report = json!({"passed":true,"initial":initial,"before_detach":before,
            "after_reattach":after,"final":final_state});
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        if let Ok(path) = std::env::var("SMARTKNOB_TEST_REPORT") {
            let file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
                .unwrap();
            serde_json::to_writer_pretty(file, &report).unwrap();
        }
    }

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
        assert!(!reply["firmware"].as_str().unwrap().is_empty());
        assert_eq!(reply["current_limit_max"], 4.5);
        let strength_max = reply["strength_max"].as_f64().unwrap();
        assert!(strength_max.is_finite() && strength_max > 0.0);
        assert_eq!(reply["current_peak_trip"], 5);
        assert_eq!(reply["current_absolute_trip"], 6);
        assert_eq!(reply["current_peak_trip_ms"], 1);
        assert_eq!(reply["current_overload_trip_ms"], 20);
        assert_eq!(reply["current_trip_recovery_ratio"], 4);
        assert_eq!(reply["detent_quiet_velocity"], false);
        assert_eq!(reply["haptic_position_filter"], false);
        assert_eq!(reply["current_target_slew"], false);
        let mut restore = RestoreHardwareConfig {
            state: &state,
            port: &port,
            config: reply["config"].clone(),
            restored: false,
        };
        for (field, value, error) in [
            ("current_limit", 4.51, "current_limit_range"),
            ("strength", strength_max + 0.01, "haptic_range"),
        ] {
            let mut config = legacy_hardware_config(&reply["config"]);
            config[field] = json!(value);
            let rejected = state
                .request(id, json!({"op":"configure", "config":config}))
                .unwrap();
            assert_eq!(rejected["ok"], false);
            assert_eq!(rejected["error"], error);
            assert_eq!(rejected["state"], "idle");
            assert_eq!(rejected["config"], reply["config"]);
            assert_eq!(rejected["duty"], json!([0, 0, 0]));
        }
        let mut config = legacy_hardware_config(&reply["config"]);
        config["current_limit"] = json!(4.5);
        config["strength"] = json!(strength_max);
        let accepted = state
            .request(id, json!({"op":"configure", "config":config}))
            .unwrap();
        assert_eq!(accepted["ok"], true);
        assert_eq!(accepted["state"], "idle");
        assert_eq!(accepted["duty"], json!([0, 0, 0]));
        assert_eq!(accepted["config"]["current_limit"], 4.5);
        assert_eq!(accepted["config"]["strength"], strength_max);
        assert_eq!(accepted["current_trip_limit"], 5);
        restore
            .restore()
            .expect("Restore original configuration and stop");
        assert!(!state.snapshot().unwrap().connected);
    }

    #[test]
    fn decodes_split_v4_reply_larger_than_4096_bytes() {
        let reply = json!({
            "device":"smartknob-s3", "protocol":1, "id":42, "ok":true,
            "firmware":"dma-localized-v4", "state":"fault", "fault":"overcurrent",
            "current_limit_max":4.5, "strength_max":100, "current_peak_trip":5,
            "current_absolute_trip":6, "host_lease_ms":0,
            "fault_sample":{"adc_raw":[2000, 2100], "adc_phase":[0, 1]},
            "diagnostic":{"samples":vec![vec![0.0; 16]; 80]}
        });
        let mut bytes = serde_json::to_vec(&reply).unwrap();
        assert!(bytes.len() > 4096 && bytes.len() < MAX_LINE);
        bytes.push(b'\n');
        let mut decoder = ReplyDecoder::new();
        let mut decoded = Vec::new();
        for chunk in bytes.chunks(137) {
            for &byte in chunk {
                if let Some(value) = decoder.push(byte, 42) {
                    decoded.push(value);
                }
            }
        }
        assert_eq!(decoded, vec![reply]);
    }

    #[test]
    fn frame_size_boundary_and_oversize_recovery_preserve_reply_identity() {
        let padded = |length: usize| {
            let mut value = json!({
                "device":"smartknob-s3", "protocol":1, "id":7, "ok":true,
                "firmware":"dma-localized-v4", "extension":""
            });
            let base = serde_json::to_vec(&value).unwrap().len();
            value["extension"] = json!("x".repeat(length - base));
            let mut bytes = serde_json::to_vec(&value).unwrap();
            assert_eq!(bytes.len(), length);
            bytes.push(b'\n');
            bytes
        };
        let mut decoder = ReplyDecoder::new();
        let boundary: Vec<_> = padded(MAX_LINE)
            .into_iter()
            .filter_map(|byte| decoder.push(byte, 7))
            .collect();
        assert_eq!(boundary.len(), 1);
        for byte in padded(MAX_LINE + 1) {
            assert!(decoder.push(byte, 7).is_none());
            assert!(decoder.line.len() <= MAX_LINE);
        }
        let stream = concat!(
            "ESP-ROM:boot\n",
            "{\"device\":\"other\",\"protocol\":1,\"id\":7,\"ok\":true}\n",
            "{\"device\":\"smartknob-s3\",\"protocol\":1,\"id\":6,\"ok\":true}\n",
            "{\"device\":\"smartknob-s3\",\"protocol\":1,\"id\":7,\"ok\":true,\"state\":\"idle\"}\n"
        );
        let decoded: Vec<_> = stream
            .bytes()
            .filter_map(|byte| decoder.push(byte, 7))
            .collect();
        assert_eq!(decoded.len(), 1);
        assert_eq!(decoded[0]["state"], "idle");
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
        device.set_timeout(Duration::from_secs(3)).unwrap();
        (
            Session {
                port: Box::new(host),
                id: 1,
                sequence: 0,
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
