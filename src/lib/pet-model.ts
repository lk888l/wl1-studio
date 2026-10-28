import { getStoredItem, registerStorageValidator, setStoredItem } from "./user-storage";

export const PET_WIDTH = 64;
export const PET_HEIGHT = 32;
export const PET_FRAME_BYTES = 256;
export const PET_MAX_FRAMES = 24;
export const PET_ACTIONS = ["idle", "blink", "happy", "eat", "sleep", "surprised", "sad", "dance"] as const;
export type PetAction = typeof PET_ACTIONS[number];
export type PetStyle = 0 | 1 | 2 | 3 | 4;
export interface PetAnimation { interval: number; frames: string[] }
export interface PetProject {
  format: "wl1-pet-v1";
  name: string;
  width: 64;
  height: 32;
  actions: Record<PetAction, PetAnimation>;
}
export const PET_ACTION_LABELS: Record<PetAction, string> = {
  idle: "待机", blink: "眨眼", happy: "开心", eat: "吃东西", sleep: "睡觉", surprised: "惊讶", sad: "委屈", dance: "跳舞",
};
export const PET_PRESETS: { style: PetStyle; name: string; title: string; description: string; color: string }[] = [
  { style: 0, name: "Orbit", title: "灵动双眼", description: "好奇地张望，笑成两道月牙。", color: "#8b81e3" },
  { style: 1, name: "Mochi", title: "团子猫", description: "尖耳朵、小胡须，开心时摇尾巴。", color: "#d99a62" },
  { style: 2, name: "Bunbun", title: "长耳兔", description: "竖起耳朵听你说话，蹦跳着打招呼。", color: "#d989a7" },
  { style: 3, name: "Pudding", title: "布丁史莱姆", description: "软乎乎的小团子，吃饱了就打瞌睡。", color: "#68aa96" },
];

export const blankPetFrame = (): string => "00".repeat(PET_FRAME_BYTES);
export function petFrameBytes(frame: string): Uint8Array {
  if (!/^[0-9a-fA-F]{512}$/.test(frame)) throw new Error("像素帧必须包含 256 个字节。");
  return Uint8Array.from({ length: PET_FRAME_BYTES }, (_, index) => Number.parseInt(frame.slice(index * 2, index * 2 + 2), 16));
}
export const petFrameHex = (bytes: Uint8Array): string => Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
export const petFrameCount = (project: PetProject): number => PET_ACTIONS.reduce((total, action) => total + project.actions[action].frames.length, 0);
export function pixelOn(bytes: Uint8Array, x: number, y: number): boolean {
  return ((bytes[y * 8 + (x >> 3)] ?? 0) & (0x80 >> (x & 7))) !== 0;
}
export function setPetPixel(bytes: Uint8Array, x: number, y: number, on: boolean): void {
  if (x < 0 || x >= PET_WIDTH || y < 0 || y >= PET_HEIGHT) return;
  const offset = y * 8 + (x >> 3);
  const mask = 0x80 >> (x & 7);
  bytes[offset] = on ? (bytes[offset] ?? 0) | mask : (bytes[offset] ?? 0) & ~mask;
}

