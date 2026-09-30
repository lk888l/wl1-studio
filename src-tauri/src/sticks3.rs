//! StickS3's physical USB radio console (API v1), independent of WL1 commands.
//! Only RS-prefixed records are consumed: boot logs can contain setup secrets.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

const MAX_REQUEST: usize = 256;
const MAX_RECORD: usize = 4096;
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(3);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
// IDs also advance across port reopens, so buffered replies cannot match a new session.
static NEXT_REQUEST: AtomicU64 = AtomicU64::new(1);
// Firmware CLI / invalid-line replies use only 1..=0x3fffffff. Keep our
// requests in the upper half, including the first handshake after NUL + LF.
const CLIENT_ID_BASE: u64 = 0x4000_0000;

// No Debug: Wi-Fi requests hold a password and must never enter logs.
#[derive(Deserialize, Serialize)]
#[serde(tag = "op", deny_unknown_fields)]
pub enum RadioRequest {
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "wifi.status")]
    WifiStatus,
    #[serde(rename = "ble.status")]
    BleStatus,
    #[serde(rename = "wifi.scan.results")]
    WifiResults {
        #[serde(default)]
        index: u8,
    },
    #[serde(rename = "ble.scan.results")]
    BleResults {
        #[serde(default)]
        index: u8,
    },
    #[serde(rename = "ble.peer")]
    BlePeer {
        #[serde(default)]
        index: u8,
    },
    #[serde(rename = "wifi.saved")]
    WifiSaved {
        #[serde(default)]
        index: u8,
    },
    #[serde(rename = "ble.saved")]
    BleSaved {
        #[serde(default)]
        index: u8,
    },
    #[serde(rename = "command.result")]
    CommandResult { ticket: u32 },
    #[serde(rename = "wifi.scan")]
    WifiScan,
    #[serde(rename = "ble.scan")]
    BleScan,
    #[serde(rename = "wifi.connect")]
    WifiConnect {
        ssid: String,
        password: String,
        remember: bool,
    },
    #[serde(rename = "ble.connect")]
    BleConnect {
        address: String,
        address_type: u8,
        remember: bool,
    },
    #[serde(rename = "wifi.use")]
    WifiUse { slot: u8 },
    #[serde(rename = "ble.use")]
    BleUse { slot: u8 },
    #[serde(rename = "wifi.forget")]
    WifiForget { slot: u8 },
    #[serde(rename = "ble.forget")]
    BleForget { slot: u8 },
    #[serde(rename = "wifi.remember")]
    WifiRemember,
    #[serde(rename = "ble.remember")]
    BleRemember,
    #[serde(rename = "wifi.reconnect")]
    WifiReconnect,
    #[serde(rename = "ble.reconnect")]
    BleReconnect,
    #[serde(rename = "wifi.disconnect")]
    WifiDisconnect,
    #[serde(rename = "ble.disconnect")]
    BleDisconnect,
    #[serde(rename = "wifi.enable")]
    WifiEnable,
    #[serde(rename = "ble.enable")]
    BleEnable,
    #[serde(rename = "wifi.disable")]
    WifiDisable,
    #[serde(rename = "ble.disable")]
    BleDisable,
}

