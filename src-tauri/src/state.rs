use std::collections::BTreeMap;
use std::io::ErrorKind;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use tauri::{AppHandle, Emitter, Manager};

use crate::protocol::{
    validate_motion_target, validate_text_command_for_target, FirmwareUpdate, LegacyAsciiCodec,
    ProtocolCodec, ValidatedCommand, ValidatedMotionCommand,
};
use crate::transport::{SerialTransport, Transport};
use crate::types::{
    ConnectionSnapshot, ConnectionTarget, ConsoleEvent, DisconnectedEvent, MotionTargetRequest,
    SerialConfig, TelemetryFrame,
};

static NEXT_SESSION_ID: AtomicU64 = AtomicU64::new(1);

pub fn unix_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub struct AppState {
    lifecycle: Mutex<()>,
    session: Mutex<Option<DeviceSession>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            lifecycle: Mutex::new(()),
            session: Mutex::new(None),
        }
    }
}

impl AppState {
    pub fn snapshot(&self) -> Result<ConnectionSnapshot, String> {
        let guard = self.session.lock().map_err(|_| "设备会话状态已损坏")?;
        Ok(guard
            .as_ref()
            .map(DeviceSession::snapshot)
            .unwrap_or_default())
    }

    pub fn connect_serial(
        &self,
        app: AppHandle,
        port_name: &str,
        config: &SerialConfig,
    ) -> Result<ConnectionSnapshot, String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "设备会话生命周期锁已损坏")?;
        self.disconnect_current(None)?;
        let transport = Box::new(SerialTransport::open(
            port_name,
            config.baud_rate,
            config.connection_target,
        )?);
        let session = DeviceSession::from_transport(
            app,
            transport,
            "serial",
            Some(config.baud_rate),
            config.allow_unsafe_writes,
            config.connection_target,
        )?;
        let snapshot = session.snapshot();
        *self.session.lock().map_err(|_| "设备会话状态已损坏")? = Some(session);
        Ok(snapshot)
    }

    pub fn connect_ble(
        &self,
        app: AppHandle,
        bluetooth: &crate::bluetooth::BluetoothState,
        device_id: &str,
        writes_unlocked: bool,
    ) -> Result<ConnectionSnapshot, String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "设备会话生命周期锁已损坏")?;
        self.disconnect_current(None)?;
        let transport = Box::new(bluetooth.open(device_id)?);
        let session = DeviceSession::from_transport(
            app,
            transport,
            "ble",
            None,
            writes_unlocked,
            ConnectionTarget::Robot,
        )?;
        let snapshot = session.snapshot();
        *self.session.lock().map_err(|_| "设备会话状态已损坏")? = Some(session);
        Ok(snapshot)
    }

    pub fn connect_mock(&self, app: AppHandle) -> Result<ConnectionSnapshot, String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "设备会话生命周期锁已损坏")?;
        self.disconnect_current(None)?;
        let session = DeviceSession::from_mock(app)?;
        let snapshot = session.snapshot();
        *self.session.lock().map_err(|_| "设备会话状态已损坏")? = Some(session);
        Ok(snapshot)
    }

    pub fn disconnect(&self, expected_session_id: Option<u64>) -> Result<(), String> {
        let _lifecycle = self
            .lifecycle
            .lock()
            .map_err(|_| "设备会话生命周期锁已损坏")?;
        self.disconnect_current(expected_session_id)
    }

    fn disconnect_current(&self, expected_session_id: Option<u64>) -> Result<(), String> {
        let session = {
            let mut guard = self.session.lock().map_err(|_| "设备会话状态已损坏")?;
            if let (Some(expected), Some(current)) = (expected_session_id, guard.as_ref()) {
                if current.session_id != expected {
                    return Ok(());
                }
            }
            guard.take()
        };
        if let Some(mut session) = session {
            session.shutdown();
        }
        Ok(())
    }

    pub fn send_command(
        &self,
        app: &AppHandle,
        command: &str,
        expected_session_id: u64,
    ) -> Result<(), String> {
        let mut guard = self.session.lock().map_err(|_| "设备会话状态已损坏")?;
        let session = guard.as_mut().ok_or("请先连接设备")?;
        session.ensure_session_id(expected_session_id)?;
        let command = session.validate_text_command(command)?;
        if let Err(reason) = session.send_validated_text(&command) {
            emit_disconnected(app, session.session_id, reason.clone());
            schedule_fault_disconnect(app, session.session_id);
            return Err(reason);
        }
        let mock_reply = match &session.writer {
            SessionWriter::Mock(control) => mock_feature_reply(control, &command.text),
            SessionWriter::Serial(_) => None,
        };
        emit_console(app, session.session_id, "tx", command.text);
        if let Some(reply) = mock_reply {
            emit_console(app, session.session_id, "rx", reply);
        }
        Ok(())
    }

    pub fn send_motion(
        &self,
        app: &AppHandle,
        target: &MotionTargetRequest,
        expected_session_id: u64,
    ) -> Result<(), String> {
        let command = validate_motion_target(target)?;
        let mut guard = self.session.lock().map_err(|_| "设备会话状态已损坏")?;
        let session = guard.as_mut().ok_or("请先连接设备")?;
        session.ensure_session_id(expected_session_id)?;
        session.ensure_motion_supported()?;
        if !session.writes_unlocked {
            return Err("真实设备写入仍处于安全锁定；请断开后在连接页确认台架安全条件".into());
        }
        if let Err(reason) = session.send_validated_motion(&command) {
            emit_disconnected(app, session.session_id, reason.clone());
            schedule_fault_disconnect(app, session.session_id);
            return Err(reason);
        }
        emit_console(app, session.session_id, "tx", command.text);
        Ok(())
    }

    pub fn set_telemetry(
        &self,
        app: &AppHandle,
        enabled: bool,
        expected_session_id: u64,
    ) -> Result<(), String> {
        let mut guard = self.session.lock().map_err(|_| "设备会话状态已损坏")?;
        let session = guard.as_mut().ok_or("请先连接设备")?;
        session.ensure_session_id(expected_session_id)?;
        session.ensure_telemetry_supported(enabled)?;
        if let Err(reason) = session.set_telemetry(app, enabled) {
            emit_disconnected(app, session.session_id, reason.clone());
            schedule_fault_disconnect(app, session.session_id);
            return Err(reason);
        }
        Ok(())
    }
}

