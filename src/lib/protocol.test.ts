import { describe, expect, it } from "vitest";

import {
  buildMotionCommand,
  commandByteLength,
  parseFirmwareLine,
  validateFirmwareCommand,
} from "./protocol";

describe("WL1 文本协议", () => {
  it("解析 IMU 三元组", () => {
    expect(parseFirmwareLine("-01.250,002.500,180.000\r\n")).toEqual({
      type: "imu",
      roll: -1.25,
      pitch: 2.5,
      yaw: 180,
    });
  });

  it("解析本地工作树的扩展 IMU 行", () => {
    expect(parseFirmwareLine("-01.250,002.500,180.000,a=01.03,ok=1")).toEqual({
      type: "imu",
      roll: -1.25,
      pitch: 2.5,
      yaw: 180,
      accelerationNormG: 1.03,
      accelerationTrusted: true,
    });
    expect(parseFirmwareLine("-01.250,002.500,180.000,a=bad,ok=1").type).toBe("log");
  });

  it("解析左右轮 RPM", () => {
    expect(parseFirmwareLine("A: -12.500\tB: 010.250")).toEqual({
      type: "rpm",
      left: -12.5,
      right: 10.25,
    });
  });

  it("拒绝超过固件缓冲上限的命令", () => {
    const longCommand = `nrfsend ${"x".repeat(30)}`;
    expect(commandByteLength(longCommand)).toBeGreaterThan(32);
    expect(validateFirmwareCommand(longCommand)).toContain("32 字节");
  });

  it("浏览器预览使用与 Rust 后端一致的文本白名单", () => {
    expect(validateFirmwareCommand("legheight 61.5")).toBeNull();
    expect(validateFirmwareCommand("anglepid auto")).toBeNull();
    expect(validateFirmwareCommand("motor 10 10")).toContain("不允许");
    expect(validateFirmwareCommand("jump 1")).toContain("不允许");
    expect(validateFirmwareCommand("rollpid -d 0.1")).toContain("没有 D 项");
    expect(validateFirmwareCommand("legheight +61.5")).toContain("十进制数字");
    expect(validateFirmwareCommand("anglepid -i 1.1")).toContain("0..=1");
    expect(validateFirmwareCommand("anglepid -d 29.9")).toContain("30..=100");
    expect(validateFirmwareCommand("differpid -i 0.011")).toContain("0..=0.01");
    expect(validateFirmwareCommand("rollpid -p -1.0")).toBeNull();
    expect(validateFirmwareCommand("rollpid -i 0.1")).toContain("-1..=0");
    expect(validateFirmwareCommand("anglebias 4.9")).toContain("5..=20");
  });

  it("生成字段顺序固定的 R 命令", () => {
    const command = buildMotionCommand({ turn: 1, velocity: -2, roll: 3, height: 61.5 });
    expect(command).toBe("R 1.0 -2.0 3.0 61.5");
    expect(validateFirmwareCommand(command)).toContain("实时控制安全通道");
  });

  it("拒绝越界或非有限的实时控制目标", () => {
    expect(() => buildMotionCommand({ turn: 101, velocity: 0, roll: 0, height: 50 })).toThrow("-100 到 100");
    expect(() => buildMotionCommand({ turn: 0, velocity: 0, roll: Number.NaN, height: 50 })).toThrow("有限数值");
    expect(() => buildMotionCommand({ turn: 0, velocity: 0, roll: 0, height: 0 })).toThrow("44.5 mm");
  });
});
