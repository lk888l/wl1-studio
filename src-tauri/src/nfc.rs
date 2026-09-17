//! PN532 serial session for reading and cloning MIFARE cards.
//!
//! Unlike the WL1 and GameBox links, this one is bidirectional and stateful: a
//! command is answered by an ACK and then by an information frame whose timing
//! depends on whether a card is in the field. A single worker thread owns the
//! port for the whole session, runs one job at a time, and reports progress
//! through Tauri events. Keeping every read and write on that one thread is
//! what makes cancellation deterministic — there is no second handle that could
//! interleave a half-finished card transaction.

use std::io::{ErrorKind, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};
use tauri::{AppHandle, Emitter};

use crate::mifare::{self, CardDump, CardKind, DataUnit, KeySource, SectorDump, KEY_BYTES};
use crate::pn532::{self, FirmwareVersion, PassiveTarget, Pn532Frame};
use crate::state::unix_millis;

const BAUD_RATE: u32 = 115_200;
const PORT_TIMEOUT: Duration = Duration::from_millis(10);

/// UM0701 §6.2.2.1 gives TMax Response Time as 15 ms for the ACK. The window
/// here is deliberately looser because a USB-serial bridge adds latency the
/// manual does not account for, and a missed ACK costs a full resend.
const ACK_TIMEOUT: Duration = Duration::from_millis(150);
const ACK_ATTEMPTS: usize = 3;

const CONTROL_TIMEOUT: Duration = Duration::from_millis(400);
/// InDataExchange waits up to 51.2 ms for a card by default, plus retries.
const RF_TIMEOUT: Duration = Duration::from_millis(1_500);

const SCAN_POLL_INTERVAL: Duration = Duration::from_millis(60);
const CANCELLED: &str = "操作已取消";

/// Consecutive card timeouts that mean the card left the field rather than a
/// single unlucky read.
const CARD_GONE_STRIKES: u32 = 8;

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NfcSnapshot {
    pub mode: NfcMode,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connected_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub firmware: Option<String>,
    pub busy: bool,
}

impl Default for NfcSnapshot {
    fn default() -> Self {
        Self {
            mode: NfcMode::Disconnected,
            label: "读卡器未连接".into(),
            session_id: None,
            connected_at: None,
            firmware: None,
            busy: false,
        }
    }
}

