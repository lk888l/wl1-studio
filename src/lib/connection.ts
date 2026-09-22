import type { ConnectionSnapshot } from "../types";

/** Missing targets in older snapshots retain the direct robot behavior. */
export function isRemoteConnection(connection: ConnectionSnapshot): boolean {
  return connection.mode === "serial" && connection.connectionTarget === "remote";
}

export function isBluetoothConnection(connection: ConnectionSnapshot): boolean {
  return connection.mode === "ble";
}

export const BLUETOOTH_COMMAND_INTERVAL_MS = 100;

export const REMOTE_COMMAND_INTERVAL_MS = 120;
export const REMOTE_MOTION_UNAVAILABLE = "遥控器模式由实体摇杆控制运动和腿高；请直连小车使用上位机实时控制。";
export const REMOTE_TELEMETRY_UNAVAILABLE = "当前遥控器桥接固件仅支持下行调参，没有小车遥测回传；请直连小车查看 IMU / RPM。";
