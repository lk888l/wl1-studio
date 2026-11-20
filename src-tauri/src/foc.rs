use crate::{commands::ProductSessionLifecycle, desktop};
use foc_drive::{Discovery, Feedback, Link, Mode, Motor, Pdo, Phase, Service, Target};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::{
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc as blocking, Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};
use tokio::sync::{mpsc, oneshot};

type Reply<T> = Result<T, String>;
const LEASE: Duration = Duration::from_secs(3);
const IDLE: Duration = Duration::from_millis(350);

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Action {
    Start { mode: Mode, period_ms: u16 },
    Target { target: Target },
    Halt { on: bool },
    QuickStop,
    Read { addresses: Vec<(u16, u8)> },
    Write { index: u16, sub: u8, value: f64 },
    ReadPdo { slot: u8 },
    WritePdo { config: Pdo },
    Packed { on: bool },
    Service { command: Service },
}

impl Action {
    async fn apply(self, motor: &mut Motor) -> Reply<Value> {
        let result: Result<Value, _> = async {
            match self {
                Self::Start { mode, period_ms } => motor.start(mode, period_ms).await?,
                Self::Target { target } => motor.set_target(target)?,
                Self::Halt { on } => motor.halt(on)?,
                Self::QuickStop => motor.quick_stop()?,
                Self::Read { addresses } => {
                    if addresses.len() > 32 {
                        return Err(anyhow::anyhow!("每批最多 32 个对象"));
                    }
                    let mut values = Vec::new();
                    for (index, sub) in addresses {
                        values.push(motor.read(index, sub).await?);
                    }
                    return Ok(json!(values));
                }
                Self::Write { index, sub, value } => {
                    return Ok(json!(motor.set_parameter(index, sub, value).await?))
                }
                Self::ReadPdo { slot } => return Ok(json!(motor.read_pdo(slot).await?)),
                Self::WritePdo { config } => motor.set_pdo(config).await?,
                Self::Packed { on } => motor.set_packed(on).await?,
                Self::Service { command } => motor.service(command).await?,
            }
            Ok(Value::Null)
        }
        .await;
        result.map_err(|error| format!("{error:#}"))
    }
}

#[derive(Clone, Serialize)]
struct TracePoint {
    seq: u64,
    time: u64,
    phase: Phase,
    source: &'static str,
    feedback: Feedback,
}

#[derive(Clone, Serialize)]
pub struct Snapshot {
    session: u64,
    link: Link,
    feedback: Feedback,
    phase: Phase,
    mode: Option<Mode>,
    sample: u64,
    age_ms: u64,
    source: &'static str,
    error: Option<String>,
    io_error: Option<String>,
    reset: bool,
    recent: Vec<TracePoint>,
}

struct Live {
    view: Snapshot,
    observed: Instant,
    lease: Instant,
    origin: Instant,
    history: VecDeque<TracePoint>,
}
impl Live {
    fn update(&mut self, motor: &Motor, reset: bool, error: Option<String>) {
        self.view.phase = motor.phase();
        self.view.mode = motor.mode();
        self.view.reset = reset;
        self.view.error = error;
    }
    fn record(&mut self) {
        if self.history.len() == 256 {
            self.history.pop_front();
        }
        self.history.push_back(TracePoint {
            seq: self.view.sample,
            time: self.observed.duration_since(self.origin).as_millis() as u64,
            phase: self.view.phase,
            source: self.view.source,
            feedback: self.view.feedback,
        });
    }
    fn snapshot(&self, after: u64) -> Snapshot {
        let mut snapshot = self.view.clone();
        snapshot.age_ms = self.observed.elapsed().as_millis() as u64;
        snapshot.recent = self
            .history
            .iter()
            .filter(|sample| sample.seq > after)
            .cloned()
            .collect();
        snapshot
    }
}
type Shared = Arc<Mutex<Live>>;
type Request = (u64, Action, oneshot::Sender<Reply<Value>>);
struct Urgent {
    exit: bool,
    physical_off: bool,
    ack: blocking::Sender<Reply<()>>,
}

struct Handle {
    shared: Shared,
    epoch: Arc<AtomicU64>,
    commands: mpsc::Sender<Request>,
    priority: mpsc::UnboundedSender<Urgent>,
    task: thread::JoinHandle<()>,
}

#[derive(Default)]
pub struct MotorHost {
    slot: Mutex<Option<Handle>>,
    next: AtomicU64,
}

