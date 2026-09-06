export type PageId =
  | "overview"
  | "kinematics"
  | "tuning"
  | "control"
  | "calibration"
  | "personalization"
  | "diagnostics";

export type ConnectionMode = "disconnected" | "mock" | "serial";
export type ConnectionTarget = "robot" | "remote";

export interface SerialPortOption {
  name: string;
  portType: string;
  vid?: number;
  pid?: number;
  manufacturer?: string;
  product?: string;
  serialNumber?: string;
}

export interface SerialConfig {
  mode: "mock" | "serial";
  connectionTarget?: ConnectionTarget;
  portName?: string;
  baudRate: number;
  allowUnsafeWrites: boolean;
}

export interface ConnectionSnapshot {
  mode: ConnectionMode;
  connectionTarget?: ConnectionTarget;
  label: string;
  sessionId?: number;
  connectedAt?: number;
  baudRate?: number;
  telemetryEnabled: boolean;
  writesUnlocked: boolean;
}

export interface TelemetrySample {
  timestamp: number;
  imuTimestamp?: number;
  rpmTimestamp?: number;
  roll: number;
  pitch: number;
  yaw: number;
  leftRpm: number;
  rightRpm: number;
  targetHeight?: number;
  linkQuality?: number;
  batteryVoltage?: number;
  accelerationNormG?: number;
  accelerationTrusted?: boolean;
}

export interface TelemetrySubscription {
  imu: boolean;
  rpm: boolean;
}

export type ConsoleDirection = "rx" | "tx" | "system";

export interface ConsoleEntry {
  id: string;
  timestamp: number;
  direction: ConsoleDirection;
  text: string;
}

export type ParameterGroupId = "attitude" | "velocity" | "steering" | "roll" | "geometry";
export type ParameterSupport = "supported" | "derived" | "reserved";

export interface ParameterDefinition {
  id: string;
  group: ParameterGroupId;
  label: string;
  symbol: string;
  description: string;
  unit?: string;
  min: number;
  max: number;
  step: number;
  defaultValue: number;
  decimals: number;
  support: ParameterSupport;
  command?: string;
  flag?: "p" | "i" | "d";
  warning?: string;
}

export type ParameterValues = Record<string, number>;

export interface ParameterProfile {
  id: string;
  name: string;
  description: string;
  updatedAt: number;
  values: ParameterValues;
  builtIn?: boolean;
}

export interface DeviceCapabilities {
  protocolVersion: number;
  firmwareLabel: string;
  supported: string[];
  reserved: string[];
}

export type DeviceEvent =
  | { type: "telemetry"; sample: TelemetrySample }
  | { type: "console"; entry: ConsoleEntry }
  | { type: "disconnected"; reason?: string };

export interface MotionTarget {
  turn: number;
  velocity: number;
  roll: number;
  height: number;
}

export interface PersonalizationSettings {
  accent: "azure" | "violet" | "coral" | "mint";
  glassStrength: "soft" | "balanced" | "clear";
  reducedMotion: boolean;
  compactTelemetry: boolean;
  robotName: string;
  ledColor: string;
  bootPose: "balanced" | "low" | "last";
}

export interface CalibrationDraft {
  imuRollBias: number;
  imuPitchBias: number;
  imuYawBias: number;
  angleBias: number;
  legHeight: number;
  updatedAt?: number;
}
