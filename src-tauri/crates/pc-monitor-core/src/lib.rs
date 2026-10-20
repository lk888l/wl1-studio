#![forbid(unsafe_code)]

//! CPU/RAM/NVIDIA sampling and the version 1 UDP monitor protocol. The worker
//! belongs to this core, so closing a page or a USB session never stops it.

use mio::{Events, Interest, Poll, Token, Waker};
use nvml_wrapper::{enum_wrappers::device::TemperatureSensor, Nvml};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddrV4, UdpSocket};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{mpsc, Arc, Mutex, MutexGuard, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use sysinfo::{MemoryRefreshKind, System};

pub const MONITOR_PORT: u16 = 4443;
pub const DEFAULT_INTERVAL_MS: u64 = 500;
pub const STALE_AFTER: Duration = Duration::from_secs(3);
pub const MAX_PACKET_BYTES: usize = 1024;
const SOCKET_READY: Token = Token(0);
const STOP_READY: Token = Token(1);

fn default_interval_ms() -> u64 {
    DEFAULT_INTERVAL_MS
}

fn default_gpu_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MonitorConfig {
    pub target_ip: String,
    #[serde(default = "default_gpu_enabled")]
    pub gpu_enabled: bool,
    #[serde(default)]
    pub gpu_uuid: Option<String>,
    #[serde(default = "default_interval_ms")]
    pub interval_ms: u64,
}

impl MonitorConfig {
    pub fn normalized(mut self) -> Result<(Self, Ipv4Addr), String> {
        let ip: Ipv4Addr = self
            .target_ip
            .trim()
            .parse()
            .map_err(|_| "请输入 ESP32-C3 的 IPv4 地址，例如 192.168.4.1".to_owned())?;
        if ip.is_unspecified() || ip.is_multicast() || ip.is_broadcast() {
            return Err("设备地址必须是有效的 IPv4 单播地址".into());
        }
        if !(250..=2000).contains(&self.interval_ms) {
            return Err("采样周期必须为 250–2000 ms".into());
        }
        self.gpu_uuid = self
            .gpu_uuid
            .map(|uuid| uuid.trim().to_owned())
            .filter(|uuid| !uuid.is_empty());
        if self.gpu_uuid.as_ref().is_some_and(|uuid| {
            uuid.len() > 96 || !uuid.bytes().all(|byte| byte.is_ascii_graphic())
        }) {
            return Err("显卡 UUID 格式无效，请重新选择显卡".into());
        }
        self.target_ip = ip.to_string();
        Ok((self, ip))
    }
}

/// Frontend representation. The UDP representation deliberately uses snake case.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSample {
    pub v: u8,
    pub session: String,
    pub seq: u32,
    pub host: String,
    pub cpu_pct: Option<f32>,
    pub ram_used: u64,
    pub ram_total: u64,
    pub gpu_name: String,
    pub gpu_pct: Option<f32>,
    pub vram_used: Option<u64>,
    pub vram_total: Option<u64>,
    pub gpu_temp_c: Option<f32>,
}

#[derive(Serialize)]
struct WireSample<'a> {
    v: u8,
    session: &'a str,
    seq: u32,
    host: &'a str,
    cpu_pct: Option<f32>,
    ram_used: u64,
    ram_total: u64,
    gpu_name: &'a str,
    gpu_pct: Option<f32>,
    vram_used: Option<u64>,
    vram_total: Option<u64>,
    gpu_temp_c: Option<f32>,
}

