import { describe, expect, it } from "vitest";

import { sanitizeConnectionPreferences, selectAvailablePort } from "./connection-preferences";

const port = (name: string) => ({ name, portType: "USB" });

describe("连接偏好与串口选择", () => {
  it("优先保留用户当前选择，刷新列表不会跳到历史串口", () => {
    expect(selectAvailablePort([port("COM3"), port("COM7")], "COM7", "COM3")).toBe("COM7");
  });

  it("多个串口中恢复上次串口，只有一个串口时自动选择", () => {
    expect(selectAvailablePort([port("COM3"), port("COM7")], "", "COM7")).toBe("COM7");
    expect(selectAvailablePort([port("COM3")], "COM7", "COM7")).toBe("COM3");
  });

  it("历史串口消失且存在多个候选时要求重新选择", () => {
    expect(selectAvailablePort([port("COM3"), port("COM7")], "COM9", "COM9")).toBe("");
    expect(selectAvailablePort([], "COM7", "COM7")).toBe("");
  });

  it("损坏的偏好回退到小车并丢弃无效串口", () => {
    expect(sanitizeConnectionPreferences(null)).toEqual({ target: "robot", portName: "" });
    expect(sanitizeConnectionPreferences({ target: "unknown", portName: {} })).toEqual({ target: "robot", portName: "" });
    expect(sanitizeConnectionPreferences({ target: "remote", portName: " COM7 " })).toEqual({ target: "remote", portName: "COM7" });
  });
});
