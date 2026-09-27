//! Native ZX-D30 BLE UART. The session owns command ordering; this bridge
//! keeps asynchronous GATT operations off the synchronous session reader.
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::io;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use btleplug::api::{
    bleuuid::uuid_from_u16, Central, CharPropFlags, Characteristic, Manager as _, Peripheral as _,
    ScanFilter, WriteType,
};
use btleplug::platform::{Manager, Peripheral};
use futures_util::StreamExt;
use tokio::time::{sleep, timeout};

use crate::transport::Transport;
use crate::types::BluetoothDeviceOption;

const PACKET_SIZE: usize = 20;
const PACKET_GAP: Duration = Duration::from_millis(25);
// Match the mini-program's per-write timeout and queued-frame age. A late
// partial frame must never be completed by a later BLE write.
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_QUEUE_AGE: Duration = Duration::from_millis(350);
const WRITE_RESULT_TIMEOUT: Duration = Duration::from_secs(5);
const IO_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Clone)]
struct DiscoveredDevice {
    peripheral: Peripheral,
    label: String,
}

#[derive(Default)]
pub struct BluetoothState {
    devices: Mutex<BTreeMap<String, DiscoveredDevice>>,
    scanning: tokio::sync::Mutex<()>,
}

async fn bounded<T>(
    operation: impl std::future::Future<Output = btleplug::Result<T>>,
) -> Result<T, String> {
    timeout(IO_TIMEOUT, operation)
        .await
        .map_err(|_| "蓝牙系统响应超时，请检查适配器后重试".to_owned())?
        .map_err(|error| format!("蓝牙操作失败: {error}"))
}

impl BluetoothState {
    pub async fn scan(&self) -> Result<Vec<BluetoothDeviceOption>, String> {
        let _scan = self
            .scanning
            .try_lock()
            .map_err(|_| "正在扫描蓝牙设备，请稍候")?;
        let manager = bounded(Manager::new()).await?;
        let adapters = bounded(manager.adapters()).await?;
        if adapters.is_empty() {
            return Err("未找到蓝牙适配器；请打开系统蓝牙。Linux 需要运行 BlueZ 蓝牙服务".into());
        }
        let mut active = Vec::new();
        let mut last_error = String::new();
        for (index, adapter) in adapters.into_iter().enumerate() {
            match bounded(adapter.start_scan(ScanFilter::default())).await {
                Ok(()) => active.push((index, adapter)),
                Err(error) => last_error = error,
            }
        }
        if active.is_empty() {
            return Err(format!(
                "无法扫描，请开启系统蓝牙并授予蓝牙权限。{last_error}"
            ));
        }
        sleep(Duration::from_secs(4)).await;
        let mut devices = BTreeMap::new();
        let mut options = Vec::new();
        for (index, adapter) in active {
            // Stop discovery even when obtaining peripherals fails.
            let found = bounded(adapter.peripherals()).await;
            let _ = bounded(adapter.stop_scan()).await;
            if let Ok(peripherals) = found {
                for peripheral in peripherals {
                    let Ok(Some(properties)) = bounded(peripheral.properties()).await else {
                        continue;
                    };
                    let name = properties.local_name.unwrap_or_default();
                    // Keep renamed modules visible even when they omit service
                    // UUIDs in advertising. GATT validation happens on connect.
                    if !properties.services.contains(&uuid_from_u16(0xffe0)) && name.is_empty() {
                        continue;
                    }
                    let id = format!("{index}:{}", peripheral.id());
                    let name = if name.is_empty() {
                        "ZX-D30 / FFE0 设备".to_owned()
                    } else {
                        name
                    };
                    options.push(BluetoothDeviceOption {
                        id: id.clone(),
                        name: name.clone(),
                        address: properties.address.to_string(),
                        rssi: properties.rssi,
                    });
                    devices.insert(
                        id,
                        DiscoveredDevice {
                            peripheral,
                            label: name,
                        },
                    );
                }
            }
        }
        options.sort_by(|a, b| b.rssi.cmp(&a.rssi).then_with(|| a.name.cmp(&b.name)));
        *self.devices.lock().map_err(|_| "蓝牙发现状态已损坏")? = devices;
        Ok(options)
    }