type SharedSerialWriter = Arc<Mutex<Box<dyn Transport>>>;
type SharedMotionHeight = Arc<Mutex<Option<f64>>>;

struct SerialReaderContext {
    stop: Arc<AtomicBool>,
    alive: Arc<AtomicBool>,
    telemetry_enabled: Arc<AtomicBool>,
    writer: SharedSerialWriter,
    last_motion_height: SharedMotionHeight,
    session_id: u64,
    connection_target: ConnectionTarget,
}

enum SessionWriter {
    Serial(SharedSerialWriter),
    Mock(Arc<Mutex<MockControl>>),
}

#[derive(Debug)]
struct MockControl {
    turn: f64,
    velocity: f64,
    roll: f64,
    raw_roll: f64,
    roll_bias: f64,
    height: f64,
    auto_leg_enabled: bool,
    tuning_parameters: BTreeMap<String, String>,
    saved_parameters: Option<MockParameterSnapshot>,
}

#[derive(Debug, PartialEq)]
struct MockParameterSnapshot {
    height: f64,
    roll: f64,
    roll_bias: f64,
    auto_leg_enabled: bool,
    tuning_parameters: BTreeMap<String, String>,
}

impl Default for MockControl {
    fn default() -> Self {
        Self {
            turn: 0.0,
            velocity: 0.0,
            roll: 0.0,
            raw_roll: 0.0,
            roll_bias: 0.0,
            height: 61.5,
            auto_leg_enabled: true,
            tuning_parameters: BTreeMap::new(),
            saved_parameters: None,
        }
    }
}

struct DeviceSession {
    mode: &'static str,
    connection_target: ConnectionTarget,
    label: String,
    baud_rate: Option<u32>,
    session_id: u64,
    connected_at: u64,
    alive: Arc<AtomicBool>,
    telemetry_enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    writer: SessionWriter,
    reader_thread: Option<JoinHandle<()>>,
    last_motion_height: SharedMotionHeight,
    writes_unlocked: bool,
    shutdown_started: bool,
}

impl DeviceSession {
    fn from_transport(
        app: AppHandle,
        transport: Box<dyn Transport>,
        mode: &'static str,
        baud_rate: Option<u32>,
        writes_unlocked: bool,
        connection_target: ConnectionTarget,
    ) -> Result<Self, String> {
        let label = if connection_target == ConnectionTarget::Remote {
            format!("{} · 遥控器无线调参", transport.label())
        } else {
            transport.label().to_owned()
        };
        let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let reader = transport.try_clone_box()?;
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let telemetry_enabled = Arc::new(AtomicBool::new(false));
        let writer = Arc::new(Mutex::new(transport));
        let last_motion_height = Arc::new(Mutex::new(None));
        let thread_stop = Arc::clone(&stop);
        let thread_alive = Arc::clone(&alive);
        let thread_telemetry_enabled = Arc::clone(&telemetry_enabled);
        let thread_writer = Arc::clone(&writer);
        let thread_last_motion_height = Arc::clone(&last_motion_height);
        let reader_thread = thread::Builder::new()
            .name("wl1-device-reader".into())
            .spawn(move || {
                serial_reader_loop(
                    app,
                    reader,
                    SerialReaderContext {
                        stop: thread_stop,
                        alive: thread_alive,
                        telemetry_enabled: thread_telemetry_enabled,
                        writer: thread_writer,
                        last_motion_height: thread_last_motion_height,
                        session_id,
                        connection_target,
                    },
                )
            })
            .map_err(|error| format!("无法启动串口读取任务: {error}"))?;

        Ok(Self {
            mode,
            connection_target,
            label,
            baud_rate,
            session_id,
            connected_at: unix_millis(),
            alive,
            telemetry_enabled,
            stop,
            writer: SessionWriter::Serial(writer),
            reader_thread: Some(reader_thread),
            last_motion_height,
            writes_unlocked,
            shutdown_started: false,
        })
    }