impl MotorHost {
    fn connect(&self, link: Link) -> Reply<Snapshot> {
        let mut slot = self.slot.lock().unwrap();
        if slot.is_some() {
            return Err("请先释放当前电机会话".into());
        }
        let session = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (ready, opened) = blocking::channel();
        let (commands, inbox) = mpsc::channel(8);
        let (priority, urgent) = mpsc::unbounded_channel();
        let epoch = Arc::new(AtomicU64::new(0));
        let generation = epoch.clone();
        let task = thread::Builder::new()
            .name("g431-pdo".into())
            .spawn(move || {
                let runtime = match tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    Ok(runtime) => runtime,
                    Err(error) => {
                        let _ = ready.send(Err(error.to_string()));
                        return;
                    }
                };
                runtime.block_on(async move {
                    let mut motor = match link.open().await {
                        Ok(node) => Motor::new(node),
                        Err(error) => {
                            let _ = ready.send(Err(format!("{error:#}")));
                            return;
                        }
                    };
                    let feedback = match motor.inspect().await {
                        Ok(sample) => sample,
                        Err(error) => {
                            let _ = ready.send(Err(format!("{error:#}")));
                            return;
                        }
                    };
                    let view = Snapshot {
                        session,
                        link,
                        feedback,
                        phase: Phase::Idle,
                        mode: None,
                        sample: 1,
                        age_ms: 0,
                        source: "SDO",
                        error: None,
                        io_error: None,
                        reset: false,
                        recent: Vec::new(),
                    };
                    let now = Instant::now();
                    let mut live = Live {
                        view,
                        observed: now,
                        lease: now,
                        origin: now,
                        history: VecDeque::with_capacity(256),
                    };
                    live.record();
                    let shared = Arc::new(Mutex::new(live));
                    if ready.send(Ok(shared.clone())).is_ok() {
                        run(motor, shared, generation, inbox, urgent).await;
                    }
                });
            })
            .map_err(|error| error.to_string())?;
        let shared = opened.recv().map_err(|_| "CAN 工作线程意外结束")??;
        let snapshot = shared.lock().unwrap().snapshot(0);
        *slot = Some(Handle {
            shared,
            epoch,
            commands,
            priority,
            task,
        });
        Ok(snapshot)
    }

    fn urgent(&self, session: Option<u64>, exit: bool, physical_off: bool) -> Reply<()> {
        let mut slot = self.slot.lock().unwrap();
        let Some(handle) = slot.as_ref() else {
            return Ok(());
        };
        if session.is_some_and(|id| handle.shared.lock().unwrap().view.session != id) {
            return Err("电机会话已变更".into());
        }
        handle.epoch.fetch_add(1, Ordering::SeqCst);
        let (ack, response) = blocking::channel();
        handle
            .priority
            .send(Urgent {
                exit,
                physical_off,
                ack,
            })
            .map_err(|_| "驱动线程已退出，请检查电机供电")?;
        response
            .recv()
            .map_err(|_| "未收到关桥结果，请检查电机供电")??;
        if exit {
            slot.take()
                .unwrap()
                .task
                .join()
                .map_err(|_| "CAN 工作线程异常退出")?;
        }
        Ok(())
    }
    pub fn disconnect(&self) -> Reply<()> {
        self.urgent(None, true, false)
    }
}

async fn run(
    mut motor: Motor,
    shared: Shared,
    epoch: Arc<AtomicU64>,
    mut inbox: mpsc::Receiver<Request>,
    mut urgent: mpsc::UnboundedReceiver<Urgent>,
) {
    let mut next = tokio::time::Instant::now() + IDLE;
    let mut reset = false;
    loop {
        tokio::select! {
            biased;
            item = urgent.recv() => {
                let Some(item) = item else { break };
                let result = match (item.exit, item.physical_off) {
                    (true, true) if motor.phase() == Phase::Unconfirmed => Ok(()),
                    (_, true) => Err("仅在关桥未确认且已物理断电时可强制释放".to_string()),
                    (true, false) => motor.release().await.map_err(|error| format!("{error:#}")),
                    (false, false) if reset => Err("节点已复位，请使用新参数重新连接".to_string()),
                    (false, false) => motor.stop(true).await.map_err(|error| format!("{error:#}")),
                };
                let done = item.exit && result.is_ok();
                shared.lock().unwrap().update(&motor, reset, result.as_ref().err().cloned());
                let _ = item.ack.send(result);
                if done { return; }
                next = tokio::time::Instant::now();
            }
            _ = tokio::time::sleep_until(next), if !reset => {
                sample_motor(&mut motor, &shared, &epoch).await;
                next = motor.next_tick().unwrap_or_else(|| tokio::time::Instant::now() + IDLE);
            }
            request = inbox.recv() => {
                let Some((generation, action, reply)) = request else { break };
                if generation != epoch.load(Ordering::SeqCst) || reset {
                    let _ = reply.send(Err("命令已被停止或重启操作撤销".into()));
                    continue;
                }
                let start = matches!(action, Action::Start { .. });
                let reboot = matches!(action, Action::Service { command: Service::ResetCommunication | Service::Reboot });
                let result = action.apply(&mut motor).await;
                reset = reboot && result.is_ok();
                if start || !motor.cyclic() { next = tokio::time::Instant::now(); }
                shared.lock().unwrap().update(&motor, reset, result.as_ref().err().cloned());
                let _ = reply.send(result);
            }
        }
    }
    let _ = motor.release().await;
}

