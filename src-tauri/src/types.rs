use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortOption {
    pub name: String,
    pub port_type: String,
    pub vid: Option<u16>,
    pub pid: Option<u16>,
    pub manufacturer: Option<String>,
    pub product: Option<String>,
    pub serial_number: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub mode: ConnectionRequestMode,
    pub port_name: Option<String>,
    #[serde(default = "default_baud_rate")]
    pub baud_rate: u32,
    /// Explicit operator acknowledgement for motion/parameter writes. When
    /// false, a real serial session remains telemetry-only.
    #[serde(default)]
    pub allow_unsafe_writes: bool,
}

const fn default_baud_rate() -> u32 {
    115_200
}

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionRequestMode {
    Mock,
    Serial,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSnapshot {
    pub mode: &'static str,
    pub label: String,
    /// Opaque generation token. Every newly opened device session gets a new
    /// value so delayed UI work cannot accidentally target a replacement link.
    pub session_id: Option<u64>,
    pub connected_at: Option<u64>,
    pub baud_rate: Option<u32>,
    pub telemetry_enabled: bool,
    pub writes_unlocked: bool,
}

impl Default for ConnectionSnapshot {
    fn default() -> Self {
        Self {
            mode: "disconnected",
            label: "未连接".into(),
            session_id: None,
            connected_at: None,
            baud_rate: None,
            telemetry_enabled: false,
            writes_unlocked: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MotionTargetRequest {
    pub turn: f64,
    pub velocity: f64,
    pub roll: f64,
    pub height: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelemetryFrame {
    pub session_id: u64,
    pub timestamp: u64,
    pub imu_timestamp: Option<u64>,
    pub rpm_timestamp: Option<u64>,
    pub roll: f64,
    pub pitch: f64,
    pub yaw: f64,
    pub left_rpm: f64,
    pub right_rpm: f64,
    /// Host-known target when available. Legacy firmware does not report the
    /// actual leg height, so serial telemetry keeps this as `None`.
    pub target_height: Option<f64>,
    pub link_quality: Option<f64>,
    pub battery_voltage: Option<f64>,
    /// Present in the current local firmware worktree's extended IMU line.
    pub acceleration_norm_g: Option<f64>,
    pub acceleration_trusted: Option<bool>,
}

impl Default for TelemetryFrame {
    fn default() -> Self {
        Self {
            session_id: 0,
            timestamp: 0,
            imu_timestamp: None,
            rpm_timestamp: None,
            roll: 0.0,
            pitch: 0.0,
            yaw: 0.0,
            left_rpm: 0.0,
            right_rpm: 0.0,
            target_height: None,
            link_quality: None,
            battery_voltage: None,
            acceleration_norm_g: None,
            acceleration_trusted: None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleEvent {
    pub session_id: u64,
    pub timestamp: u64,
    pub direction: &'static str,
    pub text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DisconnectedEvent {
    pub session_id: u64,
    pub timestamp: u64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCapabilities {
    pub protocol_version: u16,
    pub firmware_label: &'static str,
    pub supported: Vec<&'static str>,
    pub reserved: Vec<&'static str>,
}

impl DeviceCapabilities {
    pub fn legacy_ascii() -> Self {
        Self {
            protocol_version: 0,
            firmware_label: "WL1 Legacy ASCII · HEAD/worktree compatible",
            supported: vec![
                "transport.serial",
                "telemetry.imu",
                "telemetry.rpm",
                "parameter.write_volatile",
                "motion.target",
            ],
            reserved: vec![
                "handshake",
                "parameter.readback",
                "parameter.persist",
                "calibration.commit",
                "safety.arm_disarm",
                "safety.motion_timeout",
                "control.profile",
                "motion.jump",
                "firmware.update",
                "transport.can",
                "transport.usb_cdc",
                "transport.network",
            ],
        }
    }
}