    fn from_mock(app: AppHandle) -> Result<Self, String> {
        let session_id = NEXT_SESSION_ID.fetch_add(1, Ordering::Relaxed);
        let stop = Arc::new(AtomicBool::new(false));
        let alive = Arc::new(AtomicBool::new(true));
        let telemetry_enabled = Arc::new(AtomicBool::new(true));
        let control = Arc::new(Mutex::new(MockControl::default()));
        let thread_stop = Arc::clone(&stop);
        let thread_telemetry = Arc::clone(&telemetry_enabled);
        let thread_control = Arc::clone(&control);
        let reader_thread = thread::Builder::new()
            .name("wl1-mock-device".into())
            .spawn(move || {
                mock_device_loop(
                    app,
                    thread_control,
                    thread_telemetry,
                    thread_stop,
                    session_id,
                )
            })
            .map_err(|error| format!("无法启动模拟设备任务: {error}"))?;

        Ok(Self {
            mode: "mock",
            connection_target: ConnectionTarget::Robot,
            label: "WL1 模拟器".into(),
            baud_rate: None,
            session_id,
            connected_at: unix_millis(),
            alive,
            telemetry_enabled,
            stop,
            writer: SessionWriter::Mock(control),
            reader_thread: Some(reader_thread),
            last_motion_height: Arc::new(Mutex::new(None)),
            writes_unlocked: true,
            shutdown_started: false,
        })
    }

    fn snapshot(&self) -> ConnectionSnapshot {
        let alive = self.alive.load(Ordering::Acquire);
        ConnectionSnapshot {
            mode: if alive { self.mode } else { "disconnected" },
            connection_target: self.connection_target,
            label: if alive {
                self.label.clone()
            } else {
                format!("{} · 连接已中断", self.label)
            },
            session_id: alive.then_some(self.session_id),
            connected_at: Some(self.connected_at),
            baud_rate: self.baud_rate,
            telemetry_enabled: alive && self.telemetry_enabled.load(Ordering::Relaxed),
            writes_unlocked: alive && self.writes_unlocked,
        }
    }

    fn ensure_session_id(&self, expected_session_id: u64) -> Result<(), String> {
        if self.session_id != expected_session_id {
            return Err("设备会话已变化；已取消旧连接遗留的发送任务".into());
        }
        Ok(())
    }

    fn validate_text_command(&self, command: &str) -> Result<ValidatedCommand, String> {
        let command = validate_text_command_for_target(command, self.connection_target)?;
        if command.requires_write_unlock && !self.writes_unlocked {
            return Err("真实设备写入仍处于安全锁定；请断开后在连接页确认台架安全条件".into());
        }
        Ok(command)
    }

    fn ensure_motion_supported(&self) -> Result<(), String> {
        if self.connection_target == ConnectionTarget::Remote {
            return Err("遥控器模式由实体摇杆控制运动；上位机仅支持无线参数写入".into());
        }
        Ok(())
    }

    fn ensure_telemetry_supported(&self, enabled: bool) -> Result<(), String> {
        if enabled && self.connection_target == ConnectionTarget::Remote {
            return Err("遥控器固件没有车辆遥测回传；请直连小车查看 IMU 与轮速".into());
        }
        Ok(())
    }

    fn send_command(&mut self, command: &str, attempted_height: Option<f64>) -> Result<(), String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("设备连接已中断，请断开后重新连接".into());
        }
        let result = match &mut self.writer {
            SessionWriter::Serial(transport) => write_serial_command(
                transport,
                &self.alive,
                &self.last_motion_height,
                command,
                attempted_height,
            ),
            SessionWriter::Mock(control) => {
                if let Some(height) = attempted_height {
                    let mut last_motion_height = match self.last_motion_height.lock() {
                        Ok(value) => value,
                        Err(poisoned) => poisoned.into_inner(),
                    };
                    *last_motion_height = Some(height);
                }
                update_mock_control(control, command);
                Ok(())
            }
        };
        if result.is_err() {
            self.alive.store(false, Ordering::Release);
            self.best_effort_safety();
        }
        result
    }

    fn send_validated_text(&mut self, command: &ValidatedCommand) -> Result<(), String> {
        // `write_all` can reach the device before a subsequent flush reports an
        // error. `send_command` records the height atomically with writer
        // ordering, before the attempted write but only while the session lives.
        self.send_command(&command.text, command.leg_height)
    }

    fn send_validated_motion(&mut self, command: &ValidatedMotionCommand) -> Result<(), String> {
        // This is intentionally an attempted target, not an ACK/applied value.
        self.send_command(&command.text, Some(command.height))
    }

    fn set_telemetry(&mut self, app: &AppHandle, enabled: bool) -> Result<(), String> {
        if self.telemetry_enabled.load(Ordering::Relaxed) == enabled {
            return Ok(());
        }
        if matches!(&self.writer, SessionWriter::Serial(_)) {
            let imu = if enabled { "showimu -y" } else { "showimu -n" };
            let rpm = if enabled { "showrpm -y" } else { "showrpm -n" };
            self.send_command(imu, None)?;
            emit_console(app, self.session_id, "tx", imu);
            self.send_command(rpm, None)?;
            emit_console(app, self.session_id, "tx", rpm);
        }
        self.telemetry_enabled.store(enabled, Ordering::Relaxed);
        Ok(())
    }

    fn shutdown(&mut self) {
        if self.shutdown_started {
            return;
        }
        self.shutdown_started = true;
        self.stop.store(true, Ordering::Relaxed);
        self.alive.store(false, Ordering::Release);
        self.best_effort_safety();
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
    }

    fn best_effort_safety(&self) {
        if let SessionWriter::Serial(writer) = &self.writer {
            best_effort_serial_safety(writer, &self.last_motion_height, self.connection_target);
        }
    }
}