async fn sample_motor(motor: &mut Motor, shared: &Shared, epoch: &AtomicU64) {
    let owned = motor.owns_output();
    let cyclic = motor.cyclic();
    let expired = shared.lock().unwrap().lease.elapsed() > LEASE;
    let result = if expired && owned && motor.phase() != Phase::Unconfirmed {
        epoch.fetch_add(1, Ordering::SeqCst);
        match motor.release().await {
            Ok(()) => Err("界面租约已过期，已主动关桥".to_string()),
            Err(error) => Err(format!("界面租约已过期；{error:#}")),
        }
    } else if cyclic {
        motor.tick().await.map_err(|error| format!("{error:#}"))
    } else {
        motor
            .inspect()
            .await
            .map(Some)
            .map_err(|error| format!("{error:#}"))
    };
    let mut live = shared.lock().unwrap();
    live.view.phase = motor.phase();
    live.view.mode = motor.mode();
    match result {
        Ok(Some(sample)) => {
            live.view.feedback = sample;
            live.view.sample += 1;
            live.observed = Instant::now();
            live.view.source = if cyclic { "TPDO4" } else { "SDO" };
            live.view.io_error = None;
            live.record();
        }
        Ok(None) => (),
        Err(error) if owned => live.view.error = Some(error),
        Err(error) => live.view.io_error = Some(error),
    }
}

#[tauri::command]
pub async fn foc_connect(app: AppHandle, link: Link) -> Reply<Snapshot> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<ProductSessionLifecycle>();
        let _guard = lifecycle.0.lock().unwrap();
        desktop::ensure_foreground(&app)?;
        app.state::<MotorHost>().connect(link)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn foc_listen(app: AppHandle, link: Link) -> Reply<Discovery> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<ProductSessionLifecycle>();
        let _guard = lifecycle.0.lock().unwrap();
        desktop::ensure_foreground(&app)?;
        if app.state::<MotorHost>().slot.lock().unwrap().is_some() {
            return Err("请先断开当前会话再监听".into());
        }
        tauri::async_runtime::block_on(link.listen()).map_err(|error| format!("{error:#}"))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn foc_release(
    app: AppHandle,
    session: Option<u64>,
    physical_off: Option<bool>,
) -> Reply<()> {
    tauri::async_runtime::spawn_blocking(move || {
        let lifecycle = app.state::<ProductSessionLifecycle>();
        let _guard = lifecycle.0.lock().unwrap();
        app.state::<MotorHost>()
            .urgent(session, true, physical_off.unwrap_or(false))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn foc_stop(app: AppHandle, session: u64) -> Reply<()> {
    tauri::async_runtime::spawn_blocking(move || {
        app.state::<MotorHost>().urgent(Some(session), false, false)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn foc_action(state: State<'_, MotorHost>, session: u64, action: Action) -> Reply<Value> {
    let response = {
        let slot = state.slot.lock().unwrap();
        let handle = slot.as_ref().ok_or("未连接")?;
        if handle.shared.lock().unwrap().view.session != session {
            return Err("电机会话已变更".into());
        }
        let (reply, response) = oneshot::channel();
        handle
            .commands
            .try_send((handle.epoch.load(Ordering::SeqCst), action, reply))
            .map_err(|_| "电机会话繁忙或已关闭")?;
        response
    };
    response.await.map_err(|_| "电机会话已关闭".to_string())?
}

#[tauri::command]
pub fn foc_snapshot(
    state: State<'_, MotorHost>,
    session: u64,
    after_sample: Option<u64>,
) -> Reply<Snapshot> {
    let slot = state.slot.lock().unwrap();
    let mut live = slot.as_ref().ok_or("未连接")?.shared.lock().unwrap();
    if live.view.session != session {
        return Err("电机会话已变更".into());
    }
    live.lease = Instant::now();
    Ok(live.snapshot(after_sample.unwrap_or(0)))
}
