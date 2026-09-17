import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { SerialPortOption } from "../types";
import { deviceGateway, isTauriRuntime } from "./device";

export type CardKind = "classic1k" | "classic4k" | "ultralight" | "iso14443_4" | "unknown";
export type KeySource = "dictionary" | "harvested" | "manual" | "none";

export interface NfcSnapshot {
  mode: "serial" | "disconnected";
  label: string;
  sessionId?: number;
  connectedAt?: number;
  firmware?: string;
  busy: boolean;
}

export interface DataUnit {
  index: number;
  sector: number;
  /** Hex payload. Absent when the block could not be read. */
  data?: string;
  error?: string;
  isTrailer: boolean;
  isManufacturer: boolean;
}

export interface SectorDump {
  index: number;
  firstBlock: number;
  blockCount: number;
  trailerBlock: number;
  keyA?: string;
  keyB?: string;
  keySource: KeySource;
  resolved: boolean;
  /** Raw `C1C2C3` triplets, one per block. Not a permissions summary. */
  accessSummary?: string;
  message?: string;
}

export interface CardDump {
  uid: string;
  atqa: string;
  sak: number;
  kind: CardKind;
  label: string;
  /** 16 for Classic blocks, 4 for Ultralight pages. */
  unitSize: number;
  units: DataUnit[];
  sectors: SectorDump[];
  readAt: number;
  durationMs: number;
  unresolvedSectors: number;
  warnings: string[];
}

export interface WriteReport {
  uid: string;
  blocksWritten: number;
  blocksFailed: number;
  /** Deliberately not written. A refusal by design, not an error. */
  blocksSkipped: number;
  sectorsWritten: number;
  verified: boolean;
  blocksVerified: number;
  verificationFailures: string[];
  uidMatches: boolean;
  completeCopy: boolean;
  manufacturerBlockWritten?: boolean;
  durationMs: number;
  failures: string[];
  skips: string[];
  warnings: string[];
}

export interface NfcProgress {
  phase: string;
  current: number;
  total: number;
  message: string;
}

export interface SectorKeyOverride {
  sector: number;
  key: string;
  keyB: boolean;
}

export interface ReadOptions {
  extraKeys: string[];
  sectorKeys: SectorKeyOverride[];
}

export interface WriteOptions {
  writeManufacturerBlock: boolean;
  allowSameUid: boolean;
  writeTrailers: boolean;
  verify: boolean;
  sectors: number[];
  targetKeys: string[];
}

export type NfcEvent =
  | { type: "snapshot"; snapshot: NfcSnapshot }
  | { type: "progress"; sessionId: number; timestamp: number; progress: NfcProgress }
  | { type: "disconnected"; sessionId: number; timestamp: number; reason: string };

interface BackendEvent {
  sessionId: number;
  timestamp: number;
  kind: "progress" | "disconnected";
  progress?: NfcProgress;
  reason?: string;
}

const disconnected = (): NfcSnapshot => ({
  mode: "disconnected",
  label: "读卡器未连接",
  busy: false,
});

export const emptyReadOptions = (): ReadOptions => ({ extraKeys: [], sectorKeys: [] });

export const defaultWriteOptions = (): WriteOptions => ({
  // Off by default: a genuine card rejects it and a UID card accepts a value
  // that can render the clone unusable if the source UID was misread.
  writeManufacturerBlock: false,
  allowSameUid: false,
  writeTrailers: true,
  verify: true,
  sectors: [],
  targetKeys: [],
});

/** Formats a hex payload as `16 字节` pairs, lowercased for density. */
export function hexPairs(hex: string): string[] {
  const pairs: string[] = [];
  for (let index = 0; index + 1 < hex.length; index += 2) {
    pairs.push(hex.slice(index, index + 2).toUpperCase());
  }
  return pairs;
}

/** Printable ASCII for a hex payload; unprintable bytes become `.`. */
export function hexToAscii(hex: string): string {
  return hexPairs(hex)
    .map((pair) => {
      const code = Number.parseInt(pair, 16);
      return code >= 0x20 && code < 0x7f ? String.fromCharCode(code) : ".";
    })
    .join("");
}

export function formatUid(uid: string): string {
  return hexPairs(uid).join(" ");
}

