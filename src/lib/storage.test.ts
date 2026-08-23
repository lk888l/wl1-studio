import { describe, expect, it } from "vitest";

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
