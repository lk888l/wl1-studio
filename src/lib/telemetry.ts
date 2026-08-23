import type { TelemetrySample } from "../types";

export function telemetryChannelFresh(
  timestamp: number | undefined,
  now: number,
  maxAgeMs = 600,
): boolean {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return false;
  const age = now - timestamp;
  return age >= 0 && age <= maxAgeMs;
}

export const DEFAULT_TELEMETRY_LIMIT = 180;

export function appendTelemetrySample(
  samples: readonly TelemetrySample[],
  sample: TelemetrySample,
  limit = DEFAULT_TELEMETRY_LIMIT,
): TelemetrySample[] {
  if (limit <= 0) return [];
  const start = Math.max(0, samples.length - limit + 1);
  return [...samples.slice(start), sample];
}

export function mergeTelemetrySample(
  previous: TelemetrySample,
  patch: Partial<TelemetrySample>,
  timestamp = Date.now(),
): TelemetrySample {
  return {
    ...previous,
    ...patch,
    timestamp: patch.timestamp ?? timestamp,
  };
}

export function chartPath(
  samples: readonly TelemetrySample[],
  select: (sample: TelemetrySample) => number,
  width: number,
  height: number,
  padding = 8,
): string {
  if (samples.length === 0) return "";
  const values = samples.map(select);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = Math.max(max - min, 0.001);
  const drawableWidth = Math.max(0, width - padding * 2);
  const drawableHeight = Math.max(0, height - padding * 2);
  return values
    .map((value, index) => {
      const x = padding + (values.length === 1 ? drawableWidth : (index / (values.length - 1)) * drawableWidth);
      const y = padding + ((max - value) / spread) * drawableHeight;
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
}