/** Splits a flat UID into the blocks that hold it, for display. */
export function byteLength(hex: string): number {
  return Math.floor(hex.length / 2);
}

/** Counts unread blocks, including addresses absent from an imported backup. */
export function dumpGaps(dump: CardDump): number {
  const total = dump.kind === "classic1k" ? 64 : dump.kind === "classic4k" ? 256 : dump.units.length;
  const readable = new Set(dump.units.filter((unit) => unit.data?.length === dump.unitSize * 2).map((unit) => unit.index));
  return Math.max(0, total - readable.size);
}

export function missingKeySectors(dump: CardDump): SectorDump[] {
  return dump.sectors.filter((sector) => !sector.keyA || !sector.keyB);
}

export function readSummary(dump: CardDump): string {
  if (dump.kind === "ultralight") return `已记录 ${dump.units.length} 页，其中 ${dumpGaps(dump)} 页未读取。Type 2 型号与受保护区域限制请查看备份提示。`;
  const gaps = dumpGaps(dump);
  const keys = missingKeySectors(dump).length;
  return `已读取 ${dump.label}，UID ${formatUid(dump.uid)}。` +
    (gaps || keys ? `仍缺 ${gaps} 个块、${keys} 个扇区的密钥；尚不具备完整复制条件。` : "所有数据块和扇区密钥已取得；目标 UID 与写权限仍需确认。");
}

/** Validate imports before they enter UI state; native code validates again before RF writes. */
export function parseCardDump(text: string): CardDump {
  const value: unknown = JSON.parse(text);
  const fail = (): never => { throw new Error("备份结构或数据无效，请导入完整的本工具 JSON 备份（未读块应保留为空）"); };
  if (!value || typeof value !== "object") return fail();
  const d = value as CardDump;
  const hex = (value: unknown, bytes: number): value is string => typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "i").test(value);
  const classic = d.kind === "classic1k" || d.kind === "classic4k";
  if ((!classic && d.kind !== "ultralight") || (!hex(d.uid, 4) && !hex(d.uid, 7)) || !hex(d.atqa, 2)
      || d.sak !== (d.kind === "classic1k" ? 8 : d.kind === "classic4k" ? 24 : 0)
      || d.unitSize !== (classic ? 16 : 4) || typeof d.label !== "string"
      || !Array.isArray(d.units) || !Array.isArray(d.sectors) || !Array.isArray(d.warnings)
      || !d.warnings.every((warning) => typeof warning === "string")
      || !Number.isFinite(d.readAt) || !Number.isFinite(d.durationMs)) return fail();
  const total = d.kind === "classic1k" ? 64 : d.kind === "classic4k" ? 256 : d.units.length;
  if (!total || total > 256 || d.units.length !== total) return fail();
  const seen = new Set<number>();
  for (const unit of d.units) {
    if (!unit || !Number.isInteger(unit.index) || unit.index < 0 || unit.index >= total || seen.has(unit.index)
        || (unit.data != null && !hex(unit.data, d.unitSize))) return fail();
    seen.add(unit.index);
    unit.sector = classic ? (unit.index < 128 ? Math.floor(unit.index / 4) : 32 + Math.floor((unit.index - 128) / 16)) : 0;
    unit.isTrailer = classic && (unit.index < 128 ? unit.index % 4 === 3 : unit.index % 16 === 15);
    unit.isManufacturer = classic ? unit.index === 0 : unit.index < 3;
  }
  const count = d.kind === "classic1k" ? 16 : d.kind === "classic4k" ? 40 : 0;
  if (d.sectors.length !== count) return fail();
  seen.clear();
  for (const sector of d.sectors) {
    if (!sector || !Number.isInteger(sector.index) || sector.index < 0 || sector.index >= count || seen.has(sector.index)) return fail();
    seen.add(sector.index);
    const first = sector.index < 32 ? sector.index * 4 : 128 + (sector.index - 32) * 16;
    const blocks = sector.index < 32 ? 4 : 16;
    if (sector.firstBlock !== first || sector.blockCount !== blocks || sector.trailerBlock !== first + blocks - 1
        || (sector.keyA != null && !hex(sector.keyA, 6)) || (sector.keyB != null && !hex(sector.keyB, 6))
        || typeof sector.resolved !== "boolean" || !["dictionary", "harvested", "manual", "none"].includes(sector.keySource)
        || (sector.accessSummary != null && typeof sector.accessSummary !== "string")
        || (sector.message != null && typeof sector.message !== "string")) return fail();
  }
  d.unresolvedSectors = d.sectors.filter((sector) => !sector.resolved).length;
  return d;
}

