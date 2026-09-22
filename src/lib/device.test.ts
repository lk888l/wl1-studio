import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSnapshot, DeviceEvent } from "../types";

const { invoke, listen, handlers } = vi.hoisted(() => ({
  invoke: vi.fn(),
  listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

import { DeviceGateway } from "./device";

const disconnected: ConnectionSnapshot = {
  mode: "disconnected", label: "未连接", telemetryEnabled: false, writesUnlocked: false,
};
let backendSnapshot: ConnectionSnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  backendSnapshot = {
    mode: "serial", connectionTarget: "remote", sessionId: 1, label: "COM7",
    baudRate: 115200, telemetryEnabled: false, writesUnlocked: true,
  };
  invoke.mockImplementation(async (name: string) => {
    if (name === "disconnect_device") return disconnected;
    if (name === "connect_device") return { ...backendSnapshot };
    return undefined;
  });
  listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  });
});

const remoteConfig = {
  mode: "serial", connectionTarget: "remote", portName: "COM7", baudRate: 115200, allowUnsafeWrites: true,
} as const;

describe("遥控器网关能力边界", () => {
  it("传递连接对象，不自动开启遥测或发送参数", async () => {
    const gateway = new DeviceGateway();
    expect(await gateway.connect(remoteConfig)).toMatchObject({ connectionTarget: "remote", telemetryEnabled: false });
    expect(invoke).toHaveBeenCalledWith("connect_device", { config: remoteConfig });
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["disconnect_device", "connect_device"]);
  });

  it("允许 PID / 偏置，阻止遥测、腿高和实时控制进入 IPC", async () => {
    const gateway = new DeviceGateway();
    await gateway.connect(remoteConfig);
    invoke.mockClear();
    await gateway.sendTextCommand("velocitypid -p 0.04", 1);
    await gateway.sendTextCommand("anglebias auto", 1);
    await expect(gateway.sendTextCommand("legheight 60", 1)).rejects.toThrow("实体摇杆");
    await expect(gateway.setTelemetry({ imu: true, rpm: true }, 1)).rejects.toThrow("没有小车遥测");
    await expect(gateway.sendMotionTarget({ turn: 0, velocity: 0, roll: 0, height: 60 }, 1)).rejects.toThrow("实体摇杆");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["send_text_command", "send_text_command"]);
    expect(gateway.connection.mode).toBe("serial");
  });

  it("遥控器日志只作为日志，不把调试数值误当小车遥测", async () => {
    const gateway = new DeviceGateway();
    const events: DeviceEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    await gateway.connect(remoteConfig);
    handlers.get("wl1://telemetry")?.({ payload: { sessionId: 1, timestamp: 100, roll: 42 } });
    handlers.get("wl1://console")?.({ payload: { sessionId: 1, text: "NRF delivered", direction: "rx" } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "console", entry: { text: "NRF delivered" } });
  });

  it("重新直连小车恢复能力，旧会话任务仍被拒绝", async () => {
    const gateway = new DeviceGateway();
    await gateway.connect(remoteConfig);
    backendSnapshot = { ...backendSnapshot, sessionId: 2, connectionTarget: "robot" };
    await gateway.connect({ ...remoteConfig, connectionTarget: "robot" });
    await expect(gateway.sendTextCommand("anglebias 12", 1)).rejects.toThrow("会话已变化");
    await gateway.sendTextCommand("legheight 60", 2);
    await gateway.setTelemetry({ imu: true, rpm: true }, 2);
    expect(invoke).toHaveBeenCalledWith("set_telemetry", { enabled: true, expectedSessionId: 2 });
  });

  it("旧版配置/快照缺少目标时保持直连默认值", async () => {
    backendSnapshot = { ...backendSnapshot, connectionTarget: undefined };
    const gateway = new DeviceGateway();
    const { connectionTarget: _target, ...legacyConfig } = remoteConfig;
    expect((await gateway.connect(legacyConfig)).connectionTarget).toBe("robot");
    expect(invoke).toHaveBeenCalledWith("connect_device", { config: { ...legacyConfig, connectionTarget: "robot" } });
  });

  it("遥控器只读连接不能发参数", async () => {
    backendSnapshot = { ...backendSnapshot, writesUnlocked: false };
    const gateway = new DeviceGateway();
    await gateway.connect({ ...remoteConfig, allowUnsafeWrites: false });
    await expect(gateway.sendTextCommand("anglebias 12", 1)).rejects.toThrow("只读");
  });
});