// The preview and exported assets use the same monochrome 64 × 32 bitmap.
function presetFrame(style: PetStyle, action: PetAction, phase: number): string {
  const bytes = new Uint8Array(PET_FRAME_BYTES);
  const bob = action === "dance" || action === "happy" ? (phase % 2 ? -2 : 0) : 0;
  const pixel = (x: number, y: number, on = true) => setPetPixel(bytes, Math.round(x), Math.round(y + bob), on);
  const rect = (x: number, y: number, w: number, h: number, on = true) => {
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) pixel(xx, yy, on);
  };
  const line = (x0: number, y0: number, x1: number, y1: number, on = true) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0), 1);
    for (let i = 0; i <= steps; i++) pixel(x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps, on);
  };
  const ellipse = (cx: number, cy: number, rx: number, ry: number, fill = false, on = true) => {
    for (let y = Math.floor(cy - ry); y <= cy + ry; y++) for (let x = Math.floor(cx - rx); x <= cx + rx; x++) {
      const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
      if (d <= 1 && (fill || d >= .62)) pixel(x, y, on);
    }
  };
  const closed = action === "sleep" || (action === "blink" && phase % 2 === 1);
  const happy = action === "happy" || action === "dance";
  const eyes = (left: number, right: number, y: number, large: boolean) => {
    for (const x of [left, right]) {
      if (closed) rect(x - (large ? 5 : 2), y + 1, large ? 11 : 5, 1);
      else if (happy) {
        line(x - (large ? 5 : 2), y + 1, x, y - (large ? 3 : 1));
        line(x, y - (large ? 3 : 1), x + (large ? 5 : 2), y + 1);
      } else if (action === "sad") {
        line(x - (large ? 5 : 2), y - 2, x + (large ? 5 : 2), y);
        ellipse(x, y + 3, large ? 3 : 1, large ? 4 : 2, true);
      } else {
        ellipse(x, y, large ? 7 : 2, action === "surprised" ? (large ? 9 : 4) : large ? 8 : 3, true);
        if (large) rect(x + (phase % 2 ? 1 : -2), y - 4, 3, 3, false);
      }
    }
  };
  if (style === 0 || style === 4) {
    eyes(20, 44, 15, true);
    if (action === "eat") { rect(28, 25, 8, phase % 2 ? 1 : 3); rect(52 - phase * 3, 24, 3, 3); }
    if (action === "surprised") ellipse(32, 28, 2, 2);
  } else {
    if (style === 1) {
      line(19, 12, 18, 3); line(18, 3, 26, 9); line(38, 9, 45, 3); line(45, 3, 45, 13);
      ellipse(32, 18, 15, 11); line(45, 25, 51, 25); line(51, 25, 53, phase % 2 ? 18 : 22);
      for (const y of [19, 22]) { line(12, y - 1, 21, y); line(43, y, 51, y - 1); }
    } else if (style === 2) {
      ellipse(25, 9, 3, 8); ellipse(39, 9, 3, 8); ellipse(32, 22, 14, 9);
      rect(20, 29, 5, 2); rect(39, 29, 5, 2);
    } else {
      for (let x = 13; x <= 51; x++) {
        const top = 10 + Math.round(((x - 32) / 19) ** 2 * 13) + (phase % 2 ? Math.round(Math.sin(x / 7)) : 0);
        pixel(x, top); pixel(x, 29 + (x % 7 < 3 ? -1 : 0));
        if (x === 13 || x === 51) line(x, top, x, 28);
      }
      rect(35, 7, 2, 3); rect(37, 6, 3, 2);
    }
    const y = style === 2 ? 22 : 19;
    eyes(26, 38, y, false);
    if (action === "eat" || action === "surprised") ellipse(32, y + 5, 2, phase % 2 ? 1 : 3);
    else if (action === "sad") { line(30, y + 5, 32, y + 3); line(32, y + 3, 34, y + 5); }
    else { line(29, y + 4, 32, y + 6); line(32, y + 6, 35, y + 4); }
    if (action === "eat") { rect(47 - phase * 3, 24, 4, 3); rect(48 - phase * 3, 23, 2, 1); }
  }
  if (action === "sleep") { line(53, 4, 58, 4); line(58, 4, 53, 9); line(53, 9, 58, 9); }
  if (action === "happy" || action === "dance") {
    const x = phase % 2 ? 7 : 56; line(x - 2, 9, x + 2, 9); line(x, 7, x, 11);
  }
  return petFrameHex(bytes);
}