    pub fn open(&self, id: &str) -> Result<BluetoothTransport, String> {
        let device = self
            .devices
            .lock()
            .map_err(|_| "蓝牙发现状态已损坏")?
            .get(id)
            .cloned()
            .ok_or("所选蓝牙设备不在扫描列表中，请重新扫描")?;
        BluetoothTransport::open(device)
    }
}

fn uart_frame(command: &str) -> Result<String, String> {
    if command.is_empty()
        || command.len() > 32
        || command
            .bytes()
            .any(|byte| !(0x20..=0x7e).contains(&byte) || byte == b'@')
    {
        return Err("蓝牙命令必须为 1–32 字节 ASCII 正文，不能包含帧分隔符".into());
    }
    Ok(format!("@{command}\n"))
}

fn uart_characteristics(
    chars: &BTreeSet<Characteristic>,
) -> Result<(Characteristic, Characteristic, WriteType), String> {
    let uart = |c: &&Characteristic| c.service_uuid == uuid_from_u16(0xffe0);
    let writable = CharPropFlags::WRITE | CharPropFlags::WRITE_WITHOUT_RESPONSE;
    let write = [0xffe2, 0xffe1]
        .into_iter()
        .find_map(|id| {
            chars
                .iter()
                .filter(uart)
                .find(|c| c.uuid == uuid_from_u16(id) && c.properties.intersects(writable))
                .cloned()
        })
        .ok_or("设备缺少 FFE0 / FFE2（或 FFE1）可写透传通道；不使用 FFE3 IO 控制通道")?;
    let notify = chars
        .iter()
        .filter(uart)
        .find(|c| {
            c.uuid == uuid_from_u16(0xffe1)
                && c.properties
                    .intersects(CharPropFlags::NOTIFY | CharPropFlags::INDICATE)
        })
        .cloned()
        .ok_or("设备缺少 FFE1 返回通知通道")?;
    let write_type = if write.properties.contains(CharPropFlags::WRITE) {
        WriteType::WithResponse
    } else {
        WriteType::WithoutResponse
    };
    Ok((write, notify, write_type))
}

async fn write_packets<F, Fut>(
    frame: &[u8],
    queued_at: tokio::time::Instant,
    mut write: F,
) -> Result<(), String>
where
    F: FnMut(Vec<u8>) -> Fut,
    Fut: std::future::Future<Output = Result<(), String>>,
{
    for (index, packet) in frame.chunks(PACKET_SIZE).enumerate() {
        if index > 0 && queued_at.elapsed() > MAX_QUEUE_AGE {
            return Err("蓝牙分片等待超过 350 ms，已取消剩余数据".into());
        }
        timeout(WRITE_TIMEOUT, write(packet.to_vec()))
            .await
            .map_err(|_| "蓝牙单片写入超过 2 秒，连接已中止".to_owned())??;
        sleep(PACKET_GAP).await;
    }
    Ok(())
}

struct WriteRequest {
    frame: String,
    queued_at: tokio::time::Instant,
    reply: mpsc::SyncSender<Result<(), String>>,
}

struct BleLink {
    commands: Option<tokio::sync::mpsc::Sender<WriteRequest>>,
    received: Mutex<mpsc::Receiver<Vec<u8>>>,
    finished: Mutex<mpsc::Receiver<()>>,
    alive: Arc<AtomicBool>,
    failure: Arc<Mutex<String>>,
}

impl Drop for BleLink {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.commands.take();
        if let Ok(finished) = self.finished.lock() {
            let _ = finished.recv_timeout(Duration::from_secs(3));
        }
    }
}

pub struct BluetoothTransport {
    label: String,
    link: Arc<BleLink>,
    pending: VecDeque<u8>,
}

