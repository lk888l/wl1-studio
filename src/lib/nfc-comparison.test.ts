import { describe, expect, it } from "vitest";

import { parseCardDump, type CardDump } from "./nfc";
import { compareCardDumps, comparisonReducer, emptyComparisonWorkspace } from "./nfc-comparison";

function classic(kind: "classic1k" | "classic4k" = "classic1k"): CardDump {
  const sectorCount = kind === "classic1k" ? 16 : 40;
  const units = kind === "classic1k" ? 64 : 256;
  return {
    uid: "11223344", atqa: "0400", sak: kind === "classic1k" ? 8 : 24, kind,
    label: kind, unitSize: 16, readAt: 1000, durationMs: 10, unresolvedSectors: 0, warnings: [],
    units: Array.from({ length: units }, (_, index) => ({
      index, sector: index < 128 ? Math.floor(index / 4) : 32 + Math.floor((index - 128) / 16),
      isManufacturer: index === 0, isTrailer: index < 128 ? index % 4 === 3 : index % 16 === 15,
      data: (index < 128 ? index % 4 === 3 : index % 16 === 15) ? "000000000000FF078000000000000000" : "00".repeat(16),
    })),
    sectors: Array.from({ length: sectorCount }, (_, index) => {
      const firstBlock = index < 32 ? index * 4 : 128 + (index - 32) * 16;
      const blockCount = index < 32 ? 4 : 16;
      return { index, firstBlock, blockCount, trailerBlock: firstBlock + blockCount - 1,
        keyA: "A0A1A2A3A4A5", keyB: "FFFFFFFFFFFF", keySource: "dictionary", resolved: true };
    }),
  };
}

function type2(pages = 16): CardDump {
  return { ...classic(), uid: "04112233445566", sak: 0, kind: "ultralight", unitSize: 4, sectors: [],
    units: Array.from({ length: pages }, (_, index) => ({ index, sector: 0, isManufacturer: index < 3, isTrailer: false, data: "00000000" })) };
}

function changeByte(dump: CardDump, index: number, offset: number, byte: string) {
  const unit = dump.units.find((unit) => unit.index === index);
  if (!unit?.data) throw new Error("missing test unit");
  unit.data = unit.data.slice(0, offset * 2) + byte + unit.data.slice(offset * 2 + 2);
}