export function makePetPreset(style: PetStyle): PetProject {
  const preset = PET_PRESETS.find((item) => item.style === style);
  return {
    format: "wl1-pet-v1", name: preset?.name ?? "MyPet", width: PET_WIDTH, height: PET_HEIGHT,
    actions: Object.fromEntries(PET_ACTIONS.map((action) => [action, {
      interval: action === "sleep" ? 700 : action === "blink" ? 140 : action === "idle" ? 550 : 220,
      frames: [presetFrame(style, action, 0), presetFrame(style, action, 1)],
    }])) as Record<PetAction, PetAnimation>,
  };
}
export function newPetProject(): PetProject {
  return {
    format: "wl1-pet-v1", name: "MyPet", width: 64, height: 32,
    actions: Object.fromEntries(PET_ACTIONS.map((action) => [action, { interval: 250, frames: action === "idle" ? [blankPetFrame()] : [] }])) as Record<PetAction, PetAnimation>,
  };
}

export function validatePetProject(value: unknown): PetProject {
  if (!value || typeof value !== "object") throw new Error("桌宠工程格式无效。");
  const project = value as Partial<PetProject>;
  if (project.format !== "wl1-pet-v1" || project.width !== 64 || project.height !== 32) throw new Error("请导入 64 × 32 的 wl1-pet-v1 工程。");
  if (typeof project.name !== "string" || !/^[\x20-\x7e]{1,16}$/.test(project.name) || !project.name.trim()) throw new Error("宠物名称需要 1–16 个英文、数字或 ASCII 符号。");
  if (!project.actions || typeof project.actions !== "object") throw new Error("工程缺少动作数据。");
  const actions = {} as Record<PetAction, PetAnimation>;
  for (const action of PET_ACTIONS) {
    const animation = project.actions[action];
    if (!animation || !Array.isArray(animation.frames) || animation.frames.length > 4 || !Number.isInteger(animation.interval) || animation.interval < 80 || animation.interval > 1000) {
      throw new Error(`${PET_ACTION_LABELS[action]}需要 0–4 帧，帧间隔须为 80–1000 ms。`);
    }
    if (action === "idle" && !animation.frames.length) throw new Error("待机动作至少需要 1 帧。");
    actions[action] = { interval: animation.interval, frames: animation.frames.map((frame: unknown) => {
      if (typeof frame !== "string" || !/^[0-9a-fA-F]{512}$/.test(frame)) throw new Error("像素帧数据无效，必须为 256 字节十六进制。");
      return frame.toLowerCase();
    }) };
  }
  const result: PetProject = { format: "wl1-pet-v1", name: project.name, width: 64, height: 32, actions };
  if (petFrameCount(result) > PET_MAX_FRAMES) throw new Error("全部动作合计最多 24 帧。");
  return result;
}
export function encodePetPackage(input: PetProject): Uint8Array {
  const project = validatePetProject(input);
  const bytes = new Uint8Array(64 + petFrameCount(project) * PET_FRAME_BYTES);
  bytes.set([0x50, 0x45, 0x54, 0x31, 64, 32, 8, 0]);
  bytes.set(new TextEncoder().encode(project.name), 8);
  const view = new DataView(bytes.buffer);
  let offset = 64;
  PET_ACTIONS.forEach((action, index) => {
    const animation = project.actions[action];
    bytes[24 + index] = animation.frames.length;
    view.setUint16(32 + index * 2, animation.interval, true);
    for (const frame of animation.frames) { bytes.set(petFrameBytes(frame), offset); offset += PET_FRAME_BYTES; }
  });
  return bytes;
}
export function petCrc32(bytes: Uint8Array): string {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
  }
  return ((crc ^ 0xffff_ffff) >>> 0).toString(16).padStart(8, "0");
}

const STORAGE_KEY = "studio.esp-c3.pet.v1";
export function loadPetProject(): PetProject {
  try { const raw = getStoredItem(STORAGE_KEY); if (raw) return validatePetProject(JSON.parse(raw)); } catch { /* An invalid draft never prevents opening the editor. */ }
  return makePetPreset(0);
}
export async function savePetProject(project: PetProject): Promise<boolean> {
  try { const valid = validatePetProject(project); return await setStoredItem(STORAGE_KEY, JSON.stringify(valid)); } catch { return false; }
}

registerStorageValidator(STORAGE_KEY, validatePetProject);
