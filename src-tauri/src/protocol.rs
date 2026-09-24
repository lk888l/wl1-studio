use crate::types::{ConnectionTarget, MotionTargetRequest, TelemetryFrame};

#[derive(Debug, Clone, PartialEq)]
pub enum FirmwareUpdate {
    Imu {
        roll: f64,
        pitch: f64,
        yaw: f64,
        acceleration_norm_g: Option<f64>,
        acceleration_trusted: Option<bool>,
    },
    Rpm {
        left: f64,
        right: f64,
    },
    Servo {
        angle: f64,
        x: f64,
        bias: f64,
    },
    Log(String),
}

/// Protocol boundary kept separate from the transport so a future binary V1
/// codec can replace the legacy ASCII stream without changing the UI or link.
pub trait ProtocolCodec: Send {
    fn decode_line(&mut self, line: &str) -> FirmwareUpdate;
    fn apply_update(&mut self, update: &FirmwareUpdate, timestamp: u64) -> Option<TelemetryFrame>;
}

#[derive(Debug, Default)]
pub struct LegacyAsciiCodec {
    latest: TelemetryFrame,
}

impl LegacyAsciiCodec {
    pub fn parse_line(line: &str) -> FirmwareUpdate {
        let trimmed = line.trim();

        let fields = trimmed.split(',').map(str::trim).collect::<Vec<_>>();
        if matches!(fields.len(), 3 | 5) {
            let attitude = fields[..3]
                .iter()
                .map(|field| field.parse::<f64>())
                .collect::<Result<Vec<_>, _>>();
            if let Ok(attitude) = attitude {
                if attitude.iter().all(|value| value.is_finite()) {
                    let extension = if fields.len() == 5 {
                        let acceleration = fields[3]
                            .strip_prefix("a=")
                            .and_then(|value| value.parse::<f64>().ok())
                            .filter(|value| value.is_finite());
                        let trusted = match fields[4].strip_prefix("ok=") {
                            Some("0") => Some(false),
                            Some("1") => Some(true),
                            _ => None,
                        };
                        match (acceleration, trusted) {
                            (Some(acceleration), Some(trusted)) => Some((acceleration, trusted)),
                            _ => None,
                        }
                    } else {
                        Some((0.0, false))
                    };
                    if let Some((acceleration, trusted)) = extension {
                        return FirmwareUpdate::Imu {
                            roll: attitude[0],
                            pitch: attitude[1],
                            yaw: attitude[2],
                            acceleration_norm_g: (fields.len() == 5).then_some(acceleration),
                            acceleration_trusted: (fields.len() == 5).then_some(trusted),
                        };
                    }
                }
            }
        }

        if let Some(rest) = trimmed.strip_prefix("A:") {
            let mut halves = rest.splitn(2, "B:");
            if let (Some(left), Some(right)) = (halves.next(), halves.next()) {
                if let (Ok(left), Ok(right)) =
                    (left.trim().parse::<f64>(), right.trim().parse::<f64>())
                {
                    if left.is_finite() && right.is_finite() {
                        return FirmwareUpdate::Rpm { left, right };
                    }
                }
            }
        }

        if let Some(rest) = trimmed.strip_prefix("Servo angel:") {
            let values = rest
                .split_whitespace()
                .map(str::parse::<f64>)
                .collect::<Result<Vec<_>, _>>();
            if let Ok(values) = values {
                if values.len() == 3 && values.iter().all(|value| value.is_finite()) {
                    return FirmwareUpdate::Servo {
                        angle: values[0],
                        x: values[1],
                        bias: values[2],
                    };
                }
            }
        }

        FirmwareUpdate::Log(trimmed.to_owned())
    }
}

impl ProtocolCodec for LegacyAsciiCodec {
    fn decode_line(&mut self, line: &str) -> FirmwareUpdate {
        Self::parse_line(line)
    }

