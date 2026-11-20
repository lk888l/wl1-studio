use crate::{od::object, Node};
use anyhow::{ensure, Result};
use serde::{Deserialize, Serialize};

pub(crate) const OFF: u32 = 1 << 31;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Pdo {
    pub slot: u8,
    pub cob: u32,
    pub transmission: u8,
    pub timer_ms: u16,
    pub inhibit: u16,
    pub entries: Vec<u32>,
}

pub(crate) fn comm(slot: u8) -> Result<u16> {
    ensure!((1..=8).contains(&slot), "PDO 槽位必须为 1–8");
    Ok(if slot <= 4 { 0x1400 } else { 0x1800 } + u16::from((slot - 1) % 4))
}

impl Pdo {
    pub fn id(&self) -> u16 {
        (self.cob & 0x7ff) as u16
    }
    pub fn enabled(&self) -> bool {
        self.cob & OFF == 0
    }
    pub fn validate(&self) -> Result<()> {
        comm(self.slot)?;
        ensure!(
            self.cob & 0x3fff_f800 == 0
                && (!self.enabled() || matches!(self.id(), 0x181..=0x57f | 0x680..=0x6df)),
            "请选择未占用的 11 位 PDO COB-ID（避开服务 ID）"
        );
        ensure!(
            self.transmission <= 240 || self.transmission >= 254,
            "类型 241–253 保留"
        );
        ensure!(self.slot > 4 || self.inhibit == 0, "RPDO 无 inhibit 字段");
        ensure!(
            self.entries.len() <= 16 && (!self.enabled() || !self.entries.is_empty()),
            "PDO 不可启用空映射，最多 16 项"
        );
        let mut size = 0;
        for &entry in &self.entries {
            let field = object((entry >> 16) as u16, (entry >> 8) as u8)?;
            ensure!(
                field.mappable
                    && (self.slot > 4 || field.writable)
                    && entry as u8 as usize == field.scalar.size() * 8,
                "映射项 0x{entry:08X} 的方向或长度不符"
            );
            size += field.scalar.size();
        }
        ensure!(size <= 64, "PDO 映射超过 64 字节");
        Ok(())
    }
}

impl Node {
    pub async fn read_pdo(&mut self, slot: u8) -> Result<Pdo> {
        let index = comm(slot)?;
        let cob = self.read(index, 1).await? as u32;
        let transmission = self.read(index, 2).await? as u8;
        let timer_ms = self.read(index, 5).await? as u16;
        let inhibit = if slot > 4 {
            self.read(index, 3).await? as u16
        } else {
            0
        };
        let count = self.read(index + 0x200, 0).await? as u8;
        ensure!(count <= 16, "固件 PDO 映射计数无效");
        let mut entries = Vec::new();
        for sub in 1..=count {
            entries.push(self.read(index + 0x200, sub).await? as u32);
        }
        Ok(Pdo {
            slot,
            cob,
            transmission,
            timer_ms,
            inhibit,
            entries,
        })
    }

    pub(crate) async fn apply_pdo(&mut self, config: &Pdo, tail: &[u32]) -> Result<()> {
        let index = comm(config.slot)?;
        let previous = self.read(index, 1).await? as u32;
        self.write(index, 1, (previous | OFF).into()).await?;
        self.write(index + 0x200, 0, 0.0).await?;
        for (offset, &word) in config.entries.iter().chain(tail).enumerate() {
            self.write(index + 0x200, offset as u8 + 1, word.into())
                .await?;
        }
        self.write(index + 0x200, 0, config.entries.len() as f64)
            .await?;
        self.write(index, 2, config.transmission.into()).await?;
        if config.slot > 4 {
            self.write(index, 3, config.inhibit.into()).await?;
        }
        self.write(index, 5, config.timer_ms.into()).await?;
        self.write(index, 1, config.cob.into()).await?;
        ensure!(
            self.read_pdo(config.slot).await? == *config,
            "PDO{} 配置读回不匹配",
            config.slot
        );
        Ok(())
    }
}
