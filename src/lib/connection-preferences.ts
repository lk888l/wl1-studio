import type { ConnectionChoice, SerialPortOption } from "../types";
import { getStoredItem, registerStorageValidator, setStoredItem } from "./user-storage";

const CONNECTION_KEY = "wl1-studio.connection.v1";

export interface ConnectionPreferences {
  target: Exclude<ConnectionChoice, "mock">;
  portName: string;
  baudRate: 9600 | 115200;
  bleDeviceId: string;
}

export function sanitizeConnectionPreferences(value: unknown): ConnectionPreferences {
  const candidate = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    target: candidate.target === "remote" || candidate.target === "ble" ? candidate.target : "robot",
    portName: typeof candidate.portName === "string" && candidate.portName.length <= 256
      ? candidate.portName.trim()
      : "",
    baudRate: candidate.baudRate === 9600 ? 9600 : 115200,
    bleDeviceId: typeof candidate.bleDeviceId === "string" && candidate.bleDeviceId.length <= 256 ? candidate.bleDeviceId : "",
  };
}

export function loadConnectionPreferences(): ConnectionPreferences {
  try {
    return sanitizeConnectionPreferences(JSON.parse(getStoredItem(CONNECTION_KEY) ?? "{}"));
  } catch {
    return sanitizeConnectionPreferences(null);
  }
}

export function saveConnectionPreferences(preferences: ConnectionPreferences): Promise<boolean> {
  return setStoredItem(CONNECTION_KEY, JSON.stringify(sanitizeConnectionPreferences(preferences)));
}

registerStorageValidator(CONNECTION_KEY, sanitizeConnectionPreferences);

/** Select a known port or the sole available port; ambiguous lists require a choice. */
export function selectAvailablePort(
  ports: readonly SerialPortOption[],
  currentPort: string,
  preferredPort: string,
): string {
  if (ports.some((port) => port.name === currentPort)) return currentPort;
  if (ports.some((port) => port.name === preferredPort)) return preferredPort;
  return ports.length === 1 ? ports[0]?.name ?? "" : "";
}