impl BluetoothTransport {
    fn open(device: DiscoveredDevice) -> Result<Self, String> {
        let (commands, mut requests) = tokio::sync::mpsc::channel::<WriteRequest>(1);
        let (received, receiver) = mpsc::sync_channel(128);
        let (ready, readiness) = mpsc::sync_channel(1);
        let (finished, completion) = mpsc::sync_channel(1);
        let alive = Arc::new(AtomicBool::new(true));
        let failure = Arc::new(Mutex::new("蓝牙连接已断开，请重新扫描连接".to_owned()));
        let actor_alive = Arc::clone(&alive);
        let actor_failure = Arc::clone(&failure);
        let peripheral = device.peripheral;
        tauri::async_runtime::spawn(async move {
            let result: Result<(), String> = async {
                let setup = timeout(Duration::from_secs(10), async {
                    peripheral.connect().await.map_err(|e| format!("蓝牙连接失败: {e}"))?;
                    peripheral.discover_services().await.map_err(|e| format!("蓝牙服务发现失败: {e}"))?;
                    let (write, notify, write_type) = uart_characteristics(&peripheral.characteristics())?;
                    let notifications = peripheral.notifications().await.map_err(|e| format!("无法接收蓝牙通知: {e}"))?;
                    peripheral.subscribe(&notify).await.map_err(|e| format!("订阅 FFE1 失败: {e}"))?;
                    Ok::<_, String>((write, notify, write_type, notifications))
                }).await.map_err(|_| "蓝牙连接超时；请确认模块已上电，且未被微信或其他应用占用".to_owned())??;
                let (write, notify, write_type, mut notifications) = setup;
                ready.send(Ok(())).map_err(|_| "蓝牙连接已取消".to_owned())?;
                let mut heartbeat = tokio::time::interval(Duration::from_millis(250));
                loop {
                    if !actor_alive.load(Ordering::Acquire) { return Ok(()); }
                    tokio::select! {
                        request = requests.recv() => {
                            let Some(request) = request else { return Ok(()) };
                            if !actor_alive.load(Ordering::Acquire) { return Ok(()); }
                            if request.queued_at.elapsed() > MAX_QUEUE_AGE {
                                return Err("蓝牙命令等待超过 350 ms，已丢弃并断开连接".into());
                            }
                            let result = write_packets(request.frame.as_bytes(), request.queued_at, |packet| {
                                let peripheral = &peripheral;
                                let write = &write;
                                let alive = &actor_alive;
                                async move {
                                    if !alive.load(Ordering::Acquire) { return Err("蓝牙发送已取消".into()); }
                                    peripheral.write(write, &packet, write_type).await.map_err(|e| format!("蓝牙写入失败: {e}"))
                                }
                            }).await;
                            let _ = request.reply.send(result.clone());
                            result?;
                        }
                        notification = notifications.next() => {
                            let notification = notification.ok_or("蓝牙通知通道已关闭")?;
                            if notification.uuid == notify.uuid && !notification.value.is_empty() {
                                received.try_send(notification.value).map_err(|_| "蓝牙接收队列已满或关闭，连接已停止")?;
                            }
                        }
                        _ = heartbeat.tick() => {
                            if !bounded(peripheral.is_connected()).await? { return Err("蓝牙设备已断开，请重新连接".into()); }
                        }
                    }
                }
            }.await;
            if let Err(reason) = result {
                *actor_failure.lock().unwrap_or_else(|e| e.into_inner()) = reason.clone();
                let _ = ready.try_send(Err(reason));
            }
            actor_alive.store(false, Ordering::Release);
            let _ = bounded(peripheral.disconnect()).await;
            let _ = finished.send(());
        });
        let link = Arc::new(BleLink {
            commands: Some(commands),
            received: Mutex::new(receiver),
            finished: Mutex::new(completion),
            alive,
            failure,
        });
        readiness
            .recv_timeout(Duration::from_secs(12))
            .map_err(|_| "等待蓝牙连接超时".to_owned())??;
        Ok(Self {
            label: format!("{} · BLE", device.label),
            link,
            pending: VecDeque::new(),
        })
    }

    fn ensure_alive(&self) -> Result<(), String> {
        if self.link.alive.load(Ordering::Acquire) {
            Ok(())
        } else {
            Err(self
                .link
                .failure
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clone())
        }
    }
}