impl Drop for DeviceSession {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        self.alive.store(false, Ordering::Release);
        if !self.shutdown_started {
            self.best_effort_safety();
        }
        if let Some(handle) = self.reader_thread.take() {
            let _ = handle.join();
        }
    }
}

fn update_mock_control(control: &Mutex<MockControl>, command: &str) {
    let mut values = command.split_whitespace();
    let Some(name) = values.next() else { return };
    if let Ok(mut state) = control.lock() {
        if name == "R" {
            let parsed = values
                .take(4)
                .map(str::parse::<f64>)
                .collect::<Result<Vec<_>, _>>();
            if let Ok(parsed) = parsed {
                if parsed.len() == 4 && parsed.iter().all(|value| value.is_finite()) {
                    state.turn = parsed[0];
                    state.velocity = parsed[1];
                    state.roll = parsed[2];
                    state.height = parsed[3].clamp(44.5, 78.5);
                }
            }
        } else if name == "legheight" {
            if let Some(Ok(height)) = values.next().map(str::parse::<f64>) {
                if !height.is_finite() {
                    return;
                }
                state.height = height.clamp(44.5, 78.5);
            }
        } else if name == "rollbias" {
            if let Some(Ok(roll_bias)) = values.next().map(str::parse::<f64>) {
                if roll_bias.is_finite() {
                    state.roll_bias = roll_bias;
                }
            }
        } else if name == "autoleg" {
            match values.next() {
                Some("on") => state.auto_leg_enabled = true,
                Some("off") => state.auto_leg_enabled = false,
                _ => {}
            }
        } else if matches!(
            name,
            "anglebias" | "anglepid" | "velocitypid" | "differpid" | "rollpid"
        ) {
            let arguments = values.collect::<Vec<_>>();
            let (key, value) = match arguments.as_slice() {
                [value] => (name.to_owned(), *value),
                [flag, value] => (format!("{name} {flag}"), *value),
                _ => return,
            };
            // Normalize equivalent decimal input so reapplying the same value
            // does not make the mock report another Flash write.
            let value = value
                .parse::<f64>()
                .map(|value| value.to_string())
                .unwrap_or_else(|_| value.to_owned());
            state.tuning_parameters.insert(key, value);
            if name == "anglepid" && arguments.first() == Some(&"-p") {
                state.tuning_parameters.remove("anglepid");
            }
        }
    }
}

fn mock_feature_reply(control: &Mutex<MockControl>, command: &str) -> Option<String> {
    if command == "uid" {
        return Some("uid: 0123456789ABCDEF10203040".into());
    }
    if command == "rollbias" {
        let state = control.lock().ok()?;
        return Some(format!(
            "rollbias base={:.4} raw={:.4} effective={:.4}",
            state.roll_bias,
            state.raw_roll,
            state.raw_roll + state.roll_bias,
        ));
    }
    if command == "save" {
        let mut state = control.lock().ok()?;
        let parameters = MockParameterSnapshot {
            height: state.height,
            roll: state.roll,
            roll_bias: state.roll_bias,
            auto_leg_enabled: state.auto_leg_enabled,
            tuning_parameters: state.tuning_parameters.clone(),
        };
        if state.saved_parameters.as_ref() == Some(&parameters) {
            return Some("save: unchanged (no flash write)".into());
        }
        state.saved_parameters = Some(parameters);
        return Some("save: ok (all motion parameters)".into());
    }
    if !command.starts_with("autoleg ") {
        return None;
    }
    let enabled = control.lock().ok()?.auto_leg_enabled as u8;
    Some(format!("autoleg: enabled={enabled} active={enabled}"))
}

const SERIAL_PENDING_LIMIT: usize = 4096;
const TELEMETRY_HEALTH_TIMEOUT: Duration = Duration::from_secs(2);
const TELEMETRY_WEBVIEW_INTERVAL: Duration = Duration::from_millis(50);
const MAX_CONSECUTIVE_UNPARSED_LINES: usize = 64;

#[derive(Default)]
struct TelemetryHealth {
    monitoring_since: Option<Instant>,
    last_imu: Option<Instant>,
    last_rpm: Option<Instant>,
    consecutive_unparsed: usize,
}

impl TelemetryHealth {
    fn observe(&mut self, update: &FirmwareUpdate, now: Instant, enabled: bool) {
        if !enabled {
            return;
        }
        match update {
            FirmwareUpdate::Imu { .. } => {
                self.last_imu = Some(now);
                self.consecutive_unparsed = 0;
            }
            FirmwareUpdate::Rpm { .. } => {
                self.last_rpm = Some(now);
                self.consecutive_unparsed = 0;
            }
            FirmwareUpdate::Log(_) => {
                self.consecutive_unparsed = self.consecutive_unparsed.saturating_add(1);
            }
            FirmwareUpdate::Servo { .. } => {}
        }
    }

