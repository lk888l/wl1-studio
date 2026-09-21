import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./device";
import { GAMEBOX_APPLICATION_BYTES } from "./gamebox-firmware";

export const FLASH_START = 0x08000000;
export const MAX_FIRMWARE_SIZE = 16 * 1024 * 1024;
export const FLASH_PAGE_SIZE = 256;
export type FirmwareChip = "stm32f411ceu" | "stm32f103c8t6";
export type FirmwareProduct = "wl1" | "gamebox";
export type FirmwareFormat = "bin" | "hex" | "elf";

export const FIRMWARE_TARGETS = {
  wl1: { chip: "stm32f411ceu", label: "STM32F411CEU", flashSize: 512 * 1024, programSize: 512 * 1024, canErase: true, backupPrefix: "WL1" },
  gamebox: { chip: "stm32f103c8t6", label: "STM32F103C8T6", flashSize: 64 * 1024, programSize: GAMEBOX_APPLICATION_BYTES, canErase: false, backupPrefix: "GameBox" },
} as const satisfies Record<FirmwareProduct, {
  chip: FirmwareChip; label: string; flashSize: number; programSize: number; canErase: boolean; backupPrefix: string;
}>;

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
  deviceId: number;
  revisionId: number;
  flashStart: number;
  flashSize: number;
  uid: string;
  speedKhz: number;
  probeId: string;
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
  if (!isTauriRuntime()) throw new Error("ST-Link 需要桌面应用；浏览器预览不能访问 USB 或烧录固件。");
  return invoke<T>(command, args);
}

export const firmwareApi = {
  status: () => desktop<FirmwareStatus>("firmware_status"),
  listProbes: () => desktop<ProbeOption[]>("firmware_list_probes"),
  inspect: (image: FirmwareImage) => desktop<ImageSummary>("firmware_inspect", { image }),
  read: (config: ProbeConfig) => desktop<FirmwareReport>("firmware_read", { config }),
  erase: (config: ProbeConfig, confirmation: string) => desktop<FirmwareReport>("firmware_erase", { config, confirmation }),
  flash: (config: ProbeConfig, image: FirmwareImage, confirmedSha256: string) => desktop<FirmwareReport>("firmware_flash", { config, image, confirmedSha256 }),
  usbSupport: () => desktop<UsbSupport>("firmware_usb_support"),
  installUsbSupport: () => desktop<string>("firmware_install_usb_support", { confirmed: true }),
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
