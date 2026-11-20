use super::*;
use crate::{
    motion::command_frame,
    od::{object, OBJECTS},
    pdo::{comm, OFF},
};
use async_trait::async_trait;
use can_transport::{CanBus, CanCapabilities, CanFilter, CanFrame, CanId, CanIoError, CanRx};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::mpsc;

type Dictionary = BTreeMap<(u16, u8), f64>;
struct Model {
    od: Dictionary,
    operational: bool,
    respond: bool,
    telemetry: bool,
    reject: Option<(u16, u8)>,
    sent: Vec<CanFrame>,
    subscribers: Vec<(CanFilter, mpsc::UnboundedSender<CanFrame>)>,
}

impl Default for Model {
    fn default() -> Self {
        let mut od: Dictionary = OBJECTS
            .iter()
            .map(|field| ((field.index, field.sub), field.default.parse().unwrap()))
            .collect();
        for slot in 1..=8 {
            *od.get_mut(&(comm(slot).unwrap(), 1)).unwrap() += 1.0;
        }
        od.insert((0x1014, 0), 129.0);
        od.insert((0x6041, 0), 64.0);
        od.insert((0x2100, 2), 4.0);
        Self {
            od,
            operational: false,
            respond: true,
            telemetry: true,
            reject: None,
            sent: Vec::new(),
            subscribers: Vec::new(),
        }
    }
}

impl Model {
    fn emit(&mut self, frame: CanFrame) {
        self.subscribers.retain(|(filter, tx)| {
            !tx.is_closed() && (!filter.matches(&frame) || tx.send(frame).is_ok())
        });
    }
    fn sdo(&mut self, request: &[u8]) {
        if !self.respond {
            return;
        }
        let index = u16::from_le_bytes([request[1], request[2]]);
        let sub = request[3];
        let key = (index, sub);
        let field = object(index, sub).unwrap();
        let size = field.scalar.size();
        let mut reply = [0; 8];
        reply[1..4].copy_from_slice(&request[1..4]);
        if request[0] == 0x40 {
            reply[0] = 0x43 + ((4 - size) * 4) as u8;
            reply[4..4 + size].copy_from_slice(&field.scalar.encode(self.od[&key]).unwrap());
        } else if self.reject == Some(key) {
            self.reject = None;
            reply[0] = 0x80;
            reply[4..].copy_from_slice(&0x06040041u32.to_le_bytes());
        } else {
            assert!(field.writable);
            assert_eq!(request[0], 0x23 + ((4 - size) * 4) as u8);
            reply[0] = 0x60;
            let value = field.scalar.decode(&request[4..4 + size]).unwrap();
            self.od.insert(key, value);
            if key == (0x6040, 0) && value == 0.0 {
                self.od.insert((0x6041, 0), 64.0);
                self.od.insert((0x6061, 0), 0.0);
            }
        }
        self.emit(CanFrame::new_data(CanId::Standard(0x581), &reply).unwrap());
    }
    fn pdo(&mut self, frame: CanFrame) {
        assert!(self.operational);
        let id = frame.id().raw();
        let slot = (1..=4)
            .find(|&slot| self.od[&(comm(slot).unwrap(), 1)] as u32 == id)
            .unwrap();
        let map = comm(slot).unwrap() + 0x200;
        let mut offset = 0;
        let mut word = None;
        for sub in 1..=self.od[&(map, 0)] as u8 {
            let mapping = self.od[&(map, sub)] as u32;
            let key = ((mapping >> 16) as u16, (mapping >> 8) as u8);
            let size = (mapping & 255) as usize / 8;
            let value = object(key.0, key.1)
                .unwrap()
                .scalar
                .decode(&frame.data()[offset..offset + size])
                .unwrap();
            self.od.insert(key, value);
            offset += size;
            if key == (0x6040, 0) {
                word = Some(value as u16);
            }
        }
        assert_eq!(frame.is_fd(), offset > 8);
        assert!(frame.data()[offset..].iter().all(|byte| *byte == 0));
        let Some(word) = word else {
            return;
        };
        let previous = self.od[&(0x6041, 0)] as u16 & 0x6f;
        let state = match (word & 15, previous) {
            (0, _) => 0x40,
            (6, 0x40 | 0x21) => 0x21,
            (7, 0x21 | 0x23) => 0x23,
            (15, 0x23 | 0x27) => 0x27,
            (11, 0x27) => 7,
            (11, 7 | 0x40) => 0x40,
            _ => panic!("unexpected transition {previous:x} -> {word:x}"),
        };
        let status = state | if word & 16 != 0 { 0x1000 } else { 0 };
        let mode = if state == 0x27 {
            self.od[&(0x6060, 0)]
        } else {
            0.0
        };
        self.od.insert((0x6041, 0), status.into());
        self.od.insert((0x6061, 0), mode);
        if !self.telemetry {
            return;
        }
        let mut payload = Vec::new();
        for sub in 1..=self.od[&(0x1a03, 0)] as u8 {
            let mapping = self.od[&(0x1a03, sub)] as u32;
            let key = ((mapping >> 16) as u16, (mapping >> 8) as u8);
            payload.extend(
                object(key.0, key.1)
                    .unwrap()
                    .scalar
                    .encode(self.od[&key])
                    .unwrap(),
            );
        }
        assert_eq!(payload.len(), 30);
        payload.resize(32, 0);
        let feedback_id = self.od[&(0x1803, 1)] as u32;
        assert_eq!(feedback_id & OFF, 0);
        self.emit(
            CanFrame::new_fd(
                CanId::Standard((feedback_id & 0x7ff) as u16),
                &payload,
                true,
            )
            .unwrap(),
        );
    }
}