describe("NFC read-back comparison", () => {
  it("compares JSON round trips and ignores read timestamps, labels and diagnostics", () => {
    const a = classic();
    const b = parseCardDump(JSON.stringify(a));
    b.readAt = 2000;
    b.durationMs = 999;
    b.label = "another display name";
    b.warnings = ["capture warning"];
    b.sectors[0]!.keySource = "manual";
    const result = compareCardDumps(a, b);
    expect(result.status).toBe("equal");
    expect(result.equalUnits).toBe(64);
    expect(result.keys).toHaveLength(32);
  });

  it("matches units and sectors by address, independently of JSON array order or hex case", () => {
    const a = classic();
    const b = structuredClone(a);
    b.units.reverse();
    b.sectors.reverse();
    b.units.forEach((unit) => { unit.data = unit.data?.toLowerCase(); });
    b.sectors.forEach((sector) => { sector.keyA = sector.keyA?.toLowerCase(); sector.keyB = sector.keyB?.toLowerCase(); });
    expect(compareCardDumps(a, b).status).toBe("equal");
  });

  it("locates individual byte changes without treating a different UID as a data difference", () => {
    const a = classic();
    const b = classic();
    b.uid = "55667788";
    changeByte(b, 5, 7, "AA");
    const result = compareCardDumps(a, b);
    expect(result.status).toBe("different");
    expect(result.metadata[0]?.status).toBe("different");
    expect(result.differentUnits).toBe(1);
    expect(result.differentBytes).toBe(1);
    expect(result.units[5]?.changedOffsets).toEqual([7]);
  });

  it("reports identity-only differences even when every recorded block matches", () => {
    const a = classic();
    const b = classic();
    b.uid = "55667788";
    const result = compareCardDumps(a, b);
    expect(result.equalUnits).toBe(64);
    expect(result.differentUnits).toBe(0);
    expect(result.status).toBe("different");
  });

  it("does not compare incompatible card types or block sizes at matching numeric addresses", () => {
    const result = compareCardDumps(classic(), type2());
    expect(result.compatible).toBe(false);
    expect(result.units).toEqual([]);
    expect(result.keys).toEqual([]);
    expect(result.status).toBe("different");
    expect(compareCardDumps(classic(), classic("classic4k")).compatible).toBe(false);
  });

  it("uses confirmed keys and ignores raw masked trailer keys", () => {
    const a = classic();
    const b = classic();
    b.units[3]!.data = "A0A1A2A3A4A5" + "FF078000" + "FFFFFFFFFFFF";
    expect(compareCardDumps(a, b).status).toBe("equal");
    const row = compareCardDumps(a, b).units[3];
    expect(row?.a.slice(0, 6).join("")).toBe("A0A1A2A3A4A5");
    expect(row?.a.slice(10).join("")).toBe("FFFFFFFFFFFF");
  });

  it("detects actual key changes even when both raw trailer dumps are identical", () => {
    const a = classic();
    const b = classic();
    b.sectors[0]!.keyA = "B0A1A2A3A4A5";
    b.sectors[0]!.keyB = "FEFFFFFFFFFF";
    const result = compareCardDumps(a, b);
    expect(result.differentBytes).toBe(2);
    expect(result.units[3]?.changedOffsets).toEqual([0, 10]);
    expect(result.keys.filter((key) => key.status === "different")).toHaveLength(2);
  });

  it("compares access bits and the general purpose byte as well as keys", () => {
    const a = classic();
    const b = classic();
    changeByte(b, 3, 7, "08");
    changeByte(b, 3, 9, "80");
    const result = compareCardDumps(a, b);
    expect(result.units[3]?.changedOffsets).toEqual([7, 9]);
    expect(result.keys.every((key) => key.status === "equal")).toBe(true);
  });

  it("does not treat missing keys, including both missing, as matching zero keys", () => {
    const a = classic();
    const b = classic();
    delete a.sectors[0]!.keyA;
    delete b.sectors[0]!.keyA;
    delete b.sectors[0]!.keyB;
    const result = compareCardDumps(a, b);
    expect(result.status).toBe("unknown");
    expect(result.equalUnits).toBe(63);
    expect(result.incompleteUnits).toBe(1);
    expect(result.units[3]?.unknownOffsets).toHaveLength(12);
    expect(result.keys.filter((key) => key.status === "unknown")).toHaveLength(2);
  });

  it("retains a known zero key as actual data", () => {
    const a = classic();
    const b = classic();
    a.sectors[0]!.keyA = "000000000000";
    b.sectors[0]!.keyA = "000000000000";
    expect(compareCardDumps(a, b).status).toBe("equal");
  });

  it("keeps unread and absent addresses unknown, including when both sides are missing", () => {
    const a = classic();
    const b = classic();
    delete a.units[1]!.data;
    delete b.units[1]!.data;
    b.units = b.units.filter((unit) => unit.index !== 6);
    const result = compareCardDumps(a, b);
    expect(result.units).toHaveLength(64);
    expect(result.incompleteUnits).toBe(2);
    expect(result.equalUnits).toBe(62);
    expect(result.status).toBe("unknown");
    expect(result.units[6]?.b).toEqual(Array(16).fill(null));
  });

  it("reports known differences and missing bytes in the same trailer", () => {
    const a = classic();
    const b = classic();
    delete b.sectors[0]!.keyA;
    changeByte(b, 3, 9, "42");
    const result = compareCardDumps(a, b);
    expect(result.status).toBe("different");
    expect(result.differentUnits).toBe(1);
    expect(result.incompleteUnits).toBe(1);
    expect(result.units[3]?.unknownOffsets).toHaveLength(6);
    expect(result.units[3]?.changedOffsets).toEqual([9]);
  });

  it("finds big-sector trailers in Classic 4K without classifying every fourth block as a trailer", () => {
    const a = classic("classic4k");
    const b = classic("classic4k");
    b.sectors[32]!.keyA = "B0A1A2A3A4A5";
    changeByte(b, 131, 0, "42");
    const result = compareCardDumps(a, b);
    expect(result.units[131]?.kind).toBe("data");
    expect(result.units[143]?.kind).toBe("trailer");
    expect(result.units[143]?.sector).toBe(32);
    expect(result.units[143]?.changedOffsets).toEqual([0]);
    expect(result.units[255]?.sector).toBe(39);
    expect(result.keys).toHaveLength(80);
    expect(result.differentUnits).toBe(2);
  });

  it("compares Type 2 pages by address and marks a shorter capture as unknown", () => {
    const a = type2(16);
    const b = type2(45);
    changeByte(b, 5, 3, "AB");
    const result = compareCardDumps(a, b);
    expect(result.compatible).toBe(true);
    expect(result.units).toHaveLength(45);
    expect(result.keys).toHaveLength(0);
    expect(result.units[2]?.kind).toBe("manufacturer");
    expect(result.units[5]?.changedOffsets).toEqual([3]);
    expect(result.incompleteUnits).toBe(29);
    expect(result.metadata.find((field) => field.label === "记录地址数")?.status).toBe("different");
  });

  it("never calls an empty or unsupported capture equal", () => {
    const a = { ...classic(), kind: "unknown" as const, units: [], sectors: [] };
    expect(compareCardDumps(a, a).status).toBe("unknown");
    expect(compareCardDumps(type2(0), type2(0)).status).toBe("unknown");
  });
});