describe("蓝牙设备会话", () => {
  const config = { mode: "ble", bleDeviceId: "0:zx-d30", baudRate: 9600, allowUnsafeWrites: true } as const;

  it("原生扫描独立于串口枚举，浏览器不会调用蓝牙 IPC", async () => {
    const gateway = new DeviceGateway();
    invoke.mockResolvedValueOnce([{ id: "0:zx-d30", name: "WL1_BLE_TEST", address: "00:00:00:00:00:01", rssi: -52 }]);
    expect(await gateway.scanBluetoothDevices()).toHaveLength(1);
    expect(invoke).toHaveBeenLastCalledWith("scan_bluetooth_devices");
    vi.stubGlobal("window", {});
    await expect(gateway.scanBluetoothDevices()).rejects.toThrow("桌面端");
  });

  it("BLE 使用独立模式与扫描 ID，不报告虚假的无线波特率", async () => {
    backendSnapshot = { ...backendSnapshot, mode: "ble", connectionTarget: "robot", label: "WL1_BLE_TEST · BLE", baudRate: undefined };
    const gateway = new DeviceGateway();
    const snapshot = await gateway.connect(config);
    expect(snapshot).toMatchObject({ mode: "ble", baudRate: undefined, writesUnlocked: true, telemetryEnabled: false });
    expect(invoke).toHaveBeenCalledWith("connect_device", { config: { ...config, connectionTarget: "robot", portName: undefined } });
    expect(invoke).not.toHaveBeenCalledWith("set_telemetry", expect.anything());
    const target = { turn: 10, velocity: -18, roll: 0, height: 61.5 };
    await gateway.sendMotionTarget(target, 1);
    expect(invoke).toHaveBeenLastCalledWith("send_motion_target", { target, expectedSessionId: 1 });
  });

  it("蓝牙连接中的断连事件锁定旧会话，重连不补发目标", async () => {
    backendSnapshot = { ...backendSnapshot, mode: "ble", connectionTarget: "robot" };
    const gateway = new DeviceGateway();
    await gateway.connect(config);
    handlers.get("wl1://disconnected")?.({ payload: { sessionId: 1, timestamp: 10, reason: "蓝牙设备已断开" } });
    const target = { turn: 0, velocity: -18, roll: 0, height: 61.5 };
    await expect(gateway.sendMotionTarget(target, 1)).rejects.toThrow("请先连接");
    backendSnapshot = { ...backendSnapshot, sessionId: 2 };
    invoke.mockClear();
    await gateway.connect(config);
    await expect(gateway.sendMotionTarget(target, 1)).rejects.toThrow("会话已变化");
    expect(invoke.mock.calls.map(([name]) => name)).toEqual(["disconnect_device", "connect_device"]);
  });

  it("BLE 建立阶段断开不会返回已连接，只读连接仍不能运动", async () => {
    const gateway = new DeviceGateway();
    invoke.mockImplementation(async (name: string) => {
      if (name === "disconnect_device") return disconnected;
      if (name === "connect_device") {
        handlers.get("wl1://disconnected")?.({ payload: { sessionId: 3, timestamp: 10, reason: "订阅后立即断开" } });
        return { ...backendSnapshot, mode: "ble", sessionId: 3 };
      }
      return undefined;
    });
    await expect(gateway.connect(config)).rejects.toThrow("订阅后立即断开");
    expect(gateway.connection.mode).toBe("disconnected");
    invoke.mockImplementation(async (name: string) => name === "disconnect_device" ? disconnected : { ...backendSnapshot, mode: "ble", connectionTarget: "robot", writesUnlocked: false });
    await gateway.connect({ ...config, allowUnsafeWrites: false });
    await expect(gateway.sendMotionTarget({ turn: 0, velocity: 0, roll: 0, height: 60 })).rejects.toThrow("只读");
  });
});
