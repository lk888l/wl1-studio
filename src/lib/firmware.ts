import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./device";
import { GAMEBOX_APPLICATION_BYTES } from "./gamebox-firmware";

export const FLASH_START = 0x08000000;
export const MAX_FIRMWARE_SIZE = 16 * 1024 * 1024;
export const FLASH_PAGE_SIZE = 256;
export type FirmwareChip = "auto" | "stm32f411ceu" | "stm32f103c8t6" | "stm32f103cbt6" | "stm32g431cbu6";
export type FirmwareProduct = "wl1" | "gamebox" | "sticks3";
export type FirmwareFormat = "bin" | "hex" | "elf";

export const FIRMWARE_TARGETS = {
  wl1: { chip: "stm32f411ceu", label: "STM32F411CEU", flashSize: 512 * 1024, programSize: 512 * 1024, canErase: true, backupPrefix: "WL1" },
  gamebox: { chip: "stm32f103c8t6", label: "STM32F103C8T6", flashSize: 64 * 1024, programSize: GAMEBOX_APPLICATION_BYTES, canErase: false, backupPrefix: "GameBox" },
  sticks3: { chip: "auto", label: "自动识别 STM32", flashSize: null, programSize: null, canErase: true, backupPrefix: "SWD" },
} as const satisfies Record<FirmwareProduct, FirmwareTarget>;

export interface FirmwareTarget {
  chip: FirmwareChip;
  label: string;
  flashSize: number | null;
  programSize: number | null;
  canErase: boolean;
  backupPrefix: string;
}

export function resolveFirmwareTarget(product: FirmwareProduct, detected: ChipInfo | null): FirmwareTarget {
  const profile = FIRMWARE_TARGETS[product];
  if (product !== "sticks3" || !detected) return profile;
  return { ...profile, label: detected.name, flashSize: detected.flashSize, programSize: detected.flashSize, backupPrefix: detected.name };
}

export interface ProbeOption {
  id: string;
  name: string;
  serialNumber: string | null;
  accessible: boolean;
}

export interface ProbeConfig {
  probeId: string;
  chip: FirmwareChip;
  speedKhz: number;
  connectUnderReset: boolean;
  expectedTarget?: Pick<ChipInfo, "deviceId" | "flashSize" | "uid">;
}

export interface FirmwareImage {
  format: FirmwareFormat;
  data: number[];
  baseAddress: number;
  chip: FirmwareChip;
}

export interface ImageSummary {
  fileSize: number;
  programmedSize: number;
  sha256: string;
  regions: Array<{ address: number; length: number }>;
}

export interface FirmwareStatus {
  busy: boolean;
  stage: string;
  message: string;
  completed: number;
  total: number | null;
}

export interface ChipInfo {
  name: string;
  target: string;
  deviceId: number;
  revisionId: number;
  flashStart: number;
  flashSize: number;
  uid: string;
  speedKhz: number;
  probeId: string;
}

export function sameFlashTarget(a: ChipInfo, b: ChipInfo): boolean {
  return a.probeId === b.probeId && a.deviceId === b.deviceId && a.flashSize === b.flashSize && a.uid === b.uid;
}

export function firmwareImageRangeError(summary: ImageSummary, flashSize: number | null): string | null {
  if (flashSize === null) return null;
  if (summary.regions.some(({ address, length }) => address < FLASH_START || !Number.isSafeInteger(address + length) || address + length > FLASH_START + flashSize)) {
    return `文件写入范围超出实测 ${flashSize / 1024} KiB Flash（结束地址 ${hexAddress(FLASH_START + flashSize - 1)}）。请选择适合此容量的固件。`;
  }
  return null;
}

export interface FirmwareReport {
  chip: ChipInfo;
  message: string;
  bytes: number;
  sha256: string | null;
  data: number[] | null;
}

export interface UsbSupport {
  platform: string;
  canInstall: boolean;
  description: string;
  license: string;
}

async function desktop<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauriRuntime()) throw new Error("SWD 烧录器需要桌面应用；浏览器预览不能访问 USB 或烧录固件。");
  return invoke<T>(command, args);
}

export const firmwareApi = {
  status: () => desktop<FirmwareStatus>("firmware_status"),
  listProbes: () => desktop<ProbeOption[]>("firmware_list_probes"),
  inspect: (image: FirmwareImage) => desktop<ImageSummary>("firmware_inspect", { image }),
  read: (config: ProbeConfig) => desktop<FirmwareReport>("firmware_read", { config }),
  identify: (config: ProbeConfig) => desktop<FirmwareReport>("firmware_identify", { config }),
  reset: (config: ProbeConfig) => desktop<FirmwareReport>("firmware_reset", { config }),
  verify: (config: ProbeConfig, image: FirmwareImage) => desktop<FirmwareReport>("firmware_verify", { config, image }),
  erase: (config: ProbeConfig, confirmation: string) => desktop<FirmwareReport>("firmware_erase", { config, confirmation }),
  flash: (config: ProbeConfig, image: FirmwareImage, confirmedSha256: string) => desktop<FirmwareReport>("firmware_flash", { config, image, confirmedSha256 }),
  usbSupport: (sticks3 = false) => desktop<UsbSupport>("firmware_usb_support", sticks3 ? { sticks3 } : undefined),
  installUsbSupport: (sticks3 = false) => desktop<string>("firmware_install_usb_support", { confirmed: true, ...(sticks3 ? { sticks3 } : {}) }),
};

export function firmwareFormat(name: string): FirmwareFormat {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "bin" || extension === "hex" || extension === "elf") return extension;
  if (extension === "axf") return "elf";
  throw new Error("请选择 .bin、.hex、.elf 或 .axf 固件文件。");
}

export function parseFlashAddress(text: string, size: number): number {
  if (!/^(?:0x)?[0-9a-f]{1,8}$/i.test(text.trim())) throw new Error("请输入十六进制地址，例如 0x08000000。");
  const value = Number.parseInt(text.trim().replace(/^0x/i, ""), 16);
  if (value < FLASH_START || value >= FLASH_START + size) throw new Error("地址超出主 Flash 范围。");
  return value;
}

export function hexAddress(address: number): string {
  return `0x${address.toString(16).toUpperCase().padStart(8, "0")}`;
}

export function flashRows(data: readonly number[], page: number): Array<{ address: string; hex: string; ascii: string }> {
  const start = Math.max(0, Math.floor(page)) * FLASH_PAGE_SIZE;
  const rows = [];
  for (let offset = start; offset < Math.min(start + FLASH_PAGE_SIZE, data.length); offset += 16) {
    const bytes = data.slice(offset, offset + 16);
    rows.push({
      address: hexAddress(FLASH_START + offset),
      hex: bytes.map((byte) => byte.toString(16).toUpperCase().padStart(2, "0")).join(" "),
      ascii: bytes.map((byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : ".").join(""),
    });
  }
  return rows;
}

export function downloadFlash(data: readonly number[], filename: string): void {
  const url = URL.createObjectURL(new Blob([Uint8Array.from(data)], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
