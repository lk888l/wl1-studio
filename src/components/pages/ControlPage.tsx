import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Gamepad2,
  Octagon,
  ShieldAlert,
  ShieldCheck,
  SlidersHorizontal,
  WifiOff,
} from "lucide-react";
import { useEffect, useRef, useState, type PointerEvent } from "react";

import { HoldCommandRepeater, neutralMotion } from "../../lib/hold-control";
import { motionCommand } from "../../lib/device";
import type { MotionTarget, TelemetrySample } from "../../types";

type Direction = "forward" | "backward" | "left" | "right";

interface ControlPageProps {
  connected: boolean;
  writesUnlocked: boolean;
  suspended: boolean;
  sample?: TelemetrySample;
  imuFresh: boolean;
  rpmFresh: boolean;
  telemetryRequired: boolean;
  telemetryHealthy: boolean;
  lastCommand: string;
  heightTarget: number | null;
  heightRequested: boolean;
  onHeightTargetChange: (height: number) => void;
  onSendMotion: (target: MotionTarget) => Promise<void>;
}

const directionKeys: Record<string, Direction> = {
  w: "forward",
  ArrowUp: "forward",
  s: "backward",
  ArrowDown: "backward",
  a: "left",
  ArrowLeft: "left",
  d: "right",
  ArrowRight: "right",
};