#[derive(Default)]
struct MemoryBus(Mutex<Model>);
struct MemoryRx(mpsc::UnboundedReceiver<CanFrame>);
#[async_trait]
impl CanRx for MemoryRx {
    async fn recv(&mut self) -> Result<CanFrame, CanIoError> {
        self.0.recv().await.ok_or(CanIoError::Disconnected)
    }
    fn try_recv(&mut self) -> Result<Option<CanFrame>, CanIoError> {
        match self.0.try_recv() {
            Ok(frame) => Ok(Some(frame)),
            Err(mpsc::error::TryRecvError::Empty) => Ok(None),
            Err(_) => Err(CanIoError::Disconnected),
        }
    }
}
#[async_trait]
impl CanBus for MemoryBus {
    async fn send(&self, frame: CanFrame) -> Result<(), CanIoError> {
        let mut model = self.0.lock().unwrap();
        model.sent.push(frame);
        match frame.id().raw() {
            0x601 => {
                assert!(!frame.is_fd());
                model.sdo(frame.data());
            }
            0 => {
                assert!(!frame.is_fd());
                assert_eq!(frame.data()[1], 1);
                model.operational = frame.data()[0] == 1;
            }
            _ => model.pdo(frame),
        }
        Ok(())
    }
    async fn subscribe(&self, filter: CanFilter) -> Result<Box<dyn CanRx>, CanIoError> {
        let (tx, rx) = mpsc::unbounded_channel();
        self.0.lock().unwrap().subscribers.push((filter, tx));
        Ok(Box::new(MemoryRx(rx)))
    }
    fn capabilities(&self) -> CanCapabilities {
        CanCapabilities {
            fd: true,
            max_dlen: 64,
        }
    }
}

async fn axis() -> (Arc<MemoryBus>, Motor) {
    let bus = Arc::new(MemoryBus::default());
    let node = Node::attach(bus.clone(), 1).await.unwrap();
    (bus, Motor::new(node))
}
async fn step(motor: &mut Motor) -> anyhow::Result<Option<Feedback>> {
    tokio::time::sleep_until(motor.next_tick().unwrap()).await;
    motor.tick().await
}
async fn running(motor: &mut Motor, mode: Mode) {
    motor.start(mode, 10).await.unwrap();
    for _ in 0..8 {
        step(motor).await.unwrap();
        if motor.phase() == Phase::Running {
            return;
        }
    }
    panic!("did not enable");
}
fn parameters(model: &Model) -> Dictionary {
    model
        .od
        .clone()
        .into_iter()
        .filter(|((index, _), _)| {
            (0x1400..0x1b00).contains(index) || matches!(index, 0x2004 | 0x6060)
        })
        .collect()
}

#[tokio::test(start_paused = true)]
async fn inspect_release_and_wrong_identity_never_write() {
    let (bus, mut motor) = axis().await;
    motor.inspect().await.unwrap();
    motor.release().await.unwrap();
    bus.0.lock().unwrap().od.insert((0x1018, 2), 7.0);
    assert!(Node::attach(bus.clone(), 1).await.is_err());
    assert!(bus
        .0
        .lock()
        .unwrap()
        .sent
        .iter()
        .all(|frame| frame.id().raw() == 0x601 && frame.data()[0] == 0x40));
}