#[derive(Debug, Clone, Copy, Default, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NfcMode {
    Serial,
    #[default]
    Disconnected,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CardInfo {
    pub uid: String,
    pub atqa: String,
    pub sak: u8,
    pub kind: CardKind,
    pub label: String,
    /// False when the card type needs a protocol this app does not implement.
    pub supported: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl CardInfo {
    fn from_target(target: &PassiveTarget) -> Self {
        let kind = CardKind::from_sak(target.sel_res);
        let (supported, detail) = match kind {
            CardKind::Classic1K | CardKind::Classic4K => (true, None),
            CardKind::Ultralight => (
                true,
                Some("按 4 字节页读取；NTAG 写入仅覆盖用户页，保留 UID、锁定位与配置".into()),
            ),
            CardKind::Iso14443_4 => (
                false,
                Some(
                    "该卡使用 ISO/IEC 14443-4 协议（如 DESFire），需要 APDU 会话，本工具暂不支持"
                        .into(),
                ),
            ),
            CardKind::Unknown => (
                false,
                Some(format!(
                    "未知 SAK 0x{:02X}，无法确定卡片结构",
                    target.sel_res
                )),
            ),
        };
        Self {
            uid: mifare::format_hex(&target.uid),
            atqa: mifare::format_hex(&target.sens_res),
            sak: target.sel_res,
            kind,
            label: kind.label().to_owned(),
            supported,
            detail,
        }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadOptions {
    /// Extra keys the operator supplies, tried before giving up on a sector.
    #[serde(default)]
    pub extra_keys: Vec<String>,
    /// Per-sector overrides entered after a partial read.
    #[serde(default)]
    pub sector_keys: Vec<SectorKeyOverride>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectorKeyOverride {
    pub sector: u8,
    pub key: String,
    /// True for Key B, false for Key A.
    pub key_b: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteOptions {
    /// Writing sector 0 block 0 replaces the UID. Genuine NXP cards refuse it;
    /// Some compatible cards accept it after standard authentication. Off by default.
    #[serde(default)]
    pub write_manufacturer_block: bool,
    /// Required when a replacement intentionally has the source UID already.
    #[serde(default)]
    pub allow_same_uid: bool,
    #[serde(default)]
    pub expected_target_uid: Option<String>,
    #[serde(default = "default_true")]
    pub write_trailers: bool,
    #[serde(default = "default_true")]
    pub verify: bool,
    /// Sector indices to write. Empty means every sector present in the dump.
    #[serde(default)]
    pub sectors: Vec<u8>,
    /// Keys currently on the *target* card, tried before the dictionary.
    #[serde(default)]
    pub target_keys: Vec<String>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WriteReport {
    pub uid: String,
    pub blocks_written: u32,
    pub blocks_failed: u32,
    /// Blocks deliberately not written. Distinct from `blocks_failed`: these
    /// are refusals by design, not errors, and reporting them as failures made
    /// a 62-of-63 copy read like a broken write.
    pub blocks_skipped: u32,
    pub sectors_written: u32,
    pub verified: bool,
    pub blocks_verified: u32,
    pub verification_failures: Vec<String>,
    pub uid_matches: bool,
    pub complete_copy: bool,
    pub manufacturer_block_written: Option<bool>,
    pub duration_ms: u64,
    pub failures: Vec<String>,
    pub skips: Vec<String>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NfcEvent {
    pub session_id: u64,
    pub timestamp: u64,
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub progress: Option<Progress>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub phase: &'static str,
    pub current: u32,
    pub total: u32,
    pub message: String,
}

type Reply<T> = Sender<Result<T, String>>;

enum NfcJob {
    Read {
        options: ReadOptions,
        reply: Reply<CardDump>,
    },
    Write {
        dump: CardDump,
        options: WriteOptions,
        reply: Reply<WriteReport>,
    },
}

#[derive(Clone)]
struct SessionHandle {
    session_id: u64,
    jobs: Sender<NfcJob>,
    cancel: Arc<AtomicBool>,
}

impl SessionHandle {
    fn request<T>(
        &self,
        timeout: Duration,
        build: impl FnOnce(Reply<T>) -> NfcJob,
    ) -> Result<T, String> {
        let (sender, receiver) = mpsc::channel();
        self.jobs
            .send(build(sender))
            .map_err(|_| "NFC 会话已结束，请重新连接读卡器".to_owned())?;
        match receiver.recv_timeout(timeout) {
            Ok(result) => result,
            Err(RecvTimeoutError::Timeout) => {
                self.cancel();
                // Keep run_busy's ownership until the worker acknowledges the
                // cancellation; otherwise a new job could clear its flag while
                // the timed-out write is still touching the card.
                let _ = receiver.recv();
                Err("NFC 操作等待超时，当前任务已停止".into())
            }
            Err(RecvTimeoutError::Disconnected) => {
                Err("NFC 读取线程已退出，请重新连接读卡器".into())
            }
        }
    }

    fn cancel(&self) {
        self.cancel.store(true, Ordering::Release);
    }
}

/// Cheap to clone: every field lives behind the shared `Arc`, which is what
/// lets a Tauri command hand blocking card work to another thread without
/// holding a borrow on the app state across the await.
#[derive(Clone, Default)]
pub struct NfcState {
    inner: Arc<NfcStateInner>,
}

#[derive(Default)]
struct NfcStateInner {
    lifecycle: Mutex<()>,
    session: Mutex<Option<NfcSession>>,
    busy: Arc<AtomicBool>,
}

impl NfcState {
    pub fn snapshot(&self) -> Result<NfcSnapshot, String> {
        let guard = self.session_guard()?;
        Ok(match guard.as_ref() {
            Some(session) => session.snapshot(self.inner.busy.load(Ordering::Acquire)),
            None => NfcSnapshot::default(),
        })
    }

    fn session_guard(&self) -> Result<std::sync::MutexGuard<'_, Option<NfcSession>>, String> {
        self.inner
            .session
            .lock()
            .map_err(|_| "NFC 会话状态已损坏".to_owned())
    }

    fn handle(&self) -> Result<SessionHandle, String> {
        let guard = self.session_guard()?;
        let session = guard.as_ref().ok_or("读卡器未连接")?;
        if !session.alive.load(Ordering::Acquire) {
            return Err("读卡器连接已中断，请重新连接".into());
        }
        Ok(SessionHandle {
            session_id: session.session_id,
            jobs: session.jobs.clone(),
            cancel: Arc::clone(&session.cancel),
        })
    }

    pub fn cancel(&self) -> Result<(), String> {
        self.handle()?.cancel();
        Ok(())
    }

    pub fn connect(&self, app: AppHandle, port_name: &str) -> Result<NfcSnapshot, String> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| "NFC 生命周期锁已损坏")?;
        self.disconnect_current(None)?;

        let port = serialport::new(port_name, BAUD_RATE)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(PORT_TIMEOUT)
            .open()
            .map_err(|error| format!("无法打开 NFC 串口 {port_name}: {error}"))?;

        // The handshake runs before the reader thread starts so a wrong port,
        // wrong baud rate or a card module stuck in I2C mode fails the connect
        // call instead of surfacing later as an opaque read error.
        let cancel = Arc::new(AtomicBool::new(false));
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let mut link = Link::new(port, Arc::clone(&cancel));
        let firmware = link.wake_and_configure()?;
        let port = link.into_port();

        let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let (jobs, receiver) = mpsc::channel();

        let mut session = NfcSession {
            session_id,
            label: format!("{port_name} · 115200 8N1 · PN532"),
            connected_at: unix_millis(),
            firmware,
            alive: Arc::clone(&alive),
            stop: Arc::clone(&stop),
            cancel: Arc::clone(&cancel),
            jobs,
            thread: None,
        };
        let snapshot = session.snapshot(false);
        session.thread = Some(
            thread::Builder::new()
                .name("nfc-pn532".into())
                .spawn(move || {
                    worker_loop(session_id, receiver, port, Arc::clone(&cancel), &stop, &app);
                    alive.store(false, Ordering::Release);
                    let _ = app.emit(
                        "nfc:event",
                        NfcEvent {
                            session_id,
                            timestamp: unix_millis(),
                            kind: "disconnected",
                            progress: None,
                            reason: Some("读卡器会话已关闭".into()),
                        },
                    );
                })
                .map_err(|error| format!("无法启动 NFC 工作线程: {error}"))?,
        );
        *self.session_guard()? = Some(session);
        Ok(snapshot)
    }

    pub fn disconnect(&self, expected_session_id: Option<u64>) -> Result<(), String> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| "NFC 生命周期锁已损坏")?;
        self.disconnect_current(expected_session_id)
    }

    fn disconnect_current(&self, expected_session_id: Option<u64>) -> Result<(), String> {
        let session = {
            let mut guard = self.session_guard()?;
            if let (Some(expected), Some(current)) = (expected_session_id, guard.as_ref()) {
                if current.session_id != expected {
                    return Ok(());
                }
            }
            guard.take()
        };
        // The worker owns the port; dropping the session signals it to stop and
        // joins it, so the handle is closed before this returns.
        drop(session);
        Ok(())
    }

    pub fn read(
        &self,
        app: AppHandle,
        options: ReadOptions,
        timeout: Duration,
    ) -> Result<CardDump, String> {
        let handle = self.handle()?;
        run_busy(&self.inner.busy, &handle, || {
            self.emit_task(&app, &handle, "identify", 0, 1, "正在寻卡…");
            handle.request(timeout, |reply| NfcJob::Read { options, reply })
        })
    }

    pub fn write(
        &self,
        app: AppHandle,
        dump: CardDump,
        options: WriteOptions,
        timeout: Duration,
    ) -> Result<WriteReport, String> {
        let handle = self.handle()?;
        run_busy(&self.inner.busy, &handle, || {
            self.emit_task(&app, &handle, "identify", 0, 1, "请将目标卡片放到读卡器上…");
            handle.request(timeout, |reply| NfcJob::Write {
                dump,
                options,
                reply,
            })
        })
    }

    fn emit_task(
        &self,
        app: &AppHandle,
        handle: &SessionHandle,
        phase: &'static str,
        current: u32,
        total: u32,
        message: &str,
    ) {
        let _ = app.emit(
            "nfc:event",
            NfcEvent {
                session_id: handle.session_id,
                timestamp: unix_millis(),
                kind: "progress",
                progress: Some(Progress {
                    phase,
                    current,
                    total,
                    message: message.to_owned(),
                }),
                reason: None,
            },
        );
    }
}

/// Serialises card operations so two commands cannot share the port, and clears
/// any stale cancellation before a new operation starts.
fn run_busy<T>(
    busy: &AtomicBool,
    handle: &SessionHandle,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    if busy.swap(true, Ordering::AcqRel) {
        return Err("已有 NFC 操作正在进行，请等待完成或先取消".into());
    }
    handle.cancel.store(false, Ordering::Release);
    let result = operation();
    busy.store(false, Ordering::Release);
    result
}

struct NfcSession {
    session_id: u64,
    label: String,
    connected_at: u64,
    firmware: FirmwareVersion,
    alive: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    cancel: Arc<AtomicBool>,
    jobs: Sender<NfcJob>,
    thread: Option<JoinHandle<()>>,
}

impl NfcSession {
    fn snapshot(&self, busy: bool) -> NfcSnapshot {
        let alive = self.alive.load(Ordering::Acquire);
        NfcSnapshot {
            mode: if alive {
                NfcMode::Serial
            } else {
                NfcMode::Disconnected
            },
            label: if alive {
                self.label.clone()
            } else {
                format!("{} · 连接已中断", self.label)
            },
            session_id: alive.then_some(self.session_id),
            connected_at: Some(self.connected_at),
            firmware: Some(format!(
                "PN532 IC 0x{:02X} · 固件 {}.{} · 支持位 0x{:02X}",
                self.firmware.ic,
                self.firmware.version,
                self.firmware.revision,
                self.firmware.support
            )),
            busy,
        }
    }
}

impl Drop for NfcSession {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Release);
        self.stop.store(true, Ordering::Release);
        self.alive.store(false, Ordering::Release);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

/// Owns the port for the life of the session. The handle was already used for
/// the connect handshake, so the worker never has to reopen it.
fn worker_loop(
    session_id: u64,
    jobs: Receiver<NfcJob>,
    port: Box<dyn SerialPort>,
    cancel: Arc<AtomicBool>,
    stop: &AtomicBool,
    app: &AppHandle,
) {
    let mut link = Link::new(port, cancel);

    while !stop.load(Ordering::Acquire) {
        match jobs.recv_timeout(Duration::from_millis(60)) {
            Ok(NfcJob::Read { options, reply }) => {
                let result = link.read_card(&options, |progress| {
                    emit_progress(app, session_id, progress);
                });
                let _ = reply.send(result);
            }
            Ok(NfcJob::Write {
                dump,
                options,
                reply,
            }) => {
                let result = link.write_card(&dump, &options, |progress| {
                    emit_progress(app, session_id, progress);
                });
                let _ = reply.send(result);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

fn emit_progress(app: &AppHandle, session_id: u64, progress: Progress) {
    let _ = app.emit(
        "nfc:event",
        NfcEvent {
            session_id,
            timestamp: unix_millis(),
            kind: "progress",
            progress: Some(progress),
            reason: None,
        },
    );
}

/// One bidirectional conversation with the PN532: framed commands out, ACK plus
/// information frame back.
struct Link {
    port: Box<dyn SerialPort>,
    parser: pn532::FrameParser,
    cancel: Arc<AtomicBool>,
    /// Counts consecutive card timeouts so a removed card aborts a long read.
    strikes: u32,
    /// Set when the card rejected a command and must be re-selected before the
    /// next one can be believed.
    ///
    /// A MIFARE Classic card halts after a failed authentication and then
    /// rejects *every* later attempt — including one with the correct key —
    /// returning the same authentication error until it is selected again.
    /// Measured on real hardware, a single rejection is enough. Without this,
    /// the first sector whose key is not in the dictionary poisons every sector
    /// after it, which makes a whole-card read look like a total key failure.
    needs_reselect: bool,
}

impl Link {
    fn new(port: Box<dyn SerialPort>, cancel: Arc<AtomicBool>) -> Self {
        Self {
            port,
            parser: pn532::FrameParser::new(),
            cancel,
            needs_reselect: false,
            strikes: 0,
        }
    }

    /// Hands the port handle to the worker thread. The handshake runs on the
    /// same handle the worker will own, so the port is opened exactly once and
    /// a successful connect cannot be followed by a failed reopen.
    fn into_port(self) -> Box<dyn SerialPort> {
        self.port
    }

    fn check_cancelled(&self) -> Result<(), String> {
        if self.cancel.load(Ordering::Acquire) {
            return Err(CANCELLED.into());
        }
        Ok(())
    }

    /// Reads until a whole frame is available or the deadline passes. The
    /// parser is drained before the deadline check so a frame that already
    /// arrived is never discarded in favour of a timeout.
    fn next_frame(&mut self, deadline: Instant) -> Result<Pn532Frame, String> {
        let mut chunk = [0_u8; 512];
        loop {
            self.check_cancelled()?;
            if let Some(frame) = self.parser.next_frame() {
                return Ok(frame);
            }
            if Instant::now() >= deadline {
                return Err("等待 PN532 响应超时".into());
            }
            match self.port.read(&mut chunk) {
                // Some drivers report an idle timed read as zero bytes.
                Ok(0) => thread::sleep(Duration::from_millis(1)),
                Ok(count) => self.parser.push(&chunk[..count]),
                Err(error)
                    if matches!(
                        error.kind(),
                        ErrorKind::TimedOut | ErrorKind::WouldBlock | ErrorKind::Interrupted
                    ) => {}
                Err(error) => return Err(format!("读卡器串口读取失败: {error}")),
            }
        }
    }

    fn transact(&mut self, command: &[u8], timeout: Duration) -> Result<Vec<u8>, String> {
        let result = self.transact_with_preamble(command, timeout, 0);
        if result.is_err() {
            // UM0701 §6.2.2.3: host ACK aborts an unfinished command, so a
            // cancelled scan cannot leak a late response into the next job.
            let _ = self.port.write_all(&[0, 0, 0xFF, 0, 0xFF, 0]);
            let _ = self.port.flush();
            self.parser.clear();
            self.needs_reselect = true;
        }
        result
    }

    /// `preamble` dummy bytes are prepended before the start code. The PN532
    /// needs them to wake from LowVbat mode, where it cannot parse a frame that
    /// begins immediately (UM0701 §6.3.2.1).
    fn transact_with_preamble(
        &mut self,
        command: &[u8],
        timeout: Duration,
        preamble: usize,
    ) -> Result<Vec<u8>, String> {
        let frame = pn532::encode_frame(command)?;
        let mut last_error = String::from("PN532 未响应");
        for attempt in 0..ACK_ATTEMPTS {
            self.check_cancelled()?;
            self.parser.clear();
            let mut wire = Vec::with_capacity(frame.len() + preamble);
            if attempt == 0 {
                wire.extend(std::iter::repeat_n(0x55_u8, preamble));
            }
            wire.extend_from_slice(&frame);
            self.port
                .write_all(&wire)
                .and_then(|_| self.port.flush())
                .map_err(|error| format!("读卡器串口写入失败: {error}"))?;

            match self.next_frame(Instant::now() + ACK_TIMEOUT) {
                Ok(Pn532Frame::Ack) => {
                    return self.await_response(command[0], timeout);
                }
                Ok(Pn532Frame::Error(code)) => {
                    return Err(describe_error_frame(code));
                }
                Ok(Pn532Frame::Response(body))
                    if body.first() == Some(&pn532::CHIP_TFI)
                        && body.get(1) == Some(&command[0].wrapping_add(1)) =>
                {
                    // A valid response proves completion even if the ACK was
                    // lost. In particular, do not replay a completed write.
                    return Ok(body[1..].to_vec());
                }
                Ok(other) => {
                    last_error = format!("PN532 应答异常: {other:?}");
                }
                Err(error) => last_error = error,
            }
        }
        Err(format!("{last_error}（已重试 {ACK_ATTEMPTS} 次）"))
    }

    /// Waits for the information frame and returns its payload with the frame
    /// identifier stripped, so every caller receives `[response_code, params..]`
    /// and no parser has to know where the TFI sits.
    fn await_response(&mut self, command: u8, timeout: Duration) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.next_frame(deadline)? {
                Pn532Frame::Response(body) => {
                    return match body.split_first() {
                        Some((&pn532::CHIP_TFI, rest))
                            if rest.first() == Some(&command.wrapping_add(1)) =>
                        {
                            Ok(rest.to_vec())
                        }
                        Some((&pn532::CHIP_TFI, _)) => {
                            Err("PN532 响应命令不匹配，请重新连接读卡器".into())
                        }
                        Some((tfi, _)) => {
                            Err(format!("PN532 响应帧标识异常：期望 0xD5，实际 0x{tfi:02X}"))
                        }
                        None => Err("PN532 返回了空的响应帧".into()),
                    };
                }
                // A stray ACK or NACK mid-conversation is noise, not a result.
                Pn532Frame::Ack | Pn532Frame::Nack => continue,
                Pn532Frame::Error(code) => return Err(describe_error_frame(code)),
            }
        }
    }

    /// Brings the chip out of its power-on LowVbat state and bounds the passive
    /// activation retries, then confirms the part really is a PN532.
    fn wake_and_configure(&mut self) -> Result<FirmwareVersion, String> {
        // The first frame needs a long preamble because the chip powers up in
        // LowVbat mode, where H_REQ is unmonitored and only a long preamble is
        // decoded. SAMConfiguration normal mode is what leaves that state.
        let mut last_error = String::from("PN532 未响应");
        for attempt in 0..4 {
            self.check_cancelled()?;
            self.parser.clear();
            // Give T_osc_start time to elapse after the 0x55 run.
            if attempt > 0 {
                thread::sleep(Duration::from_millis(20));
            }
            match self.transact_with_preamble(
                &pn532::sam_configuration_command(0x00, 0x01),
                CONTROL_TIMEOUT,
                32,
            ) {
                Ok(_) => {
                    last_error = String::new();
                    break;
                }
                Err(error) => last_error = error,
            }
        }
        if !last_error.is_empty() {
            return Err(format!(
                "{last_error}。请确认模块拨码开关设为 HSU 串口模式、TXD/RXD 已交叉接线、波特率为 115200"
            ));
        }

        let response = self.transact(&pn532::get_firmware_version_command(), CONTROL_TIMEOUT)?;
        let firmware = pn532::parse_firmware_version(&response)?;
        if !firmware.is_pn532() {
            return Err(format!(
                "串口上有设备响应，但 IC 字节为 0x{:02X} 而不是 PN532 的 0x32",
                firmware.ic
            ));
        }
        if !firmware.supports_iso14443a() {
            return Err("该 PN532 固件未声明支持 ISO/IEC 14443 Type A，无法读取门卡".into());
        }

        // Without this the chip retries passive activation forever when no card
        // is present, so every scan would hang instead of returning "no card".
        self.transact(
            &pn532::rf_configuration_max_retries(0x02, 0x01, 0x01),
            CONTROL_TIMEOUT,
        )?;
        Ok(firmware)
    }

    fn release_target(&mut self, target: u8) {
        // Best effort: a failed release must not mask the real error.
        let _ = self.transact(&pn532::in_release_command(target), CONTROL_TIMEOUT);
    }

    /// Clears a halt left behind by a rejected command.
    ///
    /// Does nothing when the card is healthy, so the common path — a key found
    /// on the first candidate — pays no extra round trips. When the flag is
    /// set the target is released and re-selected, and `target` is updated
    /// because a fresh activation may hand back a different logical number.
    fn ensure_selected(&mut self, target: &mut PassiveTarget) -> Result<(), String> {
        if !self.needs_reselect {
            return Ok(());
        }
        self.release_target(target.target);
        // A field reset also clears Crypto1/halt state on cards that do not
        // recover through InRelease alone.
        self.transact(&[pn532::CMD_RF_CONFIGURATION, 0x01, 0x00], CONTROL_TIMEOUT)?;
        thread::sleep(Duration::from_millis(10));
        self.transact(&[pn532::CMD_RF_CONFIGURATION, 0x01, 0x01], CONTROL_TIMEOUT)?;
        let next = self.scan(Instant::now() + Duration::from_secs(2))?;
        if next.uid != target.uid
            || next.sel_res != target.sel_res
            || next.sens_res != target.sens_res
        {
            return Err("检测到卡片更换，已中止；请放回当前操作的卡片后重试".into());
        }
        *target = next;
        self.needs_reselect = false;
        Ok(())
    }

    fn list_passive_target(&mut self) -> Result<Option<PassiveTarget>, String> {
        let response = self.transact(
            &pn532::in_list_passive_target_command(1, pn532::BR_106K_TYPE_A),
            RF_TIMEOUT,
        )?;
        Ok(pn532::parse_list_passive_target(&response)?
            .into_iter()
            .next())
    }

    /// Polls for a card until one arrives or the deadline passes.
    fn scan(&mut self, deadline: Instant) -> Result<PassiveTarget, String> {
        loop {
            self.check_cancelled()?;
            if let Some(target) = self.list_passive_target()? {
                self.needs_reselect = false;
                return Ok(target);
            }
            if Instant::now() >= deadline {
                return Err("未检测到卡片，请将卡片平放在读卡器天线上".into());
            }
            thread::sleep(SCAN_POLL_INTERVAL);
        }
    }

    fn authenticate(
        &mut self,
        target: &mut PassiveTarget,
        block: u8,
        key: &[u8; KEY_BYTES],
        key_b: bool,
    ) -> Result<bool, String> {
        self.ensure_selected(target)?;
        let prefix = authentication_uid(&target.uid)?;
        let mut data = Vec::with_capacity(12);
        data.push(if key_b { 0x61 } else { 0x60 });
        data.push(block);
        data.extend_from_slice(key);
        data.extend_from_slice(&prefix);
        let response = self.transact(
            &pn532::in_data_exchange_command(target.target, &data),
            RF_TIMEOUT,
        )?;
        let (status, _) = pn532::parse_data_exchange(&response)?;
        match status {
            // 0x14 is the MIFARE authentication error. A wrong key is an
            // ordinary outcome of a sweep, not a failure of the link — but it
            // does halt the card, so the next attempt needs a re-selection.
            0x14 => {
                self.strikes = 0;
                self.needs_reselect = true;
                Ok(false)
            }
            // A mute card reports a timeout. Several in a row mean the card is
            // no longer in the field and the whole operation should stop.
            0x01 => {
                self.strikes += 1;
                self.needs_reselect = true;
                if self.strikes >= CARD_GONE_STRIKES {
                    return Err("卡片已离开射频场，请重新放卡后重试".into());
                }
                Ok(false)
            }
            0x00 => {
                self.strikes = 0;
                Ok(true)
            }
            other => {
                self.needs_reselect = true;
                Err(format!(
                    "MIFARE 认证返回异常状态 0x{other:02X}：{}",
                    pn532::status_text(other)
                ))
            }
        }
    }

    /// Reads one block. Returns `Ok(None)` for a status that means "this block
    /// is not readable", which is a normal per-block outcome.
    fn read_block(
        &mut self,
        target: &mut PassiveTarget,
        block: u8,
    ) -> Result<Option<[u8; mifare::BLOCK_BYTES]>, String> {
        self.ensure_selected(target)?;
        let response = self.transact(
            &pn532::in_data_exchange_command(target.target, &[0x30, block]),
            RF_TIMEOUT,
        )?;
        let (status, data) = pn532::parse_data_exchange(&response)?;
        if status != 0x00 {
            // Any rejection halts the card, not only a failed authentication.
            self.needs_reselect = true;
            return Ok(None);
        }
        let bytes: [u8; mifare::BLOCK_BYTES] = data
            .get(..mifare::BLOCK_BYTES)
            .and_then(|slice| slice.try_into().ok())
            .ok_or_else(|| {
                format!(
                    "块 {block} 返回 {} 字节，期望 {} 字节",
                    data.len(),
                    mifare::BLOCK_BYTES
                )
            })?;
        Ok(Some(bytes))
    }

    fn write_block(
        &mut self,
        target: &mut PassiveTarget,
        block: u8,
        data: &[u8; mifare::BLOCK_BYTES],
    ) -> Result<bool, String> {
        self.ensure_selected(target)?;
        let mut payload = Vec::with_capacity(18);
        payload.push(0xA0);
        payload.push(block);
        payload.extend_from_slice(data);
        let response = self.transact(
            &pn532::in_data_exchange_command(target.target, &payload),
            RF_TIMEOUT,
        )?;
        let (status, _) = pn532::parse_data_exchange(&response)?;
        if status == 0x00 {
            return Ok(true);
        }
        // A rejected write halts the card exactly like a rejected
        // authentication does. Without this the first refused block poisons
        // every block after it, which is how one bad sector turns into a
        // whole-card write failure.
        self.needs_reselect = true;
        self.strikes += u32::from(status == 0x01);
        Ok(false)
    }

    fn read_card(
        &mut self,
        options: &ReadOptions,
        mut progress: impl FnMut(Progress),
    ) -> Result<CardDump, String> {
        for key in &options.extra_keys {
            mifare::parse_key(key)?;
        }
        for entry in &options.sector_keys {
            mifare::parse_key(&entry.key)?;
        }
        let started = Instant::now();
        // Card-removal strikes are per operation; a previous run's timeouts
        // must not shorten this one.
        self.strikes = 0;
        self.transact(&[pn532::CMD_RF_CONFIGURATION, 0x01, 0x00], CONTROL_TIMEOUT)?;
        thread::sleep(Duration::from_millis(10));
        self.transact(&[pn532::CMD_RF_CONFIGURATION, 0x01, 0x01], CONTROL_TIMEOUT)?;
        let mut target = self.scan(Instant::now() + Duration::from_secs(45))?;
        let info = CardInfo::from_target(&target);
        if !info.supported {
            self.release_target(target.target);
            return Err(info
                .detail
                .unwrap_or_else(|| format!("{} 暂不支持读取", info.label)));
        }
        let kind = info.kind;
        let mut dump = if kind.is_classic() {
            self.read_classic(&mut target, kind, options, &mut progress)?
        } else {
            self.read_ultralight(&mut target, &mut progress)?
        };
        dump.uid = info.uid;
        dump.atqa = info.atqa;
        dump.sak = info.sak;
        dump.kind = kind;
        dump.label = info.label;
        dump.read_at = unix_millis();
        dump.duration_ms = started.elapsed().as_millis() as u64;
        self.release_target(target.target);
        Ok(dump)
    }

    fn read_classic(
        &mut self,
        target: &mut PassiveTarget,
        kind: CardKind,
        options: &ReadOptions,
        progress: &mut impl FnMut(Progress),
    ) -> Result<CardDump, String> {
        let sectors = mifare::sector_map(kind);
        let total_units: usize = sectors
            .iter()
            .map(|sector| usize::from(sector.block_count))
            .sum();
        let extra_keys: Vec<_> = options
            .extra_keys
            .iter()
            .map(|text| mifare::parse_key(text))
            .collect::<Result<_, _>>()?;
        let mut units = vec![None; total_units];
        let mut sector_dumps = Vec::with_capacity(sectors.len());
        let mut confirmed = Vec::new();
        let mut warnings = Vec::new();

        for sector in &sectors {
            let mut candidates = Vec::new();
            for entry in options
                .sector_keys
                .iter()
                .filter(|entry| entry.sector == sector.index)
            {
                candidates.push((
                    mifare::parse_key(&entry.key)?,
                    entry.key_b,
                    KeySource::Manual,
                ));
            }
            candidates.extend(sector_key_candidates(&confirmed, &extra_keys, None));
            let mut tried = Vec::new();
            let mut key_a = None;
            let mut key_b = None;
            let mut source = KeySource::None;
            let trailer_slot =
                unit_slot(&sectors, sector.trailer_block()).expect("valid sector geometry");
            for (key, is_b, key_source) in candidates {
                self.check_cancelled()?;
                if (is_b && key_b.is_some())
                    || (!is_b && key_a.is_some())
                    || tried.contains(&(key, is_b))
                {
                    continue;
                }
                tried.push((key, is_b));
                progress(Progress {
                    phase: "read",
                    current: u32::from(sector.index),
                    total: u32::from(kind_sector_count(kind)),
                    message: format!(
                        "扇区 {} / {}：认证 Key {}（候选 {}）",
                        sector.index + 1,
                        sectors.len(),
                        if is_b { "B" } else { "A" },
                        tried.len()
                    ),
                });
                if !self.authenticate(target, sector.trailer_block() as u8, &key, is_b)? {
                    continue;
                }
                source = key_source;
                if is_b {
                    key_b = Some(mifare::format_key(&key));
                } else {
                    key_a = Some(mifare::format_key(&key));
                }
                if !confirmed.contains(&(key, is_b)) {
                    confirmed.push((key, is_b));
                }
                // Read the trailer first, then fill every block this key can
                // access. A denial loses authentication, so reauthenticate
                // before the next block instead of cascading failures.
                for block in std::iter::once(sector.trailer_block()).chain(sector.data_blocks()) {
                    if units[usize::from(block)].is_some() {
                        continue;
                    }
                    if self.needs_reselect && !self.authenticate(target, block as u8, &key, is_b)? {
                        continue;
                    }
                    units[usize::from(block)] = self.read_block(target, block as u8)?;
                }
                if let Some(trailer) = units[trailer_slot] {
                    if mifare::decode_access_bits(&trailer)
                        .is_some_and(|bits| bits.key_b_readable())
                    {
                        // Table 7: these bytes are readable data. Authenticating
                        // with them as Key B is forbidden even when correct.
                        key_b = Some(mifare::format_hex(&trailer[10..16]));
                    }
                }
                if key_a.is_some()
                    && key_b.is_some()
                    && sector
                        .blocks()
                        .all(|block| units[usize::from(block)].is_some())
                {
                    break;
                }
            }
            let resolved = key_a.is_some() || key_b.is_some();
            let missing = sector
                .blocks()
                .filter(|block| units[usize::from(*block)].is_none())
                .count();
            let access = units[trailer_slot].and_then(|bytes| mifare::decode_access_bits(&bytes));
            let mut messages = Vec::new();
            if missing > 0 {
                messages.push(format!("{missing} 个块未读取"));
            }
            if key_a.is_none() {
                messages.push("Key A 未知".into());
            }
            if key_b.is_none() {
                messages.push("Key B 未知".into());
            }
            if access.is_none() {
                messages.push("权限位不可用".into());
            }
            if !messages.is_empty() {
                warnings.push(format!(
                    "扇区 {}：{}；复制前请补齐，未知密钥不会用零代替",
                    sector.index,
                    messages.join("，")
                ));
            }
            sector_dumps.push(SectorDump {
                index: sector.index,
                first_block: sector.first_block,
                block_count: sector.block_count,
                trailer_block: sector.trailer_block(),
                key_a,
                key_b,
                key_source: source,
                resolved,
                access_summary: access.map(|bits| bits.summary()),
                message: (!messages.is_empty()).then(|| messages.join("，")),
            });
        }
        let unresolved_sectors = sector_dumps
            .iter()
            .filter(|sector| !sector.resolved)
            .count() as u8;
        Ok(CardDump {
            uid: String::new(),
            atqa: String::new(),
            sak: 0,
            kind,
            label: kind.label().into(),
            unit_size: mifare::BLOCK_BYTES as u8,
            units: units
                .into_iter()
                .enumerate()
                .map(|(index, data)| DataUnit {
                    index: index as u16,
                    sector: sector_of_block(&sectors, index as u16),
                    data: data.map(|bytes| mifare::format_hex(&bytes)),
                    error: data.is_none().then(|| "未读取：密钥或访问权限不足".into()),
                    is_trailer: is_trailer(&sectors, index as u16),
                    is_manufacturer: index == 0,
                })
                .collect(),
            sectors: sector_dumps,
            read_at: 0,
            duration_ms: 0,
            unresolved_sectors,
            warnings,
        })
    }

    /// GET_VERSION uses InCommunicateThru: InDataExchange interprets 0x60 as
    /// Classic authentication and rejects its short Type 2 form.
    fn type2_layout(&mut self, target: &mut PassiveTarget) -> Result<Type2Layout, String> {
        self.ensure_selected(target)?;
        let response = self.transact(&[0x42, 0x60], RF_TIMEOUT)?;
        if response.get(1) == Some(&0) {
            if let Some(layout) = Type2Layout::from_version(&response[2..]) {
                return Ok(layout);
            }
        }
        self.needs_reselect = true;
        // Legacy Ultralight has no GET_VERSION. Only the common user pages
        // 4..15 are writable without a positive model identification.
        Ok(Type2Layout {
            pages: 16,
            user_end: 16,
            identified: false,
        })
    }

    fn read_ultralight(
        &mut self,
        target: &mut PassiveTarget,
        progress: &mut impl FnMut(Progress),
    ) -> Result<CardDump, String> {
        let layout = self.type2_layout(target)?;
        let mut units = Vec::new();
        for page in (0..layout.pages).step_by(4) {
            progress(Progress {
                phase: "read",
                current: u32::from(page),
                total: u32::from(layout.pages),
                message: format!("读取第 {page} 页…"),
            });
            // Avoid Type 2 READ rollover at the end of the physical memory.
            let start = page.min(layout.pages - 4);
            let data = self.read_block(target, start as u8)?;
            for index in page..(page + 4).min(layout.pages) {
                let offset = usize::from(index - start) * 4;
                units.push(DataUnit {
                    index,
                    sector: 0,
                    data: data.map(|bytes| mifare::format_hex(&bytes[offset..offset + 4])),
                    error: data.is_none().then(|| "未读取：权限限制或射频错误".into()),
                    is_trailer: false,
                    is_manufacturer: index < 3,
                });
            }
        }
        let mut warnings = vec!["Type 2 标签仅复制用户数据页；UID、OTP、锁定位、配置和密码不复制。密码回读的零不代表真实密码".into()];
        if !layout.identified {
            warnings.push("具体 Type 2 型号未确认，仅备份前 16 页，不能视为整卡备份".into());
        }
        Ok(CardDump {
            uid: String::new(),
            atqa: String::new(),
            sak: 0,
            kind: CardKind::Ultralight,
            label: CardKind::Ultralight.label().into(),
            unit_size: 4,
            units,
            sectors: Vec::new(),
            read_at: 0,
            duration_ms: 0,
            unresolved_sectors: 0,
            warnings,
        })
    }

    fn write_card(
        &mut self,
        dump: &CardDump,
        options: &WriteOptions,
        mut progress: impl FnMut(Progress),
    ) -> Result<WriteReport, String> {
        let started = Instant::now();
        validate_write_dump(dump, options)?;
        self.strikes = 0;
        if !dump.is_readable() {
            return Err("备份中没有可用数据，请先完整读取原卡".into());
        }
        let mut target = self.scan(Instant::now() + Duration::from_secs(30))?;
        let target_info = CardInfo::from_target(&target);
        let mut warnings = Vec::new();
        if !target_info.supported {
            self.release_target(target.target);
            return Err(target_info
                .detail
                .unwrap_or_else(|| format!("{} 暂不支持写入", target_info.label)));
        }
        if target_info.kind != dump.kind {
            self.release_target(target.target);
            return Err(format!(
                "卡型不匹配：备份来自 {}，目标卡是 {}。写入会导致数据结构错乱，已中止",
                dump.label, target_info.label
            ));
        }

        if options
            .expected_target_uid
            .as_ref()
            .is_some_and(|uid| !target_info.uid.eq_ignore_ascii_case(uid))
        {
            self.release_target(target.target);
            return Err("当前卡不是指定目标，已停止写入".into());
        }
        if options.write_manufacturer_block && target.uid.len() != 4 {
            self.release_target(target.target);
            return Err("目标必须也是 4 字节 UID，无法跨 UID 长度复制厂商块".into());
        }
        if target_info.uid.eq_ignore_ascii_case(&dump.uid) && !options.allow_same_uid {
            self.release_target(target.target);
            return Err("当前卡与原卡 UID 相同，已停止以保护原卡。请换上目标卡；若目标本来就使用相同 UID，请开启对应选项".into());
        }
        if !target_info.uid.eq_ignore_ascii_case(&dump.uid) && !options.write_manufacturer_block {
            warnings.push("目标 UID 与原卡不同。本次只复制可写数据；校验 UID 的门禁仍可能拒绝。手机钱包空白卡不能假定支持改 UID".into());
        }
        let mut target_keys = Vec::new();
        for text in &options.target_keys {
            target_keys.push(mifare::parse_key(text)?);
        }
        for text in dump.sectors.iter().flat_map(|sector| {
            [sector.key_a.as_deref(), sector.key_b.as_deref()]
                .into_iter()
                .flatten()
        }) {
            if let Ok(key) = mifare::parse_key(text) {
                target_keys.push(key);
            }
        }

        let mut report = if dump.kind.is_classic() {
            self.write_classic(
                &mut target,
                dump,
                options,
                &target_keys,
                &mut warnings,
                &mut progress,
            )?
        } else {
            self.write_ultralight(&mut target, dump, options, &mut warnings, &mut progress)?
        };
        report.duration_ms = started.elapsed().as_millis() as u64;
        report.uid = mifare::format_hex(&target.uid);
        report.uid_matches = report.uid.eq_ignore_ascii_case(&dump.uid);
        report.complete_copy = report.verified
            && report.uid_matches
            && report.blocks_skipped == 0
            && report.blocks_written as usize == dump.units.len()
            && dump.unresolved_sectors == 0;
        report.warnings = warnings;
        self.release_target(target.target);
        Ok(report)
    }

    fn write_classic(
        &mut self,
        target: &mut PassiveTarget,
        dump: &CardDump,
        options: &WriteOptions,
        target_keys: &[[u8; KEY_BYTES]],
        warnings: &mut Vec<String>,
        progress: &mut impl FnMut(Progress),
    ) -> Result<WriteReport, String> {
        let sectors = mifare::sector_map(dump.kind);
        let selected: Vec<_> = sectors
            .iter()
            .filter(|sector| options.sectors.is_empty() || options.sectors.contains(&sector.index))
            .collect();
        let mut report = WriteReport::empty();
        let mut confirmed = Vec::new();
        let mut manufacturer_keys = Vec::new();
        for (position, sector) in selected.iter().enumerate() {
            progress(Progress {
                phase: "write",
                current: position as u32,
                total: selected.len() as u32,
                message: format!("写入扇区 {}（数据块校验后再写密钥）", sector.index),
            });
            let before_failed = report.blocks_failed;
            let before_skipped = report.blocks_skipped;
            let before_written = report.blocks_written;
            let before_verification_failures = report.verification_failures.len();
            let mut keys: Vec<_> = sector_key_candidates(&confirmed, target_keys, None)
                .into_iter()
                .map(|(key, is_b, _)| (key, is_b))
                .collect();
            for block in sector.data_blocks().filter(|block| *block != 0) {
                let Some(data) = dump.unit(block) else {
                    report.skip(format!("块 {block}：备份缺失"));
                    continue;
                };
                if let Some(key) = self.write_with_keys(target, block as u8, &data, &keys)? {
                    report.blocks_written += 1;
                    if !confirmed.contains(&key) {
                        confirmed.push(key);
                    }
                    keys.retain(|entry| *entry != key);
                    keys.insert(0, key);
                    // Check before changing access bits: the source trailer
                    // may make a written block unreadable with the old key.
                    if options.verify {
                        if self.verify_data_block(target, block as u8, &data, &keys)? {
                            report.blocks_verified += 1;
                        } else {
                            report
                                .verification_failures
                                .push(format!("块 {block}：写后回读不一致或不可读"));
                        }
                    }
                } else {
                    report.blocks_failed += 1;
                    report
                        .failures
                        .push(format!("块 {block}：目标密钥或写权限不允许"));
                }
            }
            let trailer_block = sector.trailer_block();
            let source_sector = dump
                .sectors
                .iter()
                .find(|entry| entry.index == sector.index);
            let trailer = source_sector.and_then(|entry| {
                dump.unit(trailer_block).and_then(|bytes| {
                    prepare_trailer(&bytes, entry.key_a.as_deref(), entry.key_b.as_deref())
                })
            });
            if !options.write_trailers {
                report.skip(format!("扇区 {}：保留目标密钥与权限位", sector.index));
            } else if report.blocks_failed != before_failed
                || report.blocks_skipped != before_skipped
                || report.verification_failures.len() != before_verification_failures
            {
                report.skip(format!(
                    "扇区 {}：数据未完整写入或校验失败，保留尾块便于重试",
                    sector.index
                ));
            } else if let Some(trailer) = trailer {
                if self
                    .write_with_keys(target, trailer_block as u8, &trailer, &keys)?
                    .is_some()
                {
                    report.blocks_written += 1;
                    let key_a = trailer[..6].try_into().expect("trailer Key A");
                    let key_b = trailer[10..16].try_into().expect("trailer Key B");
                    keys = vec![(key_a, false)];
                    if !mifare::decode_access_bits(&trailer)
                        .expect("validated trailer")
                        .key_b_readable()
                    {
                        keys.push((key_b, true));
                    }
                    if options.verify {
                        if self.verify_trailer(target, trailer_block as u8, &trailer)? {
                            report.blocks_verified += 1;
                        } else {
                            report
                                .verification_failures
                                .push(format!("扇区 {}：尾块密钥或权限校验失败", sector.index));
                        }
                    }
                } else {
                    report.blocks_failed += 1;
                    report
                        .failures
                        .push(format!("扇区 {}：尾块写入被拒绝", sector.index));
                }
            } else {
                report.skip(format!(
                    "扇区 {}：缺少原卡 Key A / Key B 或尾块，保留目标密钥与权限位",
                    sector.index
                ));
            }
            if sector.index == 0 {
                manufacturer_keys = keys;
            }
            if report.blocks_written > before_written && report.blocks_failed == before_failed {
                report.sectors_written += 1;
            }
        }
        // UID changes last, after all ordinary sector operations.
        if selected.iter().any(|sector| sector.index == 0) {
            if !options.write_manufacturer_block {
                report.manufacturer_block_written = Some(false);
                report.skip("第 0 块：保留目标 UID / 厂商信息".into());
            } else if report.blocks_failed > 0 || !report.verification_failures.is_empty() {
                report.manufacturer_block_written = Some(false);
                report.skip("第 0 块：前序写入或校验失败，保留目标 UID 便于重试".into());
            } else if let Some(data) = dump.unit(0) {
                if self
                    .write_with_keys(target, 0, &data, &manufacturer_keys)?
                    .is_some()
                {
                    report.blocks_written += 1;
                    report.manufacturer_block_written = Some(true);
                    target.uid = mifare::decode_hex(&dump.uid)?;
                    target.sens_res = mifare::decode_hex(&dump.atqa)?
                        .try_into()
                        .expect("validated ATQA");
                    target.sel_res = dump.sak;
                    self.needs_reselect = true;
                    if options.verify {
                        if self.verify_data_block(target, 0, &data, &manufacturer_keys)? {
                            report.blocks_verified += 1;
                        } else {
                            report
                                .verification_failures
                                .push("块 0：UID / 厂商信息校验失败".into());
                        }
                    }
                } else {
                    report.blocks_failed += 1;
                    report.manufacturer_block_written = Some(false);
                    report
                        .failures
                        .push("第 0 块写入被拒绝；普通卡和手机卡不能假定支持改 UID".into());
                }
            }
        }
        if !report.skips.is_empty() {
            warnings.push("存在未复制区域；已写入块校验通过也不代表整卡一致".into());
        }
        report.verified = options.verify
            && report.blocks_written > 0
            && report.blocks_failed == 0
            && report.blocks_verified == report.blocks_written
            && report.verification_failures.is_empty();
        Ok(report)
    }

    /// Each attempted key starts a fresh authenticated operation. Failed writes
    /// and reads may halt the PICC and must never poison subsequent blocks.
    fn write_with_keys(
        &mut self,
        target: &mut PassiveTarget,
        block: u8,
        data: &[u8; 16],
        keys: &[([u8; KEY_BYTES], bool)],
    ) -> Result<Option<([u8; KEY_BYTES], bool)>, String> {
        for (key, is_b) in keys {
            if self.authenticate(target, block, key, *is_b)?
                && self.write_block(target, block, data)?
            {
                return Ok(Some((*key, *is_b)));
            }
        }
        Ok(None)
    }

    fn verify_data_block(
        &mut self,
        target: &mut PassiveTarget,
        block: u8,
        expected: &[u8; 16],
        keys: &[([u8; KEY_BYTES], bool)],
    ) -> Result<bool, String> {
        for (key, is_b) in keys {
            if self.authenticate(target, block, key, *is_b)? {
                if let Some(actual) = self.read_block(target, block)? {
                    return Ok(actual == *expected);
                }
            }
        }
        Ok(false)
    }

    fn verify_trailer(
        &mut self,
        target: &mut PassiveTarget,
        block: u8,
        expected: &[u8; 16],
    ) -> Result<bool, String> {
        let bits = mifare::decode_access_bits(expected).ok_or("尾块权限无效")?;
        let key_a = expected[..6].try_into().expect("Key A");
        let key_b = expected[10..16].try_into().expect("Key B");
        // Key A and protected Key B are masked on READ; authenticate instead.
        if !self.authenticate(target, block, &key_a, false)? {
            return Ok(false);
        }
        let mut actual = self.read_block(target, block)?;
        if !bits.key_b_readable() {
            if !self.authenticate(target, block, &key_b, true)? {
                return Ok(false);
            }
            if actual.is_none() {
                actual = self.read_block(target, block)?;
            }
        }
        Ok(actual.is_some_and(|bytes| {
            bytes[6..10] == expected[6..10]
                && (!bits.key_b_readable() || bytes[10..16] == expected[10..16])
        }))
    }

    fn write_ultralight(
        &mut self,
        target: &mut PassiveTarget,
        dump: &CardDump,
        options: &WriteOptions,
        warnings: &mut Vec<String>,
        progress: &mut impl FnMut(Progress),
    ) -> Result<WriteReport, String> {
        let layout = self.type2_layout(target)?;
        if dump.units.len() != usize::from(layout.pages) {
            return Err("Type 2 备份容量与目标不匹配；请先确认具体型号".into());
        }
        let mut report = WriteReport::empty();
        warnings.push("仅写用户页；保留目标 UID、OTP、锁定位、配置和密码".into());
        if !layout.identified {
            warnings.push("型号未确认，本次仅允许写第 4–15 页".into());
        }
        for unit in &dump.units {
            if unit.index < 4 || unit.index >= layout.user_end {
                report.skip(format!(
                    "第 {} 页：保留 UID / OTP / 锁定位 / 配置 / 密码",
                    unit.index
                ));
                continue;
            }
            let Some(hex) = &unit.data else {
                report.skip(format!("第 {} 页：备份缺失", unit.index));
                continue;
            };
            let bytes = mifare::decode_hex(hex)?;
            self.ensure_selected(target)?;
            progress(Progress {
                phase: "write",
                current: u32::from(unit.index),
                total: u32::from(layout.pages),
                message: format!("写入第 {} 页", unit.index),
            });
            let mut payload = vec![0xA2, unit.index as u8];
            payload.extend(&bytes);
            let response = self.transact(
                &pn532::in_data_exchange_command(target.target, &payload),
                RF_TIMEOUT,
            )?;
            let (status, _) = pn532::parse_data_exchange(&response)?;
            if status != 0 {
                self.needs_reselect = true;
                report.blocks_failed += 1;
                report.failures.push(format!(
                    "第 {} 页：{}",
                    unit.index,
                    pn532::status_text(status)
                ));
                continue;
            }
            report.blocks_written += 1;
            if options.verify {
                let start = unit.index.min(layout.pages - 4);
                let offset = usize::from(unit.index - start) * 4;
                if self
                    .read_block(target, start as u8)?
                    .is_some_and(|data| data[offset..offset + 4] == bytes)
                {
                    report.blocks_verified += 1;
                } else {
                    report
                        .verification_failures
                        .push(format!("第 {} 页：回读校验失败", unit.index));
                }
            }
        }
        report.verified = options.verify
            && report.blocks_written > 0
            && report.blocks_failed == 0
            && report.blocks_verified == report.blocks_written
            && report.verification_failures.is_empty();
        Ok(report)
    }
}

#[derive(Debug, Clone, Copy)]
struct Type2Layout {
    pages: u16,
    user_end: u16,
    identified: bool,
}
impl Type2Layout {
    fn from_version(version: &[u8]) -> Option<Self> {
        // NTAG213/215/216 data sheet Table 28 and memory maps.
        if version.len() != 8 || version[..6] != [0, 4, 4, 2, 1, 0] || version[7] != 3 {
            return None;
        }
        let user_end = match version[6] {
            0x0F => 40,
            0x11 => 130,
            0x13 => 226,
            _ => return None,
        };
        Some(Self {
            pages: user_end + 5,
            user_end,
            identified: true,
        })
    }
}

impl WriteReport {
    fn empty() -> Self {
        Self {
            uid: String::new(),
            blocks_written: 0,
            blocks_failed: 0,
            blocks_skipped: 0,
            sectors_written: 0,
            verified: false,
            blocks_verified: 0,
            verification_failures: Vec::new(),
            uid_matches: false,
            complete_copy: false,
            manufacturer_block_written: None,
            duration_ms: 0,
            failures: Vec::new(),
            skips: Vec::new(),
            warnings: Vec::new(),
        }
    }
    fn skip(&mut self, message: String) {
        self.blocks_skipped += 1;
        self.skips.push(message);
    }
}

fn validate_write_dump(dump: &CardDump, options: &WriteOptions) -> Result<(), String> {
    let uid = mifare::decode_hex(&dump.uid)?;
    if !matches!(uid.len(), 4 | 7)
        || mifare::decode_hex(&dump.atqa)?.len() != 2
        || CardKind::from_sak(dump.sak) != dump.kind
    {
        return Err("备份卡型、UID 或 ATQA 无效".into());
    }
    let sectors = mifare::sector_map(dump.kind);
    let expected_size = if dump.kind.is_classic() { 16 } else { 4 };
    if dump.unit_size != expected_size
        || (!dump.kind.is_classic() && dump.kind != CardKind::Ultralight)
    {
        return Err("备份数据单位或卡型不支持".into());
    }
    let total = if dump.kind.is_classic() {
        sectors
            .iter()
            .map(|sector| usize::from(sector.block_count))
            .sum()
    } else {
        dump.units.len()
    };
    if total == 0 || total > 256 || dump.units.len() != total {
        return Err("备份块数量与卡型不匹配".into());
    }
    let mut seen = std::collections::HashSet::new();
    for unit in &dump.units {
        if usize::from(unit.index) >= total || !seen.insert(unit.index) {
            return Err("备份含重复或越界块地址".into());
        }
        if let Some(hex) = &unit.data {
            let bytes = mifare::decode_hex(hex)?;
            if bytes.len() != usize::from(expected_size) {
                return Err(format!("块 {} 数据长度错误", unit.index));
            }
            if dump.kind.is_classic()
                && options.write_trailers
                && is_trailer(&sectors, unit.index)
                && (options.sectors.is_empty()
                    || options
                        .sectors
                        .contains(&sector_of_block(&sectors, unit.index)))
                && mifare::decode_access_bits(&bytes).is_none()
            {
                return Err(format!("块 {} 权限位校验失败，已在写入前中止", unit.index));
            }
        }
    }
    if dump.kind.is_classic() {
        if dump.sectors.len() != sectors.len() {
            return Err("备份扇区表不完整".into());
        }
        let mut seen = std::collections::HashSet::new();
        for entry in &dump.sectors {
            let geometry = sectors
                .iter()
                .find(|sector| sector.index == entry.index)
                .ok_or("扇区索引越界")?;
            if !seen.insert(entry.index)
                || entry.first_block != geometry.first_block
                || entry.block_count != geometry.block_count
                || entry.trailer_block != geometry.trailer_block()
            {
                return Err("备份扇区结构错误".into());
            }
            for key in [entry.key_a.as_deref(), entry.key_b.as_deref()]
                .into_iter()
                .flatten()
            {
                mifare::parse_key(key)?;
            }
        }
    }
    for sector in &options.sectors {
        if !sectors.iter().any(|entry| entry.index == *sector) {
            return Err("所选扇区超出卡片范围".into());
        }
    }
    for key in &options.target_keys {
        mifare::parse_key(key)?;
    }
    if let Some(uid) = &options.expected_target_uid {
        if !matches!(mifare::decode_hex(uid)?.len(), 4 | 7) {
            return Err("目标 UID 无效".into());
        }
    }
    if options.write_manufacturer_block {
        if !dump.kind.is_classic() || uid.len() != 4 {
            return Err("改写 UID 仅支持 4 字节 UID 的 Classic 兼容可写厂商块卡".into());
        }
        let block = dump.unit(0).ok_or("备份缺少厂商块")?;
        if mifare::manufacturer_bcc_is_valid(&block) != Some(true) || block[..4] != uid {
            return Err("厂商块 UID / BCC 与备份不一致".into());
        }
    }
    Ok(())
}

/// Candidate keys for one sector, in the order they are tried.
///
/// An operator-supplied override goes first, then keys already proven on this
/// card (most cards reuse one key set, so a confirmed key usually opens the
/// rest), then the shared dictionary. Key A and Key B are independent, so the
/// dictionary is swept for both — a card that rejects every Key A can still
/// open with a default Key B.
fn sector_key_candidates(
    confirmed: &[([u8; KEY_BYTES], bool)],
    extra_keys: &[[u8; KEY_BYTES]],
    override_key: Option<([u8; KEY_BYTES], bool)>,
) -> Vec<([u8; KEY_BYTES], bool, KeySource)> {
    let mut candidates: Vec<([u8; KEY_BYTES], bool, KeySource)> = Vec::new();
    let mut push = |key: [u8; KEY_BYTES], key_b: bool, source: KeySource| {
        if !candidates
            .iter()
            .any(|(existing, existing_b, _)| *existing == key && *existing_b == key_b)
        {
            candidates.push((key, key_b, source));
        }
    };

    if let Some((key, key_b)) = override_key {
        push(key, key_b, KeySource::Manual);
    }
    for (key, key_b) in confirmed {
        push(*key, *key_b, KeySource::Dictionary);
    }
    for key in extra_keys {
        push(*key, false, KeySource::Manual);
        push(*key, true, KeySource::Manual);
    }
    for key in mifare::DEFAULT_KEYS {
        push(key, false, KeySource::Dictionary);
    }
    for key in mifare::DEFAULT_KEYS {
        push(key, true, KeySource::Dictionary);
    }
    for (key, key_b) in confirmed {
        // A key confirmed as Key A may also be the sector's Key B.
        push(*key, !*key_b, KeySource::Harvested);
    }
    candidates
}

/// Reconstructs both hidden keys using known values. Readable Key B is copied
/// as data; protected Key B must never be inferred from masked READ bytes.
fn prepare_trailer(
    source: &[u8; mifare::BLOCK_BYTES],
    known_key_a: Option<&str>,
    known_key_b: Option<&str>,
) -> Option<[u8; mifare::BLOCK_BYTES]> {
    let bits = mifare::decode_access_bits(source)?;
    let key_a = mifare::parse_key(known_key_a?).ok()?;
    let mut trailer = *source;
    trailer[..KEY_BYTES].copy_from_slice(&key_a);
    if !bits.key_b_readable() {
        let key_b = mifare::parse_key(known_key_b?).ok()?;
        trailer[10..16].copy_from_slice(&key_b);
    }
    Some(trailer)
}

fn authentication_uid(uid: &[u8]) -> Result<[u8; 4], String> {
    if !matches!(uid.len(), 4 | 7) {
        return Err("MIFARE Classic 认证要求 4 或 7 字节 UID".into());
    }
    // MF1S50YYX_V1 §10.1.3: bytes from the last anticollision cascade.
    Ok(uid[uid.len() - 4..]
        .try_into()
        .expect("validated UID length"))
}

fn describe_error_frame(code: Option<u8>) -> String {
    match code {
        // UM0701 §6.2.3: an error frame with no status byte means the command
        // code, length or parameters were rejected outright.
        None => "PN532 拒绝该命令（语法错误帧）：命令码、长度或参数不合法".into(),
        Some(code) => format!(
            "PN532 报告错误帧 0x{code:02X}：{}",
            pn532::status_text(code)
        ),
    }
}

fn kind_sector_count(kind: CardKind) -> u8 {
    match kind {
        CardKind::Classic1K => 16,
        CardKind::Classic4K => 40,
        _ => 0,
    }
}

/// Maps an absolute block number onto its slot in the flat unit vector, which
/// is laid out sector by sector.
fn unit_slot(sectors: &[mifare::Sector], block: u16) -> Option<usize> {
    let mut offset = 0;
    for sector in sectors {
        if sector.blocks().contains(&block) {
            return Some(offset + usize::from(block - sector.first_block));
        }
        offset += usize::from(sector.block_count);
    }
    None
}

fn sector_of_block(sectors: &[mifare::Sector], block: u16) -> u8 {
    sectors
        .iter()
        .find(|sector| sector.blocks().contains(&block))
        .map(|sector| sector.index)
        .unwrap_or(0)
}

fn is_trailer(sectors: &[mifare::Sector], block: u16) -> bool {
    sectors.iter().any(|sector| sector.trailer_block() == block)
}

impl CardDump {
    /// Decoded payload of one unit, or `None` when it was not read.
    fn unit(&self, index: u16) -> Option<[u8; mifare::BLOCK_BYTES]> {
        let unit = self.units.iter().find(|unit| unit.index == index)?;
        let bytes = mifare::decode_hex(unit.data.as_deref()?).ok()?;
        bytes.as_slice().try_into().ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn classic_dump() -> CardDump {
        let sectors = mifare::sector_map(CardKind::Classic1K);
        let units = sectors
            .iter()
            .flat_map(|sector| sector.blocks())
            .map(|index| DataUnit {
                index,
                sector: sector_of_block(&sectors, index),
                data: Some("00".repeat(16)),
                error: None,
                is_trailer: is_trailer(&sectors, index),
                is_manufacturer: index == 0,
            })
            .collect();
        CardDump {
            uid: "922E5832".into(),
            atqa: "0400".into(),
            sak: 0x08,
            kind: CardKind::Classic1K,
            label: CardKind::Classic1K.label().into(),
            unit_size: 16,
            units,
            sectors: sectors
                .iter()
                .map(|sector| SectorDump {
                    index: sector.index,
                    first_block: sector.first_block,
                    block_count: sector.block_count,
                    trailer_block: sector.trailer_block(),
                    key_a: Some("FFFFFFFFFFFF".into()),
                    key_b: Some("FFFFFFFFFFFF".into()),
                    key_source: KeySource::Dictionary,
                    resolved: true,
                    access_summary: None,
                    message: None,
                })
                .collect(),
            read_at: 0,
            duration_ms: 0,
            unresolved_sectors: 0,
            warnings: vec![],
        }
    }

    #[test]
    fn unit_slots_follow_sector_order_for_both_geometries() {
        let one_k = mifare::sector_map(CardKind::Classic1K);
        assert_eq!(unit_slot(&one_k, 0), Some(0));
        assert_eq!(unit_slot(&one_k, 3), Some(3));
        assert_eq!(unit_slot(&one_k, 4), Some(4));
        assert_eq!(unit_slot(&one_k, 63), Some(63));
        assert_eq!(unit_slot(&one_k, 64), None);

        let four_k = mifare::sector_map(CardKind::Classic4K);
        // Sector 32 starts at block 128 but sits at flat offset 128 too, since
        // the first 32 sectors contributed exactly 4 blocks each.
        assert_eq!(unit_slot(&four_k, 128), Some(128));
        assert_eq!(unit_slot(&four_k, 255), Some(255));
        assert_eq!(unit_slot(&four_k, 256), None);
        assert_eq!(sector_of_block(&four_k, 127), 31);
        assert_eq!(sector_of_block(&four_k, 128), 32);
        assert!(is_trailer(&four_k, 127));
        assert!(!is_trailer(&four_k, 126));
    }

    #[test]
    fn kind_sector_counts_match_the_card_layouts() {
        assert_eq!(kind_sector_count(CardKind::Classic1K), 16);
        assert_eq!(kind_sector_count(CardKind::Classic4K), 40);
        assert_eq!(kind_sector_count(CardKind::Ultralight), 0);
    }

    #[test]
    fn key_candidates_lead_with_override_then_confirmed_then_manual() {
        let candidates =
            sector_key_candidates(&[([0xAA; 6], false)], &[[0xBB; 6]], Some(([0xCC; 6], true)));
        assert_eq!(candidates[0], ([0xCC; 6], true, KeySource::Manual));
        assert_eq!(candidates[1], ([0xAA; 6], false, KeySource::Dictionary));
        assert_eq!(candidates[2], ([0xBB; 6], false, KeySource::Manual));
        assert!(candidates.len() >= mifare::DEFAULT_KEYS.len());
        for (index, (key, key_b, _)) in candidates.iter().enumerate() {
            assert!(
                !candidates[..index]
                    .iter()
                    .any(|(other, other_b, _)| other == key && other_b == key_b),
                "重复候选 {index}"
            );
        }
    }

    #[test]
    fn key_candidates_offer_both_key_types_from_the_dictionary() {
        let candidates = sector_key_candidates(&[], &[], None);
        assert!(candidates
            .iter()
            .any(|(key, key_b, _)| *key == [0xFF; 6] && !*key_b));
        assert!(candidates
            .iter()
            .any(|(key, key_b, _)| *key == [0xFF; 6] && *key_b));
    }

    #[test]
    fn confirmed_keys_are_retried_as_the_other_key_type_last() {
        let candidates = sector_key_candidates(&[([0xAA; 6], false)], &[], None);
        let recovered = candidates.last().expect("应有候选");
        assert_eq!(recovered.0, [0xAA; 6]);
        assert!(recovered.1, "确认过的 Key A 也应作为 Key B 重试");
        assert_eq!(recovered.2, KeySource::Harvested);
        // A confirmed Key B can also be a later sector's Key A.
        let candidates = sector_key_candidates(&[([0xAA; 6], true)], &[], None);
        assert!(candidates
            .iter()
            .any(|(key, key_b, source)| *key == [0xAA; 6]
                && !*key_b
                && *source == KeySource::Harvested));
    }

    #[test]
    fn an_invalid_manual_key_fails_before_any_radio_traffic() {
        assert!(mifare::parse_key("ZZZZZZZZZZZZ").is_err());
        assert!(mifare::parse_key("AABB").is_err());
    }

    #[test]
    fn unit_lookup_returns_the_decoded_block_and_rejects_bad_hex() {
        let mut dump = classic_dump();
        assert_eq!(dump.unit(0), Some([0_u8; 16]));
        assert_eq!(dump.unit(63), Some([0_u8; 16]));
        assert_eq!(dump.unit(64), None);
        dump.units[0].data = Some("ZZ".into());
        assert_eq!(dump.unit(0), None);
        dump.units[0].data = None;
        assert_eq!(dump.unit(0), None);
    }

    #[test]
    fn card_info_marks_unsupported_protocols_with_a_reason() {
        let desfire = CardInfo::from_target(&PassiveTarget {
            target: 1,
            sens_res: [0x44, 0x00],
            sel_res: 0x20,
            uid: vec![0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66],
        });
        assert!(!desfire.supported);
        assert!(desfire.detail.is_some());
        assert_eq!(desfire.kind, CardKind::Iso14443_4);

        let classic = CardInfo::from_target(&PassiveTarget {
            target: 1,
            sens_res: [0x04, 0x00],
            sel_res: 0x08,
            uid: vec![0x92, 0x2E, 0x58, 0x32],
        });
        assert!(classic.supported);
        assert_eq!(classic.uid, "922E5832");
        assert_eq!(classic.atqa, "0400");
        assert_eq!(classic.label, "MIFARE Classic 1K");
    }

    #[test]
    fn unknown_sak_is_reported_as_unsupported_rather_than_guessed() {
        let info = CardInfo::from_target(&PassiveTarget {
            target: 1,
            sens_res: [0x00, 0x00],
            sel_res: 0x7A,
            uid: vec![0x01, 0x02, 0x03, 0x04],
        });
        assert!(!info.supported);
        assert_eq!(info.kind, CardKind::Unknown);
        assert!(info.detail.unwrap().contains("0x7A"));
    }

    #[test]
    fn a_syntax_error_frame_is_described_without_inventing_a_status() {
        let message = describe_error_frame(None);
        assert!(message.contains("语法错误帧"));
        let detailed = describe_error_frame(Some(0x27));
        assert!(detailed.contains("0x27"));
    }

    fn hardware_test_path(path: &str) -> std::path::PathBuf {
        let path = std::path::Path::new(path);
        if path.is_absolute() {
            return path.to_path_buf();
        }
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(path)
    }

    /// End-to-end check against real hardware, ignored by default because it
    /// needs a reader and a card on a real port:
    ///
    /// ```text
    /// NFC_TEST_PORT=COM3 cargo test --lib -- --ignored --nocapture reads_a_real_card
    /// ```
    ///
    /// This is the only test that exercises the serial timing, the ACK/resend
    /// loop and the card halt/re-selection behaviour together, so it is worth
    /// running by hand after any change to the RF path.
    #[test]
    #[ignore = "需要真实读卡器与卡片：设置 NFC_TEST_PORT 后加 --ignored 运行"]
    fn reads_a_real_card() {
        let port_name = std::env::var("NFC_TEST_PORT").expect("请设置 NFC_TEST_PORT（例如 COM3）");
        let port = serialport::new(&port_name, BAUD_RATE)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(PORT_TIMEOUT)
            .open()
            .expect("无法打开串口");
        let mut link = Link::new(port, Arc::new(AtomicBool::new(false)));

        let firmware = link.wake_and_configure().expect("PN532 握手失败");
        println!(
            "固件 {}.{} IC 0x{:02X}",
            firmware.version, firmware.revision, firmware.ic
        );
        assert!(firmware.is_pn532(), "IC 字节不是 0x32");

        let options = std::env::var("NFC_TEST_READ_OPTIONS")
            .ok()
            .map(|text| serde_json::from_str::<ReadOptions>(&text).expect("读取选项 JSON 无效"))
            .unwrap_or_default();
        let dump = link
            .read_card(&options, |progress| println!("{}", progress.message))
            .expect("读取失败");
        let read = dump.units.iter().filter(|unit| unit.data.is_some()).count();
        println!(
            "卡型 {}，UID {}，ATQA {}，SAK {:02X}，读出 {}/{} 块",
            dump.label,
            dump.uid,
            dump.atqa,
            dump.sak,
            read,
            dump.units.len()
        );
        println!(
            "已知 Key A：{}，已知 Key B：{}",
            dump.sectors
                .iter()
                .filter(|sector| sector.key_a.is_some())
                .count(),
            dump.sectors
                .iter()
                .filter(|sector| sector.key_b.is_some())
                .count()
        );
        for warning in &dump.warnings {
            println!("提示: {warning}");
        }
        if let Ok(path) = std::env::var("NFC_TEST_DUMP_PATH") {
            let mut options = std::fs::OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let file = options
                .open(hardware_test_path(&path))
                .expect("无法新建备份文件（不会覆盖已有文件）");
            serde_json::to_writer_pretty(file, &dump).expect("保存备份失败");
            println!("备份已保存到 {path}");
        }
        assert!(read > 0, "已识别卡片，但所有扇区均需提供正确密钥");
        if std::env::var("NFC_TEST_REQUIRE_COMPLETE").as_deref() == Ok("1") {
            assert_eq!(read, dump.units.len(), "备份仍有缺失数据");
            assert!(
                dump.sectors
                    .iter()
                    .all(|sector| sector.key_a.is_some() && sector.key_b.is_some()),
                "备份仍有未知密钥"
            );
        }
    }

    #[test]
    #[ignore = "需要 NFC_TEST_PORT；只读检查射频寻卡，不修改卡片"]
    fn diagnoses_a_real_reader() {
        let port_name = std::env::var("NFC_TEST_PORT").expect("请设置 NFC_TEST_PORT");
        let port = serialport::new(&port_name, BAUD_RATE)
            .timeout(PORT_TIMEOUT)
            .open()
            .unwrap();
        let mut link = Link::new(port, Arc::new(AtomicBool::new(false)));
        println!("Firmware: {:?}", link.wake_and_configure().unwrap());
        link.transact(&[0x32, 5, 2, 1, 5], CONTROL_TIMEOUT).unwrap();
        link.transact(&[0x32, 1, 1], CONTROL_TIMEOUT).unwrap();
        println!(
            "General status: {:02X?}",
            link.transact(&[4], CONTROL_TIMEOUT).unwrap()
        );
        println!(
            "RF registers (TxControl/TxAuto/RFCfg): {:02X?}",
            link.transact(&[6, 0x63, 4, 0x63, 5, 0x63, 0x16], CONTROL_TIMEOUT)
                .unwrap()
        );
        let mut found = 0;
        for index in 0..10 {
            let result = link.list_passive_target().unwrap();
            println!("Scan {}: {:?}", index + 1, result);
            if let Some(target) = result {
                found += 1;
                link.release_target(target.target);
            }
        }
        link.transact(&[0x32, 5, 2, 1, 1], CONTROL_TIMEOUT).unwrap();
        println!("Detected {found}/10 scans");
    }

    /// Reversible integration test for an explicitly selected blank replacement.
    /// Saves the temporary data/keys before writing, attempts restoration even
    /// after a write error, and compares the entire final dump with the baseline.
    #[test]
    #[ignore = "会写入并恢复指定空白目标卡；需要 NFC_TEST_TARGET_BACKUP、NFC_TEST_WRITE_UID、NFC_TEST_PATTERN_PATH"]
    fn round_trips_a_blank_replacement_card() {
        let port_name = std::env::var("NFC_TEST_PORT").expect("请设置 NFC_TEST_PORT");
        let expected_uid = std::env::var("NFC_TEST_WRITE_UID").expect("请指定目标 UID");
        let backup_path =
            std::env::var("NFC_TEST_TARGET_BACKUP").expect("请提供已确认的空白目标卡备份");
        let pattern_path = std::env::var("NFC_TEST_PATTERN_PATH").expect("请指定测试数据备份路径");
        let baseline: CardDump = serde_json::from_reader(
            std::fs::File::open(hardware_test_path(&backup_path)).expect("目标备份不存在"),
        )
        .expect("目标备份格式无效");
        assert!(
            baseline.uid.eq_ignore_ascii_case(&expected_uid),
            "备份不是指定目标"
        );
        assert_eq!(
            baseline.kind,
            CardKind::Classic1K,
            "此测试只针对 Classic 1K 空白目标"
        );
        let mut options: WriteOptions = serde_json::from_str(
            r#"{"writeManufacturerBlock":false,"allowSameUid":true,"writeTrailers":true,"verify":true}"#,
        ).unwrap();
        options.expected_target_uid = Some(expected_uid.clone());
        validate_write_dump(&baseline, &options).expect("目标备份无效");
        assert!(
            baseline.units.iter().all(|unit| unit.data.is_some()),
            "目标备份不完整"
        );
        assert!(
            baseline
                .units
                .iter()
                .filter(|unit| !unit.is_trailer && unit.index != 0)
                .all(|unit| unit.data.as_deref() == Some("00000000000000000000000000000000")),
            "此测试只允许已备份的空白卡"
        );
        assert!(
            baseline.sectors.iter().all(|sector| {
                sector.key_a.as_deref() == Some("FFFFFFFFFFFF")
                    && sector.key_b.as_deref() == Some("FFFFFFFFFFFF")
                    && baseline
                        .unit(sector.trailer_block)
                        .is_some_and(|bytes| bytes[6..9] == [0xFF, 7, 0x80])
            }),
            "此测试要求目标仍为出厂密钥和传输权限"
        );
        let port = serialport::new(&port_name, BAUD_RATE)
            .timeout(PORT_TIMEOUT)
            .open()
            .expect("无法打开串口");
        let mut link = Link::new(port, Arc::new(AtomicBool::new(false)));
        link.wake_and_configure().expect("握手失败");
        let before = link
            .read_card(&ReadOptions::default(), |_| {})
            .expect("测试前读取失败");
        assert_card_contents_equal(&baseline, &before);

        let mut pattern = baseline.clone();
        for unit in &mut pattern.units {
            if unit.index != 0 && !unit.is_trailer {
                let mut bytes = *b"WL1 NFC TEST----";
                bytes[12] = unit.index as u8;
                bytes[13] = !bytes[12];
                bytes[14] = 0x5A;
                bytes[15] = 0xA5;
                unit.data = Some(mifare::format_hex(&bytes));
            }
        }
        // Change one Key A and the readable Key B data, preserving all access
        // bits. This exercises real trailer reconstruction and reauthentication.
        let probe_a = "A1B2C3D4E5F6";
        let probe_b = "102030405060";
        pattern.sectors[15].key_a = Some(probe_a.into());
        pattern.sectors[15].key_b = Some(probe_b.into());
        let mut trailer = pattern.unit(63).unwrap();
        trailer[10..].copy_from_slice(&mifare::parse_key(probe_b).unwrap());
        pattern.units[63].data = Some(mifare::format_hex(&trailer));
        let mut file_options = std::fs::OpenOptions::new();
        file_options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            file_options.mode(0o600);
        }
        let file = file_options
            .open(hardware_test_path(&pattern_path))
            .expect("无法保存测试数据（不会覆盖已有文件）");
        serde_json::to_writer_pretty(file, &pattern).expect("测试数据备份失败");
        println!("目标已确认，测试数据与恢复密钥已保存；开始写入 47 个数据块和 16 个尾块");
        let exercise = link.write_card(&pattern, &options, |progress| {
            println!("测试：{}", progress.message)
        });
        println!("TEST_REPORT: {}", serde_json::to_string(&exercise).unwrap());
        // Never assert on the write result before restoring the card.
        options.target_keys = vec![probe_a.into(), "FFFFFFFFFFFF".into()];
        let restore = link.write_card(&baseline, &options, |progress| {
            println!("恢复：{}", progress.message)
        });
        println!(
            "RESTORE_REPORT: {}",
            serde_json::to_string(&restore).unwrap()
        );
        let after = link.read_card(&ReadOptions::default(), |_| {});
        let restore =
            restore.expect("恢复失败；使用保留的目标备份与测试 Key A 恢复，不要把测试数据用于门禁");
        assert!(restore.verified, "恢复后仍有块未通过校验");
        assert_eq!(restore.blocks_written, 63);
        assert_card_contents_equal(&baseline, &after.expect("恢复后整卡读取失败"));
        println!("RESTORED: 64/64 块、全部扇区密钥和 UID 与测试前一致");
        let exercise = exercise.expect("写入试验失败（空白卡已经恢复）");
        assert!(exercise.verified, "测试数据或密钥未全部写入并通过校验");
        assert_eq!(exercise.blocks_written, 63);
        assert_eq!(exercise.blocks_verified, 63);
        assert_eq!(exercise.blocks_failed, 0);
    }

    fn assert_card_contents_equal(expected: &CardDump, actual: &CardDump) {
        assert_eq!(actual.uid, expected.uid, "目标 UID 发生变化");
        assert_eq!(actual.atqa, expected.atqa);
        assert_eq!(actual.sak, expected.sak);
        assert_eq!(actual.kind, expected.kind);
        assert_eq!(actual.units.len(), expected.units.len());
        for unit in &expected.units {
            assert_eq!(
                actual.unit(unit.index),
                expected.unit(unit.index),
                "块 {} 与备份不同",
                unit.index
            );
        }
        assert_eq!(actual.sectors.len(), expected.sectors.len());
        for sector in &expected.sectors {
            let actual = actual
                .sectors
                .iter()
                .find(|entry| entry.index == sector.index)
                .expect("缺少扇区");
            assert_eq!(
                actual.key_a, sector.key_a,
                "扇区 {} Key A 不同",
                sector.index
            );
            assert_eq!(
                actual.key_b, sector.key_b,
                "扇区 {} Key B 不同",
                sector.index
            );
        }
    }

    /// Explicit replacement-card test. Never reads a card and writes its own
    /// dump back implicitly: the operator supplies a saved source and target UID.
    #[test]
    #[ignore = "需要原卡备份 NFC_TEST_SOURCE_PATH 与目标 NFC_TEST_WRITE_UID；会写入目标卡"]
    fn writes_a_real_card() {
        let port_name = std::env::var("NFC_TEST_PORT").expect("请设置 NFC_TEST_PORT");
        let path = std::env::var("NFC_TEST_SOURCE_PATH").expect("请设置原卡备份路径");
        let expected_uid = std::env::var("NFC_TEST_WRITE_UID").expect("请明确设置待写目标 UID");
        let dump: CardDump = serde_json::from_reader(
            std::fs::File::open(hardware_test_path(&path)).expect("备份不存在"),
        )
        .expect("备份格式错误");
        let mut options: WriteOptions = serde_json::from_str(
            &std::env::var("NFC_TEST_WRITE_OPTIONS").unwrap_or_else(|_| "{}".into()),
        )
        .expect("写入选项无效");
        options.expected_target_uid = Some(expected_uid.clone());
        validate_write_dump(&dump, &options).expect("备份不可写入");
        let port = serialport::new(&port_name, BAUD_RATE)
            .timeout(PORT_TIMEOUT)
            .open()
            .expect("无法打开串口");
        let mut link = Link::new(port, Arc::new(AtomicBool::new(false)));
        link.wake_and_configure().expect("PN532 握手失败");
        let target = link
            .scan(Instant::now() + Duration::from_secs(30))
            .expect("未找到目标卡");
        assert!(
            mifare::format_hex(&target.uid).eq_ignore_ascii_case(&expected_uid),
            "当前卡不是指定目标"
        );
        // Keep the expected identity pinned through the second activation.
        link.release_target(target.target);
        let actual = link
            .scan(Instant::now() + Duration::from_secs(2))
            .expect("目标卡离场");
        assert_eq!(actual.uid, target.uid);
        let report = link
            .write_card(&dump, &options, |progress| println!("{}", progress.message))
            .expect("写入失败");
        println!("{}", serde_json::to_string_pretty(&report).unwrap());
        assert!(report.blocks_written > 0, "没有块写入成功");
        assert_eq!(report.blocks_failed, 0);
        assert!(report.verified, "已写块未全部通过验证");
    }

    #[test]
    fn trailer_gets_the_confirmed_key_a_not_the_placeholder() {
        // The card returned six zero bytes where Key A should be, but
        // authentication proved the real key is FFFFFFFFFFFF.
        let mut source = [0_u8; 16];
        source[6..10].copy_from_slice(&[0xFF, 0x07, 0x80, 0x69]);
        source[10..16].copy_from_slice(&[0xFF; 6]);

        let trailer = prepare_trailer(&source, Some("FFFFFFFFFFFF"), None).unwrap();
        assert_eq!(&trailer[..6], &[0xFF; 6], "必须写入已确认的 Key A");
        assert_ne!(&trailer[..6], &[0x00; 6], "绝不能写入占位零字节");
        // Everything after Key A is copied through unchanged.
        assert_eq!(&trailer[6..], &source[6..]);
    }

    #[test]
    fn a_genuine_all_zero_key_a_is_written_as_zero() {
        // When the real Key A *is* 000000000000, the zeros are the key and must
        // survive. The rule is "write what was confirmed", not "never write
        // zeros".
        let mut source = [0_u8; 16];
        source[6..10].copy_from_slice(&[0xFF, 0x07, 0x80, 0x69]);
        source[10..16].copy_from_slice(&[0xFF; 6]);

        let trailer = prepare_trailer(&source, Some("000000000000"), None).unwrap();
        assert_eq!(&trailer[..6], &[0x00; 6]);
        assert_eq!(&trailer[10..16], &[0xFF; 6], "Key B 应原样保留");
    }

    #[test]
    fn an_unknown_key_a_refuses_to_produce_a_trailer() {
        let source = [0_u8; 16];
        assert!(prepare_trailer(&source, None, None).is_none());
        // A malformed key is as unusable as a missing one.
        assert!(prepare_trailer(&source, Some("ZZZZ"), None).is_none());
        assert!(prepare_trailer(&source, Some(""), None).is_none());
    }

    #[test]
    fn stale_disconnect_cannot_close_a_replacement_session() {
        let state = NfcState::default();
        {
            let mut guard = state.session_guard().unwrap();
            *guard = Some(NfcSession {
                session_id: 8,
                label: "TEST".into(),
                connected_at: 0,
                firmware: FirmwareVersion {
                    ic: 0x32,
                    version: 1,
                    revision: 6,
                    support: 0x07,
                },
                alive: Arc::new(AtomicBool::new(true)),
                stop: Arc::new(AtomicBool::new(false)),
                cancel: Arc::new(AtomicBool::new(false)),
                jobs: mpsc::channel().0,
                thread: None,
            });
        }
        state.disconnect(Some(7)).unwrap();
        assert_eq!(state.snapshot().unwrap().session_id, Some(8));
        state.disconnect(Some(8)).unwrap();
        assert_eq!(state.snapshot().unwrap().mode, NfcMode::Disconnected);
        assert_eq!(state.snapshot().unwrap().session_id, None);
    }

    #[test]
    fn operations_reject_a_missing_session_instead_of_blocking() {
        let state = NfcState::default();
        assert!(state.handle().is_err());
        assert!(state.cancel().is_err());
        assert!(state.snapshot().unwrap().session_id.is_none());
    }

    #[test]
    fn busy_flag_serialises_card_operations() {
        let busy = AtomicBool::new(false);
        let handle = SessionHandle {
            session_id: 1,
            jobs: mpsc::channel().0,
            cancel: Arc::new(AtomicBool::new(true)),
        };
        let first = run_busy(&busy, &handle, || Ok(1)).unwrap();
        assert_eq!(first, 1);
        // The flag is cleared afterwards, so the next operation is admitted.
        assert!(!busy.load(Ordering::Acquire));
        // A nested call is refused while the outer one holds the flag.
        let nested = run_busy(&busy, &handle, || {
            assert!(run_busy(&busy, &handle, || Ok(()))
                .unwrap_err()
                .contains("正在进行"));
            Ok(2)
        });
        assert_eq!(nested.unwrap(), 2);
        assert!(
            !handle.cancel.load(Ordering::Acquire),
            "新操作应清除旧的取消标志"
        );
    }

    #[test]
    fn event_serialization_matches_the_frontend_contract() {
        let event = NfcEvent {
            session_id: 3,
            timestamp: 99,
            kind: "progress",
            progress: Some(Progress {
                phase: "read",
                current: 2,
                total: 16,
                message: "读取扇区 3 / 16".into(),
            }),
            reason: None,
        };
        assert_eq!(
            serde_json::to_value(event).unwrap(),
            serde_json::json!({
                "sessionId": 3,
                "timestamp": 99,
                "kind": "progress",
                "progress": { "phase": "read", "current": 2, "total": 16, "message": "读取扇区 3 / 16" }
            })
        );

        let closed = NfcEvent {
            session_id: 3,
            timestamp: 100,
            kind: "disconnected",
            progress: None,
            reason: Some("拔出".into()),
        };
        assert_eq!(
            serde_json::to_value(closed).unwrap(),
            serde_json::json!({
                "sessionId": 3,
                "timestamp": 100,
                "kind": "disconnected",
                "reason": "拔出"
            })
        );
    }

    #[test]
    fn write_options_default_to_verifying_and_excluding_the_uid_block() {
        let options: WriteOptions = serde_json::from_str("{}").unwrap();
        assert!(!options.write_manufacturer_block);
        assert!(options.write_trailers);
        assert!(options.verify);
        assert!(options.sectors.is_empty());
    }

    #[test]
    fn card_info_reports_ultralight_as_supported_with_a_caveat() {
        let info = CardInfo::from_target(&PassiveTarget {
            target: 1,
            sens_res: [0x44, 0x00],
            sel_res: 0x00,
            uid: vec![0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66],
        });
        assert!(info.supported);
        assert_eq!(info.kind, CardKind::Ultralight);
        assert!(info.detail.unwrap().contains("NTAG"));
    }
}

#[cfg(all(test, unix))]
#[path = "nfc_protocol_tests.rs"]
mod protocol_tests;
