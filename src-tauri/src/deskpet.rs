//! ESP32-C3 OLED desktop pet console. Commands use a separate, owned USB
//! session because the firmware console includes echo, prompts and boot logs.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Serialize;
use serialport::{ClearBuffer, DataBits, FlowControl, Parity, SerialPort, StopBits};

const MAX_PACK_BYTES: usize = 6_208;
const MAX_LINE_BYTES: usize = 1_024;
const COMMAND_TIMEOUT: Duration = Duration::from_secs(2);
const COMMIT_TIMEOUT: Duration = Duration::from_secs(5);
static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PetSnapshot {
    pub connected: bool,
    pub session_id: Option<u64>,
    pub port_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<String>,
}

struct Command {
    text: String,
    verb: &'static str,
    timeout: Duration,
}

fn validate_command(command: &str) -> Result<Command, String> {
    // Reject line delimiters and terminal control codes before writing anything.
    if command.len() > 192
        || command.is_empty()
        || !command
            .bytes()
            .all(|byte| byte == b' ' || byte.is_ascii_graphic())
    {
        return Err("桌宠命令必须是单行 ASCII 文本，且不能超过 192 字节".into());
    }
    let words: Vec<_> = command.split_ascii_whitespace().collect();
    let verb = match words.as_slice() {
        ["pet", "status"] => "status",
        ["pet", "close"] => "close",
        ["pet", "commit"] => "commit",
        ["pet", "abort"] => "abort",
        ["pet", "open", style] if style.parse::<u8>().is_ok_and(|style| style <= 4) => "open",
        ["pet", "action", action]
            if matches!(
                *action,
                "idle" | "blink" | "happy" | "eat" | "sleep" | "surprised" | "sad" | "dance"
            ) =>
        {
            "action"
        }
        ["pet", "begin", size, crc]
            if size
                .parse::<usize>()
                .is_ok_and(|size| (1..=MAX_PACK_BYTES).contains(&size))
                && crc.len() == 8
                && crc.bytes().all(|byte| byte.is_ascii_hexdigit()) =>
        {
            "begin"
        }
        ["pet", "chunk", offset, hex]
            if !hex.is_empty()
                && hex.len() <= 128
                && hex.len() % 2 == 0
                && hex.bytes().all(|byte| byte.is_ascii_hexdigit())
                && offset.parse::<usize>().is_ok_and(|offset| {
                    offset < MAX_PACK_BYTES && hex.len() / 2 <= MAX_PACK_BYTES - offset
                }) =>
        {
            "chunk"
        }
        _ => return Err("不支持的桌宠命令或参数；仅支持桌宠状态、样式、动作及宠物包传输".into()),
    };
    Ok(Command {
        text: words.join(" "),
        verb,
        timeout: if verb == "commit" {
            COMMIT_TIMEOUT
        } else {
            COMMAND_TIMEOUT
        },
    })
}

#[derive(Default)]
enum AnsiState {
    #[default]
    Text,
    Escape,
    Csi,
    Osc,
    OscEscape,
}

#[derive(Default)]
struct LineFramer {
    bytes: Vec<u8>,
    ansi: AnsiState,
    overflow: bool,
}

impl LineFramer {
    fn push(&mut self, byte: u8) -> Option<String> {
        // Match only complete lines. A command echo or an unfinished response
        // must never acknowledge an upload chunk.
        if byte == b'\n' {
            let line =
                (!self.overflow).then(|| String::from_utf8_lossy(&self.bytes).trim().to_owned());
            self.bytes.clear();
            self.ansi = AnsiState::Text;
            self.overflow = false;
            return line;
        }
        if self.overflow {
            return None;
        }
        match self.ansi {
            AnsiState::Text => match byte {
                0x1b => self.ansi = AnsiState::Escape,
                b'\r' => {}
                0x08 | 0x7f => {
                    self.bytes.pop();
                }
                b'\t' | 0x20..=0x7e | 0x80..=0xff => self.bytes.push(byte),
                _ => {}
            },
            AnsiState::Escape => {
                self.ansi = match byte {
                    b'[' => AnsiState::Csi,
                    b']' => AnsiState::Osc,
                    _ => AnsiState::Text,
                };
            }
            AnsiState::Csi => {
                if (0x40..=0x7e).contains(&byte) {
                    self.ansi = AnsiState::Text;
                }
            }
            AnsiState::Osc => match byte {
                0x07 => self.ansi = AnsiState::Text,
                0x1b => self.ansi = AnsiState::OscEscape,
                _ => {}
            },
            AnsiState::OscEscape => {
                self.ansi = if byte == b'\\' {
                    AnsiState::Text
                } else {
                    AnsiState::Osc
                };
            }
        }
        if self.bytes.len() > MAX_LINE_BYTES {
            self.bytes.clear();
            self.overflow = true;
        }
        None
    }
}

