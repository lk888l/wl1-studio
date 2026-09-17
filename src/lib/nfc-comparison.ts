import type { CardDump, DataUnit } from "./nfc";

export type ComparisonStatus = "equal" | "different" | "unknown";
export type ComparisonSide = "a" | "b";
export type ComparisonByte = string | null;

export interface ComparisonEntry {
  id: number;
  name: string;
  source: string;
  dump: CardDump;
}

export interface ComparisonWorkspace {
  entries: ComparisonEntry[];
  a: number | null;
  b: number | null;
  nextId: number;
}

export type ComparisonAction =
  | { type: "add"; entries: { dump: CardDump; source: string; name?: string }[] }
  | { type: "select"; side: ComparisonSide; id: number | null }
  | { type: "remove"; id: number }
  | { type: "swap" }
  | { type: "clear" };

export const emptyComparisonWorkspace = (): ComparisonWorkspace => ({ entries: [], a: null, b: null, nextId: 1 });

/** Keep independent snapshots: another read, import or source edit must not alter the baseline. */
export function comparisonReducer(state: ComparisonWorkspace, action: ComparisonAction): ComparisonWorkspace {
  switch (action.type) {
    case "add": {
      const added = action.entries.map((entry, offset) => ({
        id: state.nextId + offset,
        name: entry.name || `卡片记录 ${state.nextId + offset}`,
        source: entry.source,
        dump: structuredClone(entry.dump),
      }));
      let { a, b } = state;
      for (const entry of added) {
        if (a === null) a = entry.id;
        else if (b === null) b = entry.id;
      }
      return { entries: [...state.entries, ...added], a, b, nextId: state.nextId + added.length };
    }
    case "select": {
      if (action.id !== null && !state.entries.some((entry) => entry.id === action.id)) return state;
      const other = action.side === "a" ? "b" : "a";
      // Selecting the other side's card exchanges the two selections.
      return { ...state, [action.side]: action.id, [other]: action.id !== null && state[other] === action.id ? state[action.side] : state[other] };
    }
    case "remove":
      return { ...state, entries: state.entries.filter((entry) => entry.id !== action.id), a: state.a === action.id ? null : state.a, b: state.b === action.id ? null : state.b };
    case "swap":
      return { ...state, a: state.b, b: state.a };
    case "clear":
      return { ...state, entries: [], a: null, b: null };
  }
}

export interface ComparedField {
  label: string;
  a: string | null;
  b: string | null;
  status: ComparisonStatus;
}

export interface ComparedUnit {
  index: number;
  sector: number | null;
  kind: "data" | "trailer" | "manufacturer";
  a: ComparisonByte[];
  b: ComparisonByte[];
  changedOffsets: number[];
  unknownOffsets: number[];
  status: ComparisonStatus;
}

export interface DumpComparison {
  compatible: boolean;
  metadata: ComparedField[];
  units: ComparedUnit[];
  keys: (ComparedField & { sector: number })[];
  equalUnits: number;
  differentUnits: number;
  incompleteUnits: number;
  differentBytes: number;
  status: ComparisonStatus;
}

function compareField(label: string, a: string | null, b: string | null): ComparedField {
  return { label, a, b, status: a === null || b === null ? "unknown" : a === b ? "equal" : "different" };
}

function knownHex(value: string | undefined, bytes: number): string | null {
  return value && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "i").test(value) ? value.toUpperCase() : null;
}

function bytesOf(value: string | null, size: number): ComparisonByte[] {
  return Array.from({ length: size }, (_, index) => value?.slice(index * 2, index * 2 + 2) ?? null);
}

function unitCount(dump: CardDump): number {
  if (dump.kind === "classic1k") return 64;
  if (dump.kind === "classic4k") return 256;
  return Math.max(dump.units.length, ...dump.units.map((unit) => unit.index + 1));
}

function sectorOf(index: number): number {
  return index < 128 ? Math.floor(index / 4) : 32 + Math.floor((index - 128) / 16);
}