impl MonitorSample {
    pub fn wire_bytes(&self) -> Result<Vec<u8>, String> {
        let bytes = serde_json::to_vec(&WireSample {
            v: self.v,
            session: &self.session,
            seq: self.seq,
            host: &self.host,
            cpu_pct: self.cpu_pct,
            ram_used: self.ram_used,
            ram_total: self.ram_total,
            gpu_name: &self.gpu_name,
            gpu_pct: self.gpu_pct,
            vram_used: self.vram_used,
            vram_total: self.vram_total,
            gpu_temp_c: self.gpu_temp_c,
        })
        .map_err(|error| format!("无法编码电脑监控数据：{error}"))?;
        if bytes.len() >= MAX_PACKET_BYTES {
            return Err("电脑监控报文超过长度限制".into());
        }
        Ok(bytes)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MonitorSnapshot {
    pub running: bool,
    pub session_id: Option<String>,
    pub target_ip: Option<String>,
    #[serde(default = "default_gpu_enabled")]
    pub gpu_enabled: bool,
    pub gpu_uuid: Option<String>,
    pub interval_ms: u64,
    pub sample: Option<MonitorSample>,
    pub ack_age_ms: Option<u64>,
    pub connected: bool,
    pub last_error: Option<String>,
    pub samples_sent: u64,
    pub bytes_sent: u64,
}

impl Default for MonitorSnapshot {
    fn default() -> Self {
        Self {
            running: false,
            session_id: None,
            target_ip: None,
            gpu_enabled: true,
            gpu_uuid: None,
            interval_ms: DEFAULT_INTERVAL_MS,
            sample: None,
            ack_age_ms: None,
            connected: false,
            last_error: None,
            samples_sent: 0,
            bytes_sent: 0,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GpuDevice {
    pub uuid: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct GpuDevices {
    pub gpus: Vec<GpuDevice>,
    pub warning: Option<String>,
}

#[derive(Default)]
struct Shared {
    snapshot: MonitorSnapshot,
    last_ack: Option<Instant>,
}

struct Worker {
    stop: mpsc::Sender<()>,
    wake: Arc<Waker>,
    thread: JoinHandle<()>,
}

type NvmlResult = Result<Arc<Nvml>, String>;
type NvmlCache = Arc<OnceLock<NvmlResult>>;

#[derive(Default)]
pub struct Monitor {
    shared: Arc<Mutex<Shared>>,
    worker: Mutex<Option<Worker>>,
    nvml: NvmlCache,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

fn nvml(cache: &NvmlCache) -> NvmlResult {
    cache
        .get_or_init(|| {
            Nvml::init()
                .map(Arc::new)
                .map_err(|error| format!("NVIDIA 监控不可用，CPU / 内存仍会发送：{error}"))
        })
        .clone()
}

impl Monitor {
    pub fn snapshot(&self) -> MonitorSnapshot {
        let state = lock(&self.shared);
        let mut snapshot = state.snapshot.clone();
        snapshot.ack_age_ms = state
            .last_ack
            .map(|ack| ack.elapsed().as_millis().min(u128::from(u64::MAX)) as u64);
        snapshot.connected = snapshot.running
            && state
                .last_ack
                .is_some_and(|ack| ack.elapsed() <= STALE_AFTER);
        snapshot
    }

    /// Device discovery and the sender share one lazily initialized NVML instance.
    pub fn devices(&self) -> GpuDevices {
        let driver = match nvml(&self.nvml) {
            Ok(driver) => driver,
            Err(warning) => {
                return GpuDevices {
                    gpus: Vec::new(),
                    warning: Some(warning),
                }
            }
        };
        let count = match driver.device_count() {
            Ok(count) => count,
            Err(error) => {
                return GpuDevices {
                    gpus: Vec::new(),
                    warning: Some(format!("无法枚举 NVIDIA 显卡：{error}")),
                }
            }
        };
        let mut gpus = Vec::new();
        let mut warning = None;
        for index in 0..count {
            match driver.device_by_index(index).and_then(|device| {
                Ok(GpuDevice {
                    uuid: device.uuid()?,
                    name: bounded_text(&device.name()?, 95),
                })
            }) {
                Ok(device) => gpus.push(device),
                Err(error) => warning = Some(format!("部分显卡信息不可用：{error}")),
            }
        }
        if gpus.is_empty() && warning.is_none() {
            warning = Some("未发现 NVIDIA 显卡，仍可发送 CPU / 内存指标".into());
        }
        GpuDevices { gpus, warning }
    }

    pub fn start(&self, config: MonitorConfig) -> Result<MonitorSnapshot, String> {
        let (config, ip) = config.normalized()?;
        self.start_at(config, SocketAddrV4::new(ip, MONITOR_PORT))
    }

    fn start_at(
        &self,
        config: MonitorConfig,
        target: SocketAddrV4,
    ) -> Result<MonitorSnapshot, String> {
        // Prepare the new endpoint before releasing an existing valid sender.
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
            .map_err(|error| format!("无法创建监控 UDP 端口：{error}"))?;
        socket
            .connect(target)
            .map_err(|error| format!("无法连接监控目标：{error}"))?;
        socket
            .set_nonblocking(true)
            .map_err(|error| format!("无法设置监控 UDP 端口：{error}"))?;
        let mut socket = mio::net::UdpSocket::from_std(socket);
        let poll = Poll::new().map_err(|error| format!("无法创建监控网络事件：{error}"))?;
        poll.registry()
            .register(&mut socket, SOCKET_READY, Interest::READABLE)
            .map_err(|error| format!("无法监听监控回执：{error}"))?;
        let wake = Arc::new(
            Waker::new(poll.registry(), STOP_READY)
                .map_err(|error| format!("无法创建监控停止信号：{error}"))?,
        );
        let mut worker = lock(&self.worker);
        self.stop_worker(&mut worker)?;
        let session = new_session();
        {
            let mut state = lock(&self.shared);
            state.last_ack = None;
            state.snapshot = MonitorSnapshot {
                running: true,
                session_id: Some(session.clone()),
                target_ip: Some(config.target_ip.clone()),
                gpu_enabled: config.gpu_enabled,
                gpu_uuid: config.gpu_uuid.clone(),
                interval_ms: config.interval_ms,
                ..MonitorSnapshot::default()
            };
        }
        let (stop, stopped) = mpsc::channel();
        let shared = Arc::clone(&self.shared);
        let driver = Arc::clone(&self.nvml);
        let thread = match thread::Builder::new()
            .name("pc-monitor".into())
            .spawn(move || run_worker(poll, socket, config, session, shared, driver, stopped))
        {
            Ok(thread) => thread,
            Err(error) => {
                let error = format!("无法启动电脑监控任务：{error}");
                let mut state = lock(&self.shared);
                state.snapshot.running = false;
                state.snapshot.last_error = Some(error.clone());
                return Err(error);
            }
        };
        *worker = Some(Worker { stop, wake, thread });
        Ok(self.snapshot())
    }

    pub fn stop(&self, expected_session_id: Option<&str>) -> Result<MonitorSnapshot, String> {
        let mut worker = lock(&self.worker);
        if expected_session_id.is_some_and(|expected| {
            lock(&self.shared).snapshot.session_id.as_deref() != Some(expected)
        }) {
            return Err("电脑监控会话已更新，请刷新状态后重试".into());
        }
        self.stop_worker(&mut worker)?;
        Ok(self.snapshot())
    }

    fn stop_worker(&self, worker: &mut Option<Worker>) -> Result<(), String> {
        let joined = if let Some(worker) = worker.take() {
            let _ = worker.stop.send(());
            let _ = worker.wake.wake();
            worker.thread.join().is_ok()
        } else {
            true
        };
        let mut state = lock(&self.shared);
        state.snapshot.running = false;
        state.snapshot.connected = false;
        if joined {
            Ok(())
        } else {
            let error = "电脑监控任务异常结束，请重新启动监控".to_owned();
            state.snapshot.last_error = Some(error.clone());
            Err(error)
        }
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        let _ = self.stop(None);
    }
}

fn new_session() -> String {
    static NEXT: AtomicU32 = AtomicU32::new(1);
    let epoch = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    format!(
        "{epoch:016x}{:08x}{:08x}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

fn bounded_text(text: &str, max_bytes: usize) -> String {
    let mut bounded = String::new();
    for character in text.chars() {
        let character = if character.is_control() {
            '?'
        } else {
            character
        };
        if bounded.len() + character.len_utf8() > max_bytes {
            break;
        }
        bounded.push(character);
    }
    bounded
}

fn percentage(value: f32) -> Option<f32> {
    value.is_finite().then(|| value.clamp(0.0, 100.0))
}

fn valid_gpu_memory(used: u64, total: u64) -> bool {
    total > 0 && used <= total
}

struct Sampler {
    system: System,
    host: String,
    cpu_refreshed: Instant,
    gpu: Option<(Arc<Nvml>, String, String)>,
    gpu_warning: Option<String>,
}

impl Sampler {
    fn new(driver: Option<NvmlResult>, gpu_uuid: Option<&str>) -> Self {
        let mut system = System::new();
        system.refresh_cpu_usage();
        let host = bounded_text(&System::host_name().unwrap_or_else(|| "PC".into()), 63);
        let host = if host.is_empty() { "PC".into() } else { host };
        let selection = driver
            .map(|driver| {
                driver.and_then(|driver| {
                    let device = match gpu_uuid {
                        Some(uuid) => driver.device_by_uuid(uuid),
                        None => driver.device_by_index(0),
                    }
                    .map_err(|error| format!("选定显卡不可用，CPU / 内存仍会发送：{error}"))?;
                    let uuid = device
                        .uuid()
                        .map_err(|error| format!("无法读取显卡 UUID：{error}"))?;
                    let name = device.name().unwrap_or_else(|_| "NVIDIA GPU".into());
                    Ok((Arc::clone(&driver), uuid, bounded_text(&name, 95)))
                })
            })
            .transpose();
        let (gpu, gpu_warning) = match selection {
            Ok(gpu) => (gpu, None),
            Err(warning) => (None, Some(warning)),
        };
        Self {
            system,
            host,
            cpu_refreshed: Instant::now(),
            gpu,
            gpu_warning,
        }
    }

    fn sample(&mut self, session: &str, seq: u32) -> (MonitorSample, Option<String>) {
        let cpu_pct = if self.cpu_refreshed.elapsed() >= sysinfo::MINIMUM_CPU_UPDATE_INTERVAL {
            self.system.refresh_cpu_usage();
            self.cpu_refreshed = Instant::now();
            percentage(self.system.global_cpu_usage())
        } else {
            None
        };
        self.system
            .refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        let total = self.system.total_memory();
        let mut sample = MonitorSample {
            v: 1,
            session: session.to_owned(),
            seq,
            host: self.host.clone(),
            cpu_pct,
            ram_used: total.saturating_sub(self.system.available_memory()),
            ram_total: total,
            gpu_name: self
                .gpu
                .as_ref()
                .map(|(_, _, name)| name.clone())
                .unwrap_or_default(),
            gpu_pct: None,
            vram_used: None,
            vram_total: None,
            gpu_temp_c: None,
        };
        let mut warning = self.gpu_warning.clone();
        if let Some((driver, uuid, _)) = &self.gpu {
            match driver.device_by_uuid(uuid.as_str()) {
                Ok(device) => {
                    match device.utilization_rates() {
                        Ok(usage) => sample.gpu_pct = percentage(usage.gpu as f32),
                        Err(error) => warning = Some(format!("GPU 占用率不可用：{error}")),
                    }
                    match device.memory_info() {
                        Ok(memory) if valid_gpu_memory(memory.used, memory.total) => {
                            sample.vram_used = Some(memory.used);
                            sample.vram_total = Some(memory.total);
                        }
                        Ok(_) => {
                            // WDDM may report NVML_VALUE_NOT_AVAILABLE in `used`.
                            warning.get_or_insert_with(|| "显卡驱动未提供有效的显存容量".into());
                        }
                        Err(error) => {
                            warning.get_or_insert_with(|| format!("显存指标不可用：{error}"));
                        }
                    }
                    match device.temperature(TemperatureSensor::Gpu) {
                        Ok(temperature) if temperature <= 250 => {
                            sample.gpu_temp_c = Some(temperature as f32);
                        }
                        Ok(_) => {
                            warning.get_or_insert_with(|| "显卡驱动未提供有效的 GPU 温度".into());
                        }
                        Err(error) => {
                            warning.get_or_insert_with(|| format!("GPU 温度不可用：{error}"));
                        }
                    }
                }
                Err(error) => warning = Some(format!("选定显卡暂时不可用：{error}")),
            }
        }
        (sample, warning)
    }
}

#[derive(Deserialize)]
struct Acknowledgment {
    v: u8,
    session: String,
    seq: u32,
    ack: bool,
}

fn newer_sequence(sequence: u32, previous: u32) -> bool {
    let delta = sequence.wrapping_sub(previous);
    delta != 0 && delta < (1 << 31)
}

fn matching_ack(
    bytes: &[u8],
    session: &str,
    pending: &VecDeque<(u32, Instant)>,
    last_acked: Option<u32>,
) -> Option<u32> {
    let ack: Acknowledgment = serde_json::from_slice(bytes).ok()?;
    (ack.v == 1
        && ack.ack
        && ack.session == session
        && last_acked.is_none_or(|previous| newer_sequence(ack.seq, previous))
        && pending
            .iter()
            .any(|(seq, sent)| *seq == ack.seq && sent.elapsed() <= STALE_AFTER))
    .then_some(ack.seq)
}

fn run_worker(
    mut poll: Poll,
    socket: mio::net::UdpSocket,
    config: MonitorConfig,
    session: String,
    shared: Arc<Mutex<Shared>>,
    driver: NvmlCache,
    stopped: mpsc::Receiver<()>,
) {
    // A CPU/RAM-only sender must not load or initialize the GPU driver library.
    let gpu_driver = config.gpu_enabled.then(|| nvml(&driver));
    let mut sampler = Sampler::new(gpu_driver, config.gpu_uuid.as_deref());
    let interval = Duration::from_millis(config.interval_ms);
    let mut next_sample = Instant::now();
    let mut sequence = 0_u32;
    let mut pending = VecDeque::new();
    let mut last_acked = None;
    let mut receive = [0_u8; MAX_PACKET_BYTES + 1];
    let mut events = Events::with_capacity(8);
    loop {
        match stopped.try_recv() {
            Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if Instant::now() >= next_sample {
            sequence = sequence.wrapping_add(1);
            let (sample, warning) = sampler.sample(&session, sequence);
            let sent = sample.wire_bytes().and_then(|bytes| {
                socket
                    .send(&bytes)
                    .map_err(|error| format!("监控数据发送失败，将继续重试：{error}"))
            });
            let mut state = lock(&shared);
            state.snapshot.sample = Some(sample);
            state.snapshot.last_error = sent.as_ref().err().cloned().or(warning);
            if let Ok(bytes) = sent {
                state.snapshot.samples_sent += 1;
                state.snapshot.bytes_sent += bytes as u64;
                pending.push_back((sequence, Instant::now()));
            }
            while pending
                .front()
                .is_some_and(|(_, sent)| sent.elapsed() > STALE_AFTER)
                || pending.len() > 32
            {
                pending.pop_front();
            }
            next_sample = Instant::now() + interval;
        }
        // A connected UDP socket filters replies to the configured MCU endpoint.
        // Limit each drain so malformed traffic cannot starve Stop or sampling.
        for _ in 0..32 {
            match socket.recv(&mut receive) {
                Ok(length) if length < MAX_PACKET_BYTES => {
                    if let Some(acknowledged) =
                        matching_ack(&receive[..length], &session, &pending, last_acked)
                    {
                        last_acked = Some(acknowledged);
                        lock(&shared).last_ack = Some(Instant::now());
                    }
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => break,
                Err(error) => {
                    lock(&shared).snapshot.last_error =
                        Some(format!("监控回执接收失败，将继续重试：{error}"));
                    break;
                }
            }
        }
        // Sleep until an ACK, cancellation, or the next sample. No 20 ms polling
        // timer is left running while the application lives only in the tray.
        let wait = next_sample.saturating_duration_since(Instant::now());
        if let Err(error) = poll.poll(&mut events, Some(wait)) {
            if error.kind() != std::io::ErrorKind::Interrupted {
                lock(&shared).snapshot.last_error = Some(format!("监控网络事件失败：{error}"));
                break;
            }
        }
    }
    lock(&shared).snapshot.running = false;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> MonitorConfig {
        MonitorConfig {
            target_ip: "127.0.0.1".into(),
            gpu_enabled: true,
            gpu_uuid: None,
            interval_ms: 500,
        }
    }

    #[test]
    fn config_defaults_and_validation() {
        let parsed: MonitorConfig = serde_json::from_str(r#"{"targetIp":"192.168.4.1"}"#)
            .expect("config without optional fields");
        assert_eq!(parsed.interval_ms, 500);
        assert_eq!(parsed.gpu_uuid, None);
        assert!(
            parsed.gpu_enabled,
            "legacy configurations retain GPU sampling"
        );
        let disabled: MonitorConfig = serde_json::from_str(
            r#"{"targetIp":"192.168.4.1","gpuEnabled":false,"gpuUuid":"GPU-saved"}"#,
        )
        .unwrap();
        assert!(!disabled.gpu_enabled);
        assert_eq!(
            disabled.normalized().unwrap().0.gpu_uuid.as_deref(),
            Some("GPU-saved")
        );
        for ip in [
            "",
            "device.local",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
        ] {
            let mut config = config();
            config.target_ip = ip.into();
            assert!(config.normalized().is_err(), "invalid target {ip}");
        }
        for interval in [0, 249, 2001] {
            let mut config = config();
            config.interval_ms = interval;
            assert!(config.normalized().is_err());
        }
    }

    #[test]
    fn missing_gpu_keeps_memory_and_wire_contract() {
        let mut sampler = Sampler::new(Some(Err("No NVIDIA driver".into())), None);
        let (sample, warning) = sampler.sample(&new_session(), 1);
        assert_eq!(
            sample.cpu_pct, None,
            "first CPU sample establishes baseline"
        );
        assert_eq!(sample.gpu_pct, None);
        assert!(sample.ram_used <= sample.ram_total);
        assert!(warning.is_some());
        let bytes = sample.wire_bytes().unwrap();
        assert!(bytes.len() < MAX_PACKET_BYTES);
        let wire: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(wire["v"], 1);
        assert!(wire["cpu_pct"].is_null());
        assert!(wire.get("ram_used").is_some());
        assert!(wire.get("ramUsed").is_none());
        let frontend = serde_json::to_value(sample).unwrap();
        assert!(frontend.get("ramUsed").is_some());
        assert!(frontend.get("ram_used").is_none());
    }

    #[test]
    fn disabled_gpu_skips_driver_initialization_and_keeps_cpu_ram_and_acks() {
        let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let std::net::SocketAddr::V4(target) = receiver.local_addr().unwrap() else {
            unreachable!()
        };
        let monitor = Monitor::default();
        monitor
            .start_at(
                MonitorConfig {
                    gpu_enabled: false,
                    // A saved selection is retained but never queried when disabled.
                    gpu_uuid: Some("GPU-not-present".into()),
                    ..config()
                },
                target,
            )
            .unwrap();
        let mut bytes = [0; MAX_PACKET_BYTES];
        for sequence in 1..=2 {
            let (length, sender) = receiver.recv_from(&mut bytes).unwrap();
            let sample: serde_json::Value = serde_json::from_slice(&bytes[..length]).unwrap();
            assert_eq!(sample["seq"], sequence);
            assert_eq!(sample["gpu_name"], "");
            for key in ["gpu_pct", "vram_used", "vram_total", "gpu_temp_c"] {
                assert!(sample[key].is_null(), "disabled GPU field {key}");
            }
            assert!(sample["ram_total"].as_u64().unwrap() > 0);
            assert!(sample["ram_used"].as_u64().unwrap() <= sample["ram_total"].as_u64().unwrap());
            if sequence == 2 {
                let cpu = sample["cpu_pct"].as_f64().expect("CPU sampling continues");
                assert!((0.0..=100.0).contains(&cpu));
            }
            let ack = serde_json::json!({
                "v": 1, "session": sample["session"], "seq": sample["seq"], "ack": true
            });
            receiver
                .send_to(&serde_json::to_vec(&ack).unwrap(), sender)
                .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(1);
        while !monitor.snapshot().connected && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        let stopped = monitor.stop(None).unwrap();
        assert!(!stopped.gpu_enabled);
        assert_eq!(stopped.gpu_uuid.as_deref(), Some("GPU-not-present"));
        assert!(
            stopped.ack_age_ms.is_some(),
            "CPU-only packets are acknowledged"
        );
        assert!(
            stopped.last_error.is_none(),
            "disabled GPU has no driver warning"
        );
        assert!(monitor.nvml.get().is_none(), "NVML is never initialized");
    }

    #[test]
    fn acknowledgments_require_current_session_and_new_recent_sequence() {
        let mut pending = VecDeque::new();
        pending.push_back((1, Instant::now()));
        let ack = br#"{"v":1,"session":"current","seq":1,"ack":true}"#;
        assert_eq!(matching_ack(ack, "current", &pending, None), Some(1));
        assert_eq!(matching_ack(ack, "previous", &pending, None), None);
        assert_eq!(matching_ack(ack, "current", &pending, Some(1)), None);
        pending.clear();
        pending.push_back((1, Instant::now() - STALE_AFTER - Duration::from_millis(1)));
        assert_eq!(matching_ack(ack, "current", &pending, None), None);
        assert!(newer_sequence(0, u32::MAX));
        assert!(!newer_sequence(u32::MAX, 0));
    }

    #[test]
    fn snapshot_expires_without_waiting_and_stop_is_idempotent() {
        let monitor = Monitor::default();
        {
            let mut state = lock(&monitor.shared);
            state.snapshot.running = true;
            state.last_ack = Some(Instant::now());
        }
        assert!(monitor.snapshot().connected);
        lock(&monitor.shared).last_ack = Some(Instant::now() - Duration::from_secs(4));
        assert!(!monitor.snapshot().connected);
        assert!(!monitor.stop(None).unwrap().running);
        assert!(!monitor.stop(None).unwrap().running);
    }

    #[test]
    fn unavailable_gpu_memory_cannot_poison_a_cpu_and_ram_packet() {
        assert!(!valid_gpu_memory(u64::MAX, 8 << 30));
        assert!(!valid_gpu_memory(0, 0));
        assert!(valid_gpu_memory(0, 8 << 30));
        assert!(valid_gpu_memory(8 << 30, 8 << 30));
    }

    #[test]
    fn text_and_session_fit_embedded_buffers() {
        let session = new_session();
        assert_eq!(session.len(), 32);
        assert!(session.bytes().all(|byte| byte.is_ascii_graphic()));
        assert_ne!(session, new_session());
        assert_eq!(bounded_text("测试\n电脑", 7), "测试?");
        assert!(bounded_text(&"测".repeat(100), 63).len() <= 63);
    }

    #[test]
    fn udp_roundtrip_and_stale_stop_cannot_cancel_new_session() {
        let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let target = match receiver.local_addr().unwrap() {
            std::net::SocketAddr::V4(target) => target,
            _ => unreachable!(),
        };
        let monitor = Monitor::default();
        let started = monitor.start_at(config(), target).unwrap();
        let mut bytes = [0; MAX_PACKET_BYTES];
        let (length, sender) = receiver.recv_from(&mut bytes).unwrap();
        let sample: serde_json::Value = serde_json::from_slice(&bytes[..length]).unwrap();
        assert_eq!(sample["session"].as_str(), started.session_id.as_deref());
        assert!(!monitor.snapshot().connected);
        let ack = serde_json::json!({
            "v": 1, "session": sample["session"], "seq": sample["seq"], "ack": true
        });
        receiver
            .send_to(&serde_json::to_vec(&ack).unwrap(), sender)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !monitor.snapshot().connected && Instant::now() < deadline {
            thread::sleep(Duration::from_millis(10));
        }
        assert!(monitor.snapshot().connected);
        let restarted = monitor.start_at(config(), target).unwrap();
        assert_ne!(started.session_id, restarted.session_id);
        assert!(monitor.stop(started.session_id.as_deref()).is_err());
        assert!(monitor.snapshot().running);
        let stopping = Instant::now();
        let stopped = monitor.stop(restarted.session_id.as_deref()).unwrap();
        assert!(!stopped.running);
        assert!(!stopped.connected);
        assert!(stopping.elapsed() < Duration::from_millis(300));
    }

    #[test]
    fn sleeping_sender_is_interruptible_and_counts_only_sent_payload() {
        let receiver = UdpSocket::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        receiver
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let std::net::SocketAddr::V4(target) = receiver.local_addr().unwrap() else {
            unreachable!()
        };
        let monitor = Monitor::default();
        monitor
            .start_at(
                MonitorConfig {
                    interval_ms: 2000,
                    ..config()
                },
                target,
            )
            .unwrap();
        let mut bytes = [0; MAX_PACKET_BYTES];
        let length = receiver.recv(&mut bytes).unwrap();
        // Stop must wake the network wait instead of waiting for the 2 s sample.
        let stopping = Instant::now();
        let stopped = monitor.stop(None).unwrap();
        assert!(stopping.elapsed() < Duration::from_millis(300));
        assert_eq!(stopped.samples_sent, 1);
        assert_eq!(stopped.bytes_sent, length as u64);
        receiver
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        assert!(receiver.recv(&mut bytes).is_err());
    }
}
