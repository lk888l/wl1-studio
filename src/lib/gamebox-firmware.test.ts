import { describe, expect, it } from "vitest";
import { analyzeGameBoxFirmware, GAMEBOX_APPLICATION_BYTES, gameBoxCrc32, inspectGameBoxFirmware } from "./gamebox-firmware";

function binary(size: number, stack = 0x20005000, reset = 0x08000009): ArrayBuffer {
  const buffer = new ArrayBuffer(size);
  if (size >= 8) {
    const view = new DataView(buffer);
    view.setUint32(0, stack, true);
    view.setUint32(4, reset, true);
  }
  return buffer;
}

describe("GameBox 固件本地检查", () => {
  it("CRC32 使用标准 IEEE 测试向量", () => {
    expect(gameBoxCrc32(new TextEncoder().encode("123456789"))).toBe("CBF43926");
    expect(gameBoxCrc32(new Uint8Array())).toBe("00000000");
  });
  it("接受62KiB程序区边界，拒绝覆盖设置页", () => {
    expect(analyzeGameBoxFirmware("game.bin", binary(GAMEBOX_APPLICATION_BYTES))).toMatchObject({
      fitsInternalFlash: true, vectorValid: true, issues: [],
    });
    const oversized = analyzeGameBoxFirmware("game.bin", binary(GAMEBOX_APPLICATION_BYTES + 1));
    expect(oversized.fitsInternalFlash).toBe(false);
    expect(oversized.issues.join()).toContain("设置保留区");
  });
  it("验证向量字节序、栈边界、Thumb与真实文件范围", () => {
    for (const [stack, reset] of [[0x20000000, 0x08000009], [0x20005008, 0x08000009],
      [0x2000000c, 0x08000009], [0x20005000, 0x08000008], [0x20005000, 0x08000021],
      [0x20005000, 0x08000001], [0x20005000, 0x0800f801]]) {
      expect(analyzeGameBoxFirmware("game.bin", binary(32, stack, reset)).vectorValid).toBe(false);
    }
    expect(analyzeGameBoxFirmware("game.bin", binary(32, 0x20000008, 0x0800001f)).vectorValid).toBe(true);
  });
  it("空/截断文件给出诊断，非bin或巨大文件读取前拒绝", async () => {
    expect(analyzeGameBoxFirmware("empty.bin", binary(0))).toMatchObject({
      fitsInternalFlash: false, vectorValid: false, initialStackPointer: null, resetVector: null,
    });
    expect(analyzeGameBoxFirmware("short.bin", binary(7)).issues).not.toHaveLength(0);
    await expect(inspectGameBoxFirmware({ name: "firmware.hex", size: 10 } as File)).rejects.toThrow(".bin");
    await expect(inspectGameBoxFirmware({ name: "firmware.bin", size: 16 * 1024 * 1024 + 1 } as File)).rejects.toThrow("16 MiB");
  });
});
