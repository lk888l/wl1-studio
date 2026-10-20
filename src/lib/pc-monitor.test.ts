import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MonitorSnapshot } from "./pc-monitor";

const { invoke, runtime } = vi.hoisted(() => ({ invoke: vi.fn(), runtime: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./device", () => ({ isTauriRuntime: runtime }));
import {
  emptyMonitorSnapshot, monitorBytes, monitorConnectionLabel, monitorMemory, monitorPercent, monitorRate,
  PcMonitorGateway, sanitizeMonitorConfig, validMonitorIp,
} from "./pc-monitor";

const config = { targetIp: "192.168.4.1", gpuEnabled: true, gpuUuid: null, intervalMs: 500 };
const running: MonitorSnapshot = { ...emptyMonitorSnapshot(), ...config, running: true, sessionId: "session-a" };
beforeEach(() => {
  vi.clearAllMocks();
  runtime.mockReturnValue(true);
  invoke.mockImplementation(async (command: string) => command === "pc_monitor_start" ? { ...running } : emptyMonitorSnapshot());
});
afterEach(() => { vi.useRealTimers(); });

describe("电脑监控配置与缺失指标", () => {
  it("只恢复合法配置，旧或损坏的数据回退到默认值", () => {
    expect(sanitizeMonitorConfig(null)).toEqual({ targetIp: "", gpuEnabled: true, gpuUuid: null, intervalMs: 500 });
    expect(sanitizeMonitorConfig({ targetIp: "hostname", gpuUuid: {}, intervalMs: 1 })).toEqual({ targetIp: "", gpuEnabled: true, gpuUuid: null, intervalMs: 500 });
    expect(sanitizeMonitorConfig({ targetIp: " 192.168.4.1 ", gpuUuid: " GPU-1 ", intervalMs: 2000 })).toEqual({ targetIp: "192.168.4.1", gpuEnabled: true, gpuUuid: "GPU-1", intervalMs: 2000 });
    expect(sanitizeMonitorConfig({ ...config, gpuUuid: "GPU-显卡" }).gpuUuid).toBeNull();
    expect(sanitizeMonitorConfig({ ...config, gpuUuid: "x".repeat(97) }).gpuUuid).toBeNull();
    for (const ip of ["", "192.168.4", "192.168.4.256", "0.0.0.0", "239.1.2.3", "255.255.255.255", "192.168.4.1:4443", "192.168.004.1"]) expect(validMonitorIp(ip)).toBe(false);
  });
  it("GPU 开关兼容旧配置，关闭时保留上次选择的显卡", () => {
    expect(sanitizeMonitorConfig({ ...config, gpuEnabled: false, gpuUuid: "GPU-1" })).toEqual({ ...config, gpuEnabled: false, gpuUuid: "GPU-1" });
    expect(sanitizeMonitorConfig({ ...config, gpuEnabled: "false" }).gpuEnabled).toBe(true);
  });
  it("缺失指标显示 N/A，保留有效的零占用率", () => {
    expect(monitorPercent(null)).toBe("N/A");
    expect(monitorPercent(Number.NaN)).toBe("N/A");
    expect(monitorPercent(0)).toBe("0.0%");
    expect(monitorBytes(null)).toBe("N/A");
    expect(monitorBytes(1024 ** 3)).toBe("1.0 GiB");
    expect(monitorMemory(1024 ** 2)).toBe("1.0 MiB");
    expect(monitorMemory(null)).toBe("N/A");
    expect(monitorRate(640)).toBe("640 B/s");
    expect(monitorRate(1536)).toBe("1.5 KiB/s");
    expect(monitorRate(0)).toBe("0 B/s");
    expect(monitorRate(Number.NaN)).toBe("N/A");
  });
  it("明确区分发送中、设备响应、超时与停止", () => {
    expect(monitorConnectionLabel(running)).toBe("等待设备响应");
    expect(monitorConnectionLabel({ ...running, ackAgeMs: 5000 })).toBe("设备响应已过期");
    expect(monitorConnectionLabel({ ...running, connected: true, ackAgeMs: 50 })).toBe("设备已响应");
    expect(monitorConnectionLabel(emptyMonitorSnapshot())).toBe("已停止");
  });
});

describe("电脑监控工作任务与界面生命周期", () => {
  it("浏览器不采集、不伪造发送状态，不调用桌面命令", async () => {
    runtime.mockReturnValue(false);
    const gateway = new PcMonitorGateway();
    const unsubscribe = gateway.subscribe(vi.fn());
    await gateway.refresh();
    await expect(gateway.start(config)).rejects.toThrow("桌面应用");
    await expect(gateway.enterBackground()).rejects.toThrow("桌面应用");
    await expect(gateway.savePreferences({ startInBackground: true, autoResume: true })).rejects.toThrow("桌面应用");
    expect(await gateway.devices()).toMatchObject({ gpus: [] });
    expect(gateway.getSnapshot().running).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
    unsubscribe();
  });
  it("多个组件共享轮询，页面卸载只停止轮询而不停止后台监控", async () => {
    vi.useFakeTimers();
    invoke.mockResolvedValue(running);
    const gateway = new PcMonitorGateway();
    const unsubscribeFirst = gateway.subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    const unsubscribeSecond = gateway.subscribe(vi.fn());
    expect(invoke).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledTimes(2);
    unsubscribeFirst();
    await vi.advanceTimersByTimeAsync(500);
    expect(invoke).toHaveBeenCalledTimes(3);
    unsubscribeSecond();
    await vi.advanceTimersByTimeAsync(2000);
    expect(invoke).toHaveBeenCalledTimes(3);
    expect(invoke.mock.calls.every(([command]) => command === "pc_monitor_snapshot")).toBe(true);
    expect(gateway.getSnapshot().running).toBe(true);
  });
  it("开始或停止后的状态不会被迟到的旧轮询覆盖", async () => {
    let finishPoll: (snapshot: MonitorSnapshot) => void = () => { throw new Error("轮询未开始"); };
    invoke.mockImplementation((command: string) => command === "pc_monitor_snapshot"
      ? new Promise<MonitorSnapshot>((resolve) => { finishPoll = resolve; })
      : Promise.resolve(command === "pc_monitor_start" ? running : emptyMonitorSnapshot()));
    const gateway = new PcMonitorGateway();
    const stalePoll = gateway.refresh();
    await gateway.start(config);
    finishPoll(emptyMonitorSnapshot());
    await stalePoll;
    expect(gateway.getSnapshot().sessionId).toBe("session-a");
    expect(gateway.getSnapshot().running).toBe(true);
    await gateway.stop();
    expect(invoke).toHaveBeenLastCalledWith("pc_monitor_stop", { expectedSessionId: "session-a" });
    expect(gateway.getSnapshot().running).toBe(false);
  });
  it("拒绝错误IP和不支持的周期，失败命令后仍能重试", async () => {
    const gateway = new PcMonitorGateway();
    await expect(gateway.start({ ...config, targetIp: "192.168.4.999" })).rejects.toThrow("IPv4");
    await expect(gateway.start({ ...config, intervalMs: 10 })).rejects.toThrow("采样周期");
    await expect(gateway.start({ ...config, gpuUuid: "GPU-显卡" })).rejects.toThrow("UUID");
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockRejectedValueOnce(new Error("network unavailable"));
    await expect(gateway.start(config)).rejects.toThrow("network unavailable");
    await gateway.start(config);
    expect(gateway.getSnapshot().running).toBe(true);
  });
  it("轮询失败时撤下连接成功状态，下次采样可恢复", async () => {
    const gateway = new PcMonitorGateway();
    invoke.mockResolvedValueOnce({ ...running, connected: true });
    await gateway.refresh();
    invoke.mockRejectedValueOnce(new Error("backend unavailable"));
    await expect(gateway.refresh()).rejects.toThrow("backend unavailable");
    expect(gateway.getSnapshot()).toMatchObject({ running: true, connected: false, lastError: "backend unavailable" });
    invoke.mockResolvedValueOnce({ ...running, connected: true });
    await gateway.refresh();
    expect(gateway.getSnapshot()).toMatchObject({ connected: true, lastError: null });
  });
  it("完成开始命令后才进入后台，不停止发送或在销毁窗口后继续请求快照", async () => {
    const gateway = new PcMonitorGateway();
    await Promise.all([gateway.start(config), gateway.enterBackground()]);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["pc_monitor_start", "desktop_enter_background"]);
    expect(gateway.getSnapshot().running).toBe(true);
  });
  it("运行中切换 GPU 将新配置交给后台，保留目标与显卡选择", async () => {
    const gateway = new PcMonitorGateway();
    const enabled = { ...config, gpuUuid: "GPU-1" };
    const disabled = { ...enabled, gpuEnabled: false };
    invoke.mockResolvedValueOnce({ ...running, ...enabled })
      .mockResolvedValueOnce({ ...running, ...disabled, sessionId: "session-b" });
    await gateway.start(enabled);
    await gateway.start(disabled);
    expect(invoke).toHaveBeenLastCalledWith("pc_monitor_start", { config: disabled });
    expect(gateway.getSnapshot()).toMatchObject({ running: true, gpuEnabled: false, gpuUuid: "GPU-1", targetIp: config.targetIp, sessionId: "session-b" });
  });
  it("GPU 切换期间点击停止，停止重建后的会话", async () => {
    const gateway = new PcMonitorGateway();
    await gateway.start(config);
    invoke.mockResolvedValueOnce({ ...running, gpuEnabled: false, sessionId: "session-b" })
      .mockResolvedValueOnce(emptyMonitorSnapshot());
    await Promise.all([gateway.start({ ...config, gpuEnabled: false }), gateway.stop()]);
    expect(invoke).toHaveBeenLastCalledWith("pc_monitor_stop", { expectedSessionId: "session-b" });
    expect(gateway.getSnapshot().running).toBe(false);
  });
  it("保存启动设置后读取原生配置，迟到的旧轮询不能覆盖它", async () => {
    const gateway = new PcMonitorGateway();
    let finishPoll: (snapshot: MonitorSnapshot) => void = () => { throw new Error("轮询未开始"); };
    invoke.mockImplementationOnce(() => new Promise<MonitorSnapshot>((resolve) => { finishPoll = resolve; }));
    const old = gateway.refresh();
    const preferences = { startInBackground: false, autoResume: false };
    const updated = { ...running, desktop: { preferences, monitorConfig: config, trayAvailable: true, resources: {}, warning: null } };
    invoke.mockResolvedValueOnce(undefined).mockResolvedValueOnce(updated);
    await gateway.savePreferences(preferences);
    finishPoll(emptyMonitorSnapshot());
    await old;
    expect(invoke).toHaveBeenCalledWith("desktop_save_preferences", { preferences });
    expect(gateway.getSnapshot().desktop?.preferences).toEqual(preferences);
    expect(gateway.getSnapshot().running).toBe(true);
  });
  it("后台切换失败后可重试，保留运行中的传输状态", async () => {
    const gateway = new PcMonitorGateway();
    await gateway.start(config);
    invoke.mockRejectedValueOnce(new Error("正在刷写固件"));
    await expect(gateway.enterBackground()).rejects.toThrow("正在刷写固件");
    invoke.mockResolvedValueOnce(undefined);
    await gateway.enterBackground();
    expect(gateway.getSnapshot().running).toBe(true);
  });
});