    fn check(&mut self, enabled: bool, now: Instant) -> Option<String> {
        if !enabled {
            *self = Self::default();
            return None;
        }
        let monitoring_since = *self.monitoring_since.get_or_insert(now);
        if self.consecutive_unparsed >= MAX_CONSECUTIVE_UNPARSED_LINES {
            return Some(format!(
                "遥测解析连续失败 {MAX_CONSECUTIVE_UNPARSED_LINES} 行，已锁定设备会话"
            ));
        }
        if now.saturating_duration_since(self.last_imu.unwrap_or(monitoring_since))
            >= TELEMETRY_HEALTH_TIMEOUT
        {
            return Some("IMU 遥测超过 2 秒未更新，已锁定设备会话".into());
        }
        if now.saturating_duration_since(self.last_rpm.unwrap_or(monitoring_since))
            >= TELEMETRY_HEALTH_TIMEOUT
        {
            return Some("RPM 遥测超过 2 秒未更新，已锁定设备会话".into());
        }
        None
    }
}

fn write_serial_command(
    writer: &SharedSerialWriter,
    alive: &AtomicBool,
    last_motion_height: &SharedMotionHeight,
    command: &str,
    attempted_height: Option<f64>,
) -> Result<(), String> {
    let mut transport = match writer.lock() {
        Ok(transport) => transport,
        Err(poisoned) => poisoned.into_inner(),
    };
    // The reader marks the session dead before waiting for this mutex. Recheck
    // inside the write critical section so a queued non-zero R/show*-y cannot
    // overtake its safety commands or replace the remembered safe height.
    if !alive.load(Ordering::Acquire) {
        return Err("设备连接已中断，请断开后重新连接".into());
    }
    if let Some(height) = attempted_height {
        let mut last_motion_height = match last_motion_height.lock() {
            Ok(value) => value,
            Err(poisoned) => poisoned.into_inner(),
        };
        *last_motion_height = Some(height);
    }
    transport.write_command(command)
}

fn best_effort_serial_safety(
    writer: &SharedSerialWriter,
    last_motion_height: &SharedMotionHeight,
    connection_target: ConnectionTarget,
) {
    // The remote owns joystick motion and has no telemetry forwarding. Its
    // bridge does not accept R/show* commands, including during error cleanup.
    if connection_target == ConnectionTarget::Remote {
        return;
    }
    let mut transport = match writer.lock() {
        Ok(transport) => transport,
        Err(poisoned) => poisoned.into_inner(),
    };
    // Writer -> height is the single lock order shared with the send path. A
    // fault marks `alive=false` before taking writer, so either an in-flight
    // command finishes first and this neutral follows it, or the command sees
    // the dead session inside the same critical section and never writes.
    let height = match last_motion_height.lock() {
        Ok(value) => *value,
        Err(poisoned) => *poisoned.into_inner(),
    };
    // A cloned reader can fail while the writer is still usable. These writes
    // deliberately bypass `alive`; Legacy has no ACK, so all remain best-effort.
    if let Some(height) = height {
        let _ = transport.write_command(&format!("R 0.0 0.0 0.0 {height:.1}"));
    }
    // Stop requests are safe and idempotent. Always issue both because a
    // previous/partially flushed enable request may have reached the firmware.
    let _ = transport.write_command("showimu -n");
    let _ = transport.write_command("showrpm -n");
}

fn fail_serial_reader(
    app: &AppHandle,
    alive: &AtomicBool,
    writer: &SharedSerialWriter,
    last_motion_height: &SharedMotionHeight,
    session_id: u64,
    reason: String,
    connection_target: ConnectionTarget,
) {
    alive.store(false, Ordering::Release);
    // Safety cleanup must not depend on a responsive WebView receiving the
    // disconnect event. The UI event only updates presentation/session state.
    best_effort_serial_safety(writer, last_motion_height, connection_target);
    emit_console(app, session_id, "system", reason.clone());
    emit_disconnected(app, session_id, reason);
    schedule_fault_disconnect(app, session_id);
}

fn schedule_fault_disconnect(app: &AppHandle, session_id: u64) {
    let worker_app = app.clone();
    let spawn_result = thread::Builder::new()
        .name("wl1-fault-cleanup".into())
        .spawn(move || {
            // Never disconnect inline from the reader (it would join itself),
            // or while a command holds AppState. The session token also stops a
            // late cleanup worker from touching a newer connection.
            let state = worker_app.state::<AppState>();
            let _ = state.disconnect(Some(session_id));
        });
    if let Err(error) = spawn_result {
        emit_console(
            app,
            session_id,
            "system",
            format!("无法启动后端故障清理任务；设备会话已锁定: {error}"),
        );
    }
}

