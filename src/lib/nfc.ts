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

/**
 * True when a dump still contains units the reader could not open, which is
 * what a write should warn about before touching a new card.
 */
export function dumpGaps(dump: CardDump): number {
  return dump.units.filter((unit) => !unit.data).length;
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
