import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { deviceGateway, isTauriRuntime } from "./device";
import type { SerialPortOption } from "../types";

export const GAMEBOX_KEYS = ["UP", "DOWN", "LEFT", "RIGHT", "JUMP", "FUNC", "ENTER", "BACK"] as const;
export const GAMEBOX_ACTIONS = ["PRESSED", "RELEASED", "CLICK", "DOUBLE", "LONG", "REPEAT"] as const;
export interface GameBoxButtonFrame {
  type: "button";
  uptimeMs: number;
  key: typeof GAMEBOX_KEYS[number];
  action: typeof GAMEBOX_ACTIONS[number];
  heldMs: number;
}
export type GameBoxFrame = { type: "ready" } | GameBoxButtonFrame;
export interface GameBoxSnapshot {
  mode: "disconnected" | "serial" | "demo";
  label: string;
  sessionId?: number;
  connectedAt?: number;
  identified: boolean;
  receivedLines: number;
  lastActivity?: number;
  droppedLines?: number;
}
export type GameBoxEvent =
  | { type: "snapshot"; snapshot: GameBoxSnapshot }
  | { type: "line"; sessionId: number; timestamp: number; text: string; frame?: GameBoxFrame }
  | { type: "disconnected"; sessionId: number; timestamp: number; text: string };
interface BackendEvent {
  sessionId: number;
  timestamp: number;
  kind: "line" | "disconnected";
  text: string;
  receivedLines?: number;
  droppedLines?: number;
  identified?: boolean;
}
const disconnected = (): GameBoxSnapshot => ({
  mode: "disconnected", label: "未连接", identified: false, receivedLines: 0, droppedLines: 0,
});

// Firmware source: firmware/src/tasks.rs. This is a TX log protocol,
// not a command channel. Unknown lines remain visible without identifying a device.
export function parseGameBoxLine(line: string): GameBoxFrame | undefined {
  if (line === "GAMEBOX FW2 UART-TX-DMA READY") return { type: "ready" };
  const match = /^BTN ([0-9]+) (UP|DOWN|LEFT|RIGHT|JUMP|FUNC|ENTER|BACK) (PRESSED|RELEASED|CLICK|DOUBLE|LONG|REPEAT) ([0-9]+)$/.exec(line);
  if (!match || match[0] !== line) return undefined;
  const uptimeMs = Number(match[1]);
  const heldMs = Number(match[4]);
  if (!Number.isSafeInteger(uptimeMs) || !Number.isSafeInteger(heldMs)
    || uptimeMs > 0xffff_ffff || heldMs > 0xffff_ffff) return undefined;
  return { type: "button", uptimeMs, key: match[2] as GameBoxButtonFrame["key"],
    action: match[3] as GameBoxButtonFrame["action"], heldMs };
}

export class GameBoxGateway {
  private snapshot = disconnected();
  private readonly listeners = new Set<(event: GameBoxEvent) => void>();
  private eventInstallation?: Promise<void>;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private pending: BackendEvent[] | undefined;
  private demoTimer?: ReturnType<typeof setInterval>;
  private demoSequence = 0;