describe("NFC comparison workspace workflow", () => {
  it("adds successive reads as independent A/B snapshots even for the same UID", () => {
    const source = classic();
    const first = comparisonReducer(emptyComparisonWorkspace(), { type: "add", entries: [{ dump: source, source: "读卡结果" }] });
    changeByte(source, 1, 0, "AB");
    source.sectors[0]!.keyA = "112233445566";
    source.warnings.push("later warning");
    const second = comparisonReducer(first, { type: "add", entries: [{ dump: source, source: "读卡结果" }] });
    expect([second.a, second.b]).toEqual([1, 2]);
    expect(second.entries[0]?.dump.units[1]?.data).toBe("00".repeat(16));
    expect(second.entries[0]?.dump.sectors[0]?.keyA).toBe("A0A1A2A3A4A5");
    expect(second.entries[0]?.dump.warnings).toEqual([]);
    expect(second.entries[1]?.dump.units[1]?.data).toBe(`AB${"00".repeat(15)}`);
    expect(source).not.toBe(second.entries[1]?.dump);
  });

  it("imports two JSON snapshots together, then preserves A/B when a third snapshot is added", () => {
    const entries = ["first.json", "second.json"].map((name) => ({ dump: parseCardDump(JSON.stringify(classic())), name, source: "JSON 文件" }));
    const first = comparisonReducer(emptyComparisonWorkspace(), { type: "add", entries });
    const second = comparisonReducer(first, { type: "add", entries: [{ dump: classic(), source: "读卡结果" }] });
    expect([second.a, second.b]).toEqual([1, 2]);
    expect(second.entries.map((entry) => entry.name)).toEqual(["first.json", "second.json", "卡片记录 3"]);
  });

  it("swaps selections and cannot compare an entry to itself", () => {
    const state = comparisonReducer(emptyComparisonWorkspace(), { type: "add", entries: [1, 2].map(() => ({ dump: classic(), source: "读卡结果" })) });
    const selected = comparisonReducer(state, { type: "select", side: "a", id: 2 });
    expect([selected.a, selected.b]).toEqual([2, 1]);
    expect(comparisonReducer(selected, { type: "swap" })).toEqual(state);
    expect(comparisonReducer(state, { type: "select", side: "b", id: 999 })).toBe(state);
  });

  it("clears removed selections instead of leaving a stale comparison and fills the vacant side next", () => {
    const state = comparisonReducer(emptyComparisonWorkspace(), { type: "add", entries: [1, 2].map(() => ({ dump: classic(), source: "读卡结果" })) });
    const removed = comparisonReducer(state, { type: "remove", id: 1 });
    expect(removed.a).toBeNull();
    expect(removed.b).toBe(2);
    expect(removed.entries).toHaveLength(1);
    const next = comparisonReducer(removed, { type: "add", entries: [{ dump: classic(), source: "读卡结果" }] });
    expect([next.a, next.b]).toEqual([3, 2]);
    const cleared = comparisonReducer(next, { type: "clear" });
    expect(cleared.entries).toEqual([]);
    expect([cleared.a, cleared.b]).toEqual([null, null]);
    expect(cleared.nextId).toBe(4);
  });
});