#[tokio::test(start_paused = true)]
async fn velocity_handshake_cyclic_without_sdo_and_restores_prior_route() {
    let (bus, mut motor) = axis().await;
    {
        let mut device = bus.0.lock().unwrap();
        device.od.insert((0x1400, 1), (OFF + 0x235).into());
        device.od.insert((0x1a03, 2), 0x60640020u32.into());
    }
    let initial = parameters(&bus.0.lock().unwrap());
    running(&mut motor, Mode::Velocity).await;
    let words = bus
        .0
        .lock()
        .unwrap()
        .sent
        .iter()
        .filter(|frame| frame.id().raw() == 0x235)
        .map(|frame| u16::from_le_bytes(frame.data()[4..6].try_into().unwrap()))
        .collect::<Vec<_>>();
    assert_eq!(&words[..4], &[0, 6, 7, 15]);
    bus.0.lock().unwrap().sent.clear();
    assert!(motor.read(0x6041, 0).await.is_err());
    assert!(motor.set_target(Target::Torque { permille: 1 }).is_err());
    motor
        .set_target(Target::Velocity { rev_s: -0.125 })
        .unwrap();
    step(&mut motor).await.unwrap();
    motor.halt(true).unwrap();
    step(&mut motor).await.unwrap();
    motor.halt(false).unwrap();
    step(&mut motor).await.unwrap();
    {
        let model = bus.0.lock().unwrap();
        assert!(model
            .sent
            .iter()
            .all(|frame| frame.id().raw() == 0x235 && frame.dlc() == 7 && !frame.is_fd()));
        assert_eq!(&model.sent[0].data()[..4], &(-0.125f32).to_le_bytes());
        assert_eq!(&model.sent[1].data()[4..6], &0x010fu16.to_le_bytes());
    }
    motor.quick_stop().unwrap();
    for _ in 0..4 {
        if motor.cyclic() {
            step(&mut motor).await.unwrap();
        }
    }
    assert_eq!(motor.phase(), Phase::Idle);
    assert_eq!(initial, parameters(&bus.0.lock().unwrap()));
}

