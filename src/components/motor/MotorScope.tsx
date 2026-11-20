import { Activity, Maximize2, Minimize2, Pause, Play } from "lucide-react";
import { useEffect, useMemo, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { TracePoint } from "../../lib/foc";
import { nearestSample, reading, scopeFrame, signals, type Channel, type ScopeFrame } from "./scope";
import "./MotorScope.css";

const windows = [5, 15, 30, 60];
const measurements = [
  ["latest", "窗口末值"],
  ["min", "最小值"],
  ["max", "最大值"],
  ["peakToPeak", "峰峰值"],
] as const;

function ScopePlot({
  frame,
  seconds,
  hasHistory,
}: {
  frame: ScopeFrame;
  seconds: number;
  hasHistory: boolean;
}) {
  const { samples, traces, axis, x, y } = frame;
  const [cursor, setCursor] = useState<{
    offset: number;
    tolerance: number;
  } | null>(null);
  const index = cursor ? nearestSample(samples, frame.end + cursor.offset, cursor.tolerance) : -1;
  const selected = samples[index];
  const latest = samples.at(-1);
  const hasValues = traces.some((trace) => trace.min !== null);
  const divisions = seconds >= 30 ? 6 : 5;
  const timeTicks = Array.from({ length: divisions + 1 }, (_, i) => (i * seconds) / divisions - seconds);
  const timeAt = (tick: number) => 100 + (tick / seconds) * 100;
  const inspect = (event: PointerEvent<HTMLDivElement>) => {
    if (!latest) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const msPerPixel = (seconds * 1000) / rect.width;
    setCursor({
      offset: (event.clientX - rect.right) * msPerPixel,
      tolerance: 5 * msPerPixel,
    });
  };
  const selectSample = (i: number) => {
    const sample = samples[i];
    if (sample) setCursor({ offset: sample.time - frame.end, tolerance: 0 });
  };
  const moveCursor = (event: KeyboardEvent<HTMLDivElement>) => {
    const current = index < 0 ? samples.length - 1 : index;
    const positions: Record<string, number> = {
      ArrowLeft: current - 1,
      ArrowRight: current + 1,
      Home: 0,
      End: samples.length - 1,
    };
    const next = positions[event.key];
    if (next === undefined) return;
    event.preventDefault();
    selectSample(Math.max(0, Math.min(samples.length - 1, next)));
  };
  const firstValue = traces[0]!.values[index];
  const cursorX = selected ? x(selected.time) : 0;
  const tipFromRight = cursorX > 50;
  const cursorText = selected
    ? [
        `${(selected.time / 1000).toFixed(3)} s`,
        ...traces.map((t) => `${t.label} ${reading(t.values[index] ?? null, t.digits)} ${t.unit}`),
      ].join("，")
    : "尚未选择采样点";
  return (
    <div className="scope-axes">
      <div className="scope-y-axis" aria-hidden="true">
        {axis.ticks.map((tick) => (
          <span key={tick}>{hasValues ? reading(tick, axis.digits) : ""}</span>
        ))}
      </div>
      <div
        className="scope-plot"
        style={{
          backgroundSize: `${50 / divisions}% ${50 / (axis.ticks.length - 1)}%`,
        }}
        role="slider"
        tabIndex={latest ? 0 : -1}
        aria-label="波形采样游标"
        aria-description="横轴以窗口末端为零。可用左右方向键逐点查看。"
        aria-disabled={!latest}
        aria-valuemin={0}
        aria-valuemax={Math.max(0, samples.length - 1)}
        aria-valuenow={index >= 0 ? index : Math.max(0, samples.length - 1)}
        aria-valuetext={cursorText}
        onPointerMove={inspect}
        onPointerDown={inspect}
        onPointerLeave={(event) => {
          if (event.pointerType === "mouse") setCursor(null);
        }}
        onFocus={(event) => {
          if (event.currentTarget.matches(":focus-visible")) selectSample(samples.length - 1);
        }}
        onBlur={() => setCursor(null)}
        onKeyDown={moveCursor}
      >
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
          {axis.ticks.map((tick) => (
            <line
              key={tick}
              className={hasValues && tick === 0 ? "scope-zero" : "scope-gridline"}
              x1="0"
              x2="100"
              y1={y(tick)}
              y2={y(tick)}
            />
          ))}
          {timeTicks.map((tick) => (
            <line key={tick} className="scope-gridline" x1={timeAt(tick)} x2={timeAt(tick)} y1="0" y2="100" />
          ))}
          {traces.map((trace, i) => (
            <path
              key={trace.key}
              className="scope-trace"
              d={trace.path}
              stroke={trace.color}
              strokeDasharray={i === 1 ? "6 3" : undefined}
            />
          ))}
        </svg>
        {latest &&
          traces.map(
            (trace) =>
              trace.latest !== null && (
                <i
                  key={trace.key}
                  className="scope-point"
                  style={{
                    left: `${x(latest.time)}%`,
                    top: `${y(trace.latest)}%`,
                    color: trace.color,
                  }}
                />
              ),
          )}
        {selected && (
          <>
            <i className="scope-cursor-x" style={{ left: `${cursorX}%` }} />
            {firstValue != null && <i className="scope-cursor-y" style={{ top: `${y(firstValue)}%` }} />}
            {traces.map((trace) => {
              const value = trace.values[index];
              return (
                value != null && (
                  <i
                    key={trace.key}
                    className="scope-point scope-point--cursor"
                    style={{
                      left: `${cursorX}%`,
                      top: `${y(value)}%`,
                      color: trace.color,
                    }}
                  />
                )
              );
            })}
            <div
              className="scope-tooltip"
              style={{
                [tipFromRight ? "right" : "left"]:
                  `min(${tipFromRight ? 100 - cursorX : cursorX}% + 8px, 100% - var(--tip-width))`,
              }}
            >
              <strong>
                采样时间 <b>{(selected.time / 1000).toFixed(3)} s</b>
              </strong>
              <span>
                距窗口末端 <b>{((selected.time - frame.end) / 1000).toFixed(3)} s</b>
              </span>
              {traces.map((trace) => (
                <span key={trace.key}>
                  {trace.label}{" "}
                  <b style={{ color: trace.color }}>
                    {reading(trace.values[index] ?? null, trace.digits)} {trace.unit}
                  </b>
                </span>
              ))}
            </div>
          </>
        )}
        {!hasValues && (
          <div className="scope-empty">
            <Activity size={23} aria-hidden="true" />
            <span>
              {!hasHistory ? "连接驱动器后显示波形" : latest ? "当前窗口没有有效读数" : "当前窗口暂无采样"}
            </span>
          </div>
        )}
      </div>
      <div className="scope-x-axis" title="相对窗口末端的时间">
        {timeTicks.map((tick) => (
          <span key={tick} style={{ left: `${timeAt(tick)}%` }}>
            {tick < 0 ? `−${-tick}` : "0"} s
          </span>
        ))}
      </div>
    </div>
  );
}

interface ScopeProps {
  points: readonly TracePoint[];
  stale: boolean;
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}

export function MotorScope({ points, stale, expanded, onExpandedChange }: ScopeProps) {
  const [channel, setChannel] = useState<Channel>("velocity");
  const [seconds, setSeconds] = useState(15);
  const [includeZero, setIncludeZero] = useState(false);
  const [held, setHeld] = useState<{
    history: readonly TracePoint[];
    end: number;
  } | null>(null);
  const history = held?.history ?? points;
  const newest = history.at(-1);
  const last = newest?.time ?? 0;
  const duration = seconds * 1000;
  const earliestEnd = Math.min(last, (history[0]?.time ?? 0) + duration);
  const end = held ? Math.max(earliestEnd, held.end) : last;
  const frame = useMemo(
    () => scopeFrame(history, channel, end, duration, includeZero),
    [history, channel, end, duration, includeZero],
  );
  const status = held ? "已冻结" : stale ? "反馈未刷新" : newest ? "实时跟随" : "等待反馈";
  const source = frame.samples.at(-1)?.source;
  useEffect(() => {
    if (!expanded) return;
    window.scrollTo(0, 0);
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape" && !document.querySelector("dialog[open]")) onExpandedChange(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [expanded, onExpandedChange]);
  return (
    <section className="motor-scope" aria-label="反馈示波">
      <header className="scope-heading">
        <div className="scope-title">
          <span className="scope-icon">
            <Activity size={21} aria-hidden="true" />
          </span>
          <h2>反馈示波</h2>
          <span className="scope-status" data-state={held || stale ? "held" : newest ? "live" : "idle"}>
            <i />
            {status}
            {source && <b>{source}</b>}
          </span>
        </div>
        <div className="scope-controls">
          <label className="scope-channel">
            信号
            <select
              aria-label="示波信号"
              value={channel}
              onChange={(event) => setChannel(event.target.value as Channel)}
            >
              {Object.entries(signals).map(([key, info]) => (
                <option key={key} value={key}>
                  {info.label}
                </option>
              ))}
              <option value="currents">Iq / Id 双电流</option>
            </select>
          </label>
          <fieldset className="scope-timebase" aria-label="示波窗口">
            <span aria-hidden="true">时间窗</span>
            <div>
              {windows.map((s) => (
                <button type="button" key={s} aria-pressed={s === seconds} onClick={() => setSeconds(s)}>
                  {s} s
                </button>
              ))}
            </div>
          </fieldset>
        </div>
        <div className="scope-actions">
          <button
            type="button"
            disabled={!newest}
            aria-pressed={!!held}
            aria-label={held ? "恢复实时" : "冻结画面"}
            title="冻结或恢复波形显示，采集与录制继续"
            onClick={() => setHeld(held ? null : { history: points, end: last })}
          >
            {held ? <Play size={15} /> : <Pause size={15} />}
            <span>{held ? "恢复实时" : "冻结画面"}</span>
          </button>
          <button
            type="button"
            aria-expanded={expanded}
            aria-label={expanded ? "还原布局" : "展开波形"}
            title={expanded ? "还原布局（Esc）" : "展开波形"}
            onClick={() => onExpandedChange(!expanded)}
          >
            {expanded ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
            <span>{expanded ? "还原布局" : "展开波形"}</span>
          </button>
        </div>
      </header>
      <div className="scope-screen">
        <div className="scope-screen-head">
          <div className="scope-legend">
            {frame.traces.map((trace, i) => (
              <span key={trace.key}>
                <i
                  style={{
                    color: trace.color,
                    borderTopStyle: i === 1 ? "dashed" : "solid",
                  }}
                />
                {trace.label}
                <b>{trace.unit}</b>
              </span>
            ))}
          </div>
          <div className="scope-screen-tools">
            <span>{frame.samples.length.toLocaleString()} 点</span>
            <select
              aria-label="示波纵轴量程"
              value={includeZero ? "zero" : "auto"}
              onChange={(event) => setIncludeZero(event.target.value === "zero")}
            >
              <option value="auto">自动量程</option>
              <option value="zero">包含零点</option>
            </select>
          </div>
        </div>
        <ScopePlot frame={frame} seconds={seconds} hasHistory={!!newest} />
      </div>
      {held && earliestEnd < last && (
        <label className="scope-history">
          冻结回看
          <input
            aria-label="回看窗口末端"
            type="range"
            min={earliestEnd}
            max={last}
            step={1}
            value={end}
            aria-valuetext={`会话时间 ${(end / 1000).toFixed(3)} 秒`}
            onChange={(event) => setHeld({ ...held, end: Number(event.target.value) })}
          />
          <span>{(end / 1000).toFixed(3)} s</span>
        </label>
      )}
      <dl className="scope-measurements" aria-label="当前窗口测量值">
        {measurements.map(([key, label]) => (
          <div key={key}>
            <dt>{label}</dt>
            {frame.traces.map((trace) => (
              <dd key={trace.key}>
                {channel === "currents" && <small>{trace.key === "iq_ma" ? "Iq" : "Id"}</small>}
                <strong>{reading(trace[key], trace.digits)}</strong>
                <small>{trace.unit}</small>
              </dd>
            ))}
          </div>
        ))}
      </dl>
    </section>
  );
}