enum Reply {
    Ok(String),
    Error(String),
}

fn parse_reply(line: String, verb: &str) -> Option<Reply> {
    let mut words = line.split_ascii_whitespace();
    match words.next() {
        Some("pet_ok") if words.next() == Some(verb) => Some(Reply::Ok(line)),
        Some("pet_error") => Some(Reply::Error(line)),
        _ => None,
    }
}

fn exchange<T: Read + Write + ?Sized>(
    port: &mut T,
    framer: &mut LineFramer,
    command: &Command,
) -> Result<Reply, String> {
    let mut bytes = command.text.as_bytes().to_vec();
    bytes.push(b'\n');
    port.write_all(&bytes)
        .map_err(|error| format!("桌宠串口写入失败：{error}；请重新连接后查询状态"))?;
    // Do not flush/tcdrain or retry a mutation on a removed USB device.
    let deadline = Instant::now() + command.timeout;
    let mut buffer = [0u8; 512];
    while Instant::now() < deadline {
        match port.read(&mut buffer) {
            Ok(0) => return Err("桌宠 USB 已断开，请重新连接".into()),
            Ok(count) => {
                let mut matched = None;
                for &byte in &buffer[..count] {
                    if let Some(line) = framer.push(byte) {
                        if let Some(reply) = parse_reply(line, command.verb) {
                            // Consume the complete read, including any trailing
                            // prompt, before returning the first response.
                            if matched.is_none() {
                                matched = Some(reply);
                            }
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
            Err(error) => return Err(format!("桌宠串口读取失败：{error}；请重新连接")),
        }
    }
    Err("桌宠响应超时，操作结果未知，未自动重发；请重新连接并查询状态".into())
}

struct Session {
    snapshot: PetSnapshot,
    port: Box<dyn SerialPort>,
    framer: LineFramer,
}

#[derive(Default)]
pub struct PetState {
    session: Mutex<Option<Session>>,
}

impl PetState {
    pub fn snapshot(&self) -> Result<PetSnapshot, String> {
        let guard = self.session.lock().map_err(|_| "桌宠会话锁已损坏")?;
        Ok(guard
            .as_ref()
            .map(|session| session.snapshot.clone())
            .unwrap_or_default())
    }

    pub fn disconnect(&self, expected: Option<u64>) -> Result<PetSnapshot, String> {
        let mut guard = self.session.lock().map_err(|_| "桌宠会话锁已损坏")?;
        if expected.is_none()
            || guard
                .as_ref()
                .is_some_and(|session| session.snapshot.session_id == expected)
        {
            // Closing the host link leaves the current pet visible on the OLED.
            *guard = None;
        }
        Ok(guard
            .as_ref()
            .map(|session| session.snapshot.clone())
            .unwrap_or_default())
    }

    pub fn connect(&self, port_name: &str) -> Result<PetSnapshot, String> {
        let mut guard = self.session.lock().map_err(|_| "桌宠会话锁已损坏")?;
        *guard = None;
        let mut port = serialport::new(port_name, 115_200)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(80))
            .preserve_dtr_on_open()
            .open()
            .map_err(|error| format!("无法打开桌宠串口 {port_name}：{error}"))?;
        port.clear(ClearBuffer::Input)
            .map_err(|error| format!("无法清空桌宠串口旧响应：{error}"))?;
        // Ctrl-U clears an unfinished console input line without executing it.
        port.write_all(&[0x15])
            .map_err(|error| format!("无法初始化桌宠控制台：{error}"))?;
        let mut framer = LineFramer::default();
        let status = match exchange(&mut *port, &mut framer, &validate_command("pet status")?)? {
            Reply::Ok(reply) => reply,
            Reply::Error(reply) => return Err(format!("桌宠固件握手失败：{reply}")),
        };
        let snapshot = PetSnapshot {
            connected: true,
            session_id: Some(NEXT_SESSION.fetch_add(1, Ordering::Relaxed)),
            port_name: Some(port_name.to_owned()),
            status: Some(status),
        };
        *guard = Some(Session {
            snapshot: snapshot.clone(),
            port,
            framer,
        });
        Ok(snapshot)
    }

    pub fn command(&self, expected: u64, command: &str) -> Result<String, String> {
        let command = validate_command(command)?;
        let mut guard = self.session.lock().map_err(|_| "桌宠会话锁已损坏")?;
        let session = guard
            .as_mut()
            .filter(|session| session.snapshot.session_id == Some(expected))
            .ok_or("桌宠会话已过期，请重新连接")?;
        match exchange(&mut *session.port, &mut session.framer, &command) {
            Ok(Reply::Ok(reply)) => {
                if command.verb == "status" {
                    session.snapshot.status = Some(reply.clone());
                }
                Ok(reply)
            }
            Ok(Reply::Error(reply)) => Err(reply),
            Err(error) => {
                // Without request IDs, a late ACK cannot safely belong to a
                // subsequent command. Require a fresh handshake after failure.
                *guard = None;
                Err(error)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    struct Console {
        reads: VecDeque<Vec<u8>>,
        written: Vec<u8>,
    }

    impl Read for Console {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            let Some(bytes) = self.reads.pop_front() else {
                return Ok(0);
            };
            let count = bytes.len().min(out.len());
            out[..count].copy_from_slice(&bytes[..count]);
            if count < bytes.len() {
                self.reads.push_front(bytes[count..].to_vec());
            }
            Ok(count)
        }
    }

    impl Write for Console {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.written.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            panic!("must not tcdrain")
        }
    }

    #[test]
    #[ignore = "Requires C3PET_TEST_PORT and exclusive access to an ESP32-C3 OLED console; replaces its custom pet"]
    fn hardware_console() {
        let port = std::env::var("C3PET_TEST_PORT")
            .expect("Set C3PET_TEST_PORT to the explicitly authorized ESP32-C3 console");
        assert!(!port.trim().is_empty(), "C3PET_TEST_PORT must not be empty");
        let state = PetState::default();
        let connected = state.connect(&port).expect("Desktop pet console handshake");
        assert!(connected.connected);
        assert!(connected
            .status
            .as_deref()
            .is_some_and(|line| line.starts_with("pet_ok status ")));
        let session = connected.session_id.expect("Connected console session ID");
        let command = |text: &str| {
            state
                .command(session, text)
                .unwrap_or_else(|error| panic!("Desktop pet command {text} failed: {error}"))
        };
        assert!(command("pet status").starts_with("pet_ok status "));
        for style in 0..4 {
            assert_eq!(
                command(&format!("pet open {style}")),
                format!("pet_ok open style={style}")
            );
            let status = command("pet status");
            assert!(status
                .split_ascii_whitespace()
                .any(|word| word == "active=1"));
            let expected_style = format!("style={style}");
            assert!(status
                .split_ascii_whitespace()
                .any(|word| word == expected_style));
        }
        for action in [
            "idle",
            "blink",
            "happy",
            "eat",
            "sleep",
            "surprised",
            "sad",
            "dance",
        ] {
            assert_eq!(
                command(&format!("pet action {action}")),
                format!("pet_ok action {action}")
            );
        }

        // One 64 x 32 idle frame, with two small eyes. All action intervals
        // remain valid even when their frame count is zero (idle fallback).
        let mut pack = vec![0u8; 320];
        pack[..8].copy_from_slice(&[b'P', b'E', b'T', b'1', 64, 32, 8, 0]);
        pack[8..17].copy_from_slice(b"Rust test");
        pack[24] = 1;
        for action in 0..8 {
            pack[32 + action * 2..34 + action * 2].copy_from_slice(&200u16.to_le_bytes());
        }
        for y in 12..20 {
            for x in (16..22).chain(42..48) {
                pack[64 + y * 8 + x / 8] |= 1 << (7 - x % 8);
            }
        }
        // An explicit file exercises packages emitted by the actual Studio
        // encoder through exactly the same serial upload and ACK path.
        let pack = match std::env::var_os("C3PET_TEST_PACK") {
            Some(path) => std::fs::read(path).expect("Read C3PET_TEST_PACK fixture"),
            None => pack,
        };
        assert!(
            (320..=MAX_PACK_BYTES).contains(&pack.len()),
            "PET1 fixture size is out of range"
        );
        assert_eq!(
            (pack.len() - 64) % 256,
            0,
            "PET1 fixture has partial frames"
        );
        let bytes_field = format!("bytes={}", pack.len());
        let mut crc = 0xffff_ffffu32;
        for &byte in &pack {
            crc ^= u32::from(byte);
            for _ in 0..8 {
                crc = (crc >> 1) ^ if crc & 1 != 0 { 0xedb8_8320 } else { 0 };
            }
        }
        crc ^= 0xffff_ffff;
        assert_eq!(
            command(&format!("pet begin {} {crc:08x}", pack.len())),
            format!("pet_ok begin {bytes_field}")
        );
        for (index, chunk) in pack.chunks(64).enumerate() {
            let offset = index * 64;
            let hex: String = chunk.iter().map(|byte| format!("{byte:02x}")).collect();
            assert_eq!(
                command(&format!("pet chunk {offset} {hex}")),
                format!("pet_ok chunk next={}", offset + chunk.len())
            );
        }
        assert_eq!(
            command("pet commit"),
            format!("pet_ok commit {bytes_field} crc={crc:08x}")
        );
        assert_eq!(command("pet open 4"), "pet_ok open style=4");
        let status = command("pet status");
        for field in ["active=1", "style=4", "custom=1", bytes_field.as_str()] {
            assert!(
                status.split_ascii_whitespace().any(|word| word == field),
                "Missing {field} in desktop pet status"
            );
        }
        assert!(
            !state
                .disconnect(Some(session))
                .expect("Disconnect console")
                .connected
        );
        let reconnected = state.connect(&port).expect("Reconnect desktop pet console");
        assert!(reconnected.connected);
        assert_ne!(reconnected.session_id, Some(session));
        let session = reconnected
            .session_id
            .expect("Reconnected console session ID");
        let status = state
            .command(session, "pet status")
            .expect("Status after reconnect");
        for field in ["active=1", "style=4", "custom=1", bytes_field.as_str()] {
            assert!(
                status.split_ascii_whitespace().any(|word| word == field),
                "Missing {field} after reconnect"
            );
        }
        assert_eq!(
            state
                .command(session, "pet open 1")
                .expect("Restore pixel cat"),
            "pet_ok open style=1"
        );
        assert_eq!(
            state
                .command(session, "pet action happy")
                .expect("Leave cat happy"),
            "pet_ok action happy"
        );
        assert!(
            !state
                .disconnect(Some(session))
                .expect("Close console session")
                .connected
        );
    }

    #[test]
    fn consumes_complete_ack_and_ignores_echo_prompt_logs_and_ansi() {
        let mut console = Console {
            reads: [
                b"\x1b[32mesp32c3> \x1b[0mpet chunk 0 aabb\r\nI (12) wifi: pet_ok chunk 0\r\npet_ok chun".to_vec(),
                b"k offset=2\r\nesp32c3> ".to_vec(),
                b"pet status\r\npet_ok status active=1 style=4\r\nesp32c3> ".to_vec(),
            ].into(),
            written: Vec::new(),
        };
        let mut framer = LineFramer::default();
        let reply = exchange(
            &mut console,
            &mut framer,
            &validate_command("pet chunk 0 aabb").unwrap(),
        )
        .unwrap();
        assert!(matches!(reply, Reply::Ok(line) if line == "pet_ok chunk offset=2"));
        let reply = exchange(
            &mut console,
            &mut framer,
            &validate_command("pet status").unwrap(),
        )
        .unwrap();
        assert!(matches!(reply, Reply::Ok(line) if line == "pet_ok status active=1 style=4"));
        assert_eq!(console.written, b"pet chunk 0 aabb\npet status\n");
    }

    #[test]
    fn errors_are_distinct_from_transport_failure() {
        assert!(matches!(
            parse_reply("pet_error crc_mismatch".into(), "commit"),
            Some(Reply::Error(_))
        ));
        assert!(parse_reply("esp32c3> pet_ok status".into(), "status").is_none());
        assert!(parse_reply("pet_ok chunk offset=64".into(), "status").is_none());
        assert!(parse_reply("pet_okay status".into(), "status").is_none());
    }

    #[test]
    fn drops_overlong_lines_and_requires_newline() {
        let mut framer = LineFramer::default();
        for byte in vec![b'x'; MAX_LINE_BYTES + 1] {
            assert!(framer.push(byte).is_none());
        }
        for &byte in b"pet_ok status\n" {
            assert!(framer.push(byte).is_none());
        }
        for &byte in b"pet_ok status" {
            assert!(framer.push(byte).is_none());
        }
        assert_eq!(framer.push(b'\n').as_deref(), Some("pet_ok status"));
    }

    #[test]
    fn validates_pack_bounds_and_rejects_console_injection() {
        for command in [
            "pet begin 6208 00000000",
            "pet chunk 6207 ff",
            "pet open 4",
            "pet action surprised",
        ] {
            assert!(validate_command(command).is_ok(), "{command}");
        }
        for command in [
            "pet begin 6209 00000000",
            "pet begin 1 ff",
            "pet chunk 6207 ffff",
            "pet chunk 0 f",
            "pet open 5",
            "pet action run",
            "pet status\nreboot",
            "reboot",
            "pet status\x1b[0m",
        ] {
            assert!(validate_command(command).is_err(), "{command}");
        }
        assert!(validate_command(&format!("pet chunk 0 {}", "ab".repeat(65))).is_err());
    }

    #[test]
    fn rejects_commands_without_a_session() {
        let state = PetState::default();
        assert!(!state.disconnect(Some(999)).unwrap().connected);
        assert!(state
            .command(999, "pet status")
            .unwrap_err()
            .contains("会话已过期"));
    }
}