export function downloadCardDump(dump: CardDump): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(dump, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `nfc-${dump.uid}-${dump.readAt}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export class NfcGateway {
  private snapshot = disconnected();
  private dump: CardDump | null = null;
  private report: WriteReport | null = null;
  private readonly listeners = new Set<(event: NfcEvent) => void>();
  private eventInstallation?: Promise<void>;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private pending: BackendEvent[] | undefined;

  get connection(): NfcSnapshot {
    return { ...this.snapshot };
  }
  get lastDump(): CardDump | null {
    return this.dump;
  }
  get lastReport(): WriteReport | null {
    return this.report;
  }
  setDump(dump: CardDump | null): void {
    this.dump = dump;
    this.emit({ type: "snapshot", snapshot: this.connection });
  }
  setReport(report: WriteReport | null): void {
    this.report = report;
  }

  subscribe(listener: (event: NfcEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: NfcEvent): void {
    this.listeners.forEach((listener) => {
      listener(event);
    });
  }

  private update(snapshot: NfcSnapshot): NfcSnapshot {
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
      this.eventInstallation = listen<BackendEvent>("nfc:event", ({ payload }) => {
        if (this.pending) {
          // A worker can emit before the connect IPC response reaches the
          // WebView. Buffer so those events are replayed against the session id
          // the connect call is about to return.
          if (this.pending.length >= 256) this.pending.shift();
          this.pending.push(payload);
        } else this.accept(payload);
      })
        .then(() => undefined)
        .catch((error: unknown) => {
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
      this.emit({
        type: "disconnected",
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        reason: event.reason ?? "未知原因",
      });
      return;
    }
    if (event.progress) {
      this.emit({
        type: "progress",
        sessionId: event.sessionId,
        timestamp: event.timestamp,
        progress: event.progress,
      });
    }
  }

  private async close(all = false): Promise<NfcSnapshot> {
    if (isTauriRuntime() && (all || this.snapshot.mode === "serial")) {
      await invoke<NfcSnapshot>("nfc_disconnect", {
        expectedSessionId: all ? null : this.snapshot.sessionId,
      });
    }
    return this.update(disconnected());
  }

  initialize(): Promise<NfcSnapshot> {
    return this.serialize(async () => {
      await this.installEvents();
      return this.close(true);
    });
  }

  listSerialPorts(): Promise<SerialPortOption[]> {
    return deviceGateway.listSerialPorts();
  }

  connect(portName: string): Promise<NfcSnapshot> {
    return this.serialize(async () => {
      if (!isTauriRuntime()) {
        throw new Error("读卡器需要桌面应用；浏览器中无法访问串口。");
      }
      if (!portName.trim()) throw new Error("请选择读卡器串口。");
      await this.installEvents();
      await this.close();
      this.pending = [];
      try {
        const snapshot = await invoke<NfcSnapshot>("nfc_connect", { portName });
        this.update(snapshot);
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

  disconnect(): Promise<NfcSnapshot> {
    return this.serialize(() => this.close());
  }

  cancel(): Promise<void> {
    if (!isTauriRuntime()) return Promise.resolve();
    return invoke<void>("nfc_cancel").catch(() => undefined);
  }

  readCard(options: ReadOptions): Promise<CardDump> {
    return this.serialize(async () => {
      if (!isTauriRuntime()) throw new Error("读取卡片需要桌面应用。");
      const dump = await invoke<CardDump>("nfc_read_card", { options });
      this.dump = dump;
      this.report = null;
      return dump;
    });
  }

  writeCard(dump: CardDump, options: WriteOptions): Promise<WriteReport> {
    return this.serialize(async () => {
      if (!isTauriRuntime()) throw new Error("写入卡片需要桌面应用。");
      const report = await invoke<WriteReport>("nfc_write_card", { dump, options });
      this.report = report;
      return report;
    });
  }
}

export const nfcGateway = new NfcGateway();
