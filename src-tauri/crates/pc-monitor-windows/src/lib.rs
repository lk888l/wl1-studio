#![cfg(target_os = "windows")]
#![deny(unsafe_op_in_unsafe_fn)]

//! Safe sampling APIs. Windows FFI and owned native handles stay in this crate,
//! allowing the monitor core and desktop app to continue forbidding unsafe code.

mod cpu;
mod paths;
mod processes;

pub use cpu::CpuSampler;
pub use paths::nvml_library_paths;
pub use processes::{ProcessTreeSampler, TreeUsage};
