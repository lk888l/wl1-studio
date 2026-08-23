import { describe, expect, it } from "vitest";

import type { TelemetrySample } from "../types";
import { appendTelemetrySample, chartPath, mergeTelemetrySample, telemetryChannelFresh } from "./telemetry";

const sample = (timestamp: number, pitch = 0): TelemetrySample => ({
  timestamp,
  pitch,
  roll: 0,
  yaw: 0,
  leftRpm: 0,
  rightRpm: 0,
  targetHeight: 44.5,
});

describe("遥测纯函数", () => {
  it("滚动窗口只保留最新样本", () => {
    const result = [1, 2, 3, 4].reduce<TelemetrySample[]>(
      (items, timestamp) => appendTelemetrySample(items, sample(timestamp), 3),
      [],
    );
    expect(result.map((item) => item.timestamp)).toEqual([2, 3, 4]);
  });

  it("合并部分字段时保留上一帧", () => {
    expect(mergeTelemetrySample(sample(1, 2), { roll: 3 }, 9)).toMatchObject({
      timestamp: 9,
      pitch: 2,
      roll: 3,
    });
  });

  it("真实串口未上报的可选字段保持未知", () => {
    const previous: TelemetrySample = {
      timestamp: 1,
      pitch: 0,
      roll: 0,
      yaw: 0,
      leftRpm: 0,
      rightRpm: 0,
    };
    const merged = mergeTelemetrySample(previous, { pitch: 1.25 }, 2);
    expect(merged.targetHeight).toBeUndefined();
    expect(merged.linkQuality).toBeUndefined();
    expect(merged.batteryVoltage).toBeUndefined();
  });

  it("IMU 与 RPM 使用各自更新时间判断新鲜度", () => {
    expect(telemetryChannelFresh(1_000, 1_500)).toBe(true);
    expect(telemetryChannelFresh(1_000, 1_601)).toBe(false);
    expect(telemetryChannelFresh(undefined, 1_500)).toBe(false);
    expect(telemetryChannelFresh(2_000, 1_500)).toBe(false);
  });

  it("生成有限且可渲染的 SVG 路径", () => {
    const path = chartPath([sample(1, -2), sample(2, 0), sample(3, 2)], (item) => item.pitch, 100, 40);
    expect(path).toMatch(/^M/);
    expect(path).not.toContain("NaN");
    expect(path.split(" L")).toHaveLength(3);
  });
});
