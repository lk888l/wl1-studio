import { useState } from "react";
import { Activity, Pause, Play, Send } from "lucide-react";
import {
  calibrationStates,
  canConfigure,
  hex,
  type Mode,
  modes,
  numeric,
  type Snapshot,
  type Target,
} from "../../lib/foc";
import type { Ask, Run } from "./useMotor";

type DriveProps = { view: Snapshot | null; busy: boolean; run: Run; ask: Ask };
const targetFields = {
  rev: ["位置", "rev"],
  rev_s: ["速度", "rev/s"],
  permille: ["力矩", "‰"],
  kp: ["位置增益 Kp", "Nm/rev"],
  kd: ["速度增益 Kd", "Nm/(rev/s)"],
  nm: ["前馈力矩", "Nm"],
} as const;
function TargetForm({ mode, view, busy, run }: Omit<DriveProps, "ask"> & { mode: Mode }) {
  const [draft, setDraft] = useState({
    rev: String(view?.feedback.position ?? 0),
    rev_s: "0",
    permille: "0",
    kp: "0",
    kd: "0",
    nm: "0",
  });
  const [relative, setRelative] = useState(false);
  const position = mode === "single_turn" || mode === "multi_turn";
  const keys: (keyof typeof targetFields)[] =
    mode === "velocity"
      ? ["rev_s"]
      : mode === "torque"
        ? ["permille"]
        : position
          ? ["rev"]
          : ["rev", "rev_s", "kp", "kd", "nm"];
  const limits = {
    rev: [-100000, 100000],
    rev_s: [-40, 40],
    permille: [-1000, 1000],
    kp: [0, mode === "packed_mit" ? 100 : 65.535],
    kd: [0, 20],
    nm: [-1, 1],
  } as const;
  const valid = keys.every((key) => {
    const value = numeric(draft[key]);
    return (
      value !== null &&
      value >= limits[key][0] &&
      value <= limits[key][1] &&
      (key !== "permille" || Number.isInteger(value))
    );
  });
  const submit = () => {
    if (!valid) return;
    const { rev, rev_s, kp, kd, nm, permille } = draft;
    const target: Target = position
      ? { kind: "position", rev: Number(rev), relative }
      : mode === "velocity"
        ? { kind: "velocity", rev_s: Number(rev_s) }
        : mode === "torque"
          ? { kind: "torque", permille: Number(permille) }
          : {
              kind: "mit",
              rev: Number(rev),
              rev_s: Number(rev_s),
              kp: Number(kp),
              kd: Number(kd),
              nm: Number(nm),
            };
    void run(
      { kind: "target", target },
      position ? "目标已提交，驱动等待 bit12 应答。" : "目标已交给 PDO 周期任务。",
    );
  };
  return (
    <>
      <div className="motor-fields">
        {keys.map((key) => (
          <label key={key}>
            {targetFields[key][0]} <small>{targetFields[key][1]}</small>
            <input
              type="number"
              step={key === "permille" ? 1 : "any"}
              value={draft[key]}
              min={limits[key][0]}
              max={limits[key][1]}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
            />
          </label>
        ))}
        {position && (
          <label>
            位置基准
            <select
              value={relative ? "relative" : "absolute"}
              onChange={(event) => {
                setRelative(event.target.value === "relative");
                setDraft({
                  ...draft,
                  rev: event.target.value === "relative" ? "0" : String(view?.feedback.position ?? 0),
                });
              }}
            >
              <option value="absolute">绝对坐标</option>
              <option value="relative">相对当前位置</option>
            </select>
          </label>
        )}
      </div>
      <button
        type="button"
        className="motor-primary"
        disabled={busy || !valid || view?.phase !== "running" || view.age_ms > 500}
        onClick={submit}
      >
        <Send size={15} />
        下发目标
      </button>
      {!valid && <p className="motor-warn">请补全目标，并检查数值范围。</p>}
    </>
  );
}

