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
import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { directionalMotion, HoldCommandRepeater, neutralMotion, type MotionDirection } from "../../lib/hold-control";
import { motionCommand } from "../../lib/device";
import type { MotionTarget, TelemetrySample } from "../../types";
import "./ControlPage.css";

type Direction = MotionDirection;

interface ControlPageProps {
  compact?: boolean;
  commandIntervalMs?: number;
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
  suggestedHeight?: number;
  heightRequested: boolean;
  onHeightTargetChange: (height: number) => void;
  onSendMotion: (target: MotionTarget) => Promise<void>;
}

interface MotionTargetControlProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  hint?: string;
  disabled: boolean;
  onChange: (value: number) => void;
}

function MotionTargetControl({ label, value, min, max, step, unit, hint, disabled, onChange }: MotionTargetControlProps) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => setDraft(String(value)), [value]);

  const commit = (): void => {
    const parsed = Number(draft);
    if (disabled || draft.trim() === "" || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    if (draft === String(value)) return;
    const next = Number((Math.round(Math.min(max, Math.max(min, parsed)) / step) * step).toFixed(1));
    setDraft(String(next));
    onChange(next);
  };

  return (
    <div className="control-slider motion-target-control">
      <label className="motion-target-control__row">
        <strong>{label}</strong>
        <span className="motion-target-control__value">
          <input type="number" min={min} max={max} step={step} value={draft} disabled={disabled} onChange={(event) => setDraft(event.target.value)} onBlur={commit} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
          {unit && <span>{unit}</span>}
        </span>
      </label>
      <input type="range" aria-label={`${label}滑块`} min={min} max={max} step={step} value={value} disabled={disabled} onChange={(event) => { const next = Number(event.target.value); setDraft(String(next)); onChange(next); }} />
      <div className="motion-target-control__range"><span>{min}{unit}</span><span>{max}{unit}</span></div>
      {hint && <small>{hint}</small>}
    </div>
  );
}

const directionKeys: Record<string, Direction> = {
  KeyW: "forward",
  ArrowUp: "forward",
  KeyS: "backward",
  ArrowDown: "backward",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right",
};

