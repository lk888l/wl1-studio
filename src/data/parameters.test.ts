import { describe, expect, it } from "vitest";

import { validateFirmwareCommand } from "../lib/protocol";
import { sanitizeProfiles } from "../lib/storage";
import { buildParameterCommand, parameterDefinitions } from "./parameters";

// Reference: WL1/SoftWare/wheeled-legged_Robot-WL1/vofa_host_tools_cfg/vofa_tab.json.
const vofaControls = [
  ["angleKp", 0, 150, 0.1],
  ["angleKi", 0, 1, 0.1],
  ["angleKd", -107, 100, 0.1],
  ["velocityKp", 0, 10, 0.01],
  ["velocityKi", 0, 100, 0.001],
  ["velocityKd", 0, 100, 0.01],
  ["differentialKp", -50, 50, 0.1],
  ["differentialKi", 0, 1, 0.001],
  ["differentialKd", 0, 100, 0.1],
  ["rollKp", -100, 100, 0.1],
  ["rollKi", -10, 10, 0.1],
  ["angleBias", -20, 20, 0.1],
  ["legHeight", 44.5, 78.5, 0.1],
] as const;

describe("VOFA 运动参数范围", () => {
  it.each(vofaControls)("%s 的滑块与发送校验接受完整参考范围", (id, min, max, step) => {
    const definition = parameterDefinitions.find((entry) => entry.id === id);
    expect(definition).toBeDefined();
    if (!definition) throw new Error(`缺少参数 ${id}`);
    expect([definition.min, definition.max, definition.step]).toEqual([min, max, step]);
    for (const target of ["robot", "remote"] as const) {
      if (id === "legHeight" && target === "remote") continue;
      for (const value of [min, max]) {
        const command = buildParameterCommand(definition, value);
        expect(command).not.toBeNull();
        expect(validateFirmwareCommand(command ?? "", target)).toBeNull();
      }
      for (const value of [min - step, max + step]) {
        const command = buildParameterCommand(definition, value);
        expect(validateFirmwareCommand(command ?? "", target)).toContain("范围内");
      }
    }
  });

  it("扩展范围内的重心与 PID 参数可以保存并恢复", () => {
    const values = { angleBias: -10, angleKp: 120, angleKd: -5, velocityKp: 2, velocityKi: 1, differentialKp: -8, rollKp: 10, rollKi: 2 };
    const restored = sanitizeProfiles([{ id: "vofa", name: "VOFA", description: "参考范围", updatedAt: 1, values }]);
    expect(restored[0]?.values).toEqual(values);
  });

  it("横滚积分使用固件积分项命令", () => {
    const definition = parameterDefinitions.find((entry) => entry.id === "rollKi");
    if (!definition) throw new Error("缺少横滚积分参数");
    expect(buildParameterCommand(definition, -0.4)).toBe("rollpid -i -0.400");
  });
});