impl RadioRequest {
    fn validate(&self) -> Result<(), String> {
        match self {
            Self::WifiConnect { ssid, password, .. } => {
                if ssid.is_empty() || ssid.len() > 32 || ssid.contains('\0') {
                    return Err("Wi-Fi 名称必须为 1–32 个 UTF-8 字节，且不能包含 NUL".into());
                }
                if password.contains('\0')
                    || !(password.is_empty()
                        || (8..=63).contains(&password.len())
                        || (password.len() == 64
                            && password.bytes().all(|b| b.is_ascii_hexdigit())))
                {
                    return Err(
                        "Wi-Fi 密码须为 8–63 个 UTF-8 字节或 64 位十六进制 PSK；开放网络留空"
                            .into(),
                    );
                }
            }
            Self::BleConnect {
                address,
                address_type,
                ..
            } if *address_type > 3
                || address.len() != 17
                || !address.bytes().enumerate().all(|(i, b)| {
                    if i % 3 == 2 {
                        b == b':'
                    } else {
                        b.is_ascii_hexdigit()
                    }
                }) =>
            {
                return Err("BLE 地址或地址类型无效，请重新扫描并选择设备".into());
            }
            Self::WifiUse { slot }
            | Self::BleUse { slot }
            | Self::WifiForget { slot }
            | Self::BleForget { slot }
                if *slot >= 4 =>
            {
                return Err("连接记忆槽必须在 0–3 之间".into());
            }
            Self::WifiSaved { index } | Self::BleSaved { index } if *index >= 4 => {
                return Err("连接记忆槽必须在 0–3 之间".into());
            }
            Self::WifiResults { index } | Self::BleResults { index } if *index >= 16 => {
                return Err("扫描结果索引必须在 0–15 之间".into());
            }
            Self::BlePeer { index } if *index >= 8 => return Err("BLE 服务索引超出范围".into()),
            Self::CommandResult { ticket: 0 } => return Err("命令 ticket 无效".into()),
            _ => {}
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RadioCapabilities {
    wifi: bool,
    ble: bool,
    memory_slots: u8,
}

fn capabilities(reply: &Value) -> Result<RadioCapabilities, String> {
    if reply["ok"] != true
        || reply["api"] != 1
        || reply["memory_slots"] != 4
        || reply["serial_framing"] != "RS-JSON-LF"
        || reply["auth"] != "physical"
        || reply["request_bytes"]
            .as_u64()
            .is_none_or(|n| n < MAX_REQUEST as u64)
        || !matches!(reply["wifi"].as_u64(), Some(0 | 1))
        || !matches!(reply["ble"].as_u64(), Some(0 | 1))
    {
        return Err("该串口不是兼容的 StickS3 USB 无线控制台；请使用支持 radio-console API v1 的固件，并退出 USB DAP 页面".into());
    }
    Ok(RadioCapabilities {
        wifi: reply["wifi"] == 1,
        ble: reply["ble"] == 1,
        memory_slots: 4,
    })
}

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StickS3Snapshot {
    pub connected: bool,
    pub session_id: Option<u64>,
    pub port_name: Option<String>,
    pub capabilities: Option<RadioCapabilities>,
}

#[derive(Default)]
struct RecordFramer {
    bytes: Vec<u8>,
    recording: bool,
}

impl RecordFramer {
    fn push(&mut self, byte: u8) -> Option<Value> {
        if byte == 0x1e {
            self.bytes.clear();
            self.recording = true;
        } else if self.recording && byte == b'\n' {
            self.recording = false;
            let record = serde_json::from_slice::<Value>(&self.bytes).ok();
            self.bytes.clear();
            return record.filter(|v| {
                v["v"] == 1
                    && v["id"].as_u64().is_some_and(|id| id <= i32::MAX as u64)
                    && v["ok"].is_boolean()
            });
        } else if self.recording {
            if self.bytes.len() >= MAX_RECORD {
                self.bytes.clear();
                self.recording = false;
            } else {
                self.bytes.push(byte);
            }
        }
        None
    }
}

fn encode_request(mut request: Value, id: u64) -> Result<Vec<u8>, String> {
    request["v"] = Value::from(1);
    request["id"] = Value::from(id);
    let mut bytes = serde_json::to_vec(&request).map_err(|_| "无法编码 S3 请求")?;
    if bytes.len() > MAX_REQUEST {
        return Err("转义后的请求超过固件 256 字节上限，请缩短名称或密码".into());
    }
    bytes.push(b'\n');
    Ok(bytes)
}

fn exchange<T: Read + Write + ?Sized>(
    port: &mut T,
    framer: &mut RecordFramer,
    request: Value,
    timeout: Duration,
) -> Result<Value, String> {
    let id = CLIENT_ID_BASE + NEXT_REQUEST.fetch_add(1, Ordering::Relaxed) % CLIENT_ID_BASE;
    let bytes = encode_request(request, id)?;
    port.write_all(&bytes)
        .map_err(|error| format!("S3 串口写入失败：{error}；操作结果未知，请重连后查询状态"))?;
    // Never retry a write or flush (tcdrain may block indefinitely on a removed USB device).
    let deadline = Instant::now() + timeout;
    let mut buffer = [0u8; 512];
    while Instant::now() < deadline {
        match port.read(&mut buffer) {
            Ok(0) => {
                return Err("S3 USB 已断开；请退出 USB DAP 页面或重新插入设备，再连接串口".into())
            }
            Ok(count) => {
                let mut matched = None;
                for &byte in &buffer[..count] {
                    if let Some(reply) = framer.push(byte) {
                        if reply["id"].as_u64() == Some(id) {
                            matched = Some(reply);
                        }
                    }
                }
                if let Some(reply) = matched {
                    return Ok(reply);
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                ) => {}
            Err(error) => {
                return Err(format!(
                    "S3 串口读取失败：{error}；请重新连接并查询操作结果"
                ))
            }
        }
    }
    Err(
        "S3 响应超时，操作结果未知，未自动重发。请重新连接后查看状态；USB DAP 活动时控制串口不可用"
            .into(),
    )
}

struct Session {
    snapshot: StickS3Snapshot,
    port: Box<dyn SerialPort>,
    framer: RecordFramer,
}

#[derive(Default)]
pub struct StickS3State {
    session: Mutex<Option<Session>>,
}

impl StickS3State {
    pub fn snapshot(&self) -> Result<StickS3Snapshot, String> {
        let guard = self.session.lock().map_err(|_| "S3 会话锁已损坏")?;
        Ok(guard
            .as_ref()
            .map(|s| s.snapshot.clone())
            .unwrap_or_default())
    }

    pub fn disconnect(&self, expected: Option<u64>) -> Result<StickS3Snapshot, String> {
        let mut guard = self.session.lock().map_err(|_| "S3 会话锁已损坏")?;
        if expected.is_none()
            || guard
                .as_ref()
                .is_some_and(|s| s.snapshot.session_id == expected)
        {
            // Closing the console leaves radio links and persistent memories intact.
            *guard = None;
        }
        Ok(guard
            .as_ref()
            .map(|s| s.snapshot.clone())
            .unwrap_or_default())
    }

    pub fn connect(&self, port_name: &str) -> Result<StickS3Snapshot, String> {
        let mut guard = self.session.lock().map_err(|_| "S3 会话锁已损坏")?;
        *guard = None;
        let mut port = serialport::new(port_name, 115_200)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(80))
            .preserve_dtr_on_open()
            .open()
            .map_err(|error| format!("无法打开 S3 串口 {port_name}：{error}"))?;
        // NUL invalidates the entire old line before LF. A bare LF could execute
        // another console client's unfinished mutation when reopening its port.
        port.write_all(b"\0\n")
            .map_err(|error| format!("无法初始化 S3 控制台：{error}"))?;
        let mut framer = RecordFramer::default();
        let deadline = Instant::now() + Duration::from_secs(12);
        let caps = loop {
            let reply = exchange(
                &mut *port,
                &mut framer,
                serde_json::json!({"op": "capabilities"}),
                Duration::from_millis(700),
            );
            match reply {
                Ok(value) if value["error"] != "unavailable" => break capabilities(&value)?,
                _ if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(150)),
                _ => return Err("未收到 S3 USB 控制台握手。请关闭其他串口监视器，确认固件支持 API v1，退出 USB DAP 后刷新串口重试".into()),
            }
        };
        let snapshot = StickS3Snapshot {
            connected: true,
            session_id: Some(NEXT_SESSION.fetch_add(1, Ordering::Relaxed)),
            port_name: Some(port_name.into()),
            capabilities: Some(caps),
        };
        *guard = Some(Session {
            snapshot: snapshot.clone(),
            port,
            framer,
        });
        Ok(snapshot)
    }

    pub fn request(&self, expected: u64, request: RadioRequest) -> Result<Value, String> {
        request.validate()?;
        let value = serde_json::to_value(request).map_err(|_| "无法编码 S3 操作")?;
        // Validate escaped size before touching the port or invalidating the session.
        encode_request(value.clone(), i32::MAX as u64)?;
        let mut guard = self.session.lock().map_err(|_| "S3 会话锁已损坏")?;
        let session = guard
            .as_mut()
            .filter(|s| s.snapshot.session_id == Some(expected))
            .ok_or("S3 会话已过期，请重新连接")?;
        let result = exchange(
            &mut *session.port,
            &mut session.framer,
            value,
            RESPONSE_TIMEOUT,
        );
        if result.is_err() {
            *guard = None;
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    #[ignore = "Requires STICKS3_TEST_PORT and STICKS3_TEST_IP; reads USB status without changing Wi-Fi"]
    fn hardware_usb_wifi_status() {
        let port = std::env::var("STICKS3_TEST_PORT").expect("Set the authorized USB console port");
        let ip = std::env::var("STICKS3_TEST_IP").expect("Set the expected device IP");
        let state = StickS3State::default();
        let connected = state.connect(&port).expect("USB capability handshake");
        let session = connected.session_id.unwrap();
        let status = state.request(session, RadioRequest::WifiStatus).unwrap();
        assert_eq!(status["ok"], true);
        assert_eq!(status["state"], "connected");
        assert_eq!(status["ip"], ip);
        let saved = state
            .request(session, RadioRequest::WifiSaved { index: 0 })
            .unwrap();
        assert_eq!(saved["ok"], true);
        assert!(saved["used_mask"].is_u64());
        println!(
            "USB capability handshake and Wi-Fi status passed: IP={ip}, used_mask={}",
            saved["used_mask"]
        );
        assert!(!state.disconnect(Some(session)).unwrap().connected);
    }

    #[test]
    fn frames_only_rs_records_and_recovers_after_damage() {
        let mut framer = RecordFramer::default();
        let mut replies = Vec::new();
        let stream = b"secret setup log\n{\"v\":1,\"id\":1,\"ok\":true}\n\x1ebroken\n\x1e{\"v\":2,\"id\":1,\"ok\":true}\n\x1e{\"v\":1,\"id\":1,\"ok\":true}\r\n\x1epartial\x1e{\"v\":1,\"id\":2,\"ok\":false}\n";
        for chunk in stream.chunks(3) {
            for &byte in chunk {
                if let Some(value) = framer.push(byte) {
                    replies.push(value);
                }
            }
        }
        assert_eq!(replies.len(), 2);
        assert_eq!(replies[0]["id"], 1);
        assert_eq!(replies[1]["id"], 2);
        framer.push(0x1e);
        for _ in 0..MAX_RECORD + 50 {
            assert!(framer.push(b'a').is_none());
        }
        assert!(framer.bytes.len() <= MAX_RECORD);
        for &byte in b"{\"v\":1,\"id\":3,\"ok\":true}\n" {
            assert!(framer.push(byte).is_none());
        }
        let values: Vec<_> = b"\x1e{\"v\":1,\"id\":4,\"ok\":true}\n"
            .iter()
            .filter_map(|&b| framer.push(b))
            .collect();
        assert_eq!(values.len(), 1);
    }

    #[test]
    fn credentials_use_utf8_bytes_and_json_escaping() {
        let valid = RadioRequest::WifiConnect {
            ssid: "家庭网络".into(),
            password: "pa\"ss\\word".into(),
            remember: true,
        };
        valid.validate().unwrap();
        let encoded = encode_request(serde_json::to_value(valid).unwrap(), 7).unwrap();
        let decoded: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(decoded["password"], "pa\"ss\\word");
        assert_eq!(encoded.last(), Some(&b'\n'));
        for (ssid, password) in [
            ("网".repeat(11), String::new()),
            ("ok".into(), "short".into()),
            ("ok".into(), "z".repeat(64)),
            ("ok\0".into(), String::new()),
        ] {
            assert!(RadioRequest::WifiConnect {
                ssid,
                password,
                remember: false
            }
            .validate()
            .is_err());
        }
        assert!(encode_request(serde_json::json!({"op":"wifi.connect", "ssid":"x", "password":"\u{1}".repeat(63), "remember":true}), 1).is_err());
    }

    #[test]
    fn rejects_unlisted_operations_fields_and_invalid_targets() {
        for value in [
            serde_json::json!({"op":"wifi.clear"}),
            serde_json::json!({"op":"wifi.forget","slot":0,"all":true}),
            serde_json::json!({"op":"wifi.connect","ssid":"x","password":"","remember":true,"token":"x"}),
        ] {
            assert!(serde_json::from_value::<RadioRequest>(value).is_err());
        }
        assert!(RadioRequest::WifiUse { slot: 4 }.validate().is_err());
        assert!(RadioRequest::CommandResult { ticket: 0 }
            .validate()
            .is_err());
        assert!(RadioRequest::BleConnect {
            address: "AA:BB:CC:DD:EE:FF".into(),
            address_type: 4,
            remember: true
        }
        .validate()
        .is_err());
    }

    #[test]
    fn handshake_requires_physical_console_capabilities() {
        let mut reply = serde_json::json!({"ok":true,"api":1,"memory_slots":4,"wifi":1,"ble":0,"request_bytes":256,"serial_framing":"RS-JSON-LF","auth":"physical"});
        assert!(!capabilities(&reply).unwrap().ble);
        reply["auth"] = Value::from("token");
        assert!(capabilities(&reply).is_err());
    }

    #[test]
    fn exchange_ignores_stale_ids_and_writes_a_mutation_once() {
        struct FakePort {
            written: Vec<u8>,
            response: std::io::Cursor<Vec<u8>>,
        }
        impl Write for FakePort {
            fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
                self.written.extend_from_slice(bytes);
                let request: Value = serde_json::from_slice(&self.written).unwrap();
                self.response = std::io::Cursor::new(format!("boot log\n\x1e{{\"v\":1,\"id\":2147483647,\"ok\":true}}\n\x1e{{\"v\":1,\"id\":{},\"ok\":true,\"ticket\":42}}\n", request["id"]).into_bytes());
                Ok(bytes.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                panic!("USB flush is not bounded")
            }
        }
        impl Read for FakePort {
            fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
                self.response.read(&mut bytes[..3])
            }
        }
        let mut port = FakePort {
            written: Vec::new(),
            response: std::io::Cursor::new(Vec::new()),
        };
        let reply = exchange(
            &mut port,
            &mut RecordFramer::default(),
            serde_json::json!({"op":"wifi.scan"}),
            RESPONSE_TIMEOUT,
        )
        .unwrap();
        assert_eq!(reply["ticket"], 42);
        assert_eq!(port.written.iter().filter(|&&b| b == b'\n').count(), 1);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn serial_session_handshakes_clears_partial_input_and_isolates_old_ids() {
        let (mut peer, slave) = serialport::TTYPort::pair().unwrap();
        peer.set_timeout(Duration::from_secs(2)).unwrap();
        let path = slave.name().unwrap();
        let (stop, stopped) = std::sync::mpsc::channel();
        let device = std::thread::spawn(move || {
            let mut line = Vec::new();
            let mut byte = [0u8; 1];
            let mut seen = Vec::new();
            for _ in 0..3 {
                line.clear();
                loop {
                    peer.read_exact(&mut byte).unwrap();
                    if byte[0] == b'\n' {
                        break;
                    }
                    line.push(byte[0]);
                }
                if line == b"\0" {
                    seen.push("invalidated_partial".to_owned());
                    peer.write_all(
                        b"\x1e{\"v\":1,\"id\":1,\"ok\":false,\"error\":\"invalid_line\"}\n",
                    )
                    .unwrap();
                    continue;
                }
                let request: Value = serde_json::from_slice(&line).unwrap();
                assert!(request["id"].as_u64().unwrap() >= CLIENT_ID_BASE);
                seen.push(request["op"].as_str().unwrap().to_owned());
                let mut reply = if request["op"] == "capabilities" {
                    serde_json::json!({"api":1,"memory_slots":4,"wifi":1,"ble":1,"request_bytes":256,"serial_framing":"RS-JSON-LF","auth":"physical"})
                } else {
                    assert_eq!(request["op"], "wifi.scan");
                    serde_json::json!({"result":"accepted","ticket":37})
                };
                reply["v"] = Value::from(1);
                reply["id"] = request["id"].clone();
                reply["ok"] = Value::from(true);
                // Mixed logs, fragmented records and CRLF cross the real serialport path.
                peer.write_all(b"I boot: setup log ignored\n\x1e").unwrap();
                let encoded = serde_json::to_vec(&reply).unwrap();
                for chunk in encoded.chunks(7) {
                    peer.write_all(chunk).unwrap();
                }
                peer.write_all(b"\r\n").unwrap();
            }
            stopped.recv_timeout(Duration::from_secs(5)).unwrap();
            seen
        });
        let state = StickS3State::default();
        let snapshot = state.connect(&path).unwrap();
        let id = snapshot.session_id.unwrap();
        assert!(state.request(id + 1, RadioRequest::WifiScan).is_err());
        assert!(state.disconnect(Some(id + 1)).unwrap().connected);
        let response = state.request(id, RadioRequest::WifiScan).unwrap();
        assert_eq!(response["ticket"], 37);
        assert!(!state.disconnect(Some(id)).unwrap().connected);
        assert!(state.request(id, RadioRequest::WifiScan).is_err());
        stop.send(()).unwrap();
        assert_eq!(
            device.join().unwrap(),
            ["invalidated_partial", "capabilities", "wifi.scan"]
        );
    }
}
