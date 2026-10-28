import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauriRuntime } from "./device";
import { getStoredItem, registerStorageValidator, setStoredItem } from "./user-storage";

export interface MonitorConfig {
  targetIp: string;
  gpuEnabled: boolean;
  gpuUuid: string | null;
  intervalMs: number;
}
export interface MonitorSample {
  v: number;
  session: string;
  seq: number;
  host: string;
  cpuPct: number | null;
  ramUsed: number;
  ramTotal: number;
  gpuName: string;
  gpuPct: number | null;
  vramUsed: number | null;
  vramTotal: number | null;
  gpuTempC: number | null;
}
export interface MonitorSnapshot {
  running: boolean;
  sessionId: string | null;
  targetIp: string | null;
  gpuEnabled: boolean;
  gpuUuid: string | null;
  intervalMs: number;
  sample: MonitorSample | null;
  ackAgeMs: number | null;
  connected: boolean;
  lastError: string | null;
  samplesSent: number;
  bytesSent: number;
  desktop: DesktopSnapshot | null;
}
export interface DesktopPreferences {
  startInBackground: boolean;
  autoResume: boolean;
  closeBehavior: "tray" | "exit";
}
export interface DesktopResources {
  cpuPct: number | null;
  memoryBytes: number | null;
  backendCpuPct: number | null;
  backendMemoryBytes: number | null;
  processCount: number;
  txBytesPerSecond: number | null;
  packetsPerSecond: number | null;
}
export interface DesktopSnapshot {
  preferences: DesktopPreferences;
  monitorConfig: MonitorConfig | null;
  trayAvailable: boolean;
  resources: DesktopResources;
  warning: string | null;
}
export interface MonitorDevices {
  gpus: { uuid: string; name: string }[];
  warning: string | null;
}

const CONFIG_KEY = "wl1-studio.pc-monitor.v1";
export const MONITOR_INTERVALS = [500, 1000, 2000] as const;
export const defaultMonitorConfig: MonitorConfig = { targetIp: "", gpuEnabled: true, gpuUuid: null, intervalMs: 500 };
const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);

export function validMonitorIp(value: string): boolean {
  const parts = value.trim().split(".");
  return parts.length === 4 && parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255)
    && Number(parts[0]) > 0 && Number(parts[0]) < 224 && value.trim() !== "255.255.255.255";
}
export function sanitizeMonitorConfig(value: unknown): MonitorConfig {
  if (typeof value !== "object" || !value || Array.isArray(value)) return { ...defaultMonitorConfig };
  const fields = value as Record<string, unknown>;
  return {
    targetIp: typeof fields.targetIp === "string" && validMonitorIp(fields.targetIp) ? fields.targetIp.trim() : "",
    gpuEnabled: typeof fields.gpuEnabled === "boolean" ? fields.gpuEnabled : true,
    gpuUuid: typeof fields.gpuUuid === "string" && /^[\x21-\x7e]{1,96}$/.test(fields.gpuUuid.trim()) ? fields.gpuUuid.trim() : null,
    intervalMs: typeof fields.intervalMs === "number" && MONITOR_INTERVALS.some((interval) => interval === fields.intervalMs) ? fields.intervalMs : 500,
  };
}
export function loadMonitorConfig(): MonitorConfig {
  try { return sanitizeMonitorConfig(JSON.parse(getStoredItem(CONFIG_KEY) ?? "null")); }
  catch { return { ...defaultMonitorConfig }; }
}
registerStorageValidator(CONFIG_KEY, sanitizeMonitorConfig);
export function saveMonitorConfig(config: MonitorConfig): Promise<boolean> {
  return setStoredItem(CONFIG_KEY, JSON.stringify(sanitizeMonitorConfig(config)));
}
export function emptyMonitorSnapshot(): MonitorSnapshot {
  return { running: false, sessionId: null, targetIp: null, gpuEnabled: true, gpuUuid: null, intervalMs: 500, sample: null, ackAgeMs: null, connected: false, lastError: null, samplesSent: 0, bytesSent: 0, desktop: null };
}

