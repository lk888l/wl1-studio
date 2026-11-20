use anyhow::{bail, ensure, Context, Result};
use foc_drive::{Link, Mode, Motor, Phase, Target};
use std::time::Duration;
use tokio::time::{sleep_until, Instant};

async fn run_velocity(motor: &mut Motor, rev_s: f32) -> Result<()> {
    let interrupt = tokio::signal::ctrl_c();
    tokio::pin!(interrupt);
    motor.start(Mode::Velocity, 10).await?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut move_until = None;
    let mut stopping = false;
    while let Some(next) = motor.next_tick() {
        tokio::select! {
            result = &mut interrupt => { result?; break; }
            _ = sleep_until(next) => {}
        }
        ensure!(Instant::now() < deadline, "演示总时限已到，撤销输出");
        let feedback = motor.tick().await?;
        if motor.phase() == Phase::Running && move_until.is_none() {
            println!("使能已确认：{:?}", feedback);
            motor.set_target(Target::Velocity { rev_s })?;
            move_until = Some(Instant::now() + Duration::from_secs(1));
        }
        if !stopping && move_until.is_some_and(|until| Instant::now() >= until) {
            motor.quick_stop()?;
            stopping = true;
        }
    }
    Ok(())
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().skip(1).collect();
    if args.is_empty() || args == ["--help"] {
        println!("默认不打开设备。只读：inspect；驱动：pdo_velocity --enable NODE REV/S（±0.2 rev/s，1 秒）。请先准备物理急停。");
        return Ok(());
    }
    let [flag, node, speed] = args.as_slice() else {
        bail!("参见 --help");
    };
    ensure!(flag == "--enable", "必须显式指定 --enable");
    let rev_s: f32 = speed.parse()?;
    ensure!(rev_s.abs() <= 0.2, "演示速度限 ±0.2 rev/s");
    let link = Link {
        node: node.parse()?,
        ..Link::default()
    };
    let mut motor = Motor::new(link.open().await?);
    println!("只读检查：{:?}", motor.inspect().await?);
    let motion = run_velocity(&mut motor, rev_s).await;
    motor
        .release()
        .await
        .context("未确认关桥或恢复映射，请物理切断功率电源")?;
    motion
}
