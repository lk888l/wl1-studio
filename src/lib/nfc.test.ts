import { describe, expect, it } from "vitest";

import {
  byteLength,
  defaultWriteOptions,
  dumpGaps,
  emptyReadOptions,
  formatUid,
  hexPairs,
  hexToAscii,
  parseCardDump,
  missingKeySectors,
  readSummary,
  type CardDump,
  type DataUnit,
} from "./nfc";

function unit(index: number, data?: string): DataUnit {
  return {
    index,
    sector: Math.floor(index / 4),
    data,
    error: data ? undefined : "未读取",
    isTrailer: index % 4 === 3,
    isManufacturer: index === 0,
  };
}

function dump(units: DataUnit[]): CardDump {
  return {
    uid: "922E5832",
    atqa: "0400",
    sak: 0x08,
    kind: "classic1k",
    label: "MIFARE Classic 1K",
    unitSize: 16,
    units,
    sectors: [],
    readAt: 0,
    durationMs: 0,
    unresolvedSectors: 0,
    warnings: [],
  };
}

describe("hex helpers", () => {
  it("splits a payload into uppercase byte pairs", () => {
    expect(hexPairs("922e5832")).toEqual(["92", "2E", "58", "32"]);
    expect(hexPairs("00ff0780")).toEqual(["00", "FF", "07", "80"]);
  });

  it("drops a trailing nibble rather than emitting a half byte", () => {
    expect(hexPairs("922e5")).toEqual(["92", "2E"]);
    expect(hexPairs("")).toEqual([]);
  });

  it("renders printable ASCII and masks everything else", () => {
    expect(hexToAscii("48656C6C6F")).toBe("Hello");
    expect(hexToAscii("00FF0780")).toBe("....");
    // 0x7F is DEL and 0x20 is space: the boundary is inclusive below, exclusive above.
    expect(hexToAscii("207E7F")).toBe(" ~.");
  });

  it("formats a UID as spaced bytes like a card reader prints it", () => {
    expect(formatUid("922E5832")).toBe("92 2E 58 32");
    expect(formatUid("04112233445566")).toBe("04 11 22 33 44 55 66");
    expect(byteLength("922E5832")).toBe(4);
    expect(byteLength("")).toBe(0);
  });
});

describe("dump completeness", () => {
  it("counts every unit the reader could not open", () => {
    expect(dumpGaps(dump([unit(0, "00".repeat(16)), unit(1, "11".repeat(16))]))).toBe(62);
    expect(dumpGaps(dump([unit(0, "00".repeat(16)), unit(1), unit(2)]))).toBe(63);
    expect(dumpGaps(dump([]))).toBe(64);
  });
});

describe("option defaults", () => {
  it("never writes the manufacturer block unless asked", () => {
    // Writing block 0 rewrites the UID and can brick a card, so the default
    // must stay off no matter what the UI does later.
    const options = defaultWriteOptions();
    expect(options.writeManufacturerBlock).toBe(false);
    expect(options.writeTrailers).toBe(true);
    expect(options.verify).toBe(true);
    expect(options.sectors).toEqual([]);
    expect(options.targetKeys).toEqual([]);
  });

  it("starts a read with no operator keys and no sector overrides", () => {
    expect(emptyReadOptions()).toEqual({ extraKeys: [], sectorKeys: [] });
  });

  it("hands out fresh option objects so callers cannot share state", () => {
    const first = emptyReadOptions();
    first.extraKeys.push("FFFFFFFFFFFF");
    expect(emptyReadOptions().extraKeys).toEqual([]);
  });
});

function fullDump(): CardDump {
  const result = dump(Array.from({ length: 64 }, (_, index) => unit(index, "00".repeat(16))));
  result.sectors = Array.from({ length: 16 }, (_, index) => ({
    index, firstBlock: index * 4, blockCount: 4, trailerBlock: index * 4 + 3,
    keyA: "FFFFFFFFFFFF", keyB: "FFFFFFFFFFFF", keySource: "dictionary", resolved: true,
  }));
  return result;
}

describe("backup imports and completeness", () => {
  it("imports a complete backup and reports missing keys independently from readable blocks", () => {
    const source = fullDump();
    source.sectors[0]!.keyB = undefined;
    const imported = parseCardDump(JSON.stringify(source));
    expect(dumpGaps(imported)).toBe(0);
    expect(missingKeySectors(imported).map((sector) => sector.index)).toEqual([0]);
    expect(readSummary(imported)).toContain("尚不具备完整复制条件");
  });
  it("accepts native nullable data while rejecting truncated or duplicate addresses", () => {
    const source = fullDump();
    const native = JSON.stringify(source).replace('"data":"' + "00".repeat(16) + '"', '"data":null');
    expect(dumpGaps(parseCardDump(native))).toBe(1);
    source.units.pop();
    expect(() => parseCardDump(JSON.stringify(source))).toThrow();
    const duplicate = fullDump(); duplicate.units[63]!.index = 0;
    expect(() => parseCardDump(JSON.stringify(duplicate))).toThrow();
  });
  it("rejects invalid hex, sector geometry, and absent arrays before rendering", () => {
    for (const mutate of [
      (d: CardDump) => { d.units[2]!.data = "中".repeat(16); },
      (d: CardDump) => { d.sectors[0]!.trailerBlock = 7; },
      (d: CardDump) => { d.sectors[0]!.keyA = "unknown"; },
      (d: CardDump) => { d.unitSize = 4; },
    ]) {
      const source = fullDump(); mutate(source);
      expect(() => parseCardDump(JSON.stringify(source))).toThrow();
    }
    expect(() => parseCardDump('{"uid":"12345678","units":[]}')).toThrow();
  });
});
