//! GameBox FW2 is a TX-only UART diagnostic link. This module deliberately
//! owns no writer and never uses the WL1 command or safety-stop transport.

use std::collections::VecDeque;
use std::io::{ErrorKind, Read};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use serialport::{DataBits, FlowControl, Parity, StopBits};
use tauri::{AppHandle, Emitter};

use crate::state::unix_millis;

const READY_LINE: &str = "GAMEBOX FW2 UART-TX-DMA READY";
const MAX_LINE_BYTES: usize = 4096;
const MAX_PENDING_EVENTS: usize = 256;
const EVENT_INTERVAL: Duration = Duration::from_millis(20);
const EVENTS_PER_INTERVAL: usize = 2;
static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameBoxSnapshot {
    pub mode: GameBoxMode,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<u64>,
    pub identified: bool,
    pub received_lines: u64,
    /// Complete lines omitted from the UI queue during sustained input floods.
    pub dropped_lines: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_activity: Option<u64>,
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GameBoxMode {
    Serial,
    #[default]
    Disconnected,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum GameBoxFrame {
    Ready,
    Button {
        #[serde(rename = "uptimeMs")]
        uptime_ms: u32,
        key: ButtonKey,
        action: ButtonAction,
        #[serde(rename = "heldMs")]
        held_ms: u32,
    },
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ButtonKey {
    Up,
    Down,
    Left,
    Right,
    Jump,
    Func,
    Enter,
    Back,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "UPPERCASE")]
pub enum ButtonAction {
    Pressed,
    Released,
    Click,
    Double,
    Long,
    Repeat,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GameBoxEvent {
    session_id: u64,
    timestamp: u64,
    kind: &'static str,
    text: String,
    received_lines: u64,
    dropped_lines: u64,
    identified: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    frame: Option<GameBoxFrame>,
}

fn parse_u32_decimal(value: &str) -> Option<u32> {
    // Do not accept signed values or values outside the firmware's uint32_t.
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn decode_line(line: &str) -> Option<GameBoxFrame> {
    if line == READY_LINE {
        return Some(GameBoxFrame::Ready);
    }
    // Match the firmware and frontend grammar exactly; padded tokens or tabs
    // are diagnostic text, not verified button frames.
    let mut fields = line.split(' ');
    if fields.next()? != "BTN" {
        return None;
    }
    let uptime_ms = parse_u32_decimal(fields.next()?)?;
    let key = match fields.next()? {
        "UP" => ButtonKey::Up,
        "DOWN" => ButtonKey::Down,
        "LEFT" => ButtonKey::Left,
        "RIGHT" => ButtonKey::Right,
        "JUMP" => ButtonKey::Jump,
        "FUNC" => ButtonKey::Func,
        "ENTER" => ButtonKey::Enter,
        "BACK" => ButtonKey::Back,
        _ => return None,
    };
    let action = match fields.next()? {
        "PRESSED" => ButtonAction::Pressed,
        "RELEASED" => ButtonAction::Released,
        "CLICK" => ButtonAction::Click,
        "DOUBLE" => ButtonAction::Double,
        "LONG" => ButtonAction::Long,
        "REPEAT" => ButtonAction::Repeat,
        _ => return None,
    };
    let held_ms = parse_u32_decimal(fields.next()?)?;
    if fields.next().is_some() {
        return None;
    }
    Some(GameBoxFrame::Button {
        uptime_ms,
        key,
        action,
        held_ms,
    })
}

/// Keeps chunk boundaries independent from line boundaries. Once a line is
/// oversized, discard its entire tail so it cannot masquerade as a valid BTN.
#[derive(Default)]
struct LineFramer {
    pending: Vec<u8>,
    discarding: bool,
}

impl LineFramer {
    fn push(&mut self, bytes: &[u8], mut on_line: impl FnMut(String)) {
        for &byte in bytes {
            if byte == b'\n' {
                if !self.discarding {
                    // CRLF and LF are the two supported line endings. Preserve
                    // all other whitespace so it cannot create a false READY.
                    if self.pending.last() == Some(&b'\r') {
                        self.pending.pop();
                    }
                    let text = String::from_utf8_lossy(&self.pending).into_owned();
                    if !text.is_empty() {
                        on_line(text);
                    }
                }
                self.pending.clear();
                self.discarding = false;
            } else if !self.discarding {
                if self.pending.len() == MAX_LINE_BYTES {
                    self.pending.clear();
                    self.discarding = true;
                } else {
                    self.pending.push(byte);
                }
            }
        }
    }
}

#[derive(Default)]
struct ReceiveMetrics {
    identified: bool,
    received_lines: u64,
    dropped_lines: u64,
    last_activity: Option<u64>,
}

impl ReceiveMetrics {
    fn observe(&mut self, frame: &Option<GameBoxFrame>, timestamp: u64) {
        self.identified |= matches!(frame, Some(GameBoxFrame::Ready));
        self.received_lines = self.received_lines.saturating_add(1);
        self.last_activity = Some(timestamp);
    }
}

struct EventQueue {
    pending: VecDeque<GameBoxEvent>,
    last_emit: Instant,
}

impl EventQueue {
    fn new(now: Instant) -> Self {
        Self {
            pending: VecDeque::with_capacity(MAX_PENDING_EVENTS),
            last_emit: now.checked_sub(EVENT_INTERVAL).unwrap_or(now),
        }
    }

    fn push(&mut self, event: GameBoxEvent) -> bool {
        let dropped = self.pending.len() == MAX_PENDING_EVENTS;
        if dropped {
            self.pending.pop_front();
        }
        self.pending.push_back(event);
        dropped
    }

    fn emit_due(&mut self, now: Instant, mut emit: impl FnMut(GameBoxEvent)) {
        if now.duration_since(self.last_emit) < EVENT_INTERVAL || self.pending.is_empty() {
            return;
        }
        self.last_emit = now;
        // No catch-up burst after slow reads or suspended computers.
        for _ in 0..EVENTS_PER_INTERVAL {
            let Some(event) = self.pending.pop_front() else {
                break;
            };
            emit(event);
        }
    }
}

#[derive(Default)]
pub struct GameBoxState {
    lifecycle: Mutex<()>,
    session: Mutex<Option<GameBoxSession>>,
}

impl GameBoxState {
    pub fn snapshot(&self) -> Result<GameBoxSnapshot, String> {
        let guard = self.session.lock().map_err(|_| "游戏机会话状态已损坏")?;
        match guard.as_ref() {
            Some(session) => session.snapshot(),
            None => Ok(GameBoxSnapshot {
                label: "游戏机未连接".into(),
                ..GameBoxSnapshot::default()
            }),
        }
    }

    pub fn connect(&self, app: AppHandle, port_name: &str) -> Result<GameBoxSnapshot, String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "游戏机生命周期锁已损坏")?;
        self.disconnect_current(None)?;
        let port = serialport::new(port_name, 115_200)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(20))
            .open()
            .map_err(|error| format!("无法打开游戏机串口 {port_name}: {error}"))?;

        let mut session = GameBoxSession {
            session_id: NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed),
            label: format!("{port_name} · 115200 8N1"),
            connected_at: unix_millis(),
            alive: Arc::new(AtomicBool::new(true)),
            stop: Arc::new(AtomicBool::new(false)),
            metrics: Arc::new(Mutex::new(ReceiveMetrics::default())),
            reader_thread: None,
        };
        // The connect response must identify this generation even if the
        // reader fails before IPC resolves. The frontend can then replay its
        // buffered READY/disconnected events against the correct session ID.
        let snapshot = session.snapshot()?;
        let session_id = session.session_id;
        let alive = Arc::clone(&session.alive);
        let stop = Arc::clone(&session.stop);
        let metrics = Arc::clone(&session.metrics);
        session.reader_thread = Some(
            thread::Builder::new()
                .name("gamebox-serial-reader".into())
                .spawn(move || {
                    // This thread owns the only port handle. Neither normal
                    // close nor failure cleanup writes a command or a byte.
                    let reason = read_session(port, session_id, &stop, &metrics, |event| {
                        let _ = app.emit("gamebox:event", event);
                    });
                    alive.store(false, Ordering::Release);
                    if let Some(reason) = reason {
                        let event = {
                            let received =
                                metrics.lock().unwrap_or_else(|error| error.into_inner());
                            GameBoxEvent {
                                session_id,
                                timestamp: unix_millis(),
                                kind: "disconnected",
                                text: reason,
                                received_lines: received.received_lines,
                                dropped_lines: received.dropped_lines,
                                identified: received.identified,
                                frame: None,
                            }
                        };
                        let _ = app.emit("gamebox:event", event);
                    }
                })
                .map_err(|error| format!("无法启动游戏机串口读取任务: {error}"))?,
        );
        *self.session.lock().map_err(|_| "游戏机会话状态已损坏")? = Some(session);
        Ok(snapshot)
    }

    pub fn disconnect(&self, expected_session_id: Option<u64>) -> Result<(), String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "游戏机生命周期锁已损坏")?;
        self.disconnect_current(expected_session_id)
    }

    fn disconnect_current(&self, expected_session_id: Option<u64>) -> Result<(), String> {
        let session = {
            let mut guard = self.session.lock().map_err(|_| "游戏机会话状态已损坏")?;
            if let (Some(expected), Some(current)) = (expected_session_id, guard.as_ref()) {
                if current.session_id != expected {
                    return Ok(());
                }
            }
            guard.take()
        };
        // Release the session mutex before joining; only the reader owns the
        // serial port, which is dropped before this returns.
        drop(session);
        Ok(())
    }
}

