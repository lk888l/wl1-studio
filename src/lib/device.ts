import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import type {
  BluetoothDeviceOption,
  ConnectionSnapshot,
  ConsoleEntry,
  DeviceEvent,
  MotionTarget,
  SerialConfig,
  SerialPortOption,
  TelemetrySample,
  TelemetrySubscription,
} from "../types";
import { buildMotionCommand, isReadOnlyFirmwareCommand, validateFirmwareCommand } from "./protocol";
import { isRemoteConnection, REMOTE_MOTION_UNAVAILABLE, REMOTE_TELEMETRY_UNAVAILABLE } from "./connection";
import { mergeTelemetrySample } from "./telemetry";

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

type DeviceListener = (event: DeviceEvent) => void;

interface SerialLinePayload {
  sessionId?: number;
  session_id?: number;
  text?: string;
  direction?: "rx" | "tx" | "system";
  timestamp?: number;
}

interface TelemetryPayload extends Partial<TelemetrySample> {
  sessionId?: number;
  session_id?: number;
  imu_timestamp?: number | null;
  rpm_timestamp?: number | null;
  left_rpm?: number | null;
  right_rpm?: number | null;
  target_height?: number | null;
  link_quality?: number | null;
  battery_voltage?: number | null;
  acceleration_norm_g?: number | null;
  acceleration_trusted?: boolean | null;
}

interface DisconnectedPayload {
  sessionId?: number;
  session_id?: number;
  timestamp: number;
  reason: string;
}

const numeric = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const nullableNumeric = (value: unknown): number | null | undefined =>
  value === null ? null : numeric(value);

const nowSample = (): TelemetrySample => ({
  timestamp: Date.now(),
  roll: 0,
  pitch: 0,
  yaw: 0,
  leftRpm: 0,
  rightRpm: 0,
});

const uid = (): string => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

export function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ !== undefined;
}

export class DeviceGateway {
  private readonly listeners = new Set<DeviceListener>();
  private snapshot: ConnectionSnapshot = {
    mode: "disconnected",
    label: "未连接",
    telemetryEnabled: false,
    writesUnlocked: false,
  };
  private subscription: TelemetrySubscription = { imu: true, rpm: true };
  private mockInterval: number | undefined;
  private mockStartedAt = 0;
  private mockMotion: MotionTarget = { turn: 0, velocity: 0, roll: 0, height: 61.5 };
  private mockAutoLegEnabled = true;
  private mockRollBias = 0;
  private mockParameters = new Map<string, number | string>();
  private mockSavedParameters: string | undefined;
  private lastTelemetry = nowSample();
  private unlisteners: UnlistenFn[] = [];
  private installingEvents: Promise<void> | undefined;
  private initializing: Promise<ConnectionSnapshot> | undefined;
  private browserSessionSequence = 0;
  private connecting = false;
  private readonly pendingDisconnects = new Map<number, DisconnectedPayload>();

  get connection(): ConnectionSnapshot {
    return { ...this.snapshot };
  }

  async initialize(): Promise<ConnectionSnapshot> {
    if (this.initializing) return this.initializing;
    this.initializing = (async () => {
      this.stopMock();
      if (isTauriRuntime()) {
        await this.installTauriEvents();
        this.snapshot = await invoke<ConnectionSnapshot>("disconnect_device", {
          expectedSessionId: null,
        });
      } else {
        this.snapshot = {
          mode: "disconnected",
          label: "未连接",
          telemetryEnabled: false,
          writesUnlocked: false,
        };
      }
      this.lastTelemetry = nowSample();
      this.subscription = { imu: true, rpm: true };
      return this.connection;
    })().finally(() => {
      this.initializing = undefined;
    });
    return this.initializing;
  }

