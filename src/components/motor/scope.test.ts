import { describe, expect, it } from "vitest";
import type { TracePoint } from "../../lib/foc";
import { nearestSample, scopeFrame } from "./scope";

function point(seq: number, time: number, feedback: Partial<TracePoint["feedback"]> = {}): TracePoint {
  return {
    seq,
    time,
    source: "TPDO4",
    phase: "running",
    feedback: {
      status: 39,
      fault: 0,
      position: 0,
      velocity: 0,
      id_ma: 0,
      iq_ma: 0,
      bus_mv: 24000,
      torque: 0,
      temperature: 300,
      mode: 3,
      calibration: 4,
      ...feedback,
    },
  };
}

describe("motor feedback scope", () => {
  it("measures the selected time window and resolves millivolt ripple around a DC offset", () => {
    const history = [
      point(1, 0, { bus_mv: 22000 }),
      point(2, 1000, { bus_mv: 23996 }),
      point(3, 1020, { bus_mv: 24006 }),
      point(4, 1040, { bus_mv: 27000 }),
    ];
    const frame = scopeFrame(history, "bus_mv", 1020, 1000, false);
    expect(frame.samples.map((s) => s.seq)).toEqual([2, 3]);
    expect(frame.traces[0]!.min).toBeCloseTo(23.996);
    expect(frame.traces[0]!.max).toBeCloseTo(24.006);
    expect(frame.traces[0]!.peakToPeak).toBeCloseTo(0.01);
    expect(frame.axis.low).toBeGreaterThan(23.9);
    expect(frame.axis.high).toBeLessThan(24.1);
    expect(scopeFrame(history, "bus_mv", 1020, 1000, true).axis.low).toBe(0);
  });

  it("plots signed Iq and Id in amperes on one scale and measures each independently", () => {
    const frame = scopeFrame(
      [point(1, 0, { iq_ma: 600, id_ma: -120 }), point(2, 20, { iq_ma: 800, id_ma: -70 })],
      "currents",
      20,
      5000,
      false,
    );
    expect(frame.traces.map((s) => [s.key, s.unit, s.latest])).toEqual([
      ["iq_ma", "A", 0.8],
      ["id_ma", "A", -0.07],
    ]);
    expect(frame.traces[0]!.peakToPeak).toBeCloseTo(0.2);
    expect(frame.traces[1]!.peakToPeak).toBeCloseTo(0.05);
    expect(frame.axis.low).toBeLessThan(-0.12);
    expect(frame.axis.high).toBeGreaterThan(0.8);
  });

  it("keeps the trace broken across lost sequences, feedback outages, source changes and invalid values", () => {
    const samples = [
      point(1, 0),
      point(2, 20),
      point(8, 100),
      point(9, 400),
      point(10, 420, { velocity: NaN }),
      point(11, 440),
      { ...point(12, 460), source: "SDO" as const },
      { ...point(13, 840), source: "SDO" as const },
    ];
    const frame = scopeFrame(samples, "velocity", 840, 5000, false);
    expect(frame.traces[0]!.path.match(/M/g)).toHaveLength(5);
    expect(frame.traces[0]!.path.match(/L/g)).toHaveLength(2);
    expect(frame.traces[0]!.path).not.toMatch(/NaN|Infinity/);
    expect(frame.x(420) - frame.x(20)).toBeCloseTo(8);
    expect(nearestSample(samples, 60, 5)).toBe(-1);
    expect(nearestSample(samples, 250, 5)).toBe(-1);
    expect(nearestSample(samples, 99, 5)).toBe(2);
    expect(nearestSample(samples, 690, 5)).toBe(7);
    expect(nearestSample(samples, -100, 5)).toBe(-1);
  });

  it("shows a dot for a single flat sample and leaves an empty window without readings", () => {
    const frame = scopeFrame([point(1, 0, { velocity: -2 })], "velocity", 0, 5000, false);
    expect(frame.axis.low).toBeLessThan(-2);
    expect(frame.axis.high).toBeGreaterThan(-2);
    expect(frame.traces[0]!.path).toMatch(/^M100\.000 [\d.]+h0$/);
    const empty = scopeFrame([point(1, 0)], "velocity", 9000, 5000, false);
    expect(empty.traces[0]).toMatchObject({
      min: null,
      max: null,
      peakToPeak: null,
      latest: null,
      path: "",
    });
    expect(nearestSample(empty.samples, 0, 5)).toBe(-1);
  });
});
