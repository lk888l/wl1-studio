use anyhow::{bail, ensure, Result};
use serde::Serialize;
use std::sync::LazyLock;

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Scalar {
    U8,
    I8,
    U16,
    I16,
    U32,
    I32,
    F32,
}

impl Scalar {
    pub fn size(self) -> usize {
        match self {
            Self::U8 | Self::I8 => 1,
            Self::U16 | Self::I16 => 2,
            _ => 4,
        }
    }

    pub fn encode(self, value: f64) -> Result<Vec<u8>> {
        ensure!(value.is_finite(), "数值必须有限");
        macro_rules! integer {
            ($ty:ty) => {{
                ensure!(
                    value.fract() == 0.0
                        && (<$ty>::MIN as f64..=<$ty>::MAX as f64).contains(&value),
                    "整数超出类型范围"
                );
                (value as $ty).to_le_bytes().to_vec()
            }};
        }
        Ok(match self {
            Self::U8 => integer!(u8),
            Self::I8 => integer!(i8),
            Self::U16 => integer!(u16),
            Self::I16 => integer!(i16),
            Self::U32 => integer!(u32),
            Self::I32 => integer!(i32),
            Self::F32 => {
                let value = value as f32;
                ensure!(value.is_finite(), "超出 REAL32 范围");
                value.to_le_bytes().to_vec()
            }
        })
    }

    pub fn decode(self, bytes: &[u8]) -> Result<f64> {
        ensure!(
            bytes.len() == self.size(),
            "SDO 长度不匹配：期望 {}，收到 {}",
            self.size(),
            bytes.len()
        );
        macro_rules! decode {
            ($ty:ty) => {
                <$ty>::from_le_bytes(bytes.try_into()?) as f64
            };
        }
        let value = match self {
            Self::U8 => decode!(u8),
            Self::I8 => decode!(i8),
            Self::U16 => decode!(u16),
            Self::I16 => decode!(i16),
            Self::U32 => decode!(u32),
            Self::I32 => decode!(i32),
            Self::F32 => decode!(f32),
        };
        ensure!(value.is_finite(), "设备返回非有限值");
        Ok(value)
    }
}

#[derive(Debug, Serialize)]
pub struct Object {
    pub index: u16,
    pub sub: u8,
    pub name: &'static str,
    pub scalar: Scalar,
    pub writable: bool,
    pub editable: bool,
    pub mappable: bool,
    pub default: &'static str,
}

pub static OBJECTS: LazyLock<Vec<Object>> = LazyLock::new(|| {
    include_str!("objects.csv")
        .lines()
        .skip(1)
        .map(|line| {
            let fields: Vec<_> = line.split(',').collect();
            let (index, sub) = fields[0].split_once(':').unwrap();
            let index = u16::from_str_radix(index, 16).unwrap();
            let sub = u8::from_str_radix(sub, 16).unwrap();
            let scalar = match fields[2] {
                "u8" => Scalar::U8,
                "i8" => Scalar::I8,
                "u16" => Scalar::U16,
                "i16" => Scalar::I16,
                "u32" => Scalar::U32,
                "i32" => Scalar::I32,
                "f32" => Scalar::F32,
                other => panic!("unknown EDS type {other}"),
            };
            let writable = fields[3] == "rw";
            let dedicated = matches!(
                (index, sub),
                (
                    0x1010 | 0x1011 | 0x1400..=0x1aff | 0x6040 | 0x6060 | 0x6071 | 0x607a | 0x60ff,
                    _
                ) | (0x2100, 1)
                    | (0x2003, 1..=5)
                    | (0x2004, 1..=3)
            );
            Object {
                index,
                sub,
                name: fields[1],
                scalar,
                writable,
                editable: writable && !dedicated,
                mappable: fields[4] == "1",
                default: fields[5],
            }
        })
        .collect()
});

pub fn object(index: u16, sub: u8) -> Result<&'static Object> {
    OBJECTS
        .iter()
        .find(|entry| (entry.index, entry.sub) == (index, sub))
        .ok_or_else(|| anyhow::anyhow!("未知对象 {index:04X}:{sub:02X}"))
}

impl Object {
    pub(crate) fn setting(&self, value: f64) -> Result<Vec<u8>> {
        ensure!(self.editable, "只读对象或需要使用专用操作");
        let bytes = self.scalar.encode(value)?;
        let valid = match (self.index, self.sub) {
            (0x1003, 0) => value == 0.0,
            (0x2001, 1) => (1.0..=127.0).contains(&value),
            (0x2001, 2) => NOMINAL.contains(&(value as u32)),
            (0x2001, 3) => DATA.contains(&(value as u32)),
            (0x2100, 6) => value > 0.0 && value <= 4.9,
            (0x2100, 7) => value > 0.001 && value <= 1.0,
            (0x6072, 0) | (0x2003, 6) | (0x2004, 14) => value <= 1000.0,
            (0x6065, 0) => value > 0.0 && value <= 100000.0,
            (0x6081, 0) => value > 0.0 && value <= 40.0,
            (0x6083..=0x6085, 0) => value > 0.0 && value <= 100.0,
            (0x2004, 4 | 5) => value.abs() <= 100000.0,
            (0x2004, 6 | 7) => value.abs() <= 40.0,
            (0x2004, 8 | 9) => (0.0..=100.0).contains(&value),
            (0x2004, 10 | 11) => (0.0..=20.0).contains(&value),
            (0x2004, 12 | 13) => value.abs() <= 1.0,
            _ => true,
        };
        if !valid {
            bail!("{:04X}:{:02X} 超出固件允许范围", self.index, self.sub)
        }
        Ok(bytes)
    }
}

pub const NOMINAL: [u32; 4] = [125000, 250000, 500000, 1000000];
pub const DATA: [u32; 5] = [1000000, 2000000, 4000000, 5000000, 8000000];
