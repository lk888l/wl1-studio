use crate::{
    motion::{command_frame, Ranges},
    Feedback, Mode, Node, Target,
};
use anyhow::{ensure, Result};
use can_transport::{CanFrame, CanId, CanRx};
use serde::Serialize;
use std::time::Duration;
use tokio::time::Instant;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    AwaitDisabled,
    Shutdown,
    SwitchOn,
    Enable,
    Running,
    PositionLow,
    PositionHigh,
    Halted,
    QuickStop,
    Calibrating,
    Unconfirmed,
}

pub(crate) struct Cycle {
    pub mode: Mode,
    pub phase: Phase,
    pub target: Target,
    pub command_id: u16,
    pub feedback_id: u16,
    pub word_id: Option<u16>,
    pub ranges: Ranges,
    pub rx: Box<dyn CanRx>,
    pub period: Duration,
    pub sent: bool,
    pub quick_seen: bool,
    pub edge_high: bool,
    pub since: Instant,
    pub last_feedback: Instant,
    pub last_tx: Option<Instant>,
}

impl Cycle {
    fn enter(&mut self, phase: Phase) {
        self.phase = phase;
        self.since = Instant::now();
        self.sent = false;
    }

    pub fn set_target(&mut self, target: Target) -> Result<()> {
        ensure!(
            self.phase == Phase::Running,
            "等待使能或位置应答；暂停中不可下发目标"
        );
        command_frame(self.mode, target, 0, self.command_id, &self.ranges)?;
        if matches!(target, Target::Position { .. }) {
            self.edge_high = false;
            self.enter(Phase::PositionLow);
        }
        self.target = target;
        Ok(())
    }

    pub fn halt(&mut self, on: bool) -> Result<()> {
        ensure!(
            matches!(
                (on, self.phase),
                (true, Phase::Running) | (false, Phase::Halted)
            ),
            "当前不可暂停或恢复"
        );
        self.enter(if on { Phase::Halted } else { Phase::Running });
        Ok(())
    }

    pub fn quick_stop(&mut self) -> Result<()> {
        ensure!(
            matches!(
                self.phase,
                Phase::Running | Phase::Halted | Phase::PositionLow | Phase::PositionHigh
            ),
            "当前不可快速停止"
        );
        self.enter(Phase::QuickStop);
        Ok(())
    }

    fn word(&self) -> u16 {
        match self.phase {
            Phase::Shutdown => 6,
            Phase::SwitchOn => 7,
            Phase::Enable => 15,
            Phase::QuickStop => 11,
            Phase::Running | Phase::Halted | Phase::PositionLow | Phase::PositionHigh => {
                15 | if self.phase == Phase::Halted { 256 } else { 0 }
                    | if self.edge_high { 16 } else { 0 }
                    | if matches!(self.target, Target::Position { relative: true, .. }) {
                        64
                    } else {
                        0
                    }
            }
            _ => 0,
        }
    }

    fn validate_feedback(&self, feedback: Feedback) -> Result<()> {
        let state = feedback.state();
        ensure!(
            feedback.fault == 0 && state != 8 && feedback.calibration == 4,
            "驱动故障 0x{:04X}，状态 0x{:04X}，校准 {}",
            feedback.fault,
            feedback.status,
            feedback.calibration
        );
        if matches!(
            self.phase,
            Phase::Running | Phase::PositionLow | Phase::PositionHigh | Phase::Halted
        ) {
            ensure!(
                state == 0x27 && feedback.mode == self.mode.code(),
                "驱动意外退出已使能模式"
            );
        }
        Ok(())
    }

    fn observe(&mut self, feedback: Feedback) -> Result<bool> {
        let state = feedback.state();
        if !self.sent {
            return Ok(false);
        }
        match (self.phase, state) {
            (Phase::AwaitDisabled, 0x40) => self.enter(Phase::Shutdown),
            (Phase::Shutdown, 0x21) => self.enter(Phase::SwitchOn),
            (Phase::SwitchOn, 0x23) => self.enter(Phase::Enable),
            (Phase::Enable, 0x27) if feedback.mode == self.mode.code() => {
                self.enter(Phase::Running)
            }
            (Phase::PositionLow, _) if feedback.status & 0x1000 == 0 => {
                self.edge_high = true;
                self.enter(Phase::PositionHigh);
            }
            (Phase::PositionHigh, _) if feedback.status & 0x1000 != 0 => self.enter(Phase::Running),
            (Phase::QuickStop, 0x40) => return Ok(true),
            (Phase::QuickStop, 0x07) => self.quick_seen = true,
            _ => (),
        }
        Ok(false)
    }

    pub async fn tick(&mut self, node: &Node, sample: &mut Option<Feedback>) -> Result<bool> {
        let now = Instant::now();
        ensure!(
            self.last_tx
                .is_none_or(|last| now - last < Duration::from_millis(100)),
            "主站 PDO 调度超过 100 ms"
        );
        let mut newest = None;
        let mut count = 0;
        while let Some(frame) = self.rx.try_recv()? {
            count += 1;
            ensure!(count <= 128, "TPDO 反馈积压，停止使用可能过时的状态");
            let feedback = Feedback::from_frame(frame, self.feedback_id)?;
            self.validate_feedback(feedback)?;
            newest = Some(feedback);
        }
        if let Some(feedback) = newest {
            *sample = Some(feedback);
            self.last_feedback = now;
            if self.observe(feedback)? {
                return Ok(true);
            }
        }
        ensure!(
            now - self.last_feedback < Duration::from_millis(200),
            "TPDO4 反馈超时"
        );
        ensure!(
            matches!(self.phase, Phase::Running | Phase::Halted)
                || self.quick_seen
                || self.since.elapsed() < Duration::from_millis(600),
            "驱动握手超时：{:?}",
            self.phase
        );
        if self.last_tx.is_none_or(|last| now - last >= self.period) || !self.sent {
            let word = self.word();
            node.send(command_frame(
                self.mode,
                self.target,
                word,
                self.command_id,
                &self.ranges,
            )?)
            .await?;
            if let Some(id) = self.word_id {
                node.send(CanFrame::new_data(
                    CanId::Standard(id),
                    &word.to_le_bytes(),
                )?)
                .await?;
            }
            self.sent = true;
            self.last_tx = Some(now);
        }
        Ok(false)
    }
}
