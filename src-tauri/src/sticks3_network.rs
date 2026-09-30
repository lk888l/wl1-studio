//! StickS3 discovery and owned CMSIS-DAP TCP transport for the shared flash engine.
use std::collections::BTreeMap;
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, Shutdown, SocketAddr, SocketAddrV4, TcpStream, UdpSocket};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use probe_rs::probe::{
    cmsisdap::{CmsisDap, CmsisDapTransport},
    Probe,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

const DISCOVERY_PORT: u16 = 4442;
const DISCOVERY_QUERY: &[u8] = b"STICKS3_DAP_V1?";
const DISCOVERY_REPLY: &[u8] = b"STICKS3_DAP_V1!";
const PACKET_SIZE: usize = 64;

#[derive(Default)]
pub struct StickS3NetworkState(Mutex<()>);

impl StickS3NetworkState {
    pub fn ensure_idle(&self) -> Result<(), String> {
        let _guard = self.0.try_lock().map_err(|_| "请等待网络设备查找完成")?;
        Ok(())
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NetworkDevice {
    pub host: String,
    pub port: u16,
    pub serial: String,
}

impl NetworkDevice {
    pub fn probe_id(&self) -> String {
        format!("tcp:{}:{}:{}", self.host, self.port, self.serial)
    }
    pub fn validate(&self) -> Result<(), String> {
        if ipv4(&self.host)?.to_string() != self.host
            || self.port == 0
            || !valid_serial(&self.serial)
        {
            return Err("无线探针地址或序列号无效，请重新查找".into());
        }
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkProbe {
    #[serde(flatten)]
    device: NetworkDevice,
    vendor: String,
    product: String,
    firmware_version: String,
    swd: bool,
    jtag: bool,
    packet_size: u16,
}

fn ipv4(host: &str) -> Result<Ipv4Addr, String> {
    let ip: Ipv4Addr = host
        .trim()
        .parse()
        .map_err(|_| "请输入设备的 IPv4 地址，例如 192.168.1.123；不要包含 http:// 或端口")?;
    if ip.octets()[0] == 0 || ip.octets()[0] >= 224 {
        return Err("请输入单台设备的 IPv4 地址，不能使用广播或组播地址".into());
    }
    Ok(ip)
}

fn valid_serial(serial: &str) -> bool {
    serial.len() == 12
        && serial
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'A'..=b'F').contains(&byte))
}

fn discovery_reply(data: &[u8], source: SocketAddr) -> Option<NetworkDevice> {
    let SocketAddr::V4(source) = source else {
        return None;
    };
    if source.port() != DISCOVERY_PORT || data.len() != 29 || !data.starts_with(DISCOVERY_REPLY) {
        return None;
    }
    let serial = std::str::from_utf8(&data[15..27]).ok()?;
    let port = u16::from_be_bytes([data[27], data[28]]);
    if !valid_serial(serial) || port == 0 || ipv4(&source.ip().to_string()).is_err() {
        return None;
    }
    Some(NetworkDevice {
        host: source.ip().to_string(),
        port,
        serial: serial.into(),
    })
}

fn discover() -> Result<Vec<NetworkDevice>, String> {
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| format!("无法开启局域网搜索：{error}"))?;
    socket
        .set_broadcast(true)
        .map_err(|error| error.to_string())?;
    socket
        .set_read_timeout(Some(Duration::from_millis(100)))
        .map_err(|error| error.to_string())?;
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut next_send = Instant::now();
    let mut devices = BTreeMap::new();
    // Larger than the protocol packet, so truncated oversized datagrams cannot match.
    let mut buffer = [0; 256];
    while Instant::now() < deadline {
        if Instant::now() >= next_send {
            socket
                .send_to(DISCOVERY_QUERY, (Ipv4Addr::BROADCAST, DISCOVERY_PORT))
                .map_err(|error| format!("无法发送局域网搜索，请直接输入 IP：{error}"))?;
            next_send = Instant::now() + Duration::from_millis(500);
        }
        match socket.recv_from(&mut buffer) {
            Ok((length, source)) => {
                if let Some(device) = discovery_reply(&buffer[..length], source) {
                    if devices.len() < 32 {
                        devices.entry(device.serial.clone()).or_insert(device);
                    }
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
                ) => {}
            Err(error) => return Err(format!("局域网搜索失败：{error}")),
        }
    }
    Ok(devices.into_values().collect())
}

fn remaining(deadline: Instant) -> Result<Duration, String> {
    deadline
        .checked_duration_since(Instant::now())
        .filter(|duration| !duration.is_zero())
        .ok_or_else(|| "DAP 身份查询超时；请确认 W-DAP 已开启且没有其他调试客户端占用".into())
}

fn read_exact(
    stream: &mut TcpStream,
    mut buffer: &mut [u8],
    deadline: Instant,
) -> Result<(), String> {
    while !buffer.is_empty() {
        stream
            .set_read_timeout(Some(remaining(deadline)?))
            .map_err(|error| error.to_string())?;
        match stream.read(buffer) {
            Ok(0) => {
                return Err(
                    "设备关闭了 DAP 连接；请保持 W-DAP 开启，并关闭占用它的 OpenOCD / IDE".into(),
                )
            }
            Ok(length) => buffer = &mut buffer[length..],
            Err(error) if error.kind() == ErrorKind::Interrupted => continue,
            Err(error) => {
                return Err(format!(
                    "读取 DAP 响应失败，请检查 W-DAP 和网络连接：{error}"
                ))
            }
        }
    }
    Ok(())
}

fn info(stream: &mut TcpStream, id: u8, deadline: Instant) -> Result<Vec<u8>, String> {
    stream
        .set_write_timeout(Some(remaining(deadline)?))
        .map_err(|error| error.to_string())?;
    stream
        .write_all(&[b'D', b'A', b'P', 0, 2, 0, 1, 0, 0, id])
        .map_err(|error| format!("发送 DAP 身份查询失败：{error}"))?;
    let mut header = [0; 8];
    read_exact(stream, &mut header, deadline)?;
    let size = usize::from(u16::from_le_bytes([header[4], header[5]]));
    if header[..4] != *b"DAP\0"
        || header[6] != 2
        || header[7] != 0
        || !(2..=PACKET_SIZE).contains(&size)
    {
        return Err("设备返回了无效的 CMSIS-DAP TCP 帧".into());
    }
    let mut payload = vec![0; size];
    read_exact(stream, &mut payload, deadline)?;
    if payload[0] != 0 || usize::from(payload[1]) != size - 2 {
        return Err("设备返回了无效的 DAP_Info 响应".into());
    }
    Ok(payload[2..].to_vec())
}

fn info_text(stream: &mut TcpStream, id: u8, deadline: Instant) -> Result<String, String> {
    let value = info(stream, id, deadline)?;
    // Firmware includes a terminator (older builds can include an extra NUL).
    let text = std::str::from_utf8(&value)
        .map_err(|_| "DAP 身份字段不是 UTF-8")?
        .trim_end_matches('\0');
    if text.is_empty() || text.chars().any(char::is_control) {
        return Err("DAP 身份字段为空或包含无效字符".into());
    }
    Ok(text.into())
}

fn probe(host: &str, port: u16, expected_serial: Option<&str>) -> Result<NetworkProbe, String> {
    connect_and_probe(host, port, expected_serial).map(|(_, info)| info)
}

fn connect_and_probe(
    host: &str,
    port: u16,
    expected_serial: Option<&str>,
) -> Result<(TcpStream, NetworkProbe), String> {
    let ip = ipv4(host)?;
    if port == 0 || expected_serial.is_some_and(|serial| !valid_serial(serial)) {
        return Err("设备端口或预期序列号无效，请重新搜索".into());
    }
    let deadline = Instant::now() + Duration::from_secs(5);
    let address = SocketAddr::V4(SocketAddrV4::new(ip, port));
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_secs(2))
        .map_err(|error| format!("无法连接 {address}。请确认电脑与 S3 在同一网络、设备已打开 W-DAP，且调试端口未被占用：{error}"))?;
    stream
        .set_nodelay(true)
        .map_err(|error| error.to_string())?;
    let vendor = info_text(&mut stream, 1, deadline)?;
    let product = info_text(&mut stream, 2, deadline)?;
    let serial = info_text(&mut stream, 3, deadline)?;
    if vendor != "M5StickS3" || product != "StickS3 CMSIS-DAP" || !valid_serial(&serial) {
        return Err("该地址未返回受支持的 StickS3 CMSIS-DAP 身份，请核对 IP 和固件".into());
    }
    if expected_serial.is_some_and(|expected| expected != serial) {
        return Err("设备序列号与搜索结果不一致，IP 可能已变化；请重新搜索".into());
    }
    let firmware_version = info_text(&mut stream, 4, deadline)?;
    let capabilities = info(&mut stream, 0xf0, deadline)?;
    let size = info(&mut stream, 0xff, deadline)?;
    if !(1..=2).contains(&capabilities.len()) || size.len() != 2 {
        return Err("DAP 能力或包大小字段无效".into());
    }
    let packet_size = u16::from_le_bytes([size[0], size[1]]);
    if usize::from(packet_size) != PACKET_SIZE || capabilities[0] & 3 == 0 {
        return Err("当前固件的 DAP 包大小或 SWD/JTAG 能力不兼容".into());
    }
    Ok((
        stream,
        NetworkProbe {
            device: NetworkDevice {
                host: ip.to_string(),
                port,
                serial,
            },
            vendor,
            product,
            firmware_version,
            swd: capabilities[0] & 1 != 0,
            jtag: capabilities[0] & 2 != 0,
            packet_size,
        },
    ))
}

/// Own the exact socket whose serial was verified, including all target commands.
/// Any failed/ambiguous exchange poisons it permanently; Drop cannot replay writes.
#[derive(Debug)]
struct DapTcp {
    stream: Option<TcpStream>,
}

impl CmsisDapTransport for DapTcp {
    fn exchange(&mut self, request: &[u8], response: &mut [u8]) -> std::io::Result<usize> {
        let stream = self.stream.as_mut().ok_or_else(|| {
            std::io::Error::new(ErrorKind::NotConnected, "DAP 网络会话已失效，请重新连接")
        })?;
        let result = (|| {
            if request.is_empty() || request.len() > PACKET_SIZE || request[0] == 0x07 {
                return Err("无效的 DAP 请求，或此命令没有应答".to_string());
            }
            let deadline = Instant::now() + Duration::from_secs(3);
            let mut frame = vec![b'D', b'A', b'P', 0, request.len() as u8, 0, 1, 0];
            frame.extend_from_slice(request);
            stream
                .set_write_timeout(Some(remaining(deadline)?))
                .map_err(|error| error.to_string())?;
            stream
                .write_all(&frame)
                .map_err(|error| error.to_string())?;
            let mut header = [0; 8];
            read_exact(stream, &mut header, deadline)?;
            let size = usize::from(u16::from_le_bytes([header[4], header[5]]));
            if header[..4] != *b"DAP\0"
                || header[6] != 2
                || header[7] != 0
                || !(1..=PACKET_SIZE).contains(&size)
                || size > response.len()
            {
                return Err("无效的 CMSIS-DAP TCP 响应帧".into());
            }
            read_exact(stream, &mut response[..size], deadline)?;
            if response[0] != request[0] {
                return Err("DAP 响应命令不匹配".into());
            }
            Ok(size)
        })();
        result.map_err(|error| {
            if let Some(stream) = self.stream.take() {
                let _ = stream.shutdown(Shutdown::Both);
            }
            std::io::Error::other(format!(
                "网络 DAP 传输失败：{error}；操作结果可能未知，连接已关闭且不会重发"
            ))
        })
    }
}

pub fn open_probe(device: &NetworkDevice) -> Result<Probe, String> {
    device.validate()?;
    let (stream, info) = connect_and_probe(&device.host, device.port, Some(&device.serial))?;
    let dap = CmsisDap::new_from_transport(
        Box::new(DapTcp {
            stream: Some(stream),
        }),
        usize::from(info.packet_size),
    )
    .map_err(|error| format!("无法初始化网络烧录器：{error}"))?;
    Ok(Probe::new(dap))
}

#[tauri::command]
pub async fn sticks3_network_discover(app: AppHandle) -> Result<Vec<NetworkDevice>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<crate::commands::ProductSessionLifecycle>();
        let lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
        let state = app.state::<StickS3NetworkState>();
        let _guard = state.0.try_lock().map_err(|_| "已有网络查找正在进行")?;
        app.state::<crate::firmware::FirmwareState>()
            .ensure_idle()?;
        drop(lifecycle);
        discover()
    })
    .await
    .map_err(|error| format!("网络查找任务中断：{error}"))?
}

