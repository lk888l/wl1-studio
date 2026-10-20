//! Run without Tauri to diagnose an MCU:
//! cargo run -p pc-monitor-core --example send -- 192.168.4.1 10 [--no-gpu]
use pc_monitor_core::{Monitor, MonitorConfig, DEFAULT_INTERVAL_MS};
use std::{env, thread, time::Duration};

fn main() -> Result<(), String> {
    let mut gpu_enabled = true;
    let args: Vec<_> = env::args()
        .skip(1)
        .filter(|argument| {
            if argument == "--no-gpu" {
                gpu_enabled = false;
                false
            } else {
                true
            }
        })
        .collect();
    let mut args = args.into_iter();
    let usage = "Usage: send <device IPv4> [seconds] [--no-gpu]";
    let target_ip = args.next().ok_or(usage)?;
    let seconds = args
        .next()
        .map(|value| value.parse::<u64>())
        .transpose()
        .map_err(|error| error.to_string())?
        .unwrap_or(10);
    if args.next().is_some() {
        return Err(usage.into());
    }
    let monitor = Monitor::default();
    monitor.start(MonitorConfig {
        target_ip,
        gpu_enabled,
        gpu_uuid: None,
        interval_ms: DEFAULT_INTERVAL_MS,
    })?;
    for _ in 0..seconds {
        thread::sleep(Duration::from_secs(1));
        println!("{}", serde_json::to_string(&monitor.snapshot()).unwrap());
    }
    monitor.stop(None)?;
    Ok(())
}
