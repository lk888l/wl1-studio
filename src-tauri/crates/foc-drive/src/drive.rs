use crate::{
    cycle::{Cycle, Phase},
    motion::{command_frame, FEEDBACK},
    od::object,
    pdo::{comm, OFF},
    Feedback, Mode, Node, Pdo, Target,
};
use anyhow::{bail, ensure, Context, Result};
use can_transport::CanFilter;
use serde::Deserialize;
use std::time::Duration;
use tokio::time::{sleep, Instant};

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Service {
    Calibrate,
    SlowScan,
    CompensationOn,
    CompensationOff,
    Save,
    Restore,
    ResetCommunication,
    Reboot,
    ResetFault,
}

struct Backup {
    mode: f64,
    packed: f64,
    maps: Vec<(Pdo, Vec<u32>)>,
}

struct CalibrationRun {
    started: Instant,
    observed_active: bool,
}

pub struct Motor {
    node: Node,
    cycle: Option<Cycle>,
    backup: Option<Backup>,
    calibration: Option<CalibrationRun>,
    unconfirmed: bool,
}

impl Motor {
    pub fn new(node: Node) -> Self {
        Self {
            node,
            cycle: None,
            backup: None,
            calibration: None,
            unconfirmed: false,
        }
    }
    pub fn phase(&self) -> Phase {
        if self.unconfirmed {
            Phase::Unconfirmed
        } else if self.calibration.is_some() {
            Phase::Calibrating
        } else {
            self.cycle.as_ref().map_or(Phase::Idle, |cycle| cycle.phase)
        }
    }
    pub fn mode(&self) -> Option<Mode> {
        self.cycle.as_ref().map(|cycle| cycle.mode)
    }
    pub fn owns_output(&self) -> bool {
        self.cycle.is_some()
            || self.backup.is_some()
            || self.calibration.is_some()
            || self.unconfirmed
    }
    pub fn cyclic(&self) -> bool {
        self.cycle.is_some()
    }
    pub fn next_tick(&self) -> Option<Instant> {
        self.cycle.as_ref().map(|cycle| {
            cycle
                .last_tx
                .map_or_else(Instant::now, |last| last + cycle.period)
        })
    }

    pub async fn read(&mut self, index: u16, sub: u8) -> Result<f64> {
        ensure!(
            !self.owns_output(),
            "仅在空闲时可读取字典；运行中由 TPDO 提供反馈"
        );
        self.node.read(index, sub).await
    }
    pub async fn read_pdo(&mut self, slot: u8) -> Result<Pdo> {
        ensure!(!self.owns_output(), "仅在空闲时可读取映射");
        self.node.read_pdo(slot).await
    }
    pub async fn inspect(&mut self) -> Result<Feedback> {
        ensure!(!self.cyclic(), "运行中使用 tick 的 TPDO 反馈");
        let feedback = match self.node.feedback().await {
            Err(error) if self.calibration.is_some() && !self.unconfirmed => {
                return self.fail_closed(error.context("校准反馈中断")).await
            }
            result => result?,
        };
        if !self.unconfirmed {
            if let Some(run) = self.calibration.as_mut() {
                if feedback.fault != 0 || feedback.state() == 8 || feedback.calibration == 5 {
                    return self
                        .fail_closed(anyhow::anyhow!("校准失败，故障 0x{:04X}", feedback.fault))
                        .await;
                } else if (1..=3).contains(&feedback.calibration) {
                    run.observed_active = true;
                } else if run.observed_active
                    && feedback.calibration == 4
                    && feedback.state() == 0x40
                {
                    self.calibration = None;
                } else if run.started.elapsed() >= Duration::from_secs(2) {
                    return self
                        .fail_closed(anyhow::anyhow!("未观测到有效校准序列，已请求中止"))
                        .await;
                }
            }
        }
        Ok(feedback)
    }