    fn apply_update(&mut self, update: &FirmwareUpdate, timestamp: u64) -> Option<TelemetryFrame> {
        self.latest.timestamp = timestamp;
        match update {
            FirmwareUpdate::Imu {
                roll,
                pitch,
                yaw,
                acceleration_norm_g,
                acceleration_trusted,
            } => {
                self.latest.roll = *roll;
                self.latest.pitch = *pitch;
                self.latest.yaw = *yaw;
                self.latest.acceleration_norm_g = *acceleration_norm_g;
                self.latest.acceleration_trusted = *acceleration_trusted;
                self.latest.imu_timestamp = Some(timestamp);
            }
            FirmwareUpdate::Rpm { left, right } => {
                self.latest.left_rpm = *left;
                self.latest.right_rpm = *right;
                self.latest.rpm_timestamp = Some(timestamp);
            }
            FirmwareUpdate::Servo { .. } | FirmwareUpdate::Log(_) => return None,
        }
        Some(self.latest.clone())
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedCommand {
    pub text: String,
    pub leg_height: Option<f64>,
    pub requires_write_unlock: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ValidatedMotionCommand {
    pub text: String,
    pub height: f64,
}

pub fn validate_text_command(command: &str) -> Result<ValidatedCommand, String> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err("命令不能为空".into());
    }
    if trimmed.contains('\r') || trimmed.contains('\n') {
        return Err("一次只能发送一条命令".into());
    }
    if !trimmed.is_ascii() || trimmed.bytes().any(|byte| !(0x20..=0x7e).contains(&byte)) {
        return Err("当前固件仅接受可打印 ASCII 文本".into());
    }
    if trimmed.len() > 32 {
        return Err("命令超过固件 32 字节队列上限".into());
    }

    let parts = trimmed.split_ascii_whitespace().collect::<Vec<_>>();
    if parts.join(" ") != trimmed {
        return Err("Legacy 固件命令必须使用单个空格分隔参数".into());
    }
    let command_name = parts.first().copied().unwrap_or_default();
    let mut leg_height = None;
    let mut requires_write_unlock = true;

    match command_name {
        "R" => return Err("R 运动指令只能通过实时控制安全通道发送".into()),
        "uid" => {
            require_len(&parts, 1)?;
            requires_write_unlock = false;
        }
        "autoleg" => {
            require_len(&parts, 2)?;
            match parts[1] {
                "on" | "off" => {}
                "status" => requires_write_unlock = false,
                _ => return Err("自适应腿高命令只接受 autoleg on、off 或 status".into()),
            }
        }
        "legheight" => {
            require_len(&parts, 2)?;
            leg_height = Some(parse_in_range(parts[1], 44.5, 78.5, "腿高")?);
        }
        "anglebias" => {
            require_len(&parts, 2)?;
            if parts[1] != "auto" {
                parse_in_range(parts[1], -20.0, 20.0, "俯仰静态偏置")?;
            }
        }
        "anglepid" if parts.as_slice() == ["anglepid", "auto"] => {}
        "anglepid" => validate_pid(&parts, (0.0, 150.0), (0.0, 1.0), Some((-107.0, 100.0)))?,
        "velocitypid" => validate_pid(&parts, (0.0, 10.0), (0.0, 100.0), Some((0.0, 100.0)))?,
        "differpid" => validate_pid(&parts, (-50.0, 50.0), (0.0, 1.0), Some((0.0, 100.0)))?,
        "rollpid" => validate_pid(&parts, (-100.0, 100.0), (-10.0, 10.0), None)?,
        _ => return Err(format!("当前安全配置不允许发送命令: {command_name}")),
    }

    Ok(ValidatedCommand {
        text: trimmed.to_owned(),
        leg_height,
        requires_write_unlock,
    })
}

pub fn validate_text_command_for_target(
    command: &str,
    target: ConnectionTarget,
) -> Result<ValidatedCommand, String> {
    let validated = validate_text_command(command)?;
    if target == ConnectionTarget::Remote {
        if !validated.requires_write_unlock {
            return Err("遥控器链路不回传小车查询结果；请直连小车读取".into());
        }
        if validated.leg_height.is_some() {
            return Err(
                "遥控器模式的腿高由实体摇杆控制；无线调参支持 PID、俯仰偏置和自适应腿高开关".into(),
            );
        }
        if validated.text.len() > 31 {
            return Err("无线参数命令最多 31 字节，NRF24L01 帧需保留结尾空字节".into());
        }
    }
    Ok(validated)
}

pub fn validate_motion_target(
    target: &MotionTargetRequest,
) -> Result<ValidatedMotionCommand, String> {
    validate_range_value(target.turn, -100.0, 100.0, "转向目标")?;
    validate_range_value(target.velocity, -100.0, 100.0, "速度目标")?;
    validate_range_value(target.roll, -18.0, 18.0, "横滚目标")?;
    validate_range_value(target.height, 44.5, 78.5, "腿高")?;

    Ok(ValidatedMotionCommand {
        text: format!(
            "R {:.1} {:.1} {:.1} {:.1}",
            target.turn, target.velocity, target.roll, target.height
        ),
        height: target.height,
    })
}

fn require_len(parts: &[&str], expected: usize) -> Result<(), String> {
    if parts.len() == expected {
        Ok(())
    } else {
        Err(format!("命令参数数量错误：应为 {} 项", expected - 1))
    }
}

fn parse_in_range(text: &str, min: f64, max: f64, label: &str) -> Result<f64, String> {
    if text.is_empty()
        || text
            .bytes()
            .any(|byte| !byte.is_ascii_digit() && !matches!(byte, b'.' | b'-'))
    {
        return Err(format!("{label}必须使用普通十进制数字"));
    }
    let value = text
        .parse::<f64>()
        .map_err(|_| format!("无法解析{label}"))?;
    validate_range_value(value, min, max, label)?;
    Ok(value)
}

fn validate_range_value(value: f64, min: f64, max: f64, label: &str) -> Result<(), String> {
    if !value.is_finite() {
        return Err(format!("{label}必须是有限数值"));
    }
    if !(min..=max).contains(&value) {
        return Err(format!("{label}必须在 {min}..={max} 范围内"));
    }
    Ok(())
}

fn validate_pid(
    parts: &[&str],
    p_range: (f64, f64),
    i_range: (f64, f64),
    d_range: Option<(f64, f64)>,
) -> Result<(), String> {
    require_len(parts, 3)?;
    let range = match parts[1] {
        "-p" => p_range,
        "-i" => i_range,
        "-d" => d_range.ok_or("该控制环没有 D 项")?,
        _ => return Err("PID 参数项只接受 -p、-i 或 -d".into()),
    };
    parse_in_range(parts[2], range.0, range.1, "PID 参数")?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn remote_commands_preserve_joystick_ownership_and_radio_frame_limit() {
        for command in [
            "anglepid -p 65",
            "anglepid auto",
            "anglebias auto",
            "anglebias 12",
            "velocitypid -i 0.02",
            "differpid -d 0.1",
            "rollpid -p -0.3",
        ] {
            assert!(
                validate_text_command_for_target(command, ConnectionTarget::Remote).is_ok(),
                "{command}"
            );
        }
        for command in ["legheight 61.5", "R 0 0 0 61.5", "showimu -y", "showrpm -n"] {
            assert!(
                validate_text_command_for_target(command, ConnectionTarget::Remote).is_err(),
                "{command}"
            );
        }
        let full_robot_frame = "anglepid -p 65.00000000000000000";
        assert_eq!(full_robot_frame.len(), 32);
        assert!(
            validate_text_command_for_target(full_robot_frame, ConnectionTarget::Robot).is_ok()
        );
        assert!(
            validate_text_command_for_target(full_robot_frame, ConnectionTarget::Remote).is_err()
        );
    }

    #[test]
    fn parses_imu_triplet() {
        assert_eq!(
            LegacyAsciiCodec::parse_line("-01.250,002.500,180.000\r\n"),
            FirmwareUpdate::Imu {
                roll: -1.25,
                pitch: 2.5,
                yaw: 180.0,
                acceleration_norm_g: None,
                acceleration_trusted: None,
            }
        );
    }

    #[test]
    fn parses_extended_worktree_imu_line() {
        assert_eq!(
            LegacyAsciiCodec::parse_line("-01.250,002.500,180.000,a=01.03,ok=1"),
            FirmwareUpdate::Imu {
                roll: -1.25,
                pitch: 2.5,
                yaw: 180.0,
                acceleration_norm_g: Some(1.03),
                acceleration_trusted: Some(true),
            }
        );
        assert!(matches!(
            LegacyAsciiCodec::parse_line("-01.250,002.500,180.000,a=bad,ok=1"),
            FirmwareUpdate::Log(_)
        ));
    }

    #[test]
    fn parses_rpm_line_with_tab_spacing() {
        assert_eq!(
            LegacyAsciiCodec::parse_line("A: -12.500\tB: 010.250"),
            FirmwareUpdate::Rpm {
                left: -12.5,
                right: 10.25
            }
        );
    }

    #[test]
    fn validates_uid_and_auto_leg_permissions() {
        for command in ["uid", "autoleg status"] {
            let validated = validate_text_command(command).unwrap();
            assert!(!validated.requires_write_unlock);
            assert!(validate_text_command_for_target(command, ConnectionTarget::Remote).is_err());
        }
        for command in ["autoleg on", "autoleg off"] {
            let validated = validate_text_command(command).unwrap();
            assert!(validated.requires_write_unlock);
            assert!(validate_text_command_for_target(command, ConnectionTarget::Remote).is_ok());
        }
        for command in ["uid extra", "autoleg", "autoleg toggle", "autoleg on extra"] {
            assert!(validate_text_command(command).is_err(), "{command}");
        }
    }

    #[test]
    fn validates_firmware_buffer_limit() {
        assert_eq!(
            validate_text_command("legheight 61.5").unwrap().leg_height,
            Some(61.5)
        );
        assert!(validate_text_command("showimu -y").is_err());
        assert!(validate_text_command(&"x".repeat(33)).is_err());
        assert!(validate_text_command("legheight 61.5\nshowrpm -y").is_err());
    }

    #[test]
    fn raw_terminal_rejects_all_motion_commands() {
        assert!(validate_text_command("motor 100 100").is_err());
        assert!(validate_text_command("R 0.0 0.0 0.0 0.0").is_err());
        assert!(validate_text_command("R 0.0 inf 0.0 61.5").is_err());
        assert!(validate_text_command("R 1.0 -2.0 3.0 61.5").is_err());
    }

    #[test]
    fn validates_structured_motion_targets() {
        let command = validate_motion_target(&MotionTargetRequest {
            turn: 1.0,
            velocity: -2.0,
            roll: 3.0,
            height: 61.5,
        })
        .unwrap();
        assert_eq!(command.text, "R 1.0 -2.0 3.0 61.5");
        assert_eq!(command.height, 61.5);

        assert!(validate_motion_target(&MotionTargetRequest {
            turn: 101.0,
            velocity: 0.0,
            roll: 0.0,
            height: 61.5,
        })
        .is_err());
    }

    // Limits from vofa_host_tools_cfg/vofa_tab.json, including negative PID terms.
    #[test]
    fn accepts_vofa_parameter_boundaries_and_rejects_outside_values() {
        for (prefix, min, max, step) in [
            ("anglepid -p", 0.0, 150.0, 0.1),
            ("anglepid -i", 0.0, 1.0, 0.1),
            ("anglepid -d", -107.0, 100.0, 0.1),
            ("velocitypid -p", 0.0, 10.0, 0.01),
            ("velocitypid -i", 0.0, 100.0, 0.001),
            ("velocitypid -d", 0.0, 100.0, 0.01),
            ("differpid -p", -50.0, 50.0, 0.1),
            ("differpid -i", 0.0, 1.0, 0.001),
            ("differpid -d", 0.0, 100.0, 0.1),
            ("rollpid -p", -100.0, 100.0, 0.1),
            ("rollpid -i", -10.0, 10.0, 0.1),
            ("anglebias", -20.0, 20.0, 0.1),
            ("legheight", 44.5, 78.5, 0.1),
        ] {
            for target in [ConnectionTarget::Robot, ConnectionTarget::Remote] {
                if prefix == "legheight" && target == ConnectionTarget::Remote {
                    continue;
                }
                for value in [min, max] {
                    let command = format!("{prefix} {value}");
                    assert!(
                        validate_text_command_for_target(&command, target).is_ok(),
                        "{command}"
                    );
                }
                for value in [min - step, max + step] {
                    let command = format!("{prefix} {value}");
                    assert!(
                        validate_text_command_for_target(&command, target).is_err(),
                        "{command}"
                    );
                }
            }
        }
    }
    #[test]
    fn preserves_command_syntax_checks_and_legacy_auto_forms() {
        assert!(validate_text_command("anglebias -20.1").is_err());
        assert!(validate_text_command("anglebias 12.6").is_ok());
        assert!(validate_text_command("anglebias 20.0").is_ok());
        assert!(validate_text_command("anglebias 20.1").is_err());
        assert!(validate_text_command("anglebias auto").is_ok());
        assert!(validate_text_command("anglepid auto").is_ok());
        assert!(validate_text_command("legheight +61.5").is_err());
        assert!(validate_text_command("anglepid -i 1.1").is_err());
        assert!(validate_text_command("anglepid -d -107.1").is_err());
        assert!(validate_text_command("differpid -i 1.001").is_err());
        assert!(validate_text_command("rollpid -p -1.0").is_ok());
        assert!(validate_text_command("rollpid -i 10.1").is_err());
    }
}
