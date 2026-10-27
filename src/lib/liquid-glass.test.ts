import { describe, expect, it } from "vitest";

import { createGlassMap, type GlassMap, isWindowsChromium } from "./liquid-glass";

function pixel(map: GlassMap, x: number, y: number): number[] {
  const offset = (y * map.width + x) * 4;
  return Array.from(map.pixels.slice(offset, offset + 4));
}

function mapFor(width: number, height: number, radius = 24, bezel = 20): GlassMap {
  const map = createGlassMap(width, height, radius, bezel);
  if (!map) throw new Error("Expected valid glass geometry");
  return map;
}

describe("液态玻璃位移场", () => {
  it("中心与圆角外部保持平坦，四边向内折射", () => {
    const map = mapFor(240, 120);
    expect(pixel(map, 120, 60)).toEqual([128, 128, 128, 255]);
    expect(pixel(map, 0, 0)).toEqual([128, 128, 128, 255]);
    expect(pixel(map, 3, 60)[0]).toBeGreaterThan(200);
    expect(pixel(map, 236, 60)[0]).toBeLessThan(56);
    expect(pixel(map, 120, 3)[1]).toBeGreaterThan(200);
    expect(pixel(map, 120, 116)[1]).toBeLessThan(56);
    expect(pixel(map, 3, 60)[1]).toBe(128);
    expect(pixel(map, 120, 3)[0]).toBe(128);
  });

  it("圆角产生双轴法线，水平和垂直镜像对称", () => {
    const map = mapFor(240, 120);
    const topLeft = pixel(map, 10, 10);
    expect(topLeft[0]).toBeGreaterThan(128);
    expect(topLeft[1]).toBeGreaterThan(128);
    for (const [x, y] of [[10, 10], [5, 42], [41, 7], [117, 60]] as const) {
      const a = pixel(map, x, y);
      const horizontal = pixel(map, map.width - 1 - x, y);
      const vertical = pixel(map, x, map.height - 1 - y);
      expect((a[0] ?? 0) + (horizontal[0] ?? 0)).toBe(256);
      expect(a[1]).toBe(horizontal[1]);
      expect(a[0]).toBe(vertical[0]);
      expect((a[1] ?? 0) + (vertical[1] ?? 0)).toBe(256);
    }
  });

  it("边缘平滑过渡到不发生折射的中心", () => {
    const map = mapFor(240, 120);
    const offsets = [2, 6, 10, 14, 18, 20].map((x) => pixel(map, x, 60)[0] ?? 0);
    expect(offsets).toEqual([...offsets].sort((a, b) => b - a));
    expect(offsets.at(-1)).toBe(128);
  });

  it("尺寸改变时保留 CSS 像素宽度的边缘与正确的长宽比例", () => {
    const original = mapFor(240, 120);
    const wider = mapFor(900, 120);
    expect(pixel(original, 3, 60)).toEqual(pixel(wider, 3, 60));
    expect(pixel(original, 120, 3)).toEqual(pixel(wider, 450, 3));
    const downsampled = mapFor(1800, 240, 48, 40);
    expect(downsampled.width / downsampled.height).toBeCloseTo(7.5, 1);
    const cssX = 7;
    const mapX = Math.floor(cssX / 1800 * downsampled.width);
    expect(pixel(downsampled, mapX, Math.floor(downsampled.height / 2))[0]).toBeGreaterThan(200);
  });

  it("限制位移图内存，接受极端尺寸与过大的圆角", () => {
    for (const [width, height] of [[100_000, 100_000], [1e308, 1e308], [1e308, 1], [1, 1e308]] as const) {
      const map = mapFor(width, height, 1e308);
      expect(map.width).toBeLessThanOrEqual(1024);
      expect(map.height).toBeLessThanOrEqual(1024);
      expect(map.width * map.height).toBeLessThanOrEqual(262_144);
      expect(map.pixels.length).toBe(map.width * map.height * 4);
    }
    expect(mapFor(50, 30, 100).pixels).toEqual(mapFor(50, 30, 15).pixels);
    expect(mapFor(50, 30, -1).pixels).toEqual(mapFor(50, 30, 0).pixels);
  });

  it("无效尺寸不会分配纹理", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createGlassMap(value, 100, 20, 16)).toBeNull();
      expect(createGlassMap(100, value, 20, 16)).toBeNull();
      expect(createGlassMap(100, 100, 20, value)).toBeNull();
    }
    expect(createGlassMap(100, 100, Number.NaN, 16)).toBeNull();
  });
});

describe("Windows 折射后端识别", () => {
  it("允许 Windows Chrome / Edge / WebView2", () => {
    expect(isWindowsChromium("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36")).toBe(true);
    expect(isWindowsChromium("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0")).toBe(true);
    expect(isWindowsChromium("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chromium/130.0.0.0")).toBe(true);
  });

  it("其他平台与非 Chromium 浏览器沿用兼容外观", () => {
    for (const agent of [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:131.0) Gecko/20100101 Firefox/131.0",
      "Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Linux; Android 15) Chrome/130.0.0.0 Mobile Safari/537.36",
      "",
    ]) expect(isWindowsChromium(agent)).toBe(false);
  });
});