    async fn wait_disabled(&mut self, allow_fault: bool) -> Result<()> {
        let deadline = Instant::now() + Duration::from_millis(600);
        loop {
            let status = self.node.read(0x6041, 0).await? as u16 & 0x6f;
            if status == 0x40 || (allow_fault && status == 8) {
                return Ok(());
            }
            ensure!(Instant::now() < deadline, "未确认关桥，状态 0x{status:02X}");
            sleep(Duration::from_millis(5)).await;
        }
    }

    async fn idle(&mut self, allow_fault: bool) -> Result<Feedback> {
        ensure!(!self.owns_output(), "请先关桥并结束当前会话操作");
        self.node.identify().await?;
        let feedback = self.node.feedback().await?;
        ensure!(
            !(1..=3).contains(&feedback.calibration)
                && (feedback.state() == 0x40 || (allow_fault && feedback.state() == 8)),
            "设备没有关桥或正在校准，请先确认台架并显式关桥"
        );
        ensure!(
            allow_fault || feedback.fault == 0,
            "请先处理故障 0x{:04X}",
            feedback.fault
        );
        self.node.nmt(0x80).await?;
        self.node.write(0x6040, 0, 0.0).await?;
        self.wait_disabled(allow_fault).await?;
        Ok(feedback)
    }

    pub async fn set_parameter(&mut self, index: u16, sub: u8, value: f64) -> Result<f64> {
        let field = object(index, sub)?;
        let bytes = field.setting(value)?;
        self.idle(false).await?;
        self.node.write(index, sub, value).await?;
        let readback = self.node.read(index, sub).await?;
        ensure!(
            readback == field.scalar.decode(&bytes)?,
            "写后读回不一致：设备返回 {readback}"
        );
        Ok(readback)
    }

    pub async fn set_pdo(&mut self, config: Pdo) -> Result<()> {
        config.validate()?;
        self.idle(false).await?;
        if config.enabled() {
            self.check_ids(&[(config.slot, config.id())]).await?;
        }
        let packed = self.node.read(0x2004, 1).await?;
        if config.slot <= 4 && packed != 0.0 {
            bail!("请先关闭压缩 MIT 格式再重映射 RPDO");
        }
        let original = self.node.read_pdo(config.slot).await?;
        if config == original {
            return Ok(());
        }
        let tail = self.mapping_tail(&original, config.entries.len()).await?;
        self.backup = Some(Backup {
            mode: self.node.read(0x6060, 0).await?,
            packed,
            maps: vec![(original, tail)],
        });
        if let Err(error) = self.node.apply_pdo(&config, &[]).await {
            return self.fail_closed(error).await;
        }
        self.backup = None;
        Ok(())
    }

    async fn mapping_tail(&mut self, original: &Pdo, count: usize) -> Result<Vec<u32>> {
        let map = comm(original.slot)? + 0x200;
        let mut tail = Vec::new();
        for offset in original.entries.len()..count {
            tail.push(self.node.read(map, offset as u8 + 1).await? as u32);
        }
        Ok(tail)
    }

    pub async fn set_packed(&mut self, on: bool) -> Result<()> {
        self.idle(false).await?;
        let value = if on { 1.0 } else { 0.0 };
        self.node.write(0x2004, 1, value).await?;
        ensure!(
            self.node.read(0x2004, 1).await? == value,
            "压缩格式读回不一致"
        );
        Ok(())
    }

    async fn check_ids(&mut self, selected: &[(u8, u16)]) -> Result<()> {
        let sync = self.node.read(0x1005, 0).await? as u32;
        let emcy = self.node.read(0x1014, 0).await? as u32;
        for &(slot, id) in selected {
            ensure!(
                selected.iter().filter(|item| item.1 == id).count() == 1
                    && u32::from(id) != sync & 0x7ff
                    && u32::from(id) != emcy & 0x7ff,
                "PDO{slot} COB-ID 冲突 0x{id:03X}"
            );
        }
        for other in 1..=8 {
            if !selected.iter().any(|item| item.0 == other) {
                let cob = self.node.read(comm(other)?, 1).await? as u32;
                ensure!(
                    cob & OFF != 0 || !selected.iter().any(|item| u32::from(item.1) == cob & 0x7ff),
                    "COB-ID 与已启用 PDO{other} 冲突"
                );
            }
        }
        Ok(())
    }