  get connection(): GameBoxSnapshot { return { ...this.snapshot }; }
  subscribe(listener: (event: GameBoxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private emit(event: GameBoxEvent): void { this.listeners.forEach((listener) => { listener(event); }); }
  private update(snapshot: GameBoxSnapshot): GameBoxSnapshot {
    this.snapshot = { ...snapshot };
    this.emit({ type: "snapshot", snapshot: this.connection });
    return this.connection;
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(operation);
    this.lifecycle = result.catch(() => undefined);
    return result;
  }
  private async installEvents(): Promise<void> {
    if (!isTauriRuntime()) return;
    if (!this.eventInstallation) {
      this.eventInstallation = listen<BackendEvent>("gamebox:event", ({ payload }) => {
        if (this.pending) {
          // A reader can emit before the connect IPC response reaches the WebView.
          // Preserve fault notifications even if a noisy port fills the line buffer.
          if (this.pending.length >= 256) {
            const index = this.pending.findIndex((event) => event.kind === "line");
            if (index >= 0) this.pending.splice(index, 1);
            else this.pending.shift();
          }
          this.pending.push(payload);
        } else this.accept(payload);
      }).then(() => undefined).catch((error: unknown) => {
        this.eventInstallation = undefined;
        throw error;
      });
    }
    await this.eventInstallation;
  }
  private accept(event: BackendEvent): void {
    if (event.sessionId !== this.snapshot.sessionId || this.snapshot.mode === "disconnected") return;
    if (event.kind === "disconnected") {
      this.update(disconnected());
      this.emit({ type: "disconnected", ...event });
      return;
    }
    const frame = parseGameBoxLine(event.text);
    this.update({ ...this.snapshot,
      identified: this.snapshot.identified || event.identified === true || frame?.type === "ready",
      receivedLines: event.receivedLines === undefined ? this.snapshot.receivedLines + 1
        : Math.max(this.snapshot.receivedLines, event.receivedLines),
      droppedLines: Math.max(this.snapshot.droppedLines ?? 0, event.droppedLines ?? 0),
      lastActivity: Math.max(this.snapshot.lastActivity ?? 0, event.timestamp),
    });
    this.emit({ type: "line", sessionId: event.sessionId, timestamp: event.timestamp, text: event.text, frame });
  }
  private stopDemo(): void {
    if (this.demoTimer !== undefined) clearInterval(this.demoTimer);
    this.demoTimer = undefined;
  }
  private async close(all = false): Promise<GameBoxSnapshot> {
    this.stopDemo();
    if (isTauriRuntime() && (all || this.snapshot.mode === "serial")) {
      await invoke<GameBoxSnapshot>("gamebox_disconnect", {
        expectedSessionId: all ? null : this.snapshot.sessionId,
      });
    }
    return this.update(disconnected());
  }
  initialize(): Promise<GameBoxSnapshot> {
    return this.serialize(async () => { await this.installEvents(); return this.close(true); });
  }
  listSerialPorts(): Promise<SerialPortOption[]> { return deviceGateway.listSerialPorts(); }
  connect(portName: string): Promise<GameBoxSnapshot> {
    return this.serialize(async () => {
      if (!isTauriRuntime()) throw new Error("真实串口需要桌面应用；浏览器中可使用体验演示。");
      if (!portName.trim()) throw new Error("请选择串口。");
      await this.installEvents();
      await this.close();
      this.pending = [];
      try {
        const snapshot = await invoke<GameBoxSnapshot>("gamebox_connect", { portName });
        this.update(snapshot);
        // Cumulative event counters prevent counting connect-time lines twice.
        const pending = this.pending;
        this.pending = undefined;
        for (const event of pending) this.accept(event);
        return this.connection;
      } catch (error) {
        this.pending = undefined;
        this.update(disconnected());
        throw error;
      }
    });
  }
  connectDemo(): Promise<GameBoxSnapshot> {
    return this.serialize(async () => {
      await this.close();
      const started = Date.now();
      const sessionId = -(++this.demoSequence);
      this.update({ mode: "demo", label: "GameBox 演示 · 无硬件", sessionId,
        connectedAt: started, identified: false, receivedLines: 0, droppedLines: 0 });
      this.accept({ sessionId, timestamp: started, kind: "line", text: "GAMEBOX FW2 UART-TX-DMA READY" });
      let tick = 0;
      this.demoTimer = setInterval(() => {
        const timestamp = Date.now();
        const key = GAMEBOX_KEYS[Math.floor(tick / 2) % GAMEBOX_KEYS.length];
        const pressed = tick++ % 2 === 0;
        this.accept({ sessionId, timestamp, kind: "line",
          text: `BTN ${timestamp - started} ${key} ${pressed ? "PRESSED" : "RELEASED"} ${pressed ? 0 : 700}` });
      }, 700);
      return this.connection;
    });
  }
  disconnect(): Promise<GameBoxSnapshot> { return this.serialize(() => this.close()); }
}

export const gameboxGateway = new GameBoxGateway();
