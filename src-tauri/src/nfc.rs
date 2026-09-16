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
                Some("按 4 字节页读取；NTAG 的配置页受锁定位保护，可能无法写入".into()),
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
    /// UID ("magic") cards accept it. Off unless the operator opts in.
    #[serde(default)]
    pub write_manufacturer_block: bool,
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
            Err(RecvTimeoutError::Timeout) => Err("NFC 操作等待超时".into()),
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
        let busy = Arc::clone(&self.inner.busy);

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
                    worker_loop(
                        session_id,
                        receiver,
                        port,
                        Arc::clone(&cancel),
                        &stop,
                        &busy,
                        &app,
                    );
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
    busy: &AtomicBool,
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
        busy.store(false, Ordering::Release);
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
        self.transact_with_preamble(command, timeout, 0)
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
                    return self.await_response(timeout);
                }
                Ok(Pn532Frame::Error(code)) => {
                    return Err(describe_error_frame(code));
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
    fn await_response(&mut self, timeout: Duration) -> Result<Vec<u8>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            match self.next_frame(deadline)? {
                Pn532Frame::Response(body) => {
                    return match body.split_first() {
                        Some((&pn532::CHIP_TFI, rest)) => Ok(rest.to_vec()),
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
        let Some(next) = self.list_passive_target()? else {
            return Err("卡片已离开射频场，请重新放卡后重试".into());
        };
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
        let Some(prefix) = target.uid.get(..4) else {
            return Err("卡片 UID 少于 4 字节，无法进行 MIFARE 认证".into());
        };
        let mut data = Vec::with_capacity(12);
        data.push(if key_b { 0x61 } else { 0x60 });
        data.push(block);
        data.extend_from_slice(key);
        data.extend_from_slice(prefix);
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
        let started = Instant::now();
        // Card-removal strikes are per operation; a previous run's timeouts
        // must not shorten this one.
        self.strikes = 0;
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
            self.read_ultralight(&target, &mut progress)?
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
        let units_per_sector = |sector: &mifare::Sector| usize::from(sector.block_count);
        let total_units: usize = sectors.iter().map(units_per_sector).sum();

        let mut extra_keys = Vec::new();
        for text in &options.extra_keys {
            extra_keys.push(mifare::parse_key(text)?);
        }

        let mut units: Vec<Option<[u8; mifare::BLOCK_BYTES]>> = vec![None; total_units];
        let mut sector_dumps = Vec::with_capacity(sectors.len());
        // Keys confirmed by a successful authentication, shared across sectors
        // because a card almost always reuses one key set.
        let mut confirmed: Vec<([u8; KEY_BYTES], bool)> = Vec::new();
        let mut unresolved = 0_u8;

        for sector in &sectors {
            progress(Progress {
                phase: "read",
                current: u32::from(sector.index),
                total: u32::from(kind_sector_count(kind)),
                message: format!(
                    "读取扇区 {} / {}",
                    sector.index + 1,
                    kind_sector_count(kind)
                ),
            });

            let override_key = match options
                .sector_keys
                .iter()
                .find(|entry| entry.sector == sector.index)
            {
                Some(entry) => Some((mifare::parse_key(&entry.key)?, entry.key_b)),
                None => None,
            };

            let trailer = sector.trailer_block() as u8;
            let candidates = sector_key_candidates(&confirmed, &extra_keys, override_key);

            let mut opened = None;
            for (key, key_b, source) in candidates {
                if self.authenticate(target, trailer, &key, key_b)? {
                    opened = Some((key, key_b, source));
                    break;
                }
            }

            let Some((key, key_b, source)) = opened else {
                unresolved = unresolved.saturating_add(1);
                for block in sector.blocks() {
                    let slot = unit_slot(&sectors, block);
                    if let Some(slot) = slot {
                        units[slot] = None;
                    }
                }
                sector_dumps.push(SectorDump {
                    index: sector.index,
                    first_block: sector.first_block,
                    block_count: sector.block_count,
                    trailer_block: sector.trailer_block(),
                    key_a: None,
                    key_b: None,
                    key_source: KeySource::None,
                    resolved: false,
                    access_summary: None,
                    message: Some("字典与已知密钥均无法认证该扇区".into()),
                });
                continue;
            };

            confirmed.push((key, key_b));

            let mut failures = Vec::new();
            for block in sector.blocks() {
                let Some(slot) = unit_slot(&sectors, block) else {
                    continue;
                };
                match self.read_block(target, block as u8)? {
                    Some(data) => units[slot] = Some(data),
                    None => failures.push(block),
                }
            }

            let trailer_data =
                unit_slot(&sectors, sector.trailer_block()).and_then(|slot| units[slot]);
            let (key_a_hex, key_b_hex, key_b_source) =
                self.resolve_trailer_keys(target, sector, trailer_data, &key, key_b, source)?;

            let access_summary = trailer_data
                .and_then(|data| mifare::decode_access_bits(&data))
                .map(|bits| bits.summary());

            sector_dumps.push(SectorDump {
                index: sector.index,
                first_block: sector.first_block,
                block_count: sector.block_count,
                trailer_block: sector.trailer_block(),
                key_a: key_a_hex,
                key_b: key_b_hex,
                key_source: key_b_source,
                resolved: true,
                access_summary,
                message: if failures.is_empty() {
                    None
                } else {
                    Some(format!("{} 个块读取失败（权限位限制）", failures.len()))
                },
            });
        }

        let unresolved_sectors = unresolved;
        let hidden_key_a: Vec<u8> = sector_dumps
            .iter()
            .filter(|sector| sector.resolved && sector.key_a.is_none())
            .map(|sector| sector.index)
            .collect();
        let mut warnings = Vec::new();
        if !hidden_key_a.is_empty() {
            // Worth surfacing up front: these are the sectors whose trailers a
            // clone cannot reproduce, and the operator may know the key and want
            // to enter it before making a copy.
            warnings.push(format!(
                "{} 个扇区的 Key A 无法读出（MIFARE 规定不回读 Key A）：扇区 {}。\
                 复制时这些扇区会保留目标卡原有的 Key A",
                hidden_key_a.len(),
                hidden_key_a
                    .iter()
                    .map(u8::to_string)
                    .collect::<Vec<_>>()
                    .join("、")
            ));
        }
        let units = units
            .into_iter()
            .enumerate()
            .map(|(index, data)| DataUnit {
                index: index as u16,
                sector: sector_of_block(&sectors, index as u16),
                data: data.map(|bytes| mifare::format_hex(&bytes)),
                error: data.is_none().then(|| "未读取".to_owned()),
                is_trailer: is_trailer(&sectors, index as u16),
                is_manufacturer: index == 0,
            })
            .collect();

        Ok(CardDump {
            uid: String::new(),
            atqa: String::new(),
            sak: 0,
            kind,
            label: kind.label().to_owned(),
            unit_size: mifare::BLOCK_BYTES as u8,
            units,
            sectors: sector_dumps,
            read_at: 0,
            duration_ms: 0,
            unresolved_sectors,
            warnings,
        })
    }

    // Key selection for one sector lives in a free function so it can be tested
    // without a port attached.

    /// Turns the bytes read out of a sector trailer into key values.
    ///
    /// Two rules matter here, and both were established against hardware:
    ///
    /// 1. A key is only recorded once the card has authenticated with it. The
    ///    dump must never carry a key inferred from an access-bit layout.
    /// 2. **The trailer's Key A field is not the sector's Key A.** Under the
    ///    usual `FF 07 80` access bits a MIFARE Classic card refuses to disclose
    ///    Key A and returns six zero bytes in its place on every read. The real
    ///    Key A is only knowable by having authenticated with it.
    ///
    /// So when the sector was opened with Key B, Key A stays `None` rather than
    /// being guessed from the zeros or mislabelled with the Key B value. The
    /// writer treats an unknown Key A by preserving the target card's own.
    fn resolve_trailer_keys(
        &mut self,
        target: &mut PassiveTarget,
        sector: &mifare::Sector,
        trailer: Option<[u8; mifare::BLOCK_BYTES]>,
        working_key: &[u8; KEY_BYTES],
        working_is_b: bool,
        source: KeySource,
    ) -> Result<(Option<String>, Option<String>, KeySource), String> {
        let Some(trailer) = trailer else {
            return Ok((None, None, source));
        };
        let mut key_a = None;
        let mut key_b = None;
        let trailer_block = sector.trailer_block() as u8;

        let a_bytes: [u8; KEY_BYTES] = trailer[0..KEY_BYTES].try_into().unwrap_or([0; KEY_BYTES]);
        let b_bytes: [u8; KEY_BYTES] = trailer[10..16].try_into().unwrap_or([0; KEY_BYTES]);

        // The key that opened the sector is known to be valid for its type.
        if working_is_b {
            key_b = Some(mifare::format_key(working_key));
        } else {
            key_a = Some(mifare::format_key(working_key));
        }

        // Probe the trailer's Key A field, which succeeds only on cards that do
        // disclose it (or when the real Key A really is all zeros).
        if key_a.is_none() && self.authenticate(target, trailer_block, &a_bytes, false)? {
            key_a = Some(mifare::format_key(&a_bytes));
        }
        // Key B *is* disclosed, but is still confirmed rather than trusted: it
        // is the value a clone writes back, so a wrong one breaks the copy.
        if key_b.is_none() && self.authenticate(target, trailer_block, &b_bytes, true)? {
            key_b = Some(mifare::format_key(&b_bytes));
        }
        Ok((key_a, key_b, source))
    }

    fn read_ultralight(
        &mut self,
        target: &PassiveTarget,
        progress: &mut impl FnMut(Progress),
    ) -> Result<CardDump, String> {
        let mut pages: Vec<Option<[u8; 4]>> = Vec::new();
        let mut page = 0_u8;
        let mut consecutive_misses = 0_u32;
        while page <= mifare::MAX_ULTRALIGHT_PAGE {
            progress(Progress {
                phase: "read",
                current: u32::from(page),
                total: u32::from(mifare::MAX_ULTRALIGHT_PAGE),
                message: format!("读取第 {page} 页…"),
            });
            let response = self.transact(
                &pn532::in_data_exchange_command(target.target, &[0x30, page]),
                RF_TIMEOUT,
            )?;
            let (status, data) = pn532::parse_data_exchange(&response)?;
            if status != 0x00 || data.len() < 4 {
                // Past the last page the card stops answering; that is the end
                // of the tag, not an error.
                consecutive_misses += 1;
                if consecutive_misses >= 2 {
                    break;
                }
                page = page.saturating_add(4);
                continue;
            }
            consecutive_misses = 0;
            for chunk in data.chunks_exact(4) {
                pages.push(Some(chunk.try_into().unwrap_or([0; 4])));
            }
            page = page.saturating_add(4);
        }
        if pages.is_empty() {
            return Err("未能读取到任何页，卡片可能已离开射频场".into());
        }

        let units = pages
            .into_iter()
            .enumerate()
            .map(|(index, data)| DataUnit {
                index: index as u16,
                sector: 0,
                data: data.map(|bytes| mifare::format_hex(&bytes)),
                error: data.is_none().then(|| "未读取".to_owned()),
                is_trailer: false,
                is_manufacturer: index < 3,
            })
            .collect();

        Ok(CardDump {
            uid: String::new(),
            atqa: String::new(),
            sak: 0,
            kind: CardKind::Ultralight,
            label: CardKind::Ultralight.label().to_owned(),
            unit_size: 4,
            units,
            sectors: Vec::new(),
            read_at: 0,
            duration_ms: 0,
            unresolved_sectors: 0,
            warnings: vec![
                "Ultralight / NTAG 的备份无法写回已经锁定的配置页；写入前请确认目标卡未被锁定"
                    .into(),
            ],
        })
    }

    fn write_card(
        &mut self,
        dump: &CardDump,
        options: &WriteOptions,
        mut progress: impl FnMut(Progress),
    ) -> Result<WriteReport, String> {
        let started = Instant::now();
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

        let mut target_keys = Vec::new();
        for text in &options.target_keys {
            target_keys.push(mifare::parse_key(text)?);
        }
        for text in dump
            .sectors
            .iter()
            .filter_map(|sector| sector.key_a.as_deref())
        {
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
            self.write_ultralight(&target, dump, &mut warnings, &mut progress)?
        };
        report.duration_ms = started.elapsed().as_millis() as u64;
        report.uid = target_info.uid;
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
        let selected: Vec<&mifare::Sector> = sectors
            .iter()
            .filter(|sector| options.sectors.is_empty() || options.sectors.contains(&sector.index))
            .collect();

        let mut blocks_written = 0_u32;
        let mut blocks_failed = 0_u32;
        let mut blocks_skipped = 0_u32;
        let mut sectors_written = 0_u32;
        let mut failures = Vec::new();
        let mut skips = Vec::new();
        let mut manufacturer_result = None;
        // Keys proven on the target, reused across sectors.
        let mut confirmed: Vec<[u8; KEY_BYTES]> = Vec::new();
        // Which key opened each sector on the target. Verification needs it
        // whenever the trailer was left alone, because then the card still
        // carries its own keys and the dump's keys will not authenticate.
        let mut opened_with: Vec<(u8, [u8; KEY_BYTES], bool)> = Vec::new();

        for sector in &selected {
            progress(Progress {
                phase: "write",
                current: u32::from(sector.index),
                total: selected.len() as u32,
                message: format!("写入扇区 {}", sector.index),
            });

            // A sector the source card would not give up has nothing to write.
            let Some(dump_sector) = dump
                .sectors
                .iter()
                .find(|entry| entry.index == sector.index && entry.resolved)
            else {
                continue;
            };

            let trailer_block = sector.trailer_block() as u8;
            // The target's *current* key opens the sector; the dump's key is
            // what gets written into the trailer afterwards.
            let mut candidates: Vec<[u8; KEY_BYTES]> = Vec::new();
            for key in &confirmed {
                candidates.push(*key);
            }
            for key in target_keys {
                candidates.push(*key);
            }
            for key in mifare::DEFAULT_KEYS {
                candidates.push(key);
            }
            // Key A and Key B are tried separately so the sector's actual key
            // type is known; verification has to re-authenticate the same way.
            let mut opened = None;
            for key in candidates {
                if self.authenticate(target, trailer_block, &key, false)? {
                    opened = Some((key, false));
                    break;
                }
                if self.authenticate(target, trailer_block, &key, true)? {
                    opened = Some((key, true));
                    break;
                }
            }
            let Some((open_key, open_is_b)) = opened else {
                blocks_failed += u32::from(sector.block_count);
                failures.push(format!(
                    "扇区 {}：目标卡认证失败，无法写入（请提供该卡当前的密钥）",
                    sector.index
                ));
                continue;
            };
            confirmed.push(open_key);
            opened_with.push((sector.index, open_key, open_is_b));

            for block in sector.data_blocks() {
                let Some(source) = dump.unit(block) else {
                    continue;
                };
                if block == 0 && !options.write_manufacturer_block {
                    if manufacturer_result.is_none() {
                        manufacturer_result = Some(false);
                        warnings.push(
                            "已跳过第 0 块（厂商块/UID）。原厂卡拒绝改写该块；如需完整克隆请改用 UID 卡并开启该选项"
                                .into(),
                        );
                    }
                    continue;
                }
                if block == 0 {
                    // Block 0 is `UID BCC SAK ATQA manufacturer`. The BCC is the
                    // XOR of the four UID bytes, and a clone that carries a
                    // wrong one will not be recognised by a reader, so a
                    // mismatch is surfaced before the write rather than after.
                    if mifare::manufacturer_bcc_is_valid(&source) == Some(false) {
                        warnings.push(
                            "第 0 块的 BCC 校验字节与 UID 不匹配，写回后多数读卡器将无法识别；请确认备份来源"
                                .into(),
                        );
                    }
                }
                match self.write_block(target, block as u8, &source) {
                    Ok(true) => {
                        blocks_written += 1;
                        if block == 0 {
                            manufacturer_result = Some(true);
                        }
                    }
                    Ok(false) => {
                        blocks_failed += 1;
                        if block == 0 {
                            // A refused manufacturer block is the expected
                            // outcome on a genuine card, so it is reported as a
                            // finding rather than as a generic write failure.
                            manufacturer_result = Some(false);
                            warnings.push(
                                "第 0 块（厂商块/UID）写入被卡片拒绝：这是原厂卡的正常行为，UID 无法改写"
                                    .into(),
                            );
                            continue;
                        }
                        failures.push(format!("块 {block} 写入未确认"));
                    }
                    Err(error) => return Err(error),
                }
            }

            // The trailer goes last: writing it swaps the sector's keys, so any
            // earlier write would have to re-authenticate with the new values.
            if options.write_trailers {
                let Some(trailer) = dump.unit(sector.trailer_block()) else {
                    continue;
                };
                // A trailer whose access nibbles are not self-complementary was
                // written incorrectly on the source card. Reproducing it can
                // make the sector permanently inaccessible, so it is refused
                // rather than copied.
                if mifare::decode_access_bits(&trailer).is_none() {
                    blocks_failed += 1;
                    failures.push(format!(
                        "扇区 {} 尾块的权限位不自洽，写回会永久锁死该扇区，已跳过",
                        sector.index
                    ));
                    continue;
                }
                // The trailer's Key A field must be replaced, never copied.
                //
                // That field holds six zero bytes on any card that hides Key A,
                // which is the usual case — the dump's own bytes are a
                // placeholder, not the key. Writing them verbatim would give the
                // clone Key A = 000000000000 while the original uses something
                // else, and a lock checking Key A would then reject the clone.
                // The value that is actually known to work is `key_a`, which was
                // confirmed by authenticating, so that is what goes in.
                //
                // When Key A could not be determined at all (the sector was
                // opened with Key B), the trailer cannot be reproduced: skipping
                // it leaves the target's own keys and access bits intact rather
                // than programming a placeholder the original does not have.
                let Some(trailer) = prepare_trailer(&trailer, dump_sector.key_a.as_deref()) else {
                    // A deliberate skip, not an error: the sector's data blocks
                    // were written, and only the keys could not be reproduced.
                    blocks_skipped += 1;
                    skips.push(format!(
                        "扇区 {} 的尾块未写入：原卡不公开它的 Key A（MIFARE 规定不回读 Key A），\
                         无法安全重建尾块，因此保留了目标卡自己的密钥与权限位。\
                         该扇区的数据块已正常写入；若要连密钥一起复制，请在“读取卡片”页填入该扇区的 Key A 后重新备份",
                        sector.index
                    ));
                    continue;
                };
                match self.write_block(target, trailer_block, &trailer) {
                    Ok(true) => blocks_written += 1,
                    Ok(false) => {
                        blocks_failed += 1;
                        failures.push(format!("扇区 {} 尾块写入未确认", sector.index));
                    }
                    Err(error) => return Err(error),
                }
            }
            sectors_written += 1;
        }

        let verified = if options.verify {
            self.verify_classic(target, dump, options, &selected, &opened_with)?
        } else {
            false
        };

        Ok(WriteReport {
            uid: String::new(),
            blocks_written,
            blocks_failed,
            blocks_skipped,
            sectors_written,
            verified,
            manufacturer_block_written: manufacturer_result,
            duration_ms: 0,
            failures,
            skips,
            warnings: Vec::new(),
        })
    }

    /// Reads every written sector back and compares it against the dump.
    ///
    /// `opened_with` records the key that authenticated each sector during the
    /// write. It matters when trailers are left alone: the card then still
    /// carries its own keys, so the dump's Key A would fail and a sector that
    /// was written correctly would be reported as unverifiable.
    fn verify_classic(
        &mut self,
        target: &mut PassiveTarget,
        dump: &CardDump,
        options: &WriteOptions,
        selected: &[&mifare::Sector],
        opened_with: &[(u8, [u8; KEY_BYTES], bool)],
    ) -> Result<bool, String> {
        let mut mismatches = 0_u32;
        for sector in selected {
            let Some(dump_sector) = dump
                .sectors
                .iter()
                .find(|entry| entry.index == sector.index && entry.resolved)
            else {
                continue;
            };
            let trailer_block = sector.trailer_block() as u8;

            let mut keys: Vec<([u8; KEY_BYTES], bool)> = Vec::new();
            // Writing the trailer replaces the sector's keys with the dump's.
            if options.write_trailers {
                if let Some(key) = dump_sector
                    .key_a
                    .as_deref()
                    .and_then(|text| mifare::parse_key(text).ok())
                {
                    keys.push((key, false));
                }
            }
            // Otherwise the key that opened the sector for writing still does.
            if let Some((_, key, key_b)) = opened_with
                .iter()
                .find(|(index, _, _)| *index == sector.index)
            {
                keys.push((*key, *key_b));
            }

            let mut opened = false;
            for (key, key_b) in keys {
                if self.authenticate(target, trailer_block, &key, key_b)? {
                    opened = true;
                    break;
                }
            }
            if !opened {
                // A sector that was written but cannot be re-opened is a
                // verification failure, not a pass.
                mismatches += 1;
                continue;
            }
            for block in sector.blocks() {
                let Some(expected) = dump.unit(block) else {
                    continue;
                };
                if block == 0 && !options.write_manufacturer_block {
                    continue;
                }
                match self.read_block(target, block as u8)? {
                    Some(actual) if actual == expected => {}
                    _ => mismatches += 1,
                }
            }
        }
        Ok(mismatches == 0)
    }

    fn write_ultralight(
        &mut self,
        target: &PassiveTarget,
        dump: &CardDump,
        warnings: &mut Vec<String>,
        progress: &mut impl FnMut(Progress),
    ) -> Result<WriteReport, String> {
        let mut blocks_written = 0_u32;
        let mut blocks_failed = 0_u32;
        let mut failures = Vec::new();
        let total = dump.units.len() as u32;

        for unit in &dump.units {
            let Some(hex) = unit.data.as_deref() else {
                continue;
            };
            let Ok(bytes) = mifare::decode_hex(hex) else {
                continue;
            };
            if bytes.len() != 4 {
                continue;
            }
            // Pages 0-2 hold the UID and lock bytes. They are OTP on most tags,
            // so a failed write there is expected rather than exceptional.
            if unit.index < 3 {
                warnings.push(format!(
                    "第 {} 页属于 UID/锁定字段，多数标签为只读；写入结果以报告为准",
                    unit.index
                ));
            }
            progress(Progress {
                phase: "write",
                current: u32::from(unit.index),
                total,
                message: format!("写入第 {} 页", unit.index),
            });
            let payload = [
                0xA2,
                unit.index as u8,
                bytes[0],
                bytes[1],
                bytes[2],
                bytes[3],
            ];
            let response = self.transact(
                &pn532::in_data_exchange_command(target.target, &payload),
                RF_TIMEOUT,
            )?;
            let (status, _) = pn532::parse_data_exchange(&response)?;
            if status == 0x00 {
                blocks_written += 1;
            } else {
                blocks_failed += 1;
                if unit.index >= 3 {
                    failures.push(format!(
                        "第 {} 页写入失败：{}",
                        unit.index,
                        pn532::status_text(status)
                    ));
                }
            }
        }

        Ok(WriteReport {
            uid: String::new(),
            blocks_written,
            blocks_failed,
            blocks_skipped: 0,
            sectors_written: 0,
            verified: false,
            manufacturer_block_written: None,
            duration_ms: 0,
            failures,
            skips: Vec::new(),
            warnings: Vec::new(),
        })
    }
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
    }
    for key in mifare::DEFAULT_KEYS {
        push(key, false, KeySource::Dictionary);
    }
    for key in mifare::DEFAULT_KEYS {
        push(key, true, KeySource::Dictionary);
    }
    for (key, key_b) in confirmed {
        // A key confirmed as Key A may also be the sector's Key B.
        if !*key_b {
            push(*key, true, KeySource::Harvested);
        }
    }
    candidates
}

/// Builds the sector trailer to programme into the clone, or `None` when it
/// cannot be reproduced safely.
///
/// The trailer's first six bytes are its Key A field, and on any card that
/// hides Key A those bytes read back as six zeros — they are a placeholder, not
/// the key. Copying them verbatim would give the clone
/// `Key A = 000000000000` while the original uses something else, so a lock
/// that authenticates with Key A would reject the copy. The trustworthy value
/// is the key that was *confirmed by authenticating* during the read, so that
/// is what gets written.
///
/// If no Key A was ever confirmed (the sector was opened with Key B), there is
/// nothing to substitute and no way to preserve the target's own key either —
/// its trailer reads as zeros too. Returning `None` lets the caller skip the
/// trailer and keep the target's keys rather than programming a placeholder.
fn prepare_trailer(
    source: &[u8; mifare::BLOCK_BYTES],
    known_key_a: Option<&str>,
) -> Option<[u8; mifare::BLOCK_BYTES]> {
    let key_a = mifare::parse_key(known_key_a?).ok()?;
    let mut trailer = *source;
    trailer[..KEY_BYTES].copy_from_slice(&key_a);
    Some(trailer)
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
        // A key already confirmed as Key B is not re-offered as Key A.
        let candidates = sector_key_candidates(&[([0xAA; 6], true)], &[], None);
        assert!(!candidates
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

        let mut target = link
            .scan(Instant::now() + Duration::from_secs(45))
            .expect("未在 45 秒内找到卡片");
        let uid = mifare::format_hex(&target.uid);
        println!("UID = {uid}");

        let kind = CardKind::from_sak(target.sel_res);
        assert!(
            kind.is_classic(),
            "本测试只覆盖 MIFARE Classic，实际为 {kind:?}"
        );
        let sector_count = mifare::sector_map(kind).len();

        let dump = link
            .read_classic(&mut target, kind, &ReadOptions::default(), &mut |_| {})
            .expect("读取失败");

        let read = dump.units.iter().filter(|unit| unit.data.is_some()).count();
        let resolved = dump.sectors.iter().filter(|sector| sector.resolved).count();
        println!(
            "读出 {read}/{} 块，{resolved}/{sector_count} 个扇区",
            dump.units.len()
        );
        for warning in &dump.warnings {
            println!("提示: {warning}");
        }

        // The whole point of the re-selection fix: a card whose keys are all
        // present must read completely, not stop at the first hard sector.
        assert!(resolved > 0, "没有任何扇区被攻克：话机或接线可能仍有问题");
        assert_eq!(
            read,
            dump.units.len(),
            "有块没读出来，说明扇区密钥或重选逻辑仍有问题"
        );
    }

    /// Exercises `write_card` end to end against real hardware by writing a
    /// card's own freshly-read dump back to it. Ignored by default:
    ///
    /// ```text
    /// NFC_TEST_PORT=COM3 cargo test --lib -- --ignored --nocapture writes_a_real_card
    /// ```
    ///
    /// Only idempotent for a target whose data and keys do not matter, such as
    /// a phone's regenerated virtual card. It does rewrite sector trailers.
    #[test]
    #[ignore = "需要真实读卡器与可写卡片：设置 NFC_TEST_PORT 后加 --ignored 运行"]
    fn writes_a_real_card() {
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
        link.wake_and_configure().expect("PN532 握手失败");

        let mut target = link
            .scan(Instant::now() + Duration::from_secs(30))
            .expect("未找到卡片");
        let kind = CardKind::from_sak(target.sel_res);
        println!("目标 UID = {}", mifare::format_hex(&target.uid));

        let dump = link
            .read_classic(&mut target, kind, &ReadOptions::default(), &mut |_| {})
            .expect("读取失败");
        println!(
            "读出 {}/{} 块，{} 个扇区已攻克",
            dump.units.iter().filter(|u| u.data.is_some()).count(),
            dump.units.len(),
            dump.sectors.iter().filter(|s| s.resolved).count()
        );

        // A fresh scan: the read left the card released. These are the same
        // defaults the frontend sends.
        let options = WriteOptions {
            write_manufacturer_block: false,
            write_trailers: true,
            verify: true,
            sectors: Vec::new(),
            target_keys: Vec::new(),
        };
        let report = link
            .write_card(&dump, &options, &mut |_| {})
            .expect("写入过程本身报错");

        println!(
            "写入 {} 块，失败 {} 块，{} 个扇区，回读校验 {}",
            report.blocks_written,
            report.blocks_failed,
            report.sectors_written,
            if report.verified {
                "通过"
            } else {
                "未通过"
            }
        );
        for warning in &report.warnings {
            println!("提示: {warning}");
        }
        for failure in &report.failures {
            println!("失败项: {failure}");
        }
        assert!(report.blocks_written > 0, "一个块都没写进去");
    }

    #[test]
    fn trailer_gets_the_confirmed_key_a_not_the_placeholder() {
        // The card returned six zero bytes where Key A should be, but
        // authentication proved the real key is FFFFFFFFFFFF.
        let mut source = [0_u8; 16];
        source[6..10].copy_from_slice(&[0xFF, 0x07, 0x80, 0x69]);
        source[10..16].copy_from_slice(&[0xFF; 6]);

        let trailer = prepare_trailer(&source, Some("FFFFFFFFFFFF")).unwrap();
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

        let trailer = prepare_trailer(&source, Some("000000000000")).unwrap();
        assert_eq!(&trailer[..6], &[0x00; 6]);
        assert_eq!(&trailer[10..16], &[0xFF; 6], "Key B 应原样保留");
    }

    #[test]
    fn an_unknown_key_a_refuses_to_produce_a_trailer() {
        let source = [0_u8; 16];
        assert!(prepare_trailer(&source, None).is_none());
        // A malformed key is as unusable as a missing one.
        assert!(prepare_trailer(&source, Some("ZZZZ")).is_none());
        assert!(prepare_trailer(&source, Some("")).is_none());
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