impl Transport for BluetoothTransport {
    fn label(&self) -> &str {
        &self.label
    }

    fn write_command(&mut self, command: &str) -> Result<(), String> {
        self.ensure_alive()?;
        let frame = uart_frame(command)?;
        let (reply, response) = mpsc::sync_channel(1);
        self.link
            .commands
            .as_ref()
            .ok_or("蓝牙连接已关闭")?
            .try_send(WriteRequest {
                frame,
                reply,
                queued_at: tokio::time::Instant::now(),
            })
            .map_err(|_| "蓝牙写入队列忙或连接已关闭")?;
        match response.recv_timeout(WRITE_RESULT_TIMEOUT) {
            Ok(result) => result,
            Err(_) => {
                self.link.alive.store(false, Ordering::Release);
                Err("蓝牙写入超时，连接已停止；请重新连接".into())
            }
        }
    }

    fn read_chunk(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.ensure_alive()
            .map_err(|e| io::Error::new(io::ErrorKind::ConnectionAborted, e))?;
        if buffer.is_empty() {
            return Ok(0);
        }
        if self.pending.is_empty() {
            let receiver = self
                .link
                .received
                .lock()
                .map_err(|_| io::Error::other("蓝牙读取状态已损坏"))?;
            let chunk = receiver
                .recv_timeout(Duration::from_millis(40))
                .map_err(|e| match e {
                    mpsc::RecvTimeoutError::Timeout => {
                        io::Error::new(io::ErrorKind::TimedOut, "等待蓝牙通知")
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        io::Error::new(io::ErrorKind::ConnectionAborted, "蓝牙通知已断开")
                    }
                })?;
            self.pending.extend(chunk);
        }
        let count = buffer.len().min(self.pending.len());
        for slot in &mut buffer[..count] {
            *slot = self.pending.pop_front().unwrap_or_default();
        }
        Ok(count)
    }

