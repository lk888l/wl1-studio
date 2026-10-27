export type GlassStrength = "soft" | "balanced" | "clear";

export const GLASS_PRESETS: Record<GlassStrength, {
  blur: number;
  refraction: number;
  dispersion: number;
  bezel: number;
}> = {
  soft: { blur: 12, refraction: 8, dispersion: 0.3, bezel: 16 },
  balanced: { blur: 5, refraction: 16, dispersion: 0.6, bezel: 20 },
  clear: { blur: 2, refraction: 22, dispersion: 0.9, bezel: 22 },
};

export interface GlassMap {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

const MAX_MAP_SIDE = 1024;
const MAX_MAP_PIXELS = 262_144;
const NEUTRAL = 128;

/** SVG backdrop displacement is enabled only for the initial Windows backend. */
export function isWindowsChromium(userAgent: string): boolean {
  return /Windows NT/i.test(userAgent)
    && /(?:Chrome|Chromium|Edg)\/\d+/i.test(userAgent)
    && !/(?:Android|iPhone|iPad|Firefox)/i.test(userAgent);
}

const smoothstep = (value: number): number => {
  const clamped = Math.min(1, Math.max(0, value));
  return clamped * clamped * (3 - 2 * clamped);
};

/**
 * Encode a rounded glass bezel's inward normal into the red/green channels.
 * Geometry is measured in CSS pixels even when the map is downsampled. A flat
 * centre stays neutral; only the curved bezel refracts the live backdrop.
 */
export function createGlassMap(
  width: number,
  height: number,
  radius: number,
  bezel: number,
): GlassMap | null {
  if (![width, height, radius, bezel].every(Number.isFinite)
    || width <= 0 || height <= 0 || bezel <= 0) return null;

  // Dividing before multiplication also bounds inputs near Number.MAX_VALUE.
  const scale = Math.min(
    1,
    MAX_MAP_SIDE / width,
    MAX_MAP_SIDE / height,
    Math.sqrt(MAX_MAP_PIXELS) / Math.sqrt(width) / Math.sqrt(height),
  );
  const mapWidth = Math.max(1, Math.floor(width * scale));
  const mapHeight = Math.max(1, Math.floor(height * scale));
  const pixels = new Uint8ClampedArray(mapWidth * mapHeight * 4);
  const halfWidth = width / 2;
  const halfHeight = height / 2;
  const corner = Math.min(Math.max(0, radius), halfWidth, halfHeight);
  const band = Math.min(bezel, halfWidth, halfHeight);
  const edgeFeather = Math.min(1, band / 4);

  for (let row = 0; row < mapHeight; row += 1) {
    const y = ((row + 0.5) / mapHeight - 0.5) * height;
    const qy = Math.abs(y) - halfHeight + corner;
    for (let column = 0; column < mapWidth; column += 1) {
      const x = ((column + 0.5) / mapWidth - 0.5) * width;
      const qx = Math.abs(x) - halfWidth + corner;
      const outsideX = Math.max(qx, 0);
      const outsideY = Math.max(qy, 0);
      const outsideLength = Math.hypot(outsideX, outsideY);
      const distance = outsideLength + Math.min(Math.max(qx, qy), 0) - corner;
      const depth = -distance;
      const offset = (row * mapWidth + column) * 4;
      let normalX = 0;
      let normalY = 0;
      let amount = 0;

      if (depth > 0 && depth < band) {
        if (outsideLength > 0) {
          normalX = outsideX / outsideLength * Math.sign(x);
          normalY = outsideY / outsideLength * Math.sign(y);
        } else if (qx > qy) {
          normalX = Math.sign(x);
        } else {
          normalY = Math.sign(y);
        }
        amount = smoothstep(depth / edgeFeather) * (1 - smoothstep(depth / band));
      }

      // Positive feDisplacementMap scale samples toward the glass interior.
      pixels[offset] = NEUTRAL - Math.round(normalX * amount * 127);
      pixels[offset + 1] = NEUTRAL - Math.round(normalY * amount * 127);
      pixels[offset + 2] = NEUTRAL;
      pixels[offset + 3] = 255;
    }
  }

  return { width: mapWidth, height: mapHeight, pixels };
}