/** Subscription lifetime only controls UI polling; the Rust worker owns sampling and UDP. */
export class PcMonitorGateway {
  private state = emptyMonitorSnapshot();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pollGeneration = 0;
  private revision = 0;
  private pendingChanges = 0;
  private queue: Promise<unknown> = Promise.resolve();
  readonly getSnapshot = (): MonitorSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    if (this.listeners.size === 1 && isTauriRuntime()) void this.poll(++this.pollGeneration);
    return () => {
      this.listeners.delete(listener);
      if (!this.listeners.size) { ++this.pollGeneration; clearTimeout(this.timer); }
    };
  };
  private publish(snapshot: MonitorSnapshot): MonitorSnapshot {
    this.state = snapshot;
    for (const listener of this.listeners) listener();
    return snapshot;
  }
  private async poll(generation: number): Promise<void> {
    if (generation !== this.pollGeneration || !this.listeners.size) return;
    if (!this.pendingChanges) {
      try { await this.refresh(); } catch { /* refresh publishes the error for the UI. */ }
    }
    if (generation === this.pollGeneration && this.listeners.size) this.timer = setTimeout(() => { void this.poll(generation); }, 500);
  }
  async refresh(): Promise<MonitorSnapshot> {
    if (!isTauriRuntime()) return this.state;
    const revision = this.revision;
    try {
      const next = await invoke<MonitorSnapshot>("pc_monitor_snapshot");
      return revision === this.revision && !this.pendingChanges ? this.publish(next) : this.state;
    } catch (reason) {
      if (revision === this.revision && !this.pendingChanges) this.publish({ ...this.state, connected: false, lastError: errorText(reason) });
      throw reason;
    }
  }
  private change(command: string, args: Record<string, unknown> | (() => Record<string, unknown>)): Promise<MonitorSnapshot> {
    if (!isTauriRuntime()) return Promise.reject(new Error("电脑指标采集需要使用桌面应用。"));
    ++this.revision;
    ++this.pendingChanges;
    const result = this.queue.then(async () => {
      try { return this.publish(await invoke<MonitorSnapshot>(command, typeof args === "function" ? args() : args)); }
      finally { --this.pendingChanges; }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  start(config: MonitorConfig): Promise<MonitorSnapshot> {
    if (!validMonitorIp(config.targetIp)) return Promise.reject(new Error("请输入设备的有效 IPv4 地址。"));
    if (!MONITOR_INTERVALS.some((interval) => interval === config.intervalMs)) return Promise.reject(new Error("请选择 500、1000 或 2000 ms 的采样周期。"));
    if (config.gpuUuid !== null && !/^[\x21-\x7e]{1,96}$/.test(config.gpuUuid.trim())) return Promise.reject(new Error("显卡 UUID 无效，请重新选择显卡。"));
    return this.change("pc_monitor_start", { config: { ...config, targetIp: config.targetIp.trim() } });
  }
  stop(): Promise<MonitorSnapshot> {
    return this.change("pc_monitor_stop", () => ({ expectedSessionId: this.state.sessionId }));
  }
  private desktopAction(command: string, args: Record<string, unknown>, refresh: boolean): Promise<void> {
    if (!isTauriRuntime()) return Promise.reject(new Error("后台运行需要使用桌面应用。"));
    ++this.revision;
    ++this.pendingChanges;
    const result = this.queue.then(async () => {
      try {
        await invoke<void>(command, args);
        if (refresh) this.publish(await invoke<MonitorSnapshot>("pc_monitor_snapshot"));
      } finally { --this.pendingChanges; }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  enterBackground(): Promise<void> {
    return this.desktopAction("desktop_enter_background", {}, false);
  }
  savePreferences(preferences: DesktopPreferences): Promise<void> {
    return this.desktopAction("desktop_save_preferences", { preferences }, true);
  }
  async waitForChanges(): Promise<void> {
    await this.queue;
  }
  async devices(): Promise<MonitorDevices> {
    if (!isTauriRuntime()) return { gpus: [], warning: "桌面应用可以采集本机 CPU、内存与 NVIDIA GPU 指标。" };
    return invoke<MonitorDevices>("pc_monitor_devices");
  }
}
export const pcMonitorGateway = new PcMonitorGateway();
export function usePcMonitor(): MonitorSnapshot {
  return useSyncExternalStore(pcMonitorGateway.subscribe, pcMonitorGateway.getSnapshot);
}
export function monitorConnectionLabel(snapshot: MonitorSnapshot): string {
  if (!snapshot.running) return "已停止";
  if (snapshot.connected) return "设备已响应";
  return snapshot.ackAgeMs === null ? "等待设备响应" : "设备响应已过期";
}
export function monitorPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "N/A" : `${value.toFixed(1)}%`;
}
export function monitorBytes(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "N/A" : `${(value / 1024 ** 3).toFixed(1)} GiB`;
}
export function monitorMemory(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "N/A" : `${(value / 1024 ** 2).toFixed(1)} MiB`;
}
export function monitorProcessCpu(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "N/A" : `${value.toFixed(2)}%`;
}
export function monitorRate(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "N/A";
  return value >= 1024 ? `${(value / 1024).toFixed(1)} KiB/s` : `${Math.max(0, value).toFixed(0)} B/s`;
}
