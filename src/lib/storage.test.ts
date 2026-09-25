import { describe, expect, it } from "vitest";

import { defaultParameterValues } from "../data/parameters";

import { defaultPersonalization, sanitizePersonalization, sanitizeProfiles } from "./storage";

describe("本地配置清洗", () => {
  it("损坏的个性化字段回退到默认值", () => {
    expect(sanitizePersonalization({
      accent: "unknown",
      robotName: {},
      ledColor: "red",
      reducedMotion: "yes",
    })).toEqual(defaultPersonalization);
  });

  it("档案只保留已知范围内的有限参数", () => {
    const profiles = sanitizeProfiles([{
      id: "profile-1",
      name: "  台架  ",
      description: "测试",
      updatedAt: 1,
      builtIn: true,
      values: {
        legHeight: 61.5,
        angleKd: "bad",
        rollKi: Number.NaN,
        unknown: 42,
      },
    }]);
    expect(profiles).toEqual([{
      id: "profile-1",
      name: "台架",
      description: "测试",
      updatedAt: 1,
      values: { legHeight: 61.5 },
    }]);
  });

  it("拒绝结构不完整的档案", () => {
    expect(sanitizeProfiles([null, { id: "x" }, "bad"])).toEqual([]);
  });
});


describe("自适应腿高角度中心的本地档案兼容", () => {
  const profile = { id: "roll-center", name: "中心偏置", description: "台架参数", updatedAt: 1 };

  it("新档案保留中心偏置并可 JSON 往返载入", () => {
    const values = { rollBias: -2.5, angleBias: 12.6, legHeight: 61.5 };
    const stored = JSON.parse(JSON.stringify([{ ...profile, values }]));
    expect(sanitizeProfiles(stored)[0]?.values).toEqual(values);
  });

  it("旧档案没有中心偏置时保留原参数，载入草稿使用新增参数的默认值", () => {
    const values = { angleBias: 11, legHeight: 55 };
    const restored = sanitizeProfiles([{ ...profile, values }]);
    expect(restored[0]?.values).toEqual(values);
    expect({ ...defaultParameterValues, ...restored[0]?.values }).toMatchObject({
      ...values, rollBias: 0,
    });
  });

  it("非法中心偏置不会污染其他有效参数", () => {
    for (const rollBias of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "2.5", null]) {
      const restored = sanitizeProfiles([{ ...profile, values: { rollBias, legHeight: 55 } }]);
      expect(restored[0]?.values).toEqual({ legHeight: 55 });
    }
  });
});