export function ControlPage({
  compact = false,
  commandIntervalMs = 50,
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
  suggestedHeight = 61.5,
  heightRequested,
  onHeightTargetChange,
  onSendMotion,
}: ControlPageProps) {
  const [armed, setArmed] = useState(false);
  const [speed, setSpeed] = useState(18);
  const [roll, setRoll] = useState(0);
  const height = heightTarget ?? suggestedHeight;
  const [activeDirection, setActiveDirection] = useState<Direction | null>(null);
  const [error, setError] = useState<string | null>(null);
  const armedRef = useRef(false);
  const repeater = useRef<HoldCommandRepeater | null>(null);
  const keyboardDirections = useRef(new Set<Direction>());
  const pointerDirection = useRef<Direction | null>(null);
  const activePointerId = useRef<number | null>(null);
  const wasActive = useRef(false);
  const settings = useRef({ speed, roll, height });

  const composeTarget = useCallback((): MotionTarget => {
    const active = new Set(keyboardDirections.current);
    if (pointerDirection.current) active.add(pointerDirection.current);
    return directionalMotion(active, settings.current);
  }, []);

  const syncSender = useCallback((): void => {
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
  }, [composeTarget]);

  const stopAll = useCallback((): void => {
    keyboardDirections.current.clear();
    pointerDirection.current = null;
    activePointerId.current = null;
    setActiveDirection(null);
    syncSender();
  }, [syncSender]);

  useEffect(() => {
    repeater.current = new HoldCommandRepeater(
      onSendMotion,
      commandIntervalMs,
      undefined,
      (reason) => {
        armedRef.current = false;
        setArmed(false);
        stopAll();
        setError(reason instanceof Error ? reason.message : String(reason));
      },
    );
    return () => {
      repeater.current?.dispose();
      repeater.current = null;
    };
  }, [commandIntervalMs, onSendMotion, stopAll]);

  useEffect(() => {
    // An unselected height is only a preview. Release must retain the last chosen height.
    if (heightTarget === null) return;
    settings.current = { speed, roll, height };
    if (wasActive.current) repeater.current?.update(composeTarget());
  }, [composeTarget, height, heightTarget, roll, speed]);

  useEffect(() => {
    if (!connected || !writesUnlocked || suspended || heightTarget === null || !telemetryHealthy) {
      armedRef.current = false;
      setArmed(false);
      stopAll();
    } else if (!armed) {
      stopAll();
    }
  }, [armed, connected, heightTarget, stopAll, suspended, telemetryHealthy, writesUnlocked]);

  useEffect(() => {
    const keyDown = (event: KeyboardEvent) => {
      if (armedRef.current && (event.code === "Space" || event.key === "Escape")) {
        event.preventDefault();
        armedRef.current = false;
        setArmed(false);
        stopAll();
        return;
      }
      const direction = directionKeys[event.code];
      const target = event.target as HTMLElement | null;
      if (!armedRef.current || !connected || !writesUnlocked || suspended || !telemetryHealthy || heightTarget === null || !direction || event.repeat || event.ctrlKey || event.metaKey || event.altKey || target?.matches("input, textarea, select") || target?.isContentEditable) return;
      event.preventDefault();
      keyboardDirections.current.add(direction);
      setActiveDirection(direction);
      syncSender();
    };
    const keyUp = (event: KeyboardEvent) => {
      const direction = directionKeys[event.code];
      if (!direction) return;
      keyboardDirections.current.delete(direction);
      setActiveDirection(keyboardDirections.current.values().next().value ?? pointerDirection.current);
      syncSender();
    };
    const blur = () => {
      armedRef.current = false;
      setArmed(false);
      stopAll();
    };
    const visibility = () => {
      if (document.visibilityState !== "visible") blur();
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
  }, [connected, heightTarget, stopAll, suspended, syncSender, telemetryHealthy, writesUnlocked]);

  const beginPointer = (direction: Direction, event: PointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0 || activePointerId.current !== null || !armedRef.current || !connected || !writesUnlocked || suspended || !telemetryHealthy || heightTarget === null) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointerId.current = event.pointerId;
    pointerDirection.current = direction;
    setActiveDirection(direction);
    syncSender();
  };

  const endPointer = (event: PointerEvent<HTMLButtonElement>): void => {
    if (activePointerId.current !== event.pointerId) return;
    activePointerId.current = null;
    pointerDirection.current = null;
    setActiveDirection(keyboardDirections.current.values().next().value ?? null);
    syncSender();
  };

  const emergencyStop = async (): Promise<void> => {
    if (!connected || !writesUnlocked || heightTarget === null) return;
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
    if (!connected || !writesUnlocked || suspended || !telemetryHealthy || heightTarget === null) return;
    const next = !armedRef.current;
    setError(null);
    armedRef.current = next;
    setArmed(next);
    if (!next) stopAll();
  };

  const preview = heightTarget === null
    ? "请先选择腿高目标"
    : motionCommand({ turn: 0, velocity: -speed, roll, height });
  const controlsAvailable = connected && writesUnlocked && !suspended && telemetryHealthy && heightTarget !== null;
  const armHint = !connected ? "连接设备后可启用"
    : !writesUnlocked ? "当前为只读连接，无法启用运动控制"
    : suspended ? "正在处理连接或发送参数，请稍候"
    : !telemetryHealthy ? "等待姿态与轮速数据恢复"
    : heightTarget === null ? "先选择腿高目标，再启用控制"
    : armed ? "按住方向键或 W/A/S/D 移动，松开停止"
    : "启用后，按住方向才会移动";

  return (
    <div className={"page-stack control-page" + (compact ? " control-page--compact" : "")}>
      {!compact && <section className="page-heading">
        <div>
          <h1>实时控制</h1>
          <p>选择腿高并启用控制后，按住方向键或 W/A/S/D 移动，松开即停止运动目标。</p>
        </div>
        <button className="stop-button" type="button" disabled={!connected || !writesUnlocked || heightTarget === null} onClick={() => void emergencyStop()}>
          <Octagon size={19} />立即停止
        </button>
      </section>}

      <div className="control-layout">
        <section className="control-deck glass-card liquid-card">
          <div className="control-deck__head">
            <div>{!compact && <span className="section-kicker">MOTION PAD</span>}<h2>{compact ? "实时控制" : "按住移动"}</h2></div>
            <span className={"soft-badge" + (armed ? " is-danger" : "")}>{armed ? "已启用" : "未启用"}</span>
          </div>

          <button className={"arm-control" + (armed ? " is-armed" : "")} type="button" disabled={!controlsAvailable} aria-pressed={armed} onClick={toggleArmed}>
            {armed ? <ShieldAlert size={20} /> : <ShieldCheck size={20} />}
            <span><strong>{armed ? "停用实时控制" : "启用实时控制"}</strong><small>{armHint}</small></span>
          </button>

          <div className={"motion-pad" + (!armed || !controlsAvailable ? " is-disabled" : "")}>
            <button className={"motion-key motion-key--up" + (activeDirection === "forward" ? " is-active" : "")} type="button" disabled={!armed || !controlsAvailable} aria-label="按住前进" onPointerDown={(event) => beginPointer("forward", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowUp /><span>前进<small>W</small></span></button>
            <button className={"motion-key motion-key--left" + (activeDirection === "left" ? " is-active" : "")} type="button" disabled={!armed || !controlsAvailable} aria-label="按住左转" onPointerDown={(event) => beginPointer("left", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowLeft /><span>左转<small>A</small></span></button>
            <div className="motion-center"><Gamepad2 size={compact ? 22 : 27} /><small>{compact ? "按住" : `${1000 / commandIntervalMs} Hz`}</small></div>
            <button className={"motion-key motion-key--right" + (activeDirection === "right" ? " is-active" : "")} type="button" disabled={!armed || !controlsAvailable} aria-label="按住右转" onPointerDown={(event) => beginPointer("right", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowRight /><span>右转<small>D</small></span></button>
            <button className={"motion-key motion-key--down" + (activeDirection === "backward" ? " is-active" : "")} type="button" disabled={!armed || !controlsAvailable} aria-label="按住后退" onPointerDown={(event) => beginPointer("backward", event)} onPointerUp={endPointer} onPointerCancel={endPointer} onLostPointerCapture={endPointer}><ArrowDown /><span>后退<small>S</small></span></button>
          </div>

          {compact && <button className="stop-button control-stop" type="button" disabled={!connected || !writesUnlocked || heightTarget === null} onClick={() => void emergencyStop()}><Octagon size={17} />立即停止</button>}
          <p className="control-release-hint">松开停止 · 空格 / Esc 停止并停用 · 切走窗口后需重新启用</p>
          {telemetryRequired && !telemetryHealthy && <div className="inline-error">姿态或轮速数据未就绪，控制已停用。数据恢复后请重新启用。</div>}
        </section>

        <section className="control-settings glass-card">
          {!compact && <div className="section-title-row"><div><span className="section-kicker">TARGETS</span><h2>运动目标</h2></div><SlidersHorizontal size={20} /></div>}
          <MotionTargetControl label="速度 / 转向幅度" value={speed} min={0.5} max={100} step={0.5} disabled={suspended} onChange={setSpeed} />
          <MotionTargetControl label="横滚目标" value={roll} min={-18} max={18} step={0.1} unit="°" disabled={suspended} onChange={setRoll} hint={compact ? undefined : "按住方向时生效，松开后回到 0°。"} />
          {compact ? <div className="control-height-summary"><div><strong>目标腿高</strong><output>{heightTarget === null ? "未选择" : `${height.toFixed(1)} mm`}</output></div><small>{heightTarget === null ? "先在机身区域下发腿高，或采用当前草稿作为运动目标。" : `在本页「腿高」调整 · ${heightRequested ? "已请求发送" : "尚未发送"}`}</small></div>
            : <MotionTargetControl label="目标腿高" value={height} min={44.5} max={78.5} step={0.1} unit="mm" disabled={suspended} onChange={onHeightTargetChange} hint={heightTarget === null ? "选择后生效；当前设备腿高未知。" : heightRequested ? "已请求发送；设备不提供目标确认。" : "已选择，将随下次运动指令发送。"} />}
          {heightTarget === null && <button className="text-button control-select-height" type="button" disabled={suspended} onClick={() => onHeightTargetChange(height)}>采用草稿腿高 {height.toFixed(1)} mm</button>}
          {!compact && <><div className="command-preview"><span>下一帧预览</span><code>{preview}</code></div><div className="command-preview"><span>最近发送</span><code>{lastCommand || "尚未发送运动指令"}</code></div></>}
          {error && <div className="inline-error">{error}</div>}
          {compact && <div className="control-live-feedback"><span>轮速 <strong>{sample && rpmFresh ? ((Math.abs(sample.leftRpm) + Math.abs(sample.rightRpm)) / 2).toFixed(1) : "--"}</strong> rpm</span><span>俯仰 <strong>{sample && imuFresh ? sample.pitch.toFixed(1) : "--"}</strong>°</span></div>}
        </section>
      </div>

      {!compact && <section className="safety-grid">
        <article className="glass-card safety-card safety-card--warning"><ShieldAlert size={22} /><div><strong>调试时保留物理断电方式</strong><p>软件停止发送中立目标，不能代替物理急停。</p></div></article>
        <article className="glass-card safety-card">{connected ? <ShieldCheck size={22} /> : <WifiOff size={22} />}<div><strong>{connected ? "按住移动，松开停止" : "设备尚未连接"}</strong><p>切走窗口、离开页面或连接中断时会停止运动目标。</p></div></article>
        <article className="glass-card live-target-card"><span>实时反馈</span><strong>{sample && rpmFresh ? ((Math.abs(sample.leftRpm) + Math.abs(sample.rightRpm)) / 2).toFixed(1) : "--"} <small>rpm</small></strong><p>俯仰 {sample && imuFresh ? sample.pitch.toFixed(2) : "--"}° · 腿高 {sample?.targetHeight?.toFixed(1) ?? "--"} mm</p></article>
      </section>}
    </div>
  );
}