    async fn prepare(&mut self, mode: Mode, period_ms: u16, feedback: Feedback) -> Result<()> {
        let (command_slot, entries) = mode.command_map();
        let mut layouts = vec![(command_slot, entries), (8, &FEEDBACK[..])];
        if mode == Mode::PackedMit {
            layouts.push((1, &[0x60400010]));
        }
        let mut ranges = [[0.0; 2]; 5];
        if mode == Mode::PackedMit {
            for (offset, bound) in ranges.iter_mut().flatten().enumerate() {
                *bound = self.node.read(0x2004, 4 + offset as u8).await? as f32;
            }
        }
        let target = mode.neutral(feedback.position);
        let mut ids = Vec::new();
        let mut plans = Vec::new();
        for (slot, entries) in layouts {
            let original = self.node.read_pdo(slot).await?;
            let mut run = original.clone();
            let id = if original.id() != 0 {
                original.id()
            } else {
                (if slot <= 4 { 0x200 } else { 0x180 })
                    + u16::from((slot - 1) % 4) * 0x100
                    + u16::from(self.node.id)
            };
            run.cob = (original.cob & 0x40000000) | u32::from(id);
            run.entries = entries.to_vec();
            run.transmission = 255;
            run.inhibit = 0;
            run.timer_ms = if slot == 8 { 20 } else { original.timer_ms };
            run.validate()?;
            ids.push((slot, id));
            if run != original {
                let tail = self.mapping_tail(&original, entries.len()).await?;
                plans.push((original, tail, run));
            }
        }
        self.check_ids(&ids).await?;
        command_frame(mode, target, 0, ids[0].1, &ranges)?;
        let rx = self
            .node
            .bus
            .subscribe(CanFilter::exact_standard(ids[1].1))
            .await?;
        self.backup = Some(Backup {
            mode: self.node.read(0x6060, 0).await?,
            packed: self.node.read(0x2004, 1).await?,
            maps: Vec::new(),
        });
        self.node.write(0x2004, 1, 0.0).await?;
        for (original, tail, run) in plans {
            self.backup.as_mut().unwrap().maps.push((original, tail));
            self.node.apply_pdo(&run, &[]).await?;
        }
        self.node.write(0x6060, 0, mode.code().into()).await?;
        if mode == Mode::PackedMit {
            self.node.write(0x2004, 1, 1.0).await?;
        }
        self.node.nmt(1).await?;
        let now = Instant::now();
        self.cycle = Some(Cycle {
            mode,
            phase: Phase::AwaitDisabled,
            target,
            command_id: ids[0].1,
            feedback_id: ids[1].1,
            word_id: ids.get(2).map(|item| item.1),
            ranges,
            rx,
            period: Duration::from_millis(period_ms.into()),
            sent: false,
            quick_seen: false,
            edge_high: false,
            since: now,
            last_feedback: now,
            last_tx: None,
        });
        Ok(())
    }

    pub async fn start(&mut self, mode: Mode, period_ms: u16) -> Result<()> {
        ensure!((5..=20).contains(&period_ms), "PDO 周期应为 5–20 ms");
        let feedback = self.idle(false).await?;
        ensure!(feedback.calibration == 4, "未完成电角校准，拒绝使能");
        if let Err(error) = self.prepare(mode, period_ms, feedback).await {
            return self.fail_closed(error).await;
        }
        Ok(())
    }

    fn active(&mut self) -> Result<&mut Cycle> {
        self.cycle.as_mut().context("当前没有 PDO 周期会话")
    }
    pub fn set_target(&mut self, target: Target) -> Result<()> {
        self.active()?.set_target(target)
    }
    pub fn halt(&mut self, on: bool) -> Result<()> {
        self.active()?.halt(on)
    }
    pub fn quick_stop(&mut self) -> Result<()> {
        self.active()?.quick_stop()
    }