export function Operations({ view, busy, run, ask }: DriveProps) {
  const [chosen, setChosen] = useState<Mode>("velocity"),
    [period, setPeriod] = useState("10");
  const mode = view?.mode ?? chosen;
  const live = view?.phase === "running",
    halted = view?.phase === "halted";
  const pdo = {
    velocity: "RPDO1 · 7 B",
    single_turn: "RPDO2 · 7 B",
    multi_turn: "RPDO2 · 7 B",
    torque: "RPDO3 · 5 B",
    mit: "RPDO4 · 20 B FD+BRS",
    packed_mit: "RPDO4 · 8 B + RPDO1 控制字",
  }[mode];
  const fastStop = !!view && ["running", "halted", "position_low", "position_high"].includes(view.phase);
  return (
    <>
      <div className="motor-two">
        <section className="motor-card">
          <small>01 / DRIVE SEQUENCE</small>
          <h2>输出与模式</h2>
          <p>先以中性目标使能，再单独下发运动目标。</p>
          <div className="motor-fields">
            <label>
              工作模式
              <select
                disabled={busy || !!view?.mode}
                value={mode}
                onChange={(event) => setChosen(event.target.value as Mode)}
              >
                {Object.entries(modes).map(([key, name]) => (
                  <option key={key} value={key}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              命令周期
              <select
                value={period}
                disabled={busy || !!view?.mode}
                onChange={(event) => setPeriod(event.target.value)}
              >
                {[5, 10, 15, 20].map((ms) => (
                  <option key={ms} value={ms}>
                    {ms} ms
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="motor-route">
            <span>{pdo}</span>
            <span>TPDO4 · 32 B FD+BRS</span>
          </div>
          <div className="motor-buttons">
            <button
              type="button"
              className="motor-primary"
              disabled={busy || !canConfigure(view) || view?.feedback.calibration !== 4}
              onClick={() =>
                ask(
                  "使能功率输出？",
                  `${modes[mode]}模式，${period} ms 周期。请架空或固定负载、准备物理急停，确认没有其他主站在驱动此轴。`,
                  () =>
                    void run(
                      { kind: "start", mode, period_ms: Number(period) },
                      "已启动 PDO 握手，请以状态字为准。",
                    ),
                )
              }
            >
              <Play size={15} />
              使能 PDO
            </button>
            <button
              type="button"
              disabled={busy || (!live && !halted)}
              onClick={() => void run({ kind: "halt", on: !halted })}
            >
              <Pause size={15} />
              {halted ? "恢复目标" : "Halt 暂停"}
            </button>
            <button
              type="button"
              disabled={busy || !fastStop}
              onClick={() => void run({ kind: "quick_stop" })}
            >
              快速停止
            </button>
          </div>
        </section>
        <section className="motor-card">
          <small>02 / SETPOINT</small>
          <h2>运动目标</h2>
          <p>
            {mode === "packed_mit"
              ? "按设备当前量程量化，物理零值可能有量化误差。"
              : mode === "single_turn"
                ? "沿最短路径定位；半圈选择负方向。"
                : mode === "torque"
                  ? "千分比以已应用的基准电流为基准，不是 Nm。"
                  : "编辑仅改变草稿，不会自动发送。"}
          </p>
          <TargetForm
            key={`${view?.session ?? 0}-${mode}-${!!view?.mode}`}
            view={view}
            busy={busy}
            run={run}
            mode={mode}
          />
        </section>
      </div>
      <div className="motor-readout">
        <Activity size={16} />
        <span>状态字 {view ? `0x${hex(view.feedback.status)}` : "—"}</span>
        <span>实际模式 {view?.feedback.mode ?? "—"}</span>
        <span>电角校准 {view ? (calibrationStates[view.feedback.calibration] ?? "未知") : "—"}</span>
        <span>位置应答 {view ? Number(!!(view.feedback.status & 0x1000)) : "—"}</span>
        <span>到位 {view ? Number(!!(view.feedback.status & 0x400)) : "—"}</span>
      </div>
    </>
  );
}
