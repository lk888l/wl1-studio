import type { TracePoint } from "../../lib/foc";

export const signals = {
  velocity: {
    label: "实际速度",
    unit: "rev/s",
    scale: 1,
    digits: 3,
    color: "#78e2c8",
  },
  position: {
    label: "累计位置",
    unit: "rev",
    scale: 1,
    digits: 4,
    color: "#9cbfff",
  },
  iq_ma: {
    label: "Iq 电流",
    unit: "A",
    scale: 0.001,
    digits: 3,
    color: "#78e2c8",
  },
  id_ma: {
    label: "Id 电流",
    unit: "A",
    scale: 0.001,
    digits: 3,
    color: "#ffc078",
  },
  bus_mv: {
    label: "母线电压",
    unit: "V",
    scale: 0.001,
    digits: 3,
    color: "#f1ce80",
  },
  torque: {
    label: "反馈力矩",
    unit: "‰",
    scale: 1,
    digits: 0,
    color: "#b7b0fa",
  },
  temperature: {
    label: "MCU 温度",
    unit: "°C",
    scale: 0.1,
    digits: 1,
    color: "#ffa593",
  },
};
type Signal = keyof typeof signals;
export type Channel = Signal | "currents";

export function reading(value: number | null, digits: number) {
  if (value === null) return "—";
  return (Math.abs(value) < 0.5 * 10 ** -digits ? 0 : value).toFixed(digits);
}

function axisRange(min: number, max: number, digits: number, includeZero: boolean) {
  if (!Number.isFinite(min)) return { low: 0, high: 1, ticks: [0, 0.25, 0.5, 0.75, 1], digits: 0 };
  const lo = includeZero ? Math.min(0, min) : min;
  const hi = includeZero ? Math.max(0, max) : max;
  const quantum = 10 ** -digits;
  const span = Math.max(hi - lo, 4 * quantum, Math.abs(hi) * Number.EPSILON * 8);
  const center = lo + (hi - lo) / 2;
  const ideal = span / 5;
  const decade = 10 ** Math.floor(Math.log10(ideal));
  const step = Math.max(quantum, ([1, 2, 5, 10].find((n) => n * decade >= ideal) ?? 10) * decade);
  const first = includeZero && min >= 0 && max > 0 ? 0 : Math.floor((center - span * 0.56) / step);
  const last = includeZero && max <= 0 && min < 0 ? 0 : Math.ceil((center + span * 0.56) / step);
  const ticks = Array.from({ length: last - first + 1 }, (_, i) => (first + i) * step);
  return {
    low: first * step,
    high: last * step,
    ticks,
    digits: Math.max(0, -Math.floor(Math.log10(step))),
  };
}

function continuous(previous: TracePoint, next: TracePoint) {
  // TPDO4 normally arrives every 20 ms; idle SDO feedback is polled every 350 ms.
  const gap = next.time - previous.time;
  return (
    next.seq === previous.seq + 1 &&
    next.source === previous.source &&
    gap >= 0 &&
    gap < (next.source === "TPDO4" ? 200 : 1000)
  );
}

export function scopeFrame(
  history: readonly TracePoint[],
  channel: Channel,
  end: number,
  durationMs: number,
  includeZero: boolean,
) {
  const start = end - durationMs;
  const samples = history.filter(({ time }) => time >= start && time <= end);
  const keys: Signal[] = channel === "currents" ? ["iq_ma", "id_ma"] : [channel];
  const series = keys.map((key) => {
    const info = signals[key];
    let min = Infinity;
    let max = -Infinity;
    const values = samples.map(({ feedback }) => {
      const raw = feedback[key];
      if (!Number.isFinite(raw)) return null;
      const value = raw * info.scale;
      min = Math.min(min, value);
      max = Math.max(max, value);
      return value;
    });
    const hasValues = Number.isFinite(min);
    return {
      key,
      ...info,
      values,
      latest: values.at(-1) ?? null,
      min: hasValues ? min : null,
      max: hasValues ? max : null,
      peakToPeak: hasValues ? max - min : null,
    };
  });
  const axis = axisRange(
    Math.min(...series.map((s) => s.min ?? Infinity)),
    Math.max(...series.map((s) => s.max ?? -Infinity)),
    series[0]!.digits,
    includeZero,
  );
  // Normalized coordinates also position the HTML cursor, ticks and sample markers.
  const x = (time: number) => ((time - start) / durationMs) * 100;
  const y = (value: number) => ((axis.high - value) / (axis.high - axis.low)) * 100;
  const traces = series.map((s) => {
    const path = s.values
      .map((value, index) => {
        if (value === null) return "";
        const sample = samples[index]!;
        const join = index > 0 && s.values[index - 1] !== null && continuous(samples[index - 1]!, sample);
        // A zero-length segment with round caps keeps isolated samples visible.
        return `${join ? "L" : "M"}${x(sample.time).toFixed(3)} ${y(value).toFixed(3)}${join ? "" : "h0"}`;
      })
      .join("");
    return { ...s, path };
  });
  return { samples, traces, axis, x, y, start, end };
}

export type ScopeFrame = ReturnType<typeof scopeFrame>;

export function nearestSample(samples: readonly TracePoint[], time: number, toleranceMs: number) {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || time < first.time - toleranceMs || time > last.time + toleranceMs) return -1;
  let low = 0;
  let high = samples.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle]!.time < time) low = middle + 1;
    else high = middle;
  }
  const before = samples[low - 1];
  const after = samples[low]!;
  if (!before) return low;
  const closest = time - before.time < after.time - time ? low - 1 : low;
  if (!continuous(before, after) && Math.abs(samples[closest]!.time - time) > toleranceMs) return -1;
  return closest;
}
