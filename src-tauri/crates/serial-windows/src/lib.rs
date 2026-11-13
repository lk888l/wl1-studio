#![cfg(target_os = "windows")]
#![deny(unsafe_op_in_unsafe_fn)]

//! Safe queue sizing for serialport. Native FFI stays outside the desktop crate,
//! which continues to forbid unsafe code.

use std::io;
use std::os::windows::io::AsRawHandle;

/// Request driver-owned receive/transmit queues without altering control lines.
pub fn configure_queues(port: &serialport::COMPort, receive: u32, transmit: u32) -> io::Result<()> {
    // SAFETY: the borrowed COMPort owns a live serial handle throughout the
    // call. SetupComm only asks the driver to allocate its communication queues.
    let ready = unsafe {
        windows_sys::Win32::Devices::Communication::SetupComm(
            port.as_raw_handle(),
            receive,
            transmit,
        )
    };
    if ready == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