/** Use confirmed keys rather than raw, masked trailer bytes; unknown keys stay unknown. */
function comparisonBytes(dump: CardDump, unit: DataUnit | undefined, trailer: boolean, sector: number | null): ComparisonByte[] {
  const raw = bytesOf(knownHex(unit?.data, dump.unitSize), dump.unitSize);
  if (!trailer) return raw;
  const keys = dump.sectors.find((entry) => entry.index === sector);
  return [
    ...bytesOf(knownHex(keys?.keyA, 6), 6),
    ...raw.slice(6, 10),
    ...bytesOf(knownHex(keys?.keyB, 6), 6),
  ];
}

/** Compare recorded contents by address; capture time and diagnostics are not card contents. */
export function compareCardDumps(a: CardDump, b: CardDump): DumpComparison {
  const classic = a.kind === "classic1k" || a.kind === "classic4k";
  const compatible = a.kind === b.kind && a.unitSize === b.unitSize
    && (classic ? a.unitSize === 16 : a.kind === "ultralight" && a.unitSize === 4);
  const metadata = [
    compareField("UID", a.uid.toUpperCase(), b.uid.toUpperCase()),
    compareField("ATQA", a.atqa.toUpperCase(), b.atqa.toUpperCase()),
    compareField("SAK", a.sak.toString(16).toUpperCase().padStart(2, "0"), b.sak.toString(16).toUpperCase().padStart(2, "0")),
    compareField("卡型", a.kind, b.kind),
    compareField("块 / 页字节数", String(a.unitSize), String(b.unitSize)),
    compareField("记录地址数", String(unitCount(a)), String(unitCount(b))),
  ];
  const units: ComparedUnit[] = [];
  const keys: DumpComparison["keys"] = [];
  if (compatible) {
    const aUnits = new Map(a.units.map((unit) => [unit.index, unit]));
    const bUnits = new Map(b.units.map((unit) => [unit.index, unit]));
    for (let index = 0; index < Math.max(unitCount(a), unitCount(b)); index++) {
      const sector = classic ? sectorOf(index) : null;
      const trailer = classic && (index < 128 ? index % 4 === 3 : index % 16 === 15);
      const left = comparisonBytes(a, aUnits.get(index), trailer, sector);
      const right = comparisonBytes(b, bUnits.get(index), trailer, sector);
      const changedOffsets: number[] = [];
      const unknownOffsets: number[] = [];
      for (let offset = 0; offset < a.unitSize; offset++) {
        if (left[offset] == null || right[offset] == null) unknownOffsets.push(offset);
        else if (left[offset] !== right[offset]) changedOffsets.push(offset);
      }
      units.push({
        index, sector, a: left, b: right, changedOffsets, unknownOffsets,
        kind: trailer ? "trailer" : (classic ? index === 0 : index < 3) ? "manufacturer" : "data",
        status: changedOffsets.length ? "different" : unknownOffsets.length ? "unknown" : "equal",
      });
    }
    const sectorCount = a.kind === "classic1k" ? 16 : a.kind === "classic4k" ? 40 : 0;
    for (let sector = 0; sector < sectorCount; sector++) {
      const left = a.sectors.find((entry) => entry.index === sector);
      const right = b.sectors.find((entry) => entry.index === sector);
      for (const key of ["keyA", "keyB"] as const) {
        keys.push({ sector, ...compareField(key === "keyA" ? "Key A" : "Key B", knownHex(left?.[key], 6), knownHex(right?.[key], 6)) });
      }
    }
  }
  const differentUnits = units.filter((unit) => unit.status === "different").length;
  const incompleteUnits = units.filter((unit) => unit.unknownOffsets.length > 0).length;
  const different = metadata.some((field) => field.status === "different") || differentUnits > 0;
  return {
    compatible, metadata, units, keys,
    equalUnits: units.filter((unit) => unit.status === "equal").length,
    differentUnits, incompleteUnits,
    differentBytes: units.reduce((count, unit) => count + unit.changedOffsets.length, 0),
    status: different ? "different" : !compatible || !units.length || incompleteUnits > 0 ? "unknown" : "equal",
  };
}