    fn try_clone_box(&self) -> Result<Box<dyn Transport>, String> {
        self.ensure_alive()?;
        Ok(Box::new(Self {
            label: self.label.clone(),
            link: Arc::clone(&self.link),
            pending: VecDeque::new(),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn characteristic(id: u16, properties: CharPropFlags) -> Characteristic {
        Characteristic {
            uuid: uuid_from_u16(id),
            service_uuid: uuid_from_u16(0xffe0),
            properties,
            descriptors: BTreeSet::new(),
        }
    }

    #[test]
    fn uses_uart_channel_and_never_gpio() {
        let mut chars = BTreeSet::from([
            characteristic(0xffe1, CharPropFlags::NOTIFY | CharPropFlags::WRITE),
            characteristic(0xffe2, CharPropFlags::WRITE_WITHOUT_RESPONSE),
            characteristic(0xffe3, CharPropFlags::WRITE),
        ]);
        let (write, notify, kind) = uart_characteristics(&chars).unwrap();
        assert_eq!(write.uuid, uuid_from_u16(0xffe2));
        assert_eq!(notify.uuid, uuid_from_u16(0xffe1));
        assert!(matches!(kind, WriteType::WithoutResponse));
        chars.retain(|c| c.uuid != uuid_from_u16(0xffe2));
        assert_eq!(
            uart_characteristics(&chars).unwrap().0.uuid,
            uuid_from_u16(0xffe1)
        );
        chars.retain(|c| c.uuid != uuid_from_u16(0xffe1));
        assert!(uart_characteristics(&chars).is_err());
    }

    #[test]
    fn explicit_frames_reject_injection_and_oversize_bodies() {
        assert_eq!(
            uart_frame("R -100 -100 -18 78.5").unwrap(),
            "@R -100 -100 -18 78.5\n"
        );
        assert_eq!(uart_frame(&"a".repeat(32)).unwrap().len(), 34);
        for invalid in [
            "",
            "@R 0 0 0 60",
            "ping\nping",
            "ping\r",
            "中文",
            &"a".repeat(33),
        ] {
            assert!(uart_frame(invalid).is_err());
        }
    }

    #[tokio::test]
    async fn packets_preserve_complete_frame_and_abort_on_failure() {
        let frame = uart_frame("R -100.0 -100.0 -18.0 78.5").unwrap();
        let mut packets = Vec::new();
        write_packets(frame.as_bytes(), tokio::time::Instant::now(), |packet| {
            packets.push(packet);
            async { Ok(()) }
        })
        .await
        .unwrap();
        assert_eq!(packets.concat(), frame.as_bytes());
        assert_eq!(packets[0].len(), 20);
        let mut writes = 0;
        assert!(
            write_packets(frame.as_bytes(), tokio::time::Instant::now(), |_| {
                writes += 1;
                async { Err("断开".into()) }
            })
            .await
            .is_err()
        );
        assert_eq!(writes, 1);
    }

    #[tokio::test]
    async fn a_slow_single_packet_can_complete_after_200_ms() {
        let mut writes = 0;
        write_packets(b"@rollbias 0.0\n", tokio::time::Instant::now(), |_| {
            writes += 1;
            async {
                sleep(Duration::from_millis(400)).await;
                Ok(())
            }
        })
        .await
        .unwrap();
        assert_eq!(writes, 1);
    }

    #[tokio::test]
    async fn a_late_first_packet_never_sends_the_tail() {
        let mut writes = 0;
        let result = write_packets(&[b'a'; 34], tokio::time::Instant::now(), |_| {
            writes += 1;
            async {
                sleep(Duration::from_millis(400)).await;
                Ok(())
            }
        })
        .await;
        assert!(result.unwrap_err().contains("350 ms"));
        assert_eq!(writes, 1);
    }

    #[tokio::test]
    async fn a_timed_out_write_never_sends_the_tail() {
        let mut writes = 0;
        let result = write_packets(&[b'a'; 34], tokio::time::Instant::now(), |_| {
            writes += 1;
            async {
                sleep(Duration::from_secs(3)).await;
                Ok(())
            }
        })
        .await;
        assert!(result.unwrap_err().contains("2 秒"));
        assert_eq!(writes, 1);
    }

    #[test]
    fn notifications_keep_unread_bytes_and_fail_immediately_after_disconnect() {
        let (received, receiver) = mpsc::sync_channel(2);
        let (finished, completion) = mpsc::sync_channel(1);
        finished.send(()).unwrap();
        let alive = Arc::new(AtomicBool::new(true));
        let link = Arc::new(BleLink {
            commands: None,
            received: Mutex::new(receiver),
            finished: Mutex::new(completion),
            alive: Arc::clone(&alive),
            failure: Arc::new(Mutex::new("测试断连".into())),
        });
        let mut transport = BluetoothTransport {
            label: "TEST".into(),
            link,
            pending: VecDeque::new(),
        };
        received.send(b"1,2,3\nA: 4 B: 5\n".to_vec()).unwrap();
        let mut decoded = Vec::new();
        let mut buffer = [0; 3];
        while decoded.len() < 16 {
            let count = transport.read_chunk(&mut buffer).unwrap();
            decoded.extend_from_slice(&buffer[..count]);
        }
        assert_eq!(decoded, b"1,2,3\nA: 4 B: 5\n");
        received.send(b"late\n".to_vec()).unwrap();
        alive.store(false, Ordering::Release);
        assert_eq!(
            transport.read_chunk(&mut buffer).unwrap_err().kind(),
            io::ErrorKind::ConnectionAborted
        );
        assert!(transport.write_command("R 0 0 0 60").is_err());
    }

    /// Explicitly opt-in; discovers devices without connecting or writing.
    #[test]
    #[ignore = "requires a local Bluetooth adapter; discovery only"]
    fn bluetooth_scan_smoke() {
        let devices = tauri::async_runtime::block_on(BluetoothState::default().scan()).unwrap();
        println!(
            "BLE discovery completed: {} device(s), {} ZX-D30 name(s)",
            devices.len(),
            devices
                .iter()
                .filter(|device| device.name.to_ascii_uppercase().contains("D30"))
                .count()
        );
    }
}