export function ControlPage({
  connected,
  writesUnlocked,
  suspended,
  sample,
  imuFresh,
  rpmFresh,
  telemetryRequired,
  telemetryHealthy,
  lastCommand,
  heightTarget,
  heightRequested,
  onHeightTargetChange,
  onSendMotion,
}: ControlPageProps) {
  const [armed, setArmed] = useState(false);
  const [speed, setSpeed] = useState(18);
  const [roll, setRoll] = useState(0);
  const height = heightTarget ?? 61.5;
  const [activeDirection, setActiveDirection] = useState<Direction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const armedRef = useRef(false);
  const repeater = useRef<HoldCommandRepeater | null>(null);
  const keyboardDirections = useRef(new Set<Direction>());
  const pointerDirection = useRef<Direction | null>(null);
  const wasActive = useRef(false);
  const settings = useRef({ speed, roll, height });

  const composeTarget = (): MotionTarget => {
    const active = new Set(keyboardDirections.current);
    if (pointerDirection.current) active.add(pointerDirection.current);
    const velocity =
      (active.has("forward") ? settings.current.speed : 0) -
      (active.has("backward") ? settings.current.speed : 0);
    const turn =
      (active.has("right") ? settings.current.speed : 0) -
      (active.has("left") ? settings.current.speed : 0);
    return { turn, velocity, roll: settings.current.roll, height: settings.current.height };
  };

  const syncSender = (): void => {
    const hasInput = keyboardDirections.current.size > 0 || pointerDirection.current !== null;
    if (hasInput) {
      const target = composeTarget();
      if (wasActive.current) repeater.current?.update(target);
      else {
        wasActive.current = true;
        repeater.current?.begin(target);
      }
    } else if (wasActive.current) {
      wasActive.current = false;
      repeater.current?.release();
    }
  };

  const stopAll = (): void => {
    keyboardDirections.current.clear();
    pointerDirection.current = null;
    setActiveDirection(null);
    syncSender();
  };

  useEffect(() => {
    repeater.current = new HoldCommandRepeater(
      onSendMotion,
      50,
      undefined,
      (reason) => setError(reason instanceof Error ? reason.message : String(reason)),
    );
    return () => {
      repeater.current?.dispose();
      repeater.current = null;
    };
  }, [onSendMotion]);

  useEffect(() => {
    settings.current = { speed, roll, height };
    if (wasActive.current) repeater.current?.update(composeTarget());
  }, [height, roll, speed]);

  useEffect(() => {
    if (!connected || !writesUnlocked || suspended || heightTarget === null || !telemetryHealthy) {
      armedRef.current = false;
      setArmed(false);
      stopAll();
    } else if (!armed) {
      stopAll();
    }
  }, [armed, connected, heightTarget, suspended, telemetryHealthy, writesUnlocked]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      const direction = directionKeys[event.key];
      const target = event.target as HTMLElement | null;
      if (!armedRef.current || !connected || !writesUnlocked || suspended || !telemetryHealthy || heightTarget === null || !direction || event.repeat || target?.matches("input, textarea, select")) return;
      event.preventDefault();
      keyboardDirections.current.add(direction);
      setActiveDirection(direction);
      syncSender();
    };
    const keyUp = (event: KeyboardEvent) => {
      const direction = directionKeys[event.key];
      if (!direction) return;
      keyboardDirections.current.delete(direction);
      setActiveDirection(keyboardDirections.current.values().next().value ?? pointerDirection.current);
      syncSender();
    };
    const blur = () => stopAll();
    const visibility = () => {
      if (document.visibilityState !== "visible") stopAll();
    };
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
      stopAll();
    };
  }, [connected, heightTarget, suspended, telemetryHealthy, writesUnlocked]);

  const beginPointer = (direction: Direction, event: PointerEvent<HTMLButtonElement>): void => {
    if (!armedRef.current || !connected || !writesUnlocked || suspended || !telemetryHealthy || heightTarget === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerDirection.current = direction;
    setActiveDirection(direction);
    syncSender();
  };

  const endPointer = (): void => {
    pointerDirection.current = null;
    setActiveDirection(keyboardDirections.current.values().next().value ?? null);
    syncSender();
  };

  const emergencyStop = async (): Promise<void> => {
    armedRef.current = false;
    setArmed(false);
    const wasMoving = wasActive.current;
    stopAll();
    if (!wasMoving) {
      await onSendMotion(neutralMotion(height)).catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : String(reason));
      });
    }
  };

  const toggleArmed = (): void => {
    const next = !armedRef.current;
    armedRef.current = next;
    setArmed(next);
    if (!next) stopAll();
  };

  const preview = heightTarget === null
    ? "请先明确选择本会话腿高目标"
    : motionCommand({ turn: 0, velocity: speed, roll, height });

  return (
    <div className="page-stack control-page">
      <section className="page-heading">
        <div>
          <span className="section-kicker">HOLD TO MOVE</span>
          <h1>实时控制</h1>
          <p>先明确选择本会话腿高，再按住方向键或 W/A/S/D 以 20 Hz 发送 R 目标帧；松开、失焦、隐藏页面或离开本页都会清零三轴并保留该目标。</p>
        </div>
        <button className="stop-button" type="button" disabled={!writesUnlocked || heightTarget === null} onClick={() => void emergencyStop()}>
          <Octagon size={19} />立即停止
        </button>
      </section>

      <div className="control-layout">
        <section className="control-deck glass-card liquid-card">
          <div className="control-deck__head">
            <div><span className="section-kicker">MOTION PAD</span><h2>按住移动</h2></div>
            <span className={"soft-badge" + (armed ? " is-danger" : "")}>{armed ? "控制已解锁" : "控制已锁定"}</span>
          </div>

          <div className={"motion-pad" + (!armed || !connected || !writesUnlocked || suspended || !telemetryHealthy ? " is-disabled" : "")}>
            <button className={"motion-key motion-key--up" + (activeDirection === "forward" ? " is-active" : "")} type="button" aria-label="按住前进" onPointerDown={(event) => beginPointer("forward", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowUp /><span>前进<small>W</small></span></button>
            <button className={"motion-key motion-key--left" + (activeDirection === "left" ? " is-active" : "")} type="button" aria-label="按住左转" onPointerDown={(event) => beginPointer("left", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowLeft /><span>左转<small>A</small></span></button>
            <div className="motion-center"><Gamepad2 size={27} /><small>20 Hz</small></div>
            <button className={"motion-key motion-key--right" + (activeDirection === "right" ? " is-active" : "")} type="button" aria-label="按住右转" onPointerDown={(event) => beginPointer("right", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowRight /><span>右转<small>D</small></span></button>
            <button className={"motion-key motion-key--down" + (activeDirection === "backward" ? " is-active" : "")} type="button" aria-label="按住后退" onPointerDown={(event) => beginPointer("backward", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowDown /><span>后退<small>S</small></span></button>
          </div>

          <button className={"arm-control" + (armed ? " is-armed" : "")} type="button" disabled={!writesUnlocked || suspended || !telemetryHealthy || heightTarget === null} onClick={toggleArmed}>
            {armed ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />}
            <span><strong>{armed ? "锁定实时控制" : "解锁实时控制"}</strong><small>{!connected ? "请先连接机器人" : !writesUnlocked ? "当前是只读连接，请完成安全确认后重连" : suspended ? "连接操作或参数发送期间，实时控制保持锁定" : !telemetryHealthy ? "已请求的 IMU/RPM 遥测不完整或已停滞，控制保持锁定" : heightTarget === null ? "请先在右侧明确选择腿高目标" : "解锁后才能发送非零 R 目标"}</small></span>
          </button>
          {telemetryRequired && !telemetryHealthy && <div className="inline-error">遥测健康检查未通过：前端已撤销武装并请求中立目标；请准备物理断电并重新检查连接。</div>}
        </section>

        <section className="control-settings glass-card">
          <div className="section-title-row"><div><span className="section-kicker">TARGETS</span><h2>目标约束</h2></div><SlidersHorizontal size={20} /></div>
          <label className="control-slider">
            <span><strong>速度 / 转向幅度</strong><output>{speed.toFixed(0)}</output></span>
            <input type="range" min="5" max="60" step="1" value={speed} onChange={(event) => setSpeed(Number(event.target.value))} />
            <small>固件允许 ±100；首版界面保守限制到 ±60。</small>
          </label>
          <label className="control-slider">
            <span><strong>横滚目标</strong><output>{roll.toFixed(1)}°</output></span>
            <input type="range" min="-18" max="18" step="0.5" value={roll} onChange={(event) => setRoll(Number(event.target.value))} />
            <small>仅在按住方向时随 R 帧发送，释放后回到 0°。</small>
          </label>
          <label className="control-slider">
            <span><strong>本会话腿高目标</strong><output>{heightTarget === null ? "未选择" : `${height.toFixed(1)} mm`}</output></span>
            <input type="range" min="44.5" max="78.5" step="0.5" value={height} onChange={(event) => onHeightTargetChange(Number(event.target.value))} />
            <small>{heightTarget === null ? "滑动后将明确采用该值；不会假定机器人当前处于 44.5 mm。" : heightRequested ? "该值已在本会话请求发送，但固件没有读回与 ACK。" : "该值已由操作员选择，将随首个 R 帧请求发送。"}</small>
          </label>
          {heightTarget === null && <button className="text-button" type="button" onClick={() => onHeightTargetChange(height)}>明确采用 {height.toFixed(1)} mm 作为控制目标</button>}
          <div className="command-preview"><span>下一帧预览</span><code>{preview}</code></div>
          <div className="command-preview"><span>最近发送</span><code>{lastCommand || "尚未发送 R 命令"}</code></div>
          {error && <div className="inline-error">{error}</div>}
        </section>
      </div>

      <section className="safety-grid">
        <article className="glass-card safety-card safety-card--warning"><ShieldAlert size={22} /><div><strong>软件停止不等于急停</strong><p>当前本地工作树已加入 250 ms R 超时归零，但 HEAD 基线和未知固件未必具备，且应用无法握手确认。调试时仍须架空车轮并保留物理断电。</p></div></article>
        <article className="glass-card safety-card">{connected ? <ShieldCheck size={22} /> : <WifiOff size={22} />}<div><strong>{connected ? "释放路径已覆盖" : "设备尚未连接"}</strong><p>pointer cancel、窗口失焦、页面隐藏、键盘松开、组件卸载与换页都会触发相同中立帧。</p></div></article>
        <article className="glass-card live-target-card"><span>实时反馈</span><strong>{sample && rpmFresh ? ((Math.abs(sample.leftRpm) + Math.abs(sample.rightRpm)) / 2).toFixed(1) : "--"} <small>rpm</small></strong><p>Pitch {sample && imuFresh ? sample.pitch.toFixed(2) : "--"}° · Height {sample?.targetHeight?.toFixed(1) ?? "--"} mm</p></article>
      </section>
    </div>
  );
}
