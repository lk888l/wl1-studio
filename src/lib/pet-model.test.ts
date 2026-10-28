import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PET_ACTIONS, PET_PRESETS, blankPetFrame, encodePetPackage, loadPetProject,
  makePetPreset, newPetProject, petCrc32, petFrameBytes, petFrameCount,
  petFrameHex, pixelOn, savePetProject, setPetPixel, validatePetProject,
} from "./pet-model";

afterEach(() => vi.unstubAllGlobals());

describe("桌宠工程与 PET1 二进制协议", () => {
  it("提供四种不同的风格和完整八动作模板，全部符合容量限制", () => {
    const firstFrames = new Set<string>();
    for (const preset of PET_PRESETS) {
      const project = makePetPreset(preset.style);
      expect(validatePetProject(project)).toEqual(project);
      expect(petFrameCount(project)).toBe(16);
      expect(PET_ACTIONS.every((action) => project.actions[action].frames.length === 2)).toBe(true);
      firstFrames.add(project.actions.idle.frames[0] ?? "");
    }
    expect(firstFrames.size).toBe(4);
  });
  it("按 row-major MSB 打包像素，不会与 OLED 的 page 格式混淆", () => {
    const bytes = new Uint8Array(256);
    setPetPixel(bytes, 0, 0, true); setPetPixel(bytes, 7, 0, true);
    setPetPixel(bytes, 63, 0, true); setPetPixel(bytes, 0, 1, true);
    setPetPixel(bytes, 63, 31, true); setPetPixel(bytes, -1, 0, true);
    expect(bytes[0]).toBe(0x81); expect(bytes[7]).toBe(0x01);
    expect(bytes[8]).toBe(0x80); expect(bytes[255]).toBe(0x01);
    expect(pixelOn(bytes, 63, 31)).toBe(true);
    setPetPixel(bytes, 7, 0, false);
    expect(bytes[0]).toBe(0x80);
    expect(petFrameBytes(petFrameHex(bytes))).toEqual(bytes);
  });
  it("编码精确的 64 字节头、动作顺序和小端帧间隔", () => {
    const project = newPetProject(); project.name = "1234567890abcdef";
    project.actions.idle.interval = 80;
    const frame = new Uint8Array(256); frame[0] = 128; frame[255] = 1;
    project.actions.idle.frames = [petFrameHex(frame)];
    project.actions.eat = { interval: 1000, frames: ["ff".repeat(256)] };
    const packet = encodePetPackage(project);
    expect(packet.length).toBe(64 + 2 * 256);
    expect(Array.from(packet.subarray(0, 8))).toEqual([80, 69, 84, 49, 64, 32, 8, 0]);
    expect(new TextDecoder().decode(packet.subarray(8, 24))).toBe(project.name);
    expect(Array.from(packet.subarray(24, 32))).toEqual([1, 0, 0, 1, 0, 0, 0, 0]);
    const view = new DataView(packet.buffer);
    expect(view.getUint16(32, true)).toBe(80); expect(view.getUint16(38, true)).toBe(1000);
    expect(Array.from(packet.subarray(48, 64))).toEqual(Array(16).fill(0));
    expect(packet[64]).toBe(128); expect(packet[319]).toBe(1);
    expect(Array.from(packet.subarray(320))).toEqual(Array(256).fill(255));
  });
  it("CRC-32 与标准向量一致", () => {
    expect(petCrc32(new TextEncoder().encode("123456789"))).toBe("cbf43926");
    expect(petCrc32(new Uint8Array())).toBe("00000000");
  });
  it("24 帧正好生成最大 6208 字节包，第 25 帧被拒绝", () => {
    const project = newPetProject();
    for (const action of PET_ACTIONS) project.actions[action].frames = Array(3).fill(blankPetFrame());
    expect(encodePetPackage(project).length).toBe(6208);
    project.actions.idle.frames.push(blankPetFrame());
    expect(() => encodePetPackage(project)).toThrow("24");
  });
  it("拒绝非法尺寸、未知格式、丢失动作和错误帧", () => {
    const valid = newPetProject();
    for (const value of [null, [], {}, { ...valid, width: 128 }, { ...valid, height: 64 }, { ...valid, format: "other" }, { ...valid, actions: {} }]) {
      expect(() => validatePetProject(value)).toThrow();
    }
    for (const frame of ["ff", "zz".repeat(256), null, 123]) {
      expect(() => validatePetProject({ ...valid, actions: { ...valid.actions, idle: { interval: 250, frames: [frame] } } })).toThrow();
    }
  });
  it("拒绝没有待机帧、单动作超过4帧和非法时序", () => {
    const valid = newPetProject();
    for (const idle of [{ interval: 250, frames: [] }, { interval: 250, frames: Array(5).fill(blankPetFrame()) },
      ...[0, 79, 1001, 200.5, Number.NaN, "250"].map((interval) => ({ interval, frames: [blankPetFrame()] }))]) {
      expect(() => validatePetProject({ ...valid, actions: { ...valid.actions, idle } })).toThrow();
    }
  });
  it("名称限制为 1–16 个可打印 ASCII 字符，允许恰好16字符", () => {
    const valid = newPetProject();
    for (const name of ["", " ", "x".repeat(17), "猫咪", "bad\0name", "bad\nname"]) expect(() => validatePetProject({ ...valid, name })).toThrow();
    expect(validatePetProject({ ...valid, name: "a".repeat(16) }).name).toHaveLength(16);
  });
  it("JSON 导入规范化帧数据并隔离可变原始对象", () => {
    const original = newPetProject(); original.actions.idle.frames = ["AA".repeat(256)];
    const valid = validatePetProject(JSON.parse(JSON.stringify(original)));
    expect(valid.actions.idle.frames[0]).toBe("aa".repeat(256));
    valid.actions.idle.frames.push(blankPetFrame());
    expect(original.actions.idle.frames).toHaveLength(1);
  });
  it("损坏或不可用的本地存储不会阻止离线创作", async () => {
    const store = { getItem: vi.fn(() => "{broken"), setItem: vi.fn() };
    vi.stubGlobal("localStorage", store);
    expect(loadPetProject()).toEqual(makePetPreset(0));
    expect(await savePetProject(newPetProject())).toBe(true);
    const validWrites = store.setItem.mock.calls.length;
    expect(await savePetProject({ ...newPetProject(), name: "中文" })).toBe(false);
    expect(store.setItem.mock.calls).toHaveLength(validWrites);
    store.setItem.mockImplementation(() => { throw new Error("quota"); });
    expect(await savePetProject(newPetProject())).toBe(false);
  });
});
