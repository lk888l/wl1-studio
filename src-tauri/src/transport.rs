use std::io::{self, Read, Write};
use std::time::Duration;

use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

use crate::types::ConnectionTarget;

fn serial_frame(command: &str, target: ConnectionTarget) -> Result<String, String> {
    if target == ConnectionTarget::Remote {
        if command.len() > 31 {
            return Err("无线参数命令最多 31 字节，NRF24L01 帧需保留结尾空字节".into());
        }
        // The remote parses nrfsend before forwarding the inner payload over NRF.
        Ok(format!("nrfsend {command}\n"))
    } else {
        Ok(command.to_owned())
    }
}

fn command_gap(target: ConnectionTarget) -> Duration {
    Duration::from_millis(if target == ConnectionTarget::Remote {
        120
    } else {
        2
    })
}

fn format_open_error(port_name: &str, error: &serialport::Error) -> String {
    #[cfg(target_os = "linux")]
    if matches!(
        error.kind(),
        serialport::ErrorKind::Io(io::ErrorKind::PermissionDenied)
    ) {
        return format!(
            "无法打开串口 {port_name}: 权限不足。Ubuntu/Linux 请将当前用户加入 dialout 组（sudo usermod -aG dialout $USER），注销并重新登录后重试；不要以 root 身份运行本应用"
        );
    }

    format!("无法打开串口 {port_name}: {error}")
}

/// Hardware link extension point. A session owns exactly one writer while a
/// cloned instance is moved to its reader thread. Future Replay, USB CDC, CAN
/// and network links implement this same boundary instead of leaking transport
/// details into Tauri commands or React pages.
pub trait Transport: Send {
    fn label(&self) -> &str;
    fn write_command(&mut self, command: &str) -> Result<(), String>;
    fn read_chunk(&mut self, buffer: &mut [u8]) -> io::Result<usize>;
    fn try_clone_box(&self) -> Result<Box<dyn Transport>, String>;
}

pub struct SerialTransport {
    port_name: String,
    port: Box<dyn SerialPort>,
    connection_target: ConnectionTarget,
}

impl SerialTransport {
    pub fn open(
        port_name: &str,
        baud_rate: u32,
        connection_target: ConnectionTarget,
    ) -> Result<Self, String> {
        let port = serialport::new(port_name, baud_rate)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(40))
            .open()
            .map_err(|error| format_open_error(port_name, &error))?;
        Ok(Self {
            port_name: port_name.to_owned(),
            port,
            connection_target,
        })
    }
}

impl Transport for SerialTransport {
    fn label(&self) -> &str {
        &self.port_name
    }

    fn write_command(&mut self, command: &str) -> Result<(), String> {
        // Robot Legacy firmware consumes one raw DMA idle chunk without trimming
        // CR/LF. The remote bridge assembles LF-delimited nrfsend commands across
        // USB/UART chunks, then forwards a zero-padded 32-byte NRF payload. Its
        // slower gap leaves room for the remote's 50 ms joystick radio loop.
        let frame = serial_frame(command, self.connection_target)?;
        self.port
            .write_all(frame.as_bytes())
            .and_then(|_| self.port.flush())
            .map_err(|error| format!("串口写入失败: {error}"))?;
        std::thread::sleep(command_gap(self.connection_target));
        Ok(())
    }

    fn read_chunk(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.port.read(buffer)
    }

    fn try_clone_box(&self) -> Result<Box<dyn Transport>, String> {
        let port = self
            .port
            .try_clone()
            .map_err(|error| format!("无法创建串口读取通道: {error}"))?;
        Ok(Box::new(Self {
            port_name: self.port_name.clone(),
            port,
            connection_target: self.connection_target,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn robot_and_remote_use_their_respective_frame_boundaries() {
        assert_eq!(
            serial_frame("anglepid -p 65", ConnectionTarget::Robot).unwrap(),
            "anglepid -p 65"
        );
        assert_eq!(
            serial_frame("anglepid -p 65", ConnectionTarget::Remote).unwrap(),
            "nrfsend anglepid -p 65\n"
        );
        let full_payload = "a".repeat(31);
        let remote_frame = serial_frame(&full_payload, ConnectionTarget::Remote).unwrap();
        assert_eq!(remote_frame, format!("nrfsend {full_payload}\n"));
        // The 31-byte limit applies to the radio payload, excluding UART framing.
        assert_eq!(remote_frame.len(), 40);
        assert_eq!(
            remote_frame
                .strip_prefix("nrfsend ")
                .unwrap()
                .strip_suffix('\n')
                .unwrap(),
            full_payload
        );
        assert!(serial_frame(&"a".repeat(32), ConnectionTarget::Remote).is_err());
        assert_eq!(
            command_gap(ConnectionTarget::Remote),
            Duration::from_millis(120)
        );
        assert_eq!(
            command_gap(ConnectionTarget::Robot),
            Duration::from_millis(2)
        );
    }

    #[test]
    fn open_error_includes_port_name() {
        let error = serialport::Error::new(serialport::ErrorKind::NoDevice, "not found");
        assert_eq!(
            format_open_error("/dev/ttyUSB0", &error),
            "无法打开串口 /dev/ttyUSB0: not found"
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_permission_error_explains_dialout_recovery() {
        let error = serialport::Error::new(
            serialport::ErrorKind::Io(io::ErrorKind::PermissionDenied),
            "permission denied",
        );
        let message = format_open_error("/dev/ttyACM0", &error);
        assert!(message.contains("dialout"));
        assert!(message.contains("不要以 root 身份运行"));
    }
}
