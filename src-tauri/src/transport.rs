use std::io::{self, Read, Write};
use std::time::Duration;

use serialport::{DataBits, FlowControl, Parity, SerialPort, StopBits};

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
}

impl SerialTransport {
    pub fn open(port_name: &str, baud_rate: u32) -> Result<Self, String> {
        let port = serialport::new(port_name, baud_rate)
            .data_bits(DataBits::Eight)
            .parity(Parity::None)
            .stop_bits(StopBits::One)
            .flow_control(FlowControl::None)
            .timeout(Duration::from_millis(40))
            .open()
            .map_err(|error| format!("无法打开串口 {port_name}: {error}"))?;
        Ok(Self {
            port_name: port_name.to_owned(),
            port,
        })
    }
}

impl Transport for SerialTransport {
    fn label(&self) -> &str {
        &self.port_name
    }

    fn write_command(&mut self, command: &str) -> Result<(), String> {
        // The current firmware forwards each DMA receive-to-idle chunk directly
        // to TaskReactor and does not trim CR/LF. A newline therefore becomes
        // part of the final numeric token. Send one raw command per idle frame
        // and leave a generous physical gap after flush instead.
        self.port
            .write_all(command.as_bytes())
            .and_then(|_| self.port.flush())
            .map_err(|error| format!("串口写入失败: {error}"))?;
        std::thread::sleep(Duration::from_millis(2));
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
        }))
    }
}