  subscribe(listener: DeviceListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async listSerialPorts(): Promise<SerialPortOption[]> {
    if (!isTauriRuntime()) return [];
    const result = await invoke<unknown[]>("list_serial_ports");
    return result.map((port) => this.normalizePort(port));
  }

  async scanBluetoothDevices(): Promise<BluetoothDeviceOption[]> {
    if (!isTauriRuntime()) throw new Error("蓝牙连接需要在桌面端运行。");
    return invoke<BluetoothDeviceOption[]>("scan_bluetooth_devices");
  }

  async connect(config: SerialConfig): Promise<ConnectionSnapshot> {
    const tauri = isTauriRuntime();
    await this.disconnect(tauri);
    this.lastTelemetry = nowSample();

    if (!tauri && config.mode === "mock") {
      this.mockMotion = { turn: 0, velocity: 0, roll: 0, height: 61.5 };
      this.mockAutoLegEnabled = true;
      this.mockRollBias = 0;
      this.mockParameters.clear();
      this.mockSavedParameters = undefined;
      this.snapshot = {
        mode: "mock",
        connectionTarget: "robot",
        label: "浏览器仿真 · WL1-MOCK-01",
        sessionId: ++this.browserSessionSequence,
        connectedAt: Date.now(),
        baudRate: config.baudRate,
        telemetryEnabled: true,
        writesUnlocked: true,
      };
      this.subscription = { imu: true, rpm: true };
      this.mockStartedAt = performance.now();
      this.startMock();
      this.emitConsole("system", "Mock 设备已连接；遥测与命令日志已启用，UID、自适应腿高及 Flash 保存提供模拟回执");
      return this.connection;
    }

    if (!tauri) {
      throw new Error("当前是浏览器预览，请选择 Mock 模式；真实串口或蓝牙需要在桌面端运行。");
    }
    if (config.mode === "serial" && !config.portName) throw new Error("请选择串口");
    if (config.mode === "ble" && !config.bleDeviceId) throw new Error("请扫描并选择蓝牙设备");
    await this.installTauriEvents();
    this.connecting = true;
    try {
      const backendSnapshot = await invoke<ConnectionSnapshot>("connect_device", {
        config: {
          mode: config.mode,
          connectionTarget: config.mode === "serial" ? config.connectionTarget ?? "robot" : "robot",
          portName: config.portName,
          ...(config.mode === "ble" ? { bleDeviceId: config.bleDeviceId } : {}),
          baudRate: config.baudRate,
          allowUnsafeWrites: config.mode === "mock" || config.allowUnsafeWrites,
        },
      });
      this.snapshot = {
        ...backendSnapshot,
        mode: backendSnapshot.mode,
        connectionTarget: backendSnapshot.connectionTarget ?? "robot",
        label: backendSnapshot.label || (config.mode === "mock" ? "WL1-MOCK-01" : config.portName ?? "WL1"),
        sessionId: backendSnapshot.sessionId,
        connectedAt: backendSnapshot.connectedAt ?? Date.now(),
        baudRate: config.mode === "ble" ? undefined : backendSnapshot.baudRate ?? config.baudRate,
        telemetryEnabled: backendSnapshot.telemetryEnabled ?? false,
        writesUnlocked: backendSnapshot.writesUnlocked ?? (config.mode === "mock" || config.allowUnsafeWrites),
      };
      const sessionId = this.snapshot.sessionId;
      const earlyDisconnect = sessionId === undefined ? undefined : this.pendingDisconnects.get(sessionId);
      if (this.snapshot.mode === "disconnected" || sessionId === undefined || earlyDisconnect) {
        if (sessionId !== undefined) {
          await invoke("disconnect_device", { expectedSessionId: sessionId }).catch(() => undefined);
        }
        this.snapshot = { mode: "disconnected", label: "未连接", telemetryEnabled: false, writesUnlocked: false };
        throw new Error(earlyDisconnect?.reason ?? "设备在连接建立阶段已中断，请检查设备后重试");
      }
      return this.connection;
    } finally {
      this.connecting = false;
      this.pendingDisconnects.clear();
    }
  }

  async disconnect(callBackend = true): Promise<void> {
    const previousMode = this.snapshot.mode;
    const expectedSessionId = this.snapshot.sessionId;
    this.stopMock();
    if (callBackend && isTauriRuntime()) {
      const backendSnapshot = await invoke<ConnectionSnapshot>("disconnect_device", {
        expectedSessionId: expectedSessionId ?? null,
      });
      if (backendSnapshot.mode !== "disconnected") {
        this.snapshot = backendSnapshot;
        return;
      }
    }
    if (previousMode !== "disconnected" && !isTauriRuntime()) {
      this.emitConsole("system", "设备连接已断开");
    }
    this.snapshot = {
      mode: "disconnected",
      label: "未连接",
      telemetryEnabled: false,
      writesUnlocked: false,
    };
    this.lastTelemetry = nowSample();
  }

  async sendTextCommand(command: string, expectedSessionId?: number): Promise<void> {
    const error = validateFirmwareCommand(command, isRemoteConnection(this.snapshot) ? "remote" : "robot");
    if (error) throw new Error(error);
    const sessionId = isReadOnlyFirmwareCommand(command)
      ? this.requireSession(expectedSessionId)
      : this.requireWritableSession(expectedSessionId);
    const trimmed = command.trim();
    if (isTauriRuntime()) {
      await invoke("send_text_command", { command: trimmed, expectedSessionId: sessionId });
      this.requireSession(sessionId);
      return;
    }
    this.emitConsole("tx", trimmed);
    this.handleMockCommand(trimmed);
  }

  async sendMotionTarget(target: MotionTarget, expectedSessionId?: number): Promise<void> {
    if (isRemoteConnection(this.snapshot)) throw new Error(REMOTE_MOTION_UNAVAILABLE);
    const command = buildMotionCommand(target);
    const sessionId = this.requireWritableSession(expectedSessionId);
    if (isTauriRuntime()) {
      await invoke("send_motion_target", { target, expectedSessionId: sessionId });
      this.requireSession(sessionId);
      return;
    }
    this.emitConsole("tx", command);
    this.handleMockCommand(command);
  }

  async setTelemetry(next: TelemetrySubscription, expectedSessionId?: number): Promise<void> {
    const sessionId = this.requireSession(expectedSessionId);
    if (isRemoteConnection(this.snapshot) && (next.imu || next.rpm)) {
      throw new Error(REMOTE_TELEMETRY_UNAVAILABLE);
    }
    if (isTauriRuntime()) {
      await invoke("set_telemetry", {
        enabled: next.imu || next.rpm,
        expectedSessionId: sessionId,
      });
      this.requireSession(sessionId);
    }
    this.subscription = { ...next };
    this.snapshot = { ...this.snapshot, telemetryEnabled: next.imu || next.rpm };
    if (!isTauriRuntime()) {
      this.emitConsole("system", `遥测：IMU ${next.imu ? "开" : "关"} / RPM ${next.rpm ? "开" : "关"}`);
    }
  }

  async dispose(): Promise<void> {
    await this.disconnect();
    for (const unlisten of this.unlisteners.splice(0)) unlisten();
  }

  private emit(event: DeviceEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  private requireWritableSession(expectedSessionId?: number): number {
    const sessionId = this.requireSession(expectedSessionId);
    if (!this.snapshot.writesUnlocked) {
      throw new Error("当前为只读连接，不能下发参数或运动目标。");
    }
    return sessionId;
  }

  private requireSession(expectedSessionId?: number): number {
    if (this.snapshot.mode === "disconnected" || this.snapshot.sessionId === undefined) {
      throw new Error("请先连接设备");
    }
    const sessionId = expectedSessionId ?? this.snapshot.sessionId;
    if (sessionId !== this.snapshot.sessionId) {
      throw new Error("设备会话已变化；已取消旧连接遗留的发送任务");
    }
    return sessionId;
  }

  private emitConsole(direction: ConsoleEntry["direction"], text: string, timestamp = Date.now()): void {
    this.emit({
      type: "console",
      entry: { id: uid(), timestamp, direction, text },
    });
  }

  private startMock(): void {
    this.stopMock();
    this.mockInterval = window.setInterval(() => this.mockTick(), 50);
    this.mockTick();
  }

  private stopMock(): void {
    if (this.mockInterval === undefined) return;
    window.clearInterval(this.mockInterval);
    this.mockInterval = undefined;
  }

  private mockTick(): void {
    const seconds = (performance.now() - this.mockStartedAt) / 1000;
    const turn = this.mockMotion.turn;
    const velocity = this.mockMotion.velocity;
    const wave = Math.sin(seconds * 1.6);
    const timestamp = Date.now();
    this.lastTelemetry = {
      timestamp,
      imuTimestamp: this.subscription.imu ? timestamp : this.lastTelemetry.imuTimestamp,
      rpmTimestamp: this.subscription.rpm ? timestamp : this.lastTelemetry.rpmTimestamp,
      roll: this.subscription.imu ? this.mockMotion.roll + wave * 0.65 : this.lastTelemetry.roll,
      pitch: this.subscription.imu ? velocity * 0.035 + Math.sin(seconds * 2.3) * 1.2 : this.lastTelemetry.pitch,
      yaw: this.subscription.imu ? (this.lastTelemetry.yaw + turn * 0.004 + 360) % 360 : this.lastTelemetry.yaw,
      leftRpm: this.subscription.rpm ? velocity + turn * 0.5 + wave * 1.2 : this.lastTelemetry.leftRpm,
      rightRpm: this.subscription.rpm ? velocity - turn * 0.5 - wave * 1.1 : this.lastTelemetry.rightRpm,
      targetHeight: this.mockMotion.height,
      linkQuality: 96 + Math.sin(seconds * 0.4) * 3,
      batteryVoltage: 12.35 + Math.sin(seconds * 0.1) * 0.08,
      accelerationNormG: 1 + Math.sin(seconds * 1.7) * 0.025,
      accelerationTrusted: true,
    };
    if (this.subscription.imu || this.subscription.rpm) {
      this.emit({ type: "telemetry", sample: { ...this.lastTelemetry } });
    }
  }

  private handleMockCommand(command: string): void {
    if (command === "save") {
      const snapshot = JSON.stringify({
        parameters: [...this.mockParameters.entries()].sort(([a], [b]) => a.localeCompare(b)),
        autoLeg: this.mockAutoLegEnabled,
        rollBias: this.mockRollBias,
        roll: this.mockMotion.roll,
        height: this.mockMotion.height,
      });
      const unchanged = snapshot === this.mockSavedParameters;
      this.mockSavedParameters = snapshot;
      this.emitConsole("rx", unchanged ? "save: unchanged (no flash write)" : "save: ok (all motion parameters)");
      return;
    }
    if (command === "rollbias") {
      const raw = this.lastTelemetry.roll;
      this.emitConsole("rx", `rollbias base=${this.mockRollBias.toFixed(4)} raw=${raw.toFixed(4)} effective=${(raw + this.mockRollBias).toFixed(4)}`);
      return;
    }
    if (command.startsWith("rollbias ")) {
      this.mockRollBias = Number(command.slice(9));
      return;
    }
    const pid = /^(anglepid|velocitypid|differpid|rollpid) (-[pid]) (.+)$/.exec(command);
    if (pid) this.mockParameters.set(`${pid[1]} ${pid[2]}`, Number(pid[3]));
    if (command === "anglepid auto") this.mockParameters.set("anglepid auto", "on");
    if (pid?.[1] === "anglepid" && pid[2] === "-p") this.mockParameters.set("anglepid auto", "on");
    if (command.startsWith("anglebias ")) {
      this.mockParameters.set("anglebias", command === "anglebias auto" ? "auto" : Number(command.slice(10)));
    }
    if (command === "uid") {
      this.emitConsole("rx", "uid: 0123456789ABCDEF10203040");
      return;
    }
    if (command.startsWith("autoleg ")) {
      if (command === "autoleg on") this.mockAutoLegEnabled = true;
      if (command === "autoleg off") this.mockAutoLegEnabled = false;
      const value = this.mockAutoLegEnabled ? 1 : 0;
      this.emitConsole("rx", `autoleg: enabled=${value} active=${value}`);
      return;
    }
    const motion = /^R\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)$/i.exec(command);
    if (motion) {
      const values = motion.slice(1).map(Number);
      const [turn, velocity, roll, height] = values;
      if ([turn, velocity, roll, height].every((value) => value !== undefined && Number.isFinite(value))) {
        this.mockMotion = {
          turn: turn ?? 0,
          velocity: velocity ?? 0,
          roll: roll ?? 0,
          height: height ?? 61.5,
        };
      }
      return;
    }
    const legHeight = /^legheight\s+([+-]?[\d.]+)$/.exec(command);
    if (legHeight) {
      const height = Number(legHeight[1]);
      if (Number.isFinite(height)) this.mockMotion.height = height;
    }
    // 参数下发没有通用 ACK；只有明确支持回执的功能会产生 RX。
  }

  private async installTauriEvents(): Promise<void> {
    if (this.unlisteners.length > 0) return;
    if (this.installingEvents) return this.installingEvents;
    this.installingEvents = (async () => {
      const telemetryUnlisten = await listen<TelemetryPayload>("wl1://telemetry", ({ payload }) => {
        const eventSessionId = numeric(payload.sessionId ?? payload.session_id);
        if (eventSessionId === undefined || eventSessionId !== this.snapshot.sessionId) return;
        if (isRemoteConnection(this.snapshot)) return;
        const patch: Partial<TelemetrySample> = {};
        const timestamp = numeric(payload.timestamp);
        const roll = numeric(payload.roll);
        const pitch = numeric(payload.pitch);
        const yaw = numeric(payload.yaw);
        const imuTimestamp = nullableNumeric(payload.imuTimestamp !== undefined ? payload.imuTimestamp : payload.imu_timestamp);
        const rpmTimestamp = nullableNumeric(payload.rpmTimestamp !== undefined ? payload.rpmTimestamp : payload.rpm_timestamp);
        if (timestamp !== undefined) patch.timestamp = timestamp;
        if (roll !== undefined) patch.roll = roll;
        if (pitch !== undefined) patch.pitch = pitch;
        if (yaw !== undefined) patch.yaw = yaw;
        if (imuTimestamp !== undefined) patch.imuTimestamp = imuTimestamp ?? undefined;
        if (rpmTimestamp !== undefined) patch.rpmTimestamp = rpmTimestamp ?? undefined;
        const leftRpm = numeric(payload.leftRpm ?? payload.left_rpm);
        const rightRpm = numeric(payload.rightRpm ?? payload.right_rpm);
        const targetHeight = nullableNumeric(payload.targetHeight !== undefined ? payload.targetHeight : payload.target_height);
        const linkQuality = nullableNumeric(payload.linkQuality !== undefined ? payload.linkQuality : payload.link_quality);
        const batteryVoltage = nullableNumeric(payload.batteryVoltage !== undefined ? payload.batteryVoltage : payload.battery_voltage);
        const accelerationNormG = nullableNumeric(payload.accelerationNormG !== undefined ? payload.accelerationNormG : payload.acceleration_norm_g);
        const rawAccelerationTrusted = payload.accelerationTrusted !== undefined
          ? payload.accelerationTrusted
          : payload.acceleration_trusted;
        const accelerationTrusted = typeof rawAccelerationTrusted === "boolean"
          ? rawAccelerationTrusted
          : rawAccelerationTrusted === null
            ? null
            : undefined;
        if (leftRpm !== undefined) patch.leftRpm = leftRpm;
        if (rightRpm !== undefined) patch.rightRpm = rightRpm;
        if (targetHeight !== undefined) patch.targetHeight = targetHeight ?? undefined;
        if (linkQuality !== undefined) patch.linkQuality = linkQuality ?? undefined;
        if (batteryVoltage !== undefined) patch.batteryVoltage = batteryVoltage ?? undefined;
        if (accelerationNormG !== undefined) patch.accelerationNormG = accelerationNormG ?? undefined;
        if (accelerationTrusted !== undefined) patch.accelerationTrusted = accelerationTrusted ?? undefined;
        this.lastTelemetry = mergeTelemetrySample(this.lastTelemetry, patch);
        this.emit({ type: "telemetry", sample: { ...this.lastTelemetry } });
      });
      const lineUnlisten = await listen<string | SerialLinePayload>("wl1://console", ({ payload }) => {
        const normalized = typeof payload === "string" ? { text: payload } : payload;
        const eventSessionId = numeric(normalized.sessionId ?? normalized.session_id);
        if (eventSessionId === undefined || eventSessionId !== this.snapshot.sessionId) return;
        const text = normalized.text ?? "";
        this.emitConsole(normalized.direction ?? "rx", text, normalized.timestamp);
      });
      const disconnectUnlisten = await listen<DisconnectedPayload>("wl1://disconnected", ({ payload }) => {
        const eventSessionId = numeric(payload.sessionId ?? payload.session_id);
        if (eventSessionId === undefined) return;
        if (eventSessionId !== this.snapshot.sessionId) {
          if (this.connecting) this.pendingDisconnects.set(eventSessionId, payload);
          return;
        }
        // 仅释放产生该事件的会话；迟到的旧事件不得影响新连接。
        void invoke("disconnect_device", { expectedSessionId: eventSessionId }).catch(() => undefined);
        this.lastTelemetry = nowSample();
        this.snapshot = { mode: "disconnected", label: "未连接", telemetryEnabled: false, writesUnlocked: false };
        this.emit({ type: "disconnected", reason: payload.reason });
      });
      this.unlisteners.push(telemetryUnlisten, lineUnlisten, disconnectUnlisten);
    })().finally(() => {
      this.installingEvents = undefined;
    });
    return this.installingEvents;
  }

  private normalizePort(value: unknown): SerialPortOption {
    const port = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
    return {
      vid: numeric(port.vid),
      pid: numeric(port.pid),
      name: String(port.name ?? port.port_name ?? port.path ?? "未知串口"),
      portType: String(port.portType ?? port.port_type ?? port.type ?? "Serial"),
      manufacturer: typeof port.manufacturer === "string" ? port.manufacturer : undefined,
      product: typeof port.product === "string" ? port.product : undefined,
      serialNumber: typeof port.serialNumber === "string"
        ? port.serialNumber
        : typeof port.serial_number === "string"
          ? port.serial_number
          : undefined,
    };
  }
}

export const deviceGateway = new DeviceGateway();

export function motionCommand(target: MotionTarget): string {
  return buildMotionCommand(target);
}
