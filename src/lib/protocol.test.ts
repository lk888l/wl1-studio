import { describe, expect, it } from "vitest";

import {
  buildMotionCommand,
  commandByteLength,
  isReadOnlyFirmwareCommand,
  parseFirmwareLine,
  parseRobotFeatureReply,
  validateFirmwareCommand,
} from "./protocol";

describe("WL1 文本协议", () => {
  it("空 IMU 字段不能被转换成有效的零值", () => {
    for (const line of [",,", "1,,2", " ,1,2,a=1,ok=1"]) {
      expect(parseFirmwareLine(line).type).toBe("log");
    }
  });

  it("遥控器只支持参数白名单，载荷需留出 NUL 字节", () => {
    for (const command of ["anglepid -p 60", "velocitypid -i 0.01", "rollpid -p -0.5", "differpid -d 0.1", "anglebias 12", "anglepid auto"]) {
      expect(validateFirmwareCommand(command, "remote")).toBeNull();
    }
    expect(validateFirmwareCommand("legheight 60", "remote")).toContain("实体摇杆");
    expect(validateFirmwareCommand("showimu -y", "remote")).toContain("不允许");
    const boundary = `anglebias ${"0".repeat(20)}12`;
    expect(commandByteLength(boundary)).toBe(32);
    expect(validateFirmwareCommand(boundary, "robot")).toBeNull();
    expect(validateFirmwareCommand(boundary, "remote")).toContain("31 字节");
    expect(validateFirmwareCommand(boundary.slice(0, 10) + boundary.slice(11), "remote")).toBeNull();
  });

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
    expect(validateFirmwareCommand("anglepid -d -107.1")).toContain("-107..=100");
    expect(validateFirmwareCommand("differpid -i 1.001")).toContain("0..=1");
    expect(validateFirmwareCommand("rollpid -p -1.0")).toBeNull();
    expect(validateFirmwareCommand("rollpid -i 10.1")).toContain("-10..=10");
    expect(validateFirmwareCommand("anglebias -20.1")).toContain("-20..=20");
  });

  it("只接受固件定义的 UID 与自适应腿高命令", () => {
    for (const command of ["uid", "autoleg status", "autoleg on", "autoleg off"]) {
      expect(validateFirmwareCommand(command)).toBeNull();
    }
    expect(isReadOnlyFirmwareCommand("uid")).toBe(true);
    expect(isReadOnlyFirmwareCommand("autoleg status")).toBe(true);
    expect(isReadOnlyFirmwareCommand("autoleg off")).toBe(false);
    expect(validateFirmwareCommand("uid extra")).toContain("不接受参数");
    expect(validateFirmwareCommand("autoleg toggle")).toContain("只接受");
    expect(validateFirmwareCommand("autoleg on extra")).toContain("只接受");
    expect(validateFirmwareCommand("uid", "remote")).toContain("不回传");
    expect(validateFirmwareCommand("autoleg status", "remote")).toContain("不回传");
    expect(validateFirmwareCommand("autoleg on", "remote")).toBeNull();
    expect(validateFirmwareCommand("autoleg off", "remote")).toBeNull();
  });

  it("按固件回执解析 UID 和自适应腿高的设置与运行状态", () => {
    expect(parseRobotFeatureReply("uid: 0123456789ABCDEF10203040\r\n")).toEqual({
      type: "uid", uid: "0123456789ABCDEF10203040",
    });
    expect(parseRobotFeatureReply("autoleg: enabled=1 active=0")).toEqual({
      type: "autoleg", enabled: true, active: false,
    });
    expect(parseRobotFeatureReply("autoleg: enabled=0 active=0")).toEqual({
      type: "autoleg", enabled: false, active: false,
    });
    for (const line of ["uid: usage: uid", "uid: 0123", "autoleg: enabled=2 active=1", "autoleg: usage: autoleg on|off|status"]) {
      expect(parseRobotFeatureReply(line)).toBeNull();
    }
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
