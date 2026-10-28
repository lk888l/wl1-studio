import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, wait, flush } = vi.hoisted(() => ({ invoke: vi.fn(), wait: vi.fn(), flush: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./pc-monitor", () => ({ pcMonitorGateway: { waitForChanges: wait } }));
vi.mock("./user-storage", () => ({ flushUserStorage: flush }));
import { cancelDesktopClose, completeDesktopClose } from "./desktop-lifecycle";

beforeEach(() => {
  vi.resetAllMocks();
  wait.mockResolvedValue(undefined);
  flush.mockResolvedValue(undefined);
  invoke.mockResolvedValue(undefined);
});

describe("关闭前保存", () => {
  it("先等待偏好命令和自动保存完成，才允许原生销毁界面", async () => {
    let finishSave: () => void = () => { throw new Error("save not started"); };
    flush.mockImplementation(() => new Promise<void>((resolve) => { finishSave = resolve; }));
    const closing = completeDesktopClose({ id: 7, action: "background" });
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());
    expect(invoke).not.toHaveBeenCalled();
    finishSave();
    await closing;
    expect(invoke).toHaveBeenCalledWith("desktop_complete_close", { id: 7 });
  });

  it("保存失败保留窗口，可在重试成功后关闭", async () => {
    flush.mockRejectedValueOnce(new Error("只读目录"));
    const request = { id: 8, action: "close" as const };
    await expect(completeDesktopClose(request)).rejects.toThrow("只读目录");
    expect(invoke).not.toHaveBeenCalled();
    await completeDesktopClose(request);
    expect(invoke).toHaveBeenCalledOnce();
  });

  it("只有明确放弃保存才跳过失败写入，取消通过原生取消握手", async () => {
    const request = { id: 9, action: "quit" as const };
    await completeDesktopClose(request, true);
    expect(flush).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith("desktop_complete_close", { id: 9 });
    await cancelDesktopClose(request);
    expect(invoke).toHaveBeenLastCalledWith("desktop_cancel_close", { id: 9 });
  });
});