struct GameBoxSession {
    session_id: u64,
    label: String,
    connected_at: u64,
    alive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    metrics: Arc<Mutex<ReceiveMetrics>>,
    reader_thread: Option<JoinHandle<()>>,
}

impl GameBoxSession {
    fn snapshot(&self) -> Result<GameBoxSnapshot, String> {
        let metrics = self.metrics.lock().map_err(|_| "游戏机接收状态已损坏")?;
        let alive = self.alive.load(Ordering::Acquire);
        Ok(GameBoxSnapshot {
            mode: if alive {
                GameBoxMode::Serial
            } else {
                GameBoxMode::Disconnected
            },
            label: if alive {
                self.label.clone()
            } else {
                format!("{} · 连接已中断", self.label)
            },
            session_id: alive.then_some(self.session_id),
            connected_at: Some(self.connected_at),
            identified: metrics.identified,
            received_lines: metrics.received_lines,
            dropped_lines: metrics.dropped_lines,
            last_activity: metrics.last_activity,
        })
    }
}

impl Drop for GameBoxSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        if let Some(reader_thread) = self.reader_thread.take() {
            let _ = reader_thread.join();
        }
    }
}

fn read_session(
    mut reader: impl Read,
    session_id: u64,
    stop: &AtomicBool,
    metrics: &Mutex<ReceiveMetrics>,
    mut emit: impl FnMut(GameBoxEvent),
) -> Option<String> {
    let mut framer = LineFramer::default();
    let mut queue = EventQueue::new(Instant::now());
    let mut chunk = [0_u8; 1024];
    while !stop.load(Ordering::Acquire) {
        match reader.read(&mut chunk) {
            Ok(0) => {
                // Some serial drivers return zero for an idle timed read.
                thread::sleep(Duration::from_millis(2));
            }
            Ok(count) => {
                if stop.load(Ordering::Acquire) {
                    break;
                }
                framer.push(&chunk[..count], |text| {
                    let timestamp = unix_millis();
                    let frame = decode_line(&text);
                    let mut received = metrics.lock().unwrap_or_else(|error| error.into_inner());
                    received.observe(&frame, timestamp);
                    if queue.push(GameBoxEvent {
                        session_id,
                        timestamp,
                        kind: "line",
                        text,
                        received_lines: received.received_lines,
                        dropped_lines: received.dropped_lines,
                        identified: received.identified,
                        frame,
                    }) {
                        received.dropped_lines = received.dropped_lines.saturating_add(1);
                    }
                });
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                ) => {}
            Err(error) => return Some(format!("游戏机串口读取已停止: {error}")),
        }
        if !stop.load(Ordering::Acquire) {
            queue.emit_due(Instant::now(), |mut event| {
                // Send current cumulative state even when earlier queued lines
                // were dropped, or a boot line arrived before connect resolved.
                {
                    let received = metrics.lock().unwrap_or_else(|error| error.into_inner());
                    event.received_lines = received.received_lines;
                    event.dropped_lines = received.dropped_lines;
                    event.identified = received.identified;
                }
                emit(event);
            });
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[test]
    fn framing_handles_split_crlf_multiple_lines_and_empty_lines() {
        let mut framer = LineFramer::default();
        let mut lines = Vec::new();
        framer.push(b"\r\nGAMEBOX FW2 UART-", |line| lines.push(line));
        assert!(lines.is_empty());
        framer.push(b"TX-DMA READY\r\nBTN 12 UP PRESSED 0\n \npart", |line| {
            lines.push(line)
        });
        assert_eq!(lines, [READY_LINE, "BTN 12 UP PRESSED 0", " "]);
        framer.push(b"ial\n", |line| lines.push(line));
        assert_eq!(lines.last().unwrap(), "partial");
    }

    #[test]
    fn framing_preserves_whitespace_and_strips_only_one_line_ending_cr() {
        let mut framer = LineFramer::default();
        let mut lines = Vec::new();
        framer.push(
            b" GAMEBOX FW2 UART-TX-DMA READY\r\nGAMEBOX FW2 UART-TX-DMA READY \nGAMEBOX FW2 UART-TX-DMA READY\r\r\n\t\r\nBTN 1 UP CLICK 0 \r\n",
            |line| lines.push(line),
        );
        assert_eq!(
            lines,
            [
                " GAMEBOX FW2 UART-TX-DMA READY",
                "GAMEBOX FW2 UART-TX-DMA READY ",
                "GAMEBOX FW2 UART-TX-DMA READY\r",
                "\t",
                "BTN 1 UP CLICK 0 ",
            ]
        );
        assert!(lines.iter().all(|line| decode_line(line).is_none()));
    }

    #[test]
    fn oversized_line_discards_tail_until_newline_then_recovers() {
        let mut framer = LineFramer::default();
        let mut lines = Vec::new();
        framer.push(&vec![b'x'; MAX_LINE_BYTES + 1], |line| lines.push(line));
        assert!(framer.pending.is_empty());
        framer.push(b"BTN 1 UP CLICK 0\nBTN 2 BACK CLICK 0\n", |line| {
            lines.push(line)
        });
        assert_eq!(lines, ["BTN 2 BACK CLICK 0"]);

        framer.push(&vec![b'x'; MAX_LINE_BYTES], |line| lines.push(line));
        framer.push(b"\n", |line| lines.push(line));
        assert_eq!(lines[1].len(), MAX_LINE_BYTES);
    }

    #[test]
    fn only_exact_boot_line_identifies_gamebox() {
        let mut metrics = ReceiveMetrics::default();
        for line in [
            "BTN 1 UP CLICK 0",
            "GAMEBOX READY",
            "GAMEBOX FW2 UART-TX-DMA READY extra",
            " GAMEBOX FW2 UART-TX-DMA READY",
            "GAMEBOX FW2 UART-TX-DMA READY ",
            "GAMEBOX FW2 UART-TX-DMA READY\t",
            "boot ok",
        ] {
            metrics.observe(&decode_line(line), 100);
        }
        assert!(!metrics.identified);
        metrics.observe(&decode_line(READY_LINE), 101);
        assert!(metrics.identified);
        assert_eq!(metrics.received_lines, 8);
        assert_eq!(metrics.last_activity, Some(101));
    }

    #[test]
    fn accepts_all_keys_actions_and_uint32_wrap_values() {
        for key in [
            "UP", "DOWN", "LEFT", "RIGHT", "JUMP", "FUNC", "ENTER", "BACK",
        ] {
            for action in ["PRESSED", "RELEASED", "CLICK", "DOUBLE", "LONG", "REPEAT"] {
                assert!(matches!(
                    decode_line(&format!("BTN 4294967295 {key} {action} 4294967295")),
                    Some(GameBoxFrame::Button { .. })
                ));
            }
        }
        assert_eq!(
            decode_line("BTN 0 UP PRESSED 0"),
            Some(GameBoxFrame::Button {
                uptime_ms: 0,
                key: ButtonKey::Up,
                action: ButtonAction::Pressed,
                held_ms: 0,
            })
        );
    }

    #[test]
    fn malformed_button_lines_remain_unparsed_logs() {
        for line in [
            "BTN 1 UP PRESSED",
            "BTN 1 UP CLICK 0 extra",
            "BTN 1 UNKNOWN CLICK 0",
            "BTN 1 UP HOLD 0",
            "BTN -1 UP CLICK 0",
            "BTN +1 UP CLICK 0",
            "BTN 1.5 UP CLICK 0",
            "BTN 4294967296 UP CLICK 0",
            "BTN 1 UP CLICK 4294967296",
            "BTN 1 UP CLICK -1",
            "BTN 1 up click 0",
            " BTN 1 UP CLICK 0",
            "BTN 1 UP CLICK 0 ",
            "BTN  1 UP CLICK 0",
            "BTN 1  UP CLICK 0",
            "BTN 1 UP  CLICK 0",
            "BTN 1 UP CLICK  0",
            "BTN\t1 UP CLICK 0",
            "BTN 1\tUP CLICK 0",
            "BTN 1 UP\tCLICK 0",
            "BTN 1 UP CLICK\t0",
            "BTN 1 UP CLICK 0\t",
        ] {
            assert_eq!(decode_line(line), None, "{line}");
        }
    }

    fn test_event(index: u64) -> GameBoxEvent {
        GameBoxEvent {
            session_id: 7,
            timestamp: index,
            kind: "line",
            text: format!("line {index}"),
            received_lines: index,
            dropped_lines: 0,
            identified: false,
            frame: None,
        }
    }

    #[test]
    fn ui_queue_is_bounded_and_rate_limited_without_catchup_bursts() {
        let now = Instant::now();
        let mut queue = EventQueue::new(now);
        for index in 0..MAX_PENDING_EVENTS {
            assert!(!queue.push(test_event(index as u64)));
        }
        assert!(queue.push(test_event(256)));
        assert_eq!(queue.pending.len(), MAX_PENDING_EVENTS);
        let mut events = Vec::new();
        queue.emit_due(now, |event| events.push(event));
        assert_eq!(events.len(), EVENTS_PER_INTERVAL);
        assert_eq!(events[0].timestamp, 1);
        queue.emit_due(now + Duration::from_millis(19), |event| events.push(event));
        assert_eq!(events.len(), EVENTS_PER_INTERVAL);
        queue.emit_due(now + Duration::from_secs(10), |event| events.push(event));
        assert_eq!(events.len(), EVENTS_PER_INTERVAL * 2);
    }

    fn test_session(session_id: u64) -> GameBoxSession {
        GameBoxSession {
            session_id,
            label: "TEST".into(),
            connected_at: 10,
            alive: Arc::new(AtomicBool::new(true)),
            stop: Arc::new(AtomicBool::new(false)),
            metrics: Arc::new(Mutex::new(ReceiveMetrics::default())),
            reader_thread: None,
        }
    }

    #[test]
    fn stale_disconnect_cannot_close_replacement_session() {
        let state = GameBoxState::default();
        *state.session.lock().unwrap() = Some(test_session(8));
        state.disconnect(Some(7)).unwrap();
        assert_eq!(state.snapshot().unwrap().session_id, Some(8));
        assert!(!state.snapshot().unwrap().identified);
        state.disconnect(Some(8)).unwrap();
        assert_eq!(state.snapshot().unwrap().mode, GameBoxMode::Disconnected);
        assert_eq!(state.snapshot().unwrap().session_id, None);
    }

    #[test]
    fn fault_releases_read_handle_without_a_write_capability() {
        struct FailingReader(Arc<AtomicBool>);
        impl Read for FailingReader {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::new(ErrorKind::BrokenPipe, "unplugged"))
            }
        }
        impl Drop for FailingReader {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let released = Arc::new(AtomicBool::new(false));
        let reason = read_session(
            FailingReader(Arc::clone(&released)),
            1,
            &AtomicBool::new(false),
            &Mutex::new(ReceiveMetrics::default()),
            |_| panic!("No line should be emitted"),
        );
        assert!(reason.unwrap().contains("unplugged"));
        assert!(released.load(Ordering::Acquire));
    }

    #[test]
    fn event_serialization_matches_frontend_contract() {
        let event = GameBoxEvent {
            session_id: 123,
            timestamp: 456,
            kind: "line",
            text: "BTN 100 JUMP DOUBLE 20".into(),
            received_lines: 2,
            dropped_lines: 0,
            identified: true,
            frame: decode_line("BTN 100 JUMP DOUBLE 20"),
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "sessionId": 123,
                "timestamp": 456,
                "kind": "line",
                "text": "BTN 100 JUMP DOUBLE 20",
                "receivedLines": 2,
                "droppedLines": 0,
                "identified": true,
                "frame": { "type": "button", "uptimeMs": 100, "key": "JUMP", "action": "DOUBLE", "heldMs": 20 }
            })
        );
    }
}