#[tauri::command]
pub async fn sticks3_network_probe(
    app: AppHandle,
    host: String,
    port: u16,
    expected_serial: Option<String>,
) -> Result<NetworkProbe, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<crate::commands::ProductSessionLifecycle>();
        let lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
        let state = app.state::<StickS3NetworkState>();
        let _guard = state.0.try_lock().map_err(|_| "已有网络查找正在进行")?;
        app.state::<crate::firmware::FirmwareState>()
            .ensure_idle()?;
        drop(lifecycle);
        probe(&host, port, expected_serial.as_deref())
    })
    .await
    .map_err(|error| format!("DAP 身份查询任务中断：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;
    use std::thread;

    fn announcement() -> Vec<u8> {
        let mut data = DISCOVERY_REPLY.to_vec();
        data.extend_from_slice(b"14C19FD536F4");
        data.extend_from_slice(&4441_u16.to_be_bytes());
        data
    }

    #[test]
    fn discovery_validates_exact_packet_and_uses_source_ip() {
        let source = "172.18.7.163:4442".parse().unwrap();
        let data = announcement();
        assert_eq!(DISCOVERY_QUERY.len(), 15);
        assert_eq!(
            discovery_reply(&data, source),
            Some(NetworkDevice {
                host: "172.18.7.163".into(),
                port: 4441,
                serial: "14C19FD536F4".into(),
            })
        );
        for length in 0..data.len() {
            assert!(discovery_reply(&data[..length], source).is_none());
        }
        let mut extra = data.clone();
        extra.push(0);
        assert!(discovery_reply(&extra, source).is_none());
        for index in [0, 14, 15, 26] {
            let mut invalid = data.clone();
            invalid[index] = b'?';
            assert!(discovery_reply(&invalid, source).is_none());
        }
        let mut zero_port = data.clone();
        zero_port[27..].fill(0);
        assert!(discovery_reply(&zero_port, source).is_none());
        assert!(discovery_reply(&data, "172.18.7.163:4441".parse().unwrap()).is_none());
    }

    #[test]
    fn rejects_non_device_addresses() {
        assert_eq!(ipv4(" 172.18.7.163 ").unwrap().to_string(), "172.18.7.163");
        for host in [
            "",
            "localhost",
            "192.168.1",
            "192.168.01.1",
            "256.0.0.1",
            "http://192.168.1.1",
            "192.168.1.1:4441",
            "0.1.2.3",
            "224.0.0.1",
            "255.255.255.255",
            "::1",
        ] {
            assert!(ipv4(host).is_err(), "{host}");
        }
    }

    // A real TCP peer exercises split headers/bodies and checks that every
    // request is DAP_Info; no debug port is connected and EOF releases the socket.
    fn fake_probe(serial: &'static str) -> (u16, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            loop {
                let mut request = [0; 10];
                match stream.read_exact(&mut request) {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::UnexpectedEof => break,
                    Err(error) => panic!("{error}"),
                }
                assert_eq!(&request[..9], &[b'D', b'A', b'P', 0, 2, 0, 1, 0, 0]);
                let value = match request[9] {
                    1 => b"M5StickS3\0".to_vec(),
                    2 => b"StickS3 CMSIS-DAP\0\0".to_vec(),
                    3 => format!("{serial}\0").into_bytes(),
                    4 => b"2.1.2\0".to_vec(),
                    0xf0 => vec![0x23],
                    0xff => vec![64, 0],
                    id => panic!("Unexpected DAP_Info ID: {id}"),
                };
                let mut frame = vec![
                    b'D',
                    b'A',
                    b'P',
                    0,
                    (value.len() + 2) as u8,
                    0,
                    2,
                    0,
                    0,
                    value.len() as u8,
                ];
                frame.extend(value);
                for fragment in frame.chunks(3) {
                    stream.write_all(fragment).unwrap();
                }
            }
        });
        (port, worker)
    }

    #[test]
    fn tcp_probe_reads_identity_capabilities_and_releases_connection() {
        let (port, worker) = fake_probe("14C19FD536F4");
        let result = probe("127.0.0.1", port, Some("14C19FD536F4")).unwrap();
        assert!(result.swd && result.jtag);
        assert_eq!(result.packet_size, 64);
        assert_eq!(result.firmware_version, "2.1.2");
        assert_eq!(result.device.serial, "14C19FD536F4");
        worker.join().unwrap();
    }

    #[test]
    fn tcp_probe_rejects_changed_or_invalid_serial() {
        for serial in ["AABBCCDDEEFF", "bad-identity"] {
            let (port, worker) = fake_probe(serial);
            assert!(probe("127.0.0.1", port, Some("14C19FD536F4")).is_err());
            worker.join().unwrap();
        }
    }

    #[test]
    fn tcp_info_rejects_malformed_frames_and_truncation() {
        let bad_frames = [
            vec![b'D', b'A', b'P', 0, 65, 0, 2, 0], // Oversized payload.
            vec![b'D', b'A', b'P', 0, 2, 0, 1, 0, 0, 0], // Request masquerading as response.
            vec![b'D', b'A', b'P', 0, 2, 0, 2, 1, 0, 0], // Reserved bit.
            vec![b'D', b'A', b'P', 0, 2, 0, 2, 0, 0, 1], // Invalid inner length.
            vec![b'D', b'A', b'P', 0, 2, 0, 2, 0, 1, 0], // Wrong command.
            vec![b'D', b'A', b'P', 0, 8, 0, 2, 0, 0], // Truncated body.
            vec![b'H', b'T', b'T', b'P', 2, 0, 2, 0],
        ];
        for frame in bad_frames {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let address = listener.local_addr().unwrap();
            let worker = thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                let mut request = [0; 10];
                stream.read_exact(&mut request).unwrap();
                stream.write_all(&frame).unwrap();
            });
            let mut stream = TcpStream::connect(address).unwrap();
            assert!(info(&mut stream, 1, Instant::now() + Duration::from_secs(1)).is_err());
            worker.join().unwrap();
        }
    }

    #[test]
    fn slow_response_obeys_overall_deadline() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 10];
            stream.read_exact(&mut request).unwrap();
            for byte in b"DAP\0\x02\0\x02\0\0\0" {
                if stream.write_all(&[*byte]).is_err() {
                    break;
                }
                thread::sleep(Duration::from_millis(20));
            }
        });
        let mut stream = TcpStream::connect(address).unwrap();
        let start = Instant::now();
        assert!(info(&mut stream, 1, start + Duration::from_millis(50)).is_err());
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(stream);
        worker.join().unwrap();
    }

    fn engine_peer() -> (NetworkDevice, thread::JoinHandle<Vec<Vec<u8>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let device = NetworkDevice {
            host: "127.0.0.1".into(),
            port: listener.local_addr().unwrap().port(),
            serial: "14C19FD536F4".into(),
        };
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            stream.set_nodelay(true).unwrap();
            let mut requests = Vec::new();
            loop {
                let mut header = [0; 8];
                match stream.read_exact(&mut header) {
                    Ok(()) => {}
                    Err(error) if error.kind() == ErrorKind::UnexpectedEof => break,
                    Err(error) => panic!("{error}"),
                }
                assert_eq!(&header[..4], b"DAP\0");
                assert_eq!(&header[6..], &[1, 0]);
                let length = usize::from(u16::from_le_bytes([header[4], header[5]]));
                assert!((1..=64).contains(&length));
                let mut request = vec![0; length];
                stream.read_exact(&mut request).unwrap();
                let response = match request[0] {
                    0 => {
                        let info = match request[1] {
                            1 => b"M5StickS3\0".to_vec(),
                            2 => b"StickS3 CMSIS-DAP\0".to_vec(),
                            3 => b"14C19FD536F4\0".to_vec(),
                            4 => b"2.1.2\0".to_vec(),
                            0xf0 => vec![0x23],
                            0xfe => vec![1],
                            0xff => vec![64, 0],
                            id => panic!("unexpected info {id}"),
                        };
                        let mut response = vec![0, info.len() as u8];
                        response.extend(info);
                        response
                    }
                    2 | 0x10 => vec![request[0], request[1]],
                    1 | 3 | 4 | 0x11 | 0x13 => vec![request[0], 0],
                    command => panic!("unexpected command {command:#x}"),
                };
                requests.push(request);
                let mut frame = vec![b'D', b'A', b'P', 0, response.len() as u8, 0, 2, 0];
                frame.extend(response);
                for chunk in frame.chunks(3) {
                    stream.write_all(chunk).unwrap();
                }
            }
            requests
        });
        (device, worker)
    }

    #[test]
    fn shared_engine_uses_verified_socket_for_swd_and_jtag() {
        for protocol in [
            probe_rs::probe::WireProtocol::Swd,
            probe_rs::probe::WireProtocol::Jtag,
        ] {
            let (device, worker) = engine_peer();
            let mut probe = open_probe(&device).unwrap();
            probe.select_protocol(protocol).unwrap();
            probe.set_speed(100).unwrap();
            probe.attach_to_unspecified().unwrap();
            probe.detach().unwrap();
            drop(probe);
            let requests = worker.join().unwrap();
            let selected = if protocol == probe_rs::probe::WireProtocol::Swd {
                1
            } else {
                2
            };
            assert!(requests.iter().any(|request| request == &[2, selected]));
            assert_eq!(
                requests.iter().filter(|r| r.as_slice() == [0, 3]).count(),
                1
            );
            assert!(requests.iter().any(|r| r[0] == 3));
        }
    }

    #[test]
    fn shared_engine_refuses_changed_identity_before_target_commands() {
        let (mut device, worker) = engine_peer();
        device.serial = "AABBCCDDEEFF".into();
        assert!(open_probe(&device).unwrap_err().contains("序列号"));
        assert!(worker.join().unwrap().iter().all(|request| request[0] == 0));
    }

    #[test]
    fn ambiguous_write_failure_closes_socket_and_never_replays() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut frame = [0; 15];
            stream.read_exact(&mut frame).unwrap();
            assert_eq!(&frame[8..], &[5, 0, 1, 0, 1, 2, 3]);
            // Wrong response type after accepting a write: outcome is unknown.
            stream.write_all(b"DAP\0\x02\0\x01\0\x05\0").unwrap();
            let mut byte = [0];
            assert!(matches!(stream.read(&mut byte), Ok(0) | Err(_)));
        });
        let mut transport = DapTcp {
            stream: Some(TcpStream::connect(address).unwrap()),
        };
        let request = [5, 0, 1, 0, 1, 2, 3];
        assert!(transport.exchange(&request, &mut [0; 64]).is_err());
        assert_eq!(
            transport
                .exchange(&request, &mut [0; 64])
                .unwrap_err()
                .kind(),
            ErrorKind::NotConnected
        );
        worker.join().unwrap();
    }

    #[test]
    fn transport_accepts_full_size_split_responses() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let worker = thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut frame = [0; 72];
            stream.read_exact(&mut frame).unwrap();
            assert_eq!(&frame[..8], b"DAP\0\x40\0\x01\0");
            assert_eq!(&frame[8..], &[0x14; 64]);
            frame[6] = 2;
            for chunk in frame.chunks(5) {
                stream.write_all(chunk).unwrap();
            }
        });
        let mut transport = DapTcp {
            stream: Some(TcpStream::connect(address).unwrap()),
        };
        let mut response = [0; 64];
        assert_eq!(transport.exchange(&[0x14; 64], &mut response).unwrap(), 64);
        assert_eq!(response, [0x14; 64]);
        worker.join().unwrap();
    }

    #[test]
    #[ignore = "Requires STICKS3_TEST_IP and STICKS3_NO_TARGET=1; user must confirm no target is wired"]
    fn hardware_network_engine_modes() {
        assert_eq!(std::env::var("STICKS3_NO_TARGET").as_deref(), Ok("1"));
        let host = std::env::var("STICKS3_TEST_IP").unwrap();
        let device = probe(&host, 4441, None).unwrap().device;
        for protocol in [
            probe_rs::probe::WireProtocol::Swd,
            probe_rs::probe::WireProtocol::Jtag,
        ] {
            let mut probe =
                open_probe(&device).expect("Open shared engine with verified TCP transport");
            probe.select_protocol(protocol).unwrap();
            probe.set_speed(100).unwrap();
            probe
                .attach_to_unspecified()
                .expect("Initialize CMSIS-DAP port without attaching a target core");
            probe.detach().unwrap();
            drop(probe);
            println!("Shared engine {protocol:?} initialization, detach and socket release passed");
        }
    }

    #[test]
    #[ignore = "Requires an explicitly selected StickS3 with W-DAP open; identity queries only"]
    fn hardware_network_identity() {
        let host =
            std::env::var("STICKS3_TEST_IP").expect("Set STICKS3_TEST_IP to the authorized device");
        let result = probe(&host, 4441, None).expect("Read real DAP identity");
        assert!(result.swd && result.jtag);
        println!("{result:?}");
        // Immediate reuse verifies that the first query relinquished its TCP session.
        let again =
            probe(&host, 4441, Some(&result.device.serial)).expect("Reconnect to same probe");
        assert_eq!(again.device, result.device);
        let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        socket
            .send_to(DISCOVERY_QUERY, (ipv4(&host).unwrap(), DISCOVERY_PORT))
            .unwrap();
        let mut data = [0; 256];
        let (length, source) = socket.recv_from(&mut data).expect("UDP discovery response");
        assert_eq!(
            discovery_reply(&data[..length], source),
            Some(result.device)
        );
        println!("LAN broadcast results: {:?}", discover().unwrap());
    }
}