fn serial_reader_loop(
    app: AppHandle,
    mut reader: Box<dyn Transport>,
    context: SerialReaderContext,
) {
    let SerialReaderContext {
        stop,
        alive,
        telemetry_enabled,
        writer,
        last_motion_height,
        session_id,
        connection_target,
    } = context;
    let mut codec = LegacyAsciiCodec::default();
    let mut chunk = [0_u8; 256];
    let mut pending = Vec::<u8>::with_capacity(512);
    let mut last_telemetry_emit = Instant::now()
        .checked_sub(TELEMETRY_WEBVIEW_INTERVAL)
        .unwrap_or_else(Instant::now);
    let mut telemetry_health = TelemetryHealth::default();

    while !stop.load(Ordering::Relaxed) {
        match reader.read_chunk(&mut chunk) {
            Ok(0) => continue,
            Ok(count) => {
                pending.extend_from_slice(&chunk[..count]);
                while let Some(newline) = pending.iter().position(|byte| *byte == b'\n') {
                    let line = pending.drain(..=newline).collect::<Vec<_>>();
                    let text = String::from_utf8_lossy(&line).trim().to_owned();
                    if text.is_empty() {
                        continue;
                    }
                    if connection_target == ConnectionTarget::Remote {
                        // Bridge logs and NRF hardware ACKs are not vehicle
                        // telemetry or parameter execution acknowledgements.
                        emit_console(&app, session_id, "rx", text);
                        continue;
                    }
                    let update = codec.decode_line(&text);
                    telemetry_health.observe(
                        &update,
                        Instant::now(),
                        telemetry_enabled.load(Ordering::Relaxed),
                    );
                    if matches!(
                        &update,
                        FirmwareUpdate::Servo { .. } | FirmwareUpdate::Log(_)
                    ) {
                        emit_console(&app, session_id, "rx", text.clone());
                    }
                    let decoded_at = unix_millis();
                    if let Some(mut frame) = codec.apply_update(&update, decoded_at) {
                        // Decode every line so the cache stays current, but cap
                        // WebView events at 20 Hz. Raw structured telemetry is
                        // intentionally not duplicated into the React console.
                        if last_telemetry_emit.elapsed() >= TELEMETRY_WEBVIEW_INTERVAL {
                            frame.session_id = session_id;
                            frame.timestamp = decoded_at;
                            let _ = app.emit("wl1://telemetry", frame);
                            last_telemetry_emit = Instant::now();
                        }
                    }
                    if let FirmwareUpdate::Servo { angle, x, bias } = update {
                        emit_console(
                            &app,
                            session_id,
                            "system",
                            format!("腿部解算：舵机 {angle:.3}° · x {x:.3} · bias {bias:.3}"),
                        );
                    }
                }
                if pending.len() > SERIAL_PENDING_LIMIT {
                    fail_serial_reader(
                        &app,
                        &alive,
                        &writer,
                        &last_motion_height,
                        session_id,
                        "设备接收超过 4096 字节仍无换行，帧边界已失步；设备会话已锁定".into(),
                        connection_target,
                    );
                    break;
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(error) => {
                let reason = format!("设备读取已停止: {error}");
                fail_serial_reader(
                    &app,
                    &alive,
                    &writer,
                    &last_motion_height,
                    session_id,
                    reason,
                    connection_target,
                );
                break;
            }
        }

        if let Some(reason) =
            telemetry_health.check(telemetry_enabled.load(Ordering::Relaxed), Instant::now())
        {
            fail_serial_reader(
                &app,
                &alive,
                &writer,
                &last_motion_height,
                session_id,
                reason,
                connection_target,
            );
            break;
        }
    }
}

fn mock_device_loop(
    app: AppHandle,
    control: Arc<Mutex<MockControl>>,
    telemetry_enabled: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    session_id: u64,
) {
    let started = Instant::now();
    while !stop.load(Ordering::Relaxed) {
        if telemetry_enabled.load(Ordering::Relaxed) {
            let seconds = started.elapsed().as_secs_f64();
            let (turn, velocity, roll_target, height) = control
                .lock()
                .map(|state| (state.turn, state.velocity, state.roll, state.height))
                .unwrap_or((0.0, 0.0, 0.0, 61.5));
            let wave = (seconds * 1.6).sin();
            let raw_roll = roll_target + wave * 0.65;
            if let Ok(mut state) = control.lock() {
                state.raw_roll = raw_roll;
            }
            let timestamp = unix_millis();
            let frame = TelemetryFrame {
                session_id,
                timestamp,
                imu_timestamp: Some(timestamp),
                rpm_timestamp: Some(timestamp),
                roll: raw_roll,
                pitch: (seconds * 1.15).sin() * 1.15,
                yaw: (seconds * 3.5).sin() * 4.0,
                left_rpm: velocity + turn * 0.5 + wave * 1.2,
                right_rpm: velocity - turn * 0.5 - wave * 1.1,
                target_height: Some(height),
                link_quality: Some(96.0 + (seconds * 0.7).sin() * 2.0),
                battery_voltage: Some(12.1 + (seconds * 0.2).sin() * 0.08),
                acceleration_norm_g: Some(1.0 + (seconds * 1.6).sin() * 0.025),
                acceleration_trusted: Some(true),
            };
            let _ = app.emit("wl1://telemetry", frame);
        }
        thread::sleep(Duration::from_millis(50));
    }
}

pub fn emit_console(
    app: &AppHandle,
    session_id: u64,
    direction: &'static str,
    text: impl Into<String>,
) {
    let _ = app.emit(
        "wl1://console",
        ConsoleEvent {
            session_id,
            timestamp: unix_millis(),
            direction,
            text: text.into(),
        },
    );
}

fn emit_disconnected(app: &AppHandle, session_id: u64, reason: String) {
    let _ = app.emit(
        "wl1://disconnected",
        DisconnectedEvent {
            session_id,
            timestamp: unix_millis(),
            reason,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io;

    #[derive(Clone)]
    struct FlushFailTransport {
        writes: Arc<Mutex<Vec<String>>>,
    }

    impl Transport for FlushFailTransport {
        fn label(&self) -> &str {
            "TEST"
        }

        fn write_command(&mut self, command: &str) -> Result<(), String> {
            self.writes.lock().unwrap().push(command.to_owned());
            Err("simulated flush failure after bytes were accepted".into())
        }

        fn read_chunk(&mut self, _buffer: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(ErrorKind::TimedOut, "test timeout"))
        }

        fn try_clone_box(&self) -> Result<Box<dyn Transport>, String> {
            Ok(Box::new(self.clone()))
        }
    }

    fn failing_serial_session(writes: Arc<Mutex<Vec<String>>>) -> DeviceSession {
        DeviceSession {
            mode: "serial",
            connection_target: ConnectionTarget::Robot,
            label: "TEST".into(),
            baud_rate: Some(115_200),
            session_id: 99,
            connected_at: 0,
            alive: Arc::new(AtomicBool::new(true)),
            telemetry_enabled: Arc::new(AtomicBool::new(false)),
            stop: Arc::new(AtomicBool::new(false)),
            writer: SessionWriter::Serial(Arc::new(Mutex::new(Box::new(FlushFailTransport {
                writes,
            })))),
            reader_thread: None,
            last_motion_height: Arc::new(Mutex::new(None)),
            writes_unlocked: true,
            shutdown_started: false,
        }
    }

    #[test]
    fn mock_feature_replies_follow_the_current_switch_state() {
        let control = Mutex::new(MockControl::default());
        assert_eq!(
            mock_feature_reply(&control, "uid").as_deref(),
            Some("uid: 0123456789ABCDEF10203040")
        );
        assert_eq!(
            mock_feature_reply(&control, "autoleg status").as_deref(),
            Some("autoleg: enabled=1 active=1")
        );
        update_mock_control(&control, "autoleg off");
        assert_eq!(
            mock_feature_reply(&control, "autoleg off").as_deref(),
            Some("autoleg: enabled=0 active=0")
        );
    }

    #[test]
    fn flash_save_permissions_reject_without_writing_or_disconnecting() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut session = failing_serial_session(Arc::clone(&writes));
        session.writes_unlocked = false;
        assert!(session.validate_text_command("save").is_err());
        assert!(session.validate_text_command("uid").is_ok());
        assert!(session.validate_text_command("rollbias").is_ok());
        assert!(session.validate_text_command("rollbias 1.5").is_err());
        assert_eq!(session.snapshot().mode, "serial");
        assert!(writes.lock().unwrap().is_empty());

        session.writes_unlocked = true;
        assert!(session.validate_text_command("save").is_ok());
        assert!(session.validate_text_command("rollbias 1.5").is_ok());
        session.connection_target = ConnectionTarget::Remote;
        assert!(session.validate_text_command("save").is_err());
        assert!(session.validate_text_command("rollbias").is_err());
        assert!(session.validate_text_command("rollbias 1.5").is_err());
        assert_eq!(session.snapshot().mode, "serial");
        assert!(writes.lock().unwrap().is_empty());
    }

    #[test]
    fn mock_flash_save_reports_changes_across_parameter_groups() {
        let control = Mutex::new(MockControl::default());
        let saved = Some("save: ok (all motion parameters)");
        let unchanged = Some("save: unchanged (no flash write)");
        assert_eq!(mock_feature_reply(&control, "save").as_deref(), saved);
        assert_eq!(mock_feature_reply(&control, "save").as_deref(), unchanged);
        for command in [
            "anglebias 12",
            "rollbias 1.5",
            "anglepid -p 80",
            "velocitypid -i 0.02",
            "differpid -p 3",
            "rollpid -i -0.3",
            "autoleg off",
            "legheight 60",
            "R 0 0 1 60",
        ] {
            update_mock_control(&control, command);
            assert_eq!(
                mock_feature_reply(&control, "save").as_deref(),
                saved,
                "{command}"
            );
            assert_eq!(
                mock_feature_reply(&control, "save").as_deref(),
                unchanged,
                "{command}"
            );
        }
        // Queries and changes to the live speed/turn targets are not persisted.
        for command in [
            "uid",
            "autoleg status",
            "rollbias",
            "rollbias 1.500",
            "R 10 20 1 60",
            "anglepid -p 80.00",
        ] {
            update_mock_control(&control, command);
            assert_eq!(
                mock_feature_reply(&control, "save").as_deref(),
                unchanged,
                "{command}"
            );
        }
    }

    #[test]
    fn mock_roll_center_is_persistent_and_independent_from_motion_targets_and_sensor_data() {
        let control = Mutex::new(MockControl::default());
        let saved = Some("save: ok (all motion parameters)");
        let unchanged = Some("save: unchanged (no flash write)");
        assert_eq!(
            mock_feature_reply(&control, "rollbias").as_deref(),
            Some("rollbias base=0.0000 raw=0.0000 effective=0.0000")
        );
        assert_eq!(mock_feature_reply(&control, "save").as_deref(), saved);
        update_mock_control(&control, "rollbias 0");
        assert_eq!(mock_feature_reply(&control, "save").as_deref(), unchanged);

        update_mock_control(&control, "rollbias 1.5");
        assert!(mock_feature_reply(&control, "rollbias 1.5").is_none());
        assert_eq!(mock_feature_reply(&control, "save").as_deref(), saved);
        update_mock_control(&control, "rollbias 1.500");
        assert_eq!(mock_feature_reply(&control, "save").as_deref(), unchanged);

        control.lock().unwrap().raw_roll = -2.0;
        assert_eq!(
            mock_feature_reply(&control, "rollbias").as_deref(),
            Some("rollbias base=1.5000 raw=-2.0000 effective=-0.5000")
        );
        assert_eq!(mock_feature_reply(&control, "save").as_deref(), unchanged);
        update_mock_control(&control, "R 0 0 5 61.5");
        assert_eq!(
            mock_feature_reply(&control, "rollbias").as_deref(),
            Some("rollbias base=1.5000 raw=-2.0000 effective=-0.5000")
        );
        assert_eq!(control.lock().unwrap().roll, 5.0);
    }

    #[test]
    fn remote_capability_rejections_leave_session_connected_and_write_nothing() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut session = failing_serial_session(Arc::clone(&writes));
        session.connection_target = ConnectionTarget::Remote;

        assert!(session.ensure_motion_supported().is_err());
        assert!(session.ensure_telemetry_supported(true).is_err());
        assert!(session.ensure_telemetry_supported(false).is_ok());
        assert_eq!(session.snapshot().mode, "serial");
        assert!(!session.snapshot().telemetry_enabled);
        assert!(writes.lock().unwrap().is_empty());
    }

    #[test]
    fn remote_shutdown_and_drop_never_override_remote_joysticks() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut session = failing_serial_session(Arc::clone(&writes));
        session.connection_target = ConnectionTarget::Remote;
        *session.last_motion_height.lock().unwrap() = Some(60.0);
        session.shutdown();
        drop(session);

        let mut session = failing_serial_session(Arc::clone(&writes));
        session.connection_target = ConnectionTarget::Remote;
        drop(session);
        assert!(writes.lock().unwrap().is_empty());
    }

    #[test]
    fn remote_flush_failure_does_not_send_robot_cleanup_commands() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut session = failing_serial_session(Arc::clone(&writes));
        session.connection_target = ConnectionTarget::Remote;
        let command =
            validate_text_command_for_target("anglepid -p 65", ConnectionTarget::Remote).unwrap();
        assert!(session.send_validated_text(&command).is_err());
        assert_eq!(session.snapshot().mode, "disconnected");
        drop(session);
        assert_eq!(*writes.lock().unwrap(), ["anglepid -p 65"]);
    }

    #[test]
    fn failed_motion_flush_performs_backend_safety_without_webview_callback() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let mut session = failing_serial_session(Arc::clone(&writes));
        let command = validate_motion_target(&MotionTargetRequest {
            turn: 12.0,
            velocity: 24.0,
            roll: 1.0,
            height: 57.5,
        })
        .unwrap();

        assert!(session.send_validated_motion(&command).is_err());
        assert_eq!(*session.last_motion_height.lock().unwrap(), Some(57.5));

        assert_eq!(
            *writes.lock().unwrap(),
            [
                "R 12.0 24.0 1.0 57.5",
                "R 0.0 0.0 0.0 57.5",
                "showimu -n",
                "showrpm -n",
            ]
        );
    }
    #[test]
    fn drop_performs_backend_safety_when_shutdown_was_skipped() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let session = failing_serial_session(Arc::clone(&writes));
        *session.last_motion_height.lock().unwrap() = Some(60.0);

        drop(session);

        assert_eq!(
            *writes.lock().unwrap(),
            ["R 0.0 0.0 0.0 60.0", "showimu -n", "showrpm -n",]
        );
    }

    #[test]
    fn queued_motion_cannot_overtake_reader_fault_safety() {
        let writes = Arc::new(Mutex::new(Vec::new()));
        let writer: SharedSerialWriter = Arc::new(Mutex::new(Box::new(FlushFailTransport {
            writes: Arc::clone(&writes),
        })));
        let height = Arc::new(Mutex::new(Some(55.0)));
        let alive = AtomicBool::new(false);

        assert!(
            write_serial_command(&writer, &alive, &height, "R 12.0 24.0 1.0 70.0", Some(70.0),)
                .is_err()
        );
        assert_eq!(*height.lock().unwrap(), Some(55.0));
        assert!(writes.lock().unwrap().is_empty());
    }

    #[test]
    fn telemetry_health_requires_both_channels_and_rejects_parse_floods() {
        let started = Instant::now();
        let mut health = TelemetryHealth::default();
        assert!(health.check(true, started).is_none());
        health.observe(
            &FirmwareUpdate::Imu {
                roll: 0.0,
                pitch: 0.0,
                yaw: 0.0,
                acceleration_norm_g: None,
                acceleration_trusted: None,
            },
            started + Duration::from_millis(100),
            true,
        );
        assert!(health
            .check(true, started + Duration::from_millis(1_999))
            .is_none());
        assert!(health
            .check(true, started + Duration::from_secs(2))
            .unwrap()
            .contains("RPM"));

        health.check(false, started + Duration::from_secs(3));
        health.check(true, started + Duration::from_secs(4));
        for _ in 0..MAX_CONSECUTIVE_UNPARSED_LINES {
            health.observe(
                &FirmwareUpdate::Log("bad".into()),
                started + Duration::from_secs(4),
                true,
            );
        }
        assert!(health
            .check(true, started + Duration::from_secs(4))
            .unwrap()
            .contains("连续失败"));
    }
}