#[tokio::test(start_paused = true)]
async fn both_position_modes_latch_relative_target_once_per_accepted_edge() {
    for mode in [Mode::SingleTurn, Mode::MultiTurn] {
        let (bus, mut motor) = axis().await;
        running(&mut motor, mode).await;
        bus.0.lock().unwrap().sent.clear();
        let target = Target::Position {
            rev: 0.1,
            relative: true,
        };
        motor.set_target(target).unwrap();
        assert!(motor.set_target(target).is_err());
        for _ in 0..7 {
            step(&mut motor).await.unwrap();
        }
        assert_eq!(motor.phase(), Phase::Running);
        {
            let model = bus.0.lock().unwrap();
            let words = model
                .sent
                .iter()
                .map(|frame| {
                    assert_eq!(frame.id().raw(), 0x301);
                    assert_eq!(frame.data()[6], mode.code() as u8);
                    u16::from_le_bytes(frame.data()[4..6].try_into().unwrap())
                })
                .collect::<Vec<_>>();
            assert_eq!(words[0], 0x4f);
            assert!(words[1..].iter().all(|word| *word == 0x5f));
        }
        motor.release().await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn packed_command_precedes_separate_controlword_and_other_formats_enable() {
    for mode in [Mode::PackedMit, Mode::Mit, Mode::Torque] {
        let (bus, mut motor) = axis().await;
        running(&mut motor, mode).await;
        {
            let model = bus.0.lock().unwrap();
            let start = model
                .sent
                .iter()
                .position(|frame| frame.id().raw() == 0 && frame.data()[0] == 1)
                .unwrap();
            let frames = &model.sent[start + 1..];
            if mode == Mode::PackedMit {
                for pair in frames.chunks_exact(2) {
                    assert_eq!((pair[0].id().raw(), pair[0].dlc()), (0x501, 8));
                    assert_eq!((pair[1].id().raw(), pair[1].dlc()), (0x201, 2));
                }
            } else {
                assert!(frames.iter().all(|frame| if mode == Mode::Mit {
                    frame.brs() && frame.dlc() == 20
                } else {
                    !frame.is_fd() && frame.dlc() == 5
                }));
            }
        }
        motor.release().await.unwrap();
    }
}

#[tokio::test(start_paused = true)]
async fn link_loss_never_claims_confirmed_stop_and_recovery_is_explicit() {
    let (bus, mut motor) = axis().await;
    running(&mut motor, Mode::Velocity).await;
    bus.0.lock().unwrap().respond = false;
    tokio::time::advance(Duration::from_millis(101)).await;
    assert!(motor.tick().await.is_err());
    assert_eq!(motor.phase(), Phase::Unconfirmed);
    assert!(motor.owns_output());
    assert!(motor.start(Mode::Velocity, 10).await.is_err());
    bus.0.lock().unwrap().respond = true;
    motor.release().await.unwrap();
    assert_eq!(motor.phase(), Phase::Idle);
}

#[tokio::test(start_paused = true)]
async fn feedback_timeout_stops_even_when_transmit_is_healthy() {
    let (bus, mut motor) = axis().await;
    running(&mut motor, Mode::Velocity).await;
    bus.0.lock().unwrap().telemetry = false;
    let mut error = None;
    for _ in 0..25 {
        if let Err(reason) = step(&mut motor).await {
            error = Some(reason);
            break;
        }
    }
    assert!(error.unwrap().to_string().contains("TPDO4"));
    assert!(!motor.owns_output());
}

#[tokio::test(start_paused = true)]
async fn calibration_guard_and_mapping_abort_never_enable_and_undo_partial_changes() {
    let (bus, mut motor) = axis().await;
    bus.0.lock().unwrap().od.insert((0x2100, 2), 0.0);
    assert!(motor.start(Mode::Velocity, 10).await.is_err());
    bus.0.lock().unwrap().od.insert((0x2100, 2), 4.0);
    let prior = parameters(&bus.0.lock().unwrap());
    bus.0.lock().unwrap().reject = Some((0x1a03, 7));
    let error = motor.start(Mode::Velocity, 10).await.unwrap_err();
    assert!(format!("{error:#}").contains("06040041"));
    assert_eq!(motor.phase(), Phase::Idle);
    let model = bus.0.lock().unwrap();
    assert_eq!(prior, parameters(&model));
    assert!(!model
        .sent
        .iter()
        .any(|frame| frame.id().raw() == 0 && frame.data()[0] == 1));
}

#[test]
fn dictionary_types_and_wire_vectors_match_the_firmware() {
    assert_eq!(OBJECTS.len(), 286);
    assert!(object(0x2001, 4).unwrap().setting(0.0).is_err());
    assert!(object(0x2001, 1).unwrap().setting(1.5).is_err());
    assert!(object(0x2001, 2).unwrap().setting(800000.0).is_err());
    assert!(object(0x6072, 0).unwrap().setting(1001.0).is_err());
    let ranges = [
        [-0.5, 0.5],
        [-10.0, 10.0],
        [0.0, 100.0],
        [0.0, 20.0],
        [-0.05, 0.05],
    ];
    let target = Target::Mit {
        rev: 0.5,
        rev_s: -10.0,
        kp: 100.0,
        kd: 0.0,
        nm: 0.05,
    };
    let frame = command_frame(Mode::PackedMit, target, 15, 0x501, &ranges).unwrap();
    assert_eq!(
        frame.data(),
        &[0xff, 0x0f, 0x00, 0xff, 0x0f, 0x00, 0xff, 0xff]
    );
    let target = Target::Mit {
        rev: 1.0,
        rev_s: -2.0,
        kp: 1.0,
        kd: 0.5,
        nm: 0.0,
    };
    let frame = command_frame(Mode::Mit, target, 15, 0x501, &ranges).unwrap();
    assert!(frame.brs());
    assert_eq!(
        frame.data(),
        &[0, 0, 128, 63, 0, 0, 0, 192, 0, 0, 0, 0, 232, 3, 244, 1, 15, 0, 5, 0]
    );
    assert!(command_frame(Mode::PackedMit, target, 0, 0x501, &ranges).is_err());
    assert!(command_frame(
        Mode::Velocity,
        Target::Velocity { rev_s: f32::NAN },
        0,
        0x201,
        &ranges
    )
    .is_err());
    let id = CanId::Standard(0x481);
    assert!(Feedback::from_frame(CanFrame::new_fd(id, &[0; 32], false).unwrap(), 0x481).is_err());
    assert!(Feedback::from_frame(CanFrame::new_fd(id, &[0; 24], true).unwrap(), 0x481).is_err());
}

#[test]
fn twenty_gs_usb_profiles_and_passive_mode_need_no_device() {
    use can_transport::gs_usb::GsTiming;
    let rate = |timing: GsTiming| {
        80_000_000 / (timing.brp * (1 + timing.prop_seg + timing.phase_seg1 + timing.phase_seg2))
    };
    for nominal in od::NOMINAL {
        for data in od::DATA {
            let link = Link {
                channel: 3,
                nominal,
                data,
                ..Link::default()
            };
            for silent in [false, true] {
                let config = link.timing_config(silent).unwrap();
                assert_eq!(
                    (config.channel, config.fd, config.listen_only),
                    (3, true, silent)
                );
                assert_eq!(rate(config.nominal), nominal);
                assert_eq!(rate(config.data.unwrap()), data);
            }
        }
    }
    assert!(Link {
        channel: 4,
        ..Link::default()
    }
    .timing_config(false)
    .is_err());
    assert!(Link {
        node: 0,
        ..Link::default()
    }
    .timing_config(false)
    .is_err());
}

#[tokio::test(start_paused = true)]
async fn faults_between_healthy_samples_are_not_hidden_by_coalescing() {
    let (bus, mut motor) = axis().await;
    running(&mut motor, Mode::Velocity).await;
    {
        let mut device = bus.0.lock().unwrap();
        let mut payload = [0; 32];
        payload[0] = 0x40;
        payload[29] = 4;
        let id = CanId::Standard(0x481);
        device.emit(CanFrame::new_fd(id, &payload, true).unwrap());
        payload[0] = 0x27;
        payload[28] = 3;
        device.emit(CanFrame::new_fd(id, &payload, true).unwrap());
    }
    assert!(step(&mut motor).await.is_err());
    assert_eq!(motor.phase(), Phase::Idle);
}

#[tokio::test(start_paused = true)]
async fn parameters_read_back_and_manual_mapping_is_transactional() {
    let (bus, mut motor) = axis().await;
    assert_eq!(motor.set_parameter(0x6081, 0, 1.25).await.unwrap(), 1.25);
    let mut config = motor.read_pdo(8).await.unwrap();
    let initial = config.clone();
    config.entries = vec![0x60640020, 0x606c0020];
    config.cob &= !OFF;
    config.transmission = 255;
    config.timer_ms = 25;
    bus.0.lock().unwrap().reject = Some((0x1803, 2));
    assert!(motor.set_pdo(config.clone()).await.is_err());
    assert_eq!(motor.read_pdo(8).await.unwrap(), initial);
    motor.set_pdo(config.clone()).await.unwrap();
    assert_eq!(motor.read_pdo(8).await.unwrap(), config);
    assert_eq!(motor.phase(), Phase::Idle);
    assert!(bus
        .0
        .lock()
        .unwrap()
        .sent
        .iter()
        .all(|frame| frame.id().raw() != 0 || frame.data()[0] == 0x80));
}

#[tokio::test(start_paused = true)]
async fn calibration_requires_a_real_state_sequence_not_elapsed_time_alone() {
    let (bus, mut motor) = axis().await;
    motor.service(Service::Calibrate).await.unwrap();
    tokio::time::advance(Duration::from_millis(350)).await;
    motor.inspect().await.unwrap();
    assert_eq!(motor.phase(), Phase::Calibrating);
    assert!(motor.read(0x1018, 0).await.is_err());
    bus.0.lock().unwrap().od.insert((0x2100, 2), 2.0);
    motor.inspect().await.unwrap();
    bus.0.lock().unwrap().od.insert((0x2100, 2), 4.0);
    motor.inspect().await.unwrap();
    assert_eq!(motor.phase(), Phase::Idle);
    motor.service(Service::SlowScan).await.unwrap();
    bus.0.lock().unwrap().respond = false;
    assert!(motor.inspect().await.is_err());
    assert_eq!(motor.phase(), Phase::Unconfirmed);
    bus.0.lock().unwrap().respond = true;
    motor.release().await.unwrap();
}
