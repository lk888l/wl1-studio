import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConnectionSnapshot, DeviceEvent } from "../types";
import type { DeviceGateway } from "./device";
import { getParameterSaveBlockReason, saveParametersToFlash } from "./parameter-save";

function testGateway() {
  let connection: ConnectionSnapshot = {
    mode: "serial", connectionTarget: "robot", sessionId: 7, label: "COM7",
    telemetryEnabled: false, writesUnlocked: true,
  };
  const listeners = new Set<(event: DeviceEvent) => void>();
  const sendTextCommand = vi.fn<DeviceGateway["sendTextCommand"]>().mockResolvedValue(undefined);
  return {
    get connection() { return { ...connection }; },
    setConnection(patch: Partial<ConnectionSnapshot>) { connection = { ...connection, ...patch }; },
    subscribe(listener: (event: DeviceEvent) => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    sendTextCommand,
    emit(event: DeviceEvent) { for (const listener of listeners) listener(event); },
    receive(text: string, direction: "rx" | "tx" | "system" = "rx") {
      this.emit({ type: "console", entry: { id: "reply", timestamp: Date.now(), direction, text } });
    },
    get listenerCount() { return listeners.size; },
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("SRAM 参数保存到 Flash", () => {
  it.each([
    ["save: ok (all motion parameters)", "saved"],
    ["save: unchanged (no flash write)", "unchanged"],
  ])("先订阅再发送，支持同步回执 %s", async (reply, status) => {
    const gateway = testGateway();
    gateway.sendTextCommand.mockImplementation(async () => { gateway.receive(reply); });
    await expect(saveParametersToFlash(gateway, 7)).resolves.toBe(status);
    expect(gateway.sendTextCommand).toHaveBeenCalledExactlyOnceWith("save", 7);
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("异步接收成功回执，TX 与 system 不能充当回执", async () => {
    const gateway = testGateway();
    const saved = vi.fn();
    const pending = saveParametersToFlash(gateway, 7).then(saved);
    gateway.receive("save: ok (all motion parameters)", "tx");
    gateway.receive("save: ok (all motion parameters)", "system");
    gateway.receive("prefix save: ok (all motion parameters)");
    await vi.advanceTimersByTimeAsync(100);
    expect(saved).not.toHaveBeenCalled();
    expect(gateway.listenerCount).toBe(1);
    gateway.receive("save: ok (all motion parameters)");
    await pending;
    expect(saved).toHaveBeenCalledWith("saved");
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["save: busy; system is starting", "正在启动"],
    ["save: full; use save recycle to erase journal and save", "已满"],
    ["save: invalid parameters", "无效参数"],
    ["save: flash error; RAM settings retained", "SRAM"],
    ["save: busy; recycle requires stopped control, or another save is active", "正忙"],
    ["save: usage: save [all|recycle]", "固件版本"],
    ["save: unknown failure", "未确认保存"],
    ["save: ok (all motion parameters) extra", "未确认保存"],
  ])("固件拒绝时说明原因并清理监听：%s", async (reply, message) => {
    const gateway = testGateway();
    const pending = saveParametersToFlash(gateway, 7);
    const assertion = expect(pending).rejects.toThrow(message);
    gateway.receive(reply);
    await assertion;
    expect(gateway.sendTextCommand).toHaveBeenCalledExactlyOnceWith("save", 7);
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("10 秒没有明确回执时报告未知结果，不自动重试", async () => {
    const gateway = testGateway();
    const pending = saveParametersToFlash(gateway, 7);
    const assertion = expect(pending).rejects.toThrow("超时，无法确认");
    gateway.receive("未知命令: save");
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(gateway.sendTextCommand).toHaveBeenCalledTimes(1);
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("超时后禁止同会话再次保存，迟到 ACK 不能冒充下一次成功", async () => {
    const gateway = testGateway();
    const pending = saveParametersToFlash(gateway, 7);
    const timedOut = expect(pending).rejects.toThrow("超时");
    await vi.advanceTimersByTimeAsync(10_000);
    await timedOut;
    expect(getParameterSaveBlockReason(gateway, 7)).toContain("重新连接");
    const next = saveParametersToFlash(gateway, 7);
    gateway.receive("save: ok (all motion parameters)");
    await expect(next).rejects.toThrow("上次保存结果未确认");
    expect(gateway.sendTextCommand).toHaveBeenCalledTimes(1);
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("明确固件拒绝后允许手动再次保存", async () => {
    const gateway = testGateway();
    const pending = saveParametersToFlash(gateway, 7);
    const rejected = expect(pending).rejects.toThrow("正在启动");
    gateway.receive("save: busy; system is starting");
    await rejected;
    expect(getParameterSaveBlockReason(gateway, 7)).toBeNull();
    const next = saveParametersToFlash(gateway, 7);
    gateway.receive("save: ok (all motion parameters)");
    await expect(next).resolves.toBe("saved");
  });

  it("取消已发送任务后隔离同一会话", async () => {
    const gateway = testGateway();
    const controller = new AbortController();
    const pending = saveParametersToFlash(gateway, 7, controller.signal);
    const rejected = expect(pending).rejects.toThrow("取消");
    controller.abort();
    await rejected;
    await expect(saveParametersToFlash(gateway, 7)).rejects.toThrow("重新连接");
    expect(gateway.sendTextCommand).toHaveBeenCalledTimes(1);
  });

  it("收到断开事件时取消等待", async () => {
    const gateway = testGateway();
    const pending = saveParametersToFlash(gateway, 7);
    const assertion = expect(pending).rejects.toThrow("设备已断开");
    gateway.emit({ type: "disconnected" });
    await assertion;
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ mode: "disconnected" as const }, "设备已断开"],
    [{ sessionId: 8 }, "会话已变化"],
  ])("静默连接状态变化也取消旧保存：%s", async (connection, message) => {
    const gateway = testGateway();
    const pending = saveParametersToFlash(gateway, 7);
    const assertion = expect(pending).rejects.toThrow(message);
    gateway.setConnection(connection);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("新会话回执不能确认旧会话的保存", async () => {
    const gateway = testGateway();
    const pending = saveParametersToFlash(gateway, 7);
    const assertion = expect(pending).rejects.toThrow("会话已变化");
    gateway.setConnection({ sessionId: 8 });
    gateway.receive("save: ok (all motion parameters)");
    await assertion;
    expect(gateway.listenerCount).toBe(0);
  });

  it("阻止重复点击，完成后可再次保存", async () => {
    const gateway = testGateway();
    const first = saveParametersToFlash(gateway, 7);
    await expect(saveParametersToFlash(gateway, 7)).rejects.toThrow("请勿重复保存");
    expect(gateway.sendTextCommand).toHaveBeenCalledTimes(1);
    gateway.receive("save: ok (all motion parameters)");
    await expect(first).resolves.toBe("saved");
    const second = saveParametersToFlash(gateway, 7);
    gateway.receive("save: unchanged (no flash write)");
    await expect(second).resolves.toBe("unchanged");
    expect(gateway.sendTextCommand).toHaveBeenCalledTimes(2);
  });

  it("取消清理监听与计时器，迟到回执不影响结果", async () => {
    const gateway = testGateway();
    const controller = new AbortController();
    const pending = saveParametersToFlash(gateway, 7, controller.signal);
    const assertion = expect(pending).rejects.toThrow("已取消等待");
    controller.abort();
    gateway.receive("save: ok (all motion parameters)");
    await assertion;
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("发送失败不等待超时，隔离未确认会话，重连后允许保存", async () => {
    const gateway = testGateway();
    gateway.sendTextCommand.mockRejectedValueOnce(new Error("串口写入失败"));
    await expect(saveParametersToFlash(gateway, 7)).rejects.toThrow("串口写入失败");
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(getParameterSaveBlockReason(gateway, 7)).toContain("上次保存结果未确认");
    await expect(saveParametersToFlash(gateway, 7)).rejects.toThrow("重新连接");
    expect(gateway.sendTextCommand).toHaveBeenCalledTimes(1);
    gateway.setConnection({ sessionId: 8 });
    expect(getParameterSaveBlockReason(gateway, 8)).toBeNull();
    gateway.sendTextCommand.mockImplementation(async () => { gateway.receive("save: ok (all motion parameters)"); });
    await expect(saveParametersToFlash(gateway, 8)).resolves.toBe("saved");
  });

  it("即使出现同步回执，发送失败仍不能报告成功", async () => {
    const gateway = testGateway();
    gateway.sendTextCommand.mockImplementation(async () => {
      gateway.receive("save: ok (all motion parameters)");
      throw new Error("发送任务失败");
    });
    await expect(saveParametersToFlash(gateway, 7)).rejects.toThrow("发送任务失败");
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    [{ mode: "disconnected" as const }, "设备已断开"],
    [{ sessionId: 8 }, "会话已变化"],
    [{ writesUnlocked: false }, "只读"],
    [{ connectionTarget: "remote" as const }, "遥控器链路"],
  ])("发送前拒绝不可保存的连接：%s", async (connection, message) => {
    const gateway = testGateway();
    gateway.setConnection(connection);
    await expect(saveParametersToFlash(gateway, 7)).rejects.toThrow(message);
    expect(gateway.sendTextCommand).not.toHaveBeenCalled();
    expect(gateway.listenerCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("已取消的任务不会发送保存", async () => {
    const gateway = testGateway();
    const controller = new AbortController();
    controller.abort();
    await expect(saveParametersToFlash(gateway, 7, controller.signal)).rejects.toThrow("已取消等待");
    expect(gateway.sendTextCommand).not.toHaveBeenCalled();
    expect(gateway.listenerCount).toBe(0);
  });
});
