use crate::Node;
use anyhow::{bail, ensure, Result};
use can_transport::{CanFrame, CanId};
use serde::{Deserialize, Serialize};

pub(crate) const FEEDBACK: [u32; 11] = [
    0x60410010, 0x603f0010, 0x60640020, 0x606c0020, 0x22030120, 0x22030220, 0x22020020, 0x60770010,
    0x21000910, 0x60610008, 0x21000208,
];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Mode {
    Velocity,
    Torque,
    SingleTurn,
    MultiTurn,
    Mit,
    PackedMit,
}

impl Mode {
    pub fn code(self) -> i8 {
        match self {
            Self::Velocity => 3,
            Self::Torque => 4,
            Self::SingleTurn => -1,
            Self::MultiTurn => 1,
            _ => 5,
        }
    }
    pub(crate) fn command_map(self) -> (u8, &'static [u32]) {
        match self {
            Self::Velocity => (1, &[0x60ff0020, 0x60400010, 0x60600008]),
            Self::SingleTurn | Self::MultiTurn => (2, &[0x607a0020, 0x60400010, 0x60600008]),
            Self::Torque => (3, &[0x60710010, 0x60400010, 0x60600008]),
            Self::PackedMit => (4, &[0x20040220, 0x20040320]),
            Self::Mit => (
                4,
                &[
                    0x20030120, 0x20030220, 0x20030320, 0x20030410, 0x20030510, 0x60400010,
                    0x60600008,
                ],
            ),
        }
    }
    pub fn neutral(self, position: f32) -> Target {
        match self {
            Self::Velocity => Target::Velocity { rev_s: 0.0 },
            Self::Torque => Target::Torque { permille: 0 },
            Self::SingleTurn | Self::MultiTurn => Target::Position {
                rev: position,
                relative: false,
            },
            _ => Target::Mit {
                rev: position,
                rev_s: 0.0,
                kp: 0.0,
                kd: 0.0,
                nm: 0.0,
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Target {
    Velocity {
        rev_s: f32,
    },
    Torque {
        permille: i16,
    },
    Position {
        rev: f32,
        relative: bool,
    },
    Mit {
        rev: f32,
        rev_s: f32,
        kp: f32,
        kd: f32,
        nm: f32,
    },
}

pub(crate) type Ranges = [[f32; 2]; 5];

pub(crate) fn command_frame(
    mode: Mode,
    target: Target,
    word: u16,
    id: u16,
    ranges: &Ranges,
) -> Result<CanFrame> {
    let id = CanId::Standard(id);
    let mut bytes = [0u8; 20];
    let word_at = match (mode, target) {
        (Mode::Velocity, Target::Velocity { rev_s }) => {
            ensure!(rev_s.abs() <= 40.0, "速度限 ±40 rev/s");
            bytes[..4].copy_from_slice(&rev_s.to_le_bytes());
            4
        }
        (Mode::Torque, Target::Torque { permille }) => {
            ensure!(permille.unsigned_abs() <= 1000, "力矩限 ±1000 ‰");
            bytes[..2].copy_from_slice(&permille.to_le_bytes());
            2
        }
        (Mode::SingleTurn | Mode::MultiTurn, Target::Position { rev, .. }) => {
            ensure!(rev.abs() <= 100000.0, "位置限 ±100000 rev");
            bytes[..4].copy_from_slice(&rev.to_le_bytes());
            4
        }
        (
            Mode::Mit,
            Target::Mit {
                rev,
                rev_s,
                kp,
                kd,
                nm,
            },
        ) => {
            ensure!(
                rev.abs() <= 100000.0
                    && rev_s.abs() <= 40.0
                    && nm.abs() <= 1.0
                    && (0.0..=65.535).contains(&kp)
                    && (0.0..=20.0).contains(&kd),
                "MIT 目标或增益超出范围"
            );
            for (field, value) in bytes[..12].chunks_exact_mut(4).zip([rev, rev_s, nm]) {
                field.copy_from_slice(&value.to_le_bytes());
            }
            for (field, value) in bytes[12..16].chunks_exact_mut(2).zip([kp, kd]) {
                field.copy_from_slice(&((value * 1000.0).round() as u16).to_le_bytes());
            }
            16
        }
        (
            Mode::PackedMit,
            Target::Mit {
                rev,
                rev_s,
                kp,
                kd,
                nm,
            },
        ) => {
            let mut packet = 0u64;
            for ((value, [low, high]), bits) in [rev, rev_s, kp, kd, nm]
                .into_iter()
                .zip(*ranges)
                .zip([16, 12, 12, 12, 12])
            {
                ensure!(
                    low.is_finite()
                        && high.is_finite()
                        && low < high
                        && (low..=high).contains(&value),
                    "压缩 MIT 目标 {value} 不在设备量程 [{low}, {high}]"
                );
                packet = packet << bits
                    | (((f64::from(value) - f64::from(low)) / (f64::from(high) - f64::from(low))
                        * ((1u64 << bits) - 1) as f64)
                        .round() as u64);
            }
            return Ok(CanFrame::new_data(id, &packet.to_le_bytes())?);
        }
        _ => bail!("目标类型与当前使能模式不一致"),
    };
    bytes[word_at..word_at + 2].copy_from_slice(&word.to_le_bytes());
    bytes[word_at + 2] = mode.code() as u8;
    Ok(if mode == Mode::Mit {
        CanFrame::new_fd(id, &bytes, true)?
    } else {
        CanFrame::new_data(id, &bytes[..word_at + 3])?
    })
}

#[derive(Clone, Copy, Debug, Default, Serialize)]
pub struct Feedback {
    pub status: u16,
    pub fault: u16,
    pub position: f32,
    pub velocity: f32,
    pub id_ma: i32,
    pub iq_ma: i32,
    pub bus_mv: i32,
    pub torque: i16,
    pub temperature: i16,
    pub mode: i8,
    pub calibration: u8,
}

impl Feedback {
    pub fn state(self) -> u16 {
        self.status & 0x6f
    }
    pub(crate) fn from_frame(frame: CanFrame, id: u16) -> Result<Self> {
        ensure!(
            frame.id() == CanId::Standard(id) && frame.is_fd() && frame.brs() && frame.dlc() == 32,
            "TPDO4 需要 32 字节 FD+BRS"
        );
        let bytes = frame.data();
        let sample = Self {
            status: u16::from_le_bytes(bytes[0..2].try_into()?),
            fault: u16::from_le_bytes(bytes[2..4].try_into()?),
            position: f32::from_le_bytes(bytes[4..8].try_into()?),
            velocity: f32::from_le_bytes(bytes[8..12].try_into()?),
            id_ma: i32::from_le_bytes(bytes[12..16].try_into()?),
            iq_ma: i32::from_le_bytes(bytes[16..20].try_into()?),
            bus_mv: i32::from_le_bytes(bytes[20..24].try_into()?),
            torque: i16::from_le_bytes(bytes[24..26].try_into()?),
            temperature: i16::from_le_bytes(bytes[26..28].try_into()?),
            mode: bytes[28] as i8,
            calibration: bytes[29],
        };
        ensure!(
            sample.position.is_finite() && sample.velocity.is_finite(),
            "TPDO 反馈非有限值"
        );
        Ok(sample)
    }
}

impl Node {
    pub async fn feedback(&mut self) -> Result<Feedback> {
        Ok(Feedback {
            status: self.read(0x6041, 0).await? as u16,
            fault: self.read(0x603f, 0).await? as u16,
            position: self.read(0x6064, 0).await? as f32,
            velocity: self.read(0x606c, 0).await? as f32,
            id_ma: self.read(0x2203, 1).await? as i32,
            iq_ma: self.read(0x2203, 2).await? as i32,
            bus_mv: self.read(0x2202, 0).await? as i32,
            torque: self.read(0x6077, 0).await? as i16,
            temperature: self.read(0x2100, 9).await? as i16,
            mode: self.read(0x6061, 0).await? as i8,
            calibration: self.read(0x2100, 2).await? as u8,
        })
    }
}