    pub async fn tick(&mut self) -> Result<Option<Feedback>> {
        let mut sample = None;
        let Some(cycle) = self.cycle.as_mut() else {
            return Ok(None);
        };
        match cycle.tick(&self.node, &mut sample).await {
            Ok(true) => self.stop(false).await?,
            Ok(false) => (),
            Err(error) => return self.fail_closed(error).await,
        }
        Ok(sample)
    }

    async fn fail_closed<T>(&mut self, error: anyhow::Error) -> Result<T> {
        if let Err(stop) = self.release().await {
            bail!("{error:#}；{stop:#}");
        }
        Err(error)
    }

    async fn disable(&mut self, interrupt: bool) -> Result<()> {
        if interrupt || self.calibration.is_some() {
            self.node.nmt(2).await?;
            sleep(Duration::from_millis(20)).await;
        }
        self.node.nmt(0x80).await?;
        self.node.write(0x6040, 0, 0.0).await?;
        self.wait_disabled(true).await?;
        ensure!(
            !(1..=3).contains(&(self.node.read(0x2100, 2).await? as u8)),
            "校准未中止"
        );
        self.calibration = None;
        if let Some(backup) = &mut self.backup {
            self.node.write(0x2004, 1, 0.0).await?;
            while let Some((original, tail)) = backup.maps.last() {
                self.node.apply_pdo(original, tail).await?;
                backup.maps.pop();
            }
            self.node.write(0x6060, 0, backup.mode).await?;
            self.node.write(0x2004, 1, backup.packed).await?;
            self.backup = None;
        }
        Ok(())
    }

    pub async fn stop(&mut self, interrupt_calibration: bool) -> Result<()> {
        self.cycle = None;
        self.unconfirmed = true;
        self.disable(interrupt_calibration)
            .await
            .context("关桥或恢复映射未确认，请物理断电或重试关桥")?;
        self.unconfirmed = false;
        Ok(())
    }
    pub async fn release(&mut self) -> Result<()> {
        if self.owns_output() {
            self.stop(false).await?;
        }
        Ok(())
    }

    pub async fn service(&mut self, command: Service) -> Result<()> {
        let feedback = self.idle(matches!(command, Service::ResetFault)).await?;
        match command {
            Service::Calibrate | Service::SlowScan => {
                let slow = matches!(command, Service::SlowScan);
                ensure!(!slow || feedback.calibration == 4, "慢扫描需要已有有效校准");
                self.calibration = Some(CalibrationRun {
                    started: Instant::now(),
                    observed_active: false,
                });
                if let Err(error) = self
                    .node
                    .write(
                        0x2100,
                        1,
                        u32::from_le_bytes(if slow { *b"slow" } else { *b"cali" }).into(),
                    )
                    .await
                {
                    return self.fail_closed(error).await;
                }
                Ok(())
            }
            Service::CompensationOn | Service::CompensationOff => {
                self.node
                    .write(
                        0x2100,
                        1,
                        u32::from_le_bytes(if matches!(command, Service::CompensationOn) {
                            *b"con "
                        } else {
                            *b"coff"
                        })
                        .into(),
                    )
                    .await
            }
            Service::Save => {
                self.node
                    .write(0x1010, 1, u32::from_le_bytes(*b"save").into())
                    .await
            }
            Service::Restore => {
                self.node
                    .write(0x1011, 1, u32::from_le_bytes(*b"load").into())
                    .await
            }
            Service::Reboot => self.node.nmt(0x81).await,
            Service::ResetCommunication => self.node.nmt(0x82).await,
            Service::ResetFault => {
                let pulse = async {
                    self.node.write(0x6040, 0, 128.0).await?;
                    self.wait_disabled(false).await
                }
                .await;
                self.node
                    .write(0x6040, 0, 0.0)
                    .await
                    .context("未确认复位脉冲已清零")?;
                pulse?;
                let fault = self.node.read(0x603f, 0).await? as u16;
                ensure!(fault == 0, "故障未清除：0x{fault:04X}");
                Ok(())
            }
        }
    }
}
