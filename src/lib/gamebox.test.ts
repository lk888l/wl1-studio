import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GameBoxEvent, GameBoxSnapshot } from "./gamebox";

const { invoke, listen, handlers } = vi.hoisted(() => ({
  invoke: vi.fn(), listen: vi.fn(),
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));
import { GameBoxGateway, parseGameBoxLine } from "./gamebox";

const closed: GameBoxSnapshot = { mode: "disconnected", label: "未连接", identified: false, receivedLines: 0 };
let backend: GameBoxSnapshot;
function receive(payload: unknown): void { handlers.get("gamebox:event")?.({ payload }); }

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  backend = { mode: "serial", sessionId: 1, label: "COM7", receivedLines: 0, identified: false };
  invoke.mockImplementation(async (name: string) => name === "gamebox_connect" ? { ...backend } : closed);
  listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(name, handler);
    return () => handlers.delete(name);
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("GameBox 已核实日志协议", () => {
  it("精确启动标记才确认身份，按键流不冒充握手", () => {
    expect(parseGameBoxLine("GAMEBOX FW2 UART-TX-DMA READY")).toEqual({ type: "ready" });
    expect(parseGameBoxLine("prefix GAMEBOX FW2 UART-TX-DMA READY")).toBeUndefined();
    expect(parseGameBoxLine("BTN 4294967295 BACK LONG 650")).toEqual({
      type: "button", key: "BACK", action: "LONG", heldMs: 650, uptimeMs: 4294967295,
    });
    for (const line of ["BTN 4294967296 UP PRESSED 0", "BTN 1 UP PRESSED 4294967296", "BTN -1 UP CLICK 0",
      "BTN 1 A CLICK 0", "BTN 1 UP UNKNOWN 0", "BTN 1 UP CLICK 0 extra", "BTN 1 UP CLICK 0\n",
      "BTN 1 UP CLICK 0\r", "BTN 1 UP CLICK 0\u2028", "BTN 1  UP CLICK 0", " BTN 1 UP CLICK 0"]) {
      expect(parseGameBoxLine(line)).toBeUndefined();
    }
  });
});

describe("GameBox 会话生命周期", () => {
  it("只接收日志，无写命令，并隔离旧会话事件", async () => {
    const gateway = new GameBoxGateway();
    const events: GameBoxEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    await gateway.initialize();
    await gateway.connect("COM7");
    receive({ kind: "line", sessionId: 1, timestamp: 10, text: "BTN 1 UP PRESSED 0" });
    expect(gateway.connection.identified).toBe(false);
    receive({ kind: "line", sessionId: 1, timestamp: 20, text: "GAMEBOX FW2 UART-TX-DMA READY" });
    expect(gateway.connection.identified).toBe(true);
    backend = { ...backend, sessionId: 2 };
    await gateway.connect("COM7");
    events.length = 0;
    receive({ kind: "disconnected", sessionId: 1, timestamp: 30, text: "old fault" });
    receive({ kind: "line", sessionId: 1, timestamp: 31, text: "GAMEBOX FW2 UART-TX-DMA READY" });
    expect(events).toHaveLength(0);
    expect(gateway.connection).toMatchObject({ sessionId: 2, identified: false });
    expect(invoke.mock.calls.every(([name]) => ["gamebox_connect", "gamebox_disconnect"].includes(name))).toBe(true);
    await gateway.disconnect();
    expect(invoke).toHaveBeenLastCalledWith("gamebox_disconnect", { expectedSessionId: 2 });
  });
  it("保留connect响应前的启动和断开事件", async () => {
    const gateway = new GameBoxGateway();
    invoke.mockImplementation(async (name: string) => {
      if (name === "gamebox_connect") {
        receive({ kind: "line", sessionId: 1, timestamp: 10, text: "GAMEBOX FW2 UART-TX-DMA READY", receivedLines: 1 });
        receive({ kind: "disconnected", sessionId: 1, timestamp: 11, text: "拔出" });
        return backend;
      }
      return closed;
    });
    expect((await gateway.connect("COM7")).mode).toBe("disconnected");
  });
  it("累计状态在日志过载与连接早到事件中不回退、不重复计数", async () => {
    const gateway = new GameBoxGateway();
    invoke.mockImplementation(async (name: string) => {
      if (name === "gamebox_connect") {
        receive({ kind: "line", sessionId: 1, timestamp: 10, text: "BTN 1 UP CLICK 0",
          receivedLines: 300, droppedLines: 44, identified: true });
        return backend;
      }
      return closed;
    });
    await gateway.connect("COM7");
    expect(gateway.connection).toMatchObject({ receivedLines: 300, droppedLines: 44, identified: true });
    receive({ kind: "line", sessionId: 1, timestamp: 9, text: "BTN 0 UP PRESSED 0",
      receivedLines: 2, droppedLines: 0, identified: false });
    expect(gateway.connection).toMatchObject({ receivedLines: 300, droppedLines: 44, identified: true, lastActivity: 10 });
  });
  it("启动失败与关闭失败可重试，不谎报已释放会话", async () => {
    const gateway = new GameBoxGateway();
    listen.mockRejectedValueOnce(new Error("listen failed"));
    await expect(gateway.initialize()).rejects.toThrow("listen failed");
    await gateway.initialize();
    await gateway.connect("COM7");
    invoke.mockRejectedValueOnce(new Error("disconnect failed"));
    await expect(gateway.disconnect()).rejects.toThrow("disconnect failed");
    expect(gateway.connection.mode).toBe("serial");
    await gateway.disconnect();
    expect(gateway.connection.mode).toBe("disconnected");
  });
  it("演示清楚分离真实串口，并在退出后停止事件", async () => {
    vi.stubGlobal("window", {});
    vi.useFakeTimers();
    const gateway = new GameBoxGateway();
    await expect(gateway.connect("COM7")).rejects.toThrow("桌面应用");
    const events: GameBoxEvent[] = [];
    gateway.subscribe((event) => events.push(event));
    expect(await gateway.connectDemo()).toMatchObject({ mode: "demo", identified: true, receivedLines: 1 });
    vi.advanceTimersByTime(1400);
    expect(gateway.connection.receivedLines).toBe(3);
    await gateway.disconnect();
    events.length = 0;
    vi.advanceTimersByTime(7000);
    expect(events).toHaveLength(0);
    expect(invoke).not.toHaveBeenCalled();
  });
});
