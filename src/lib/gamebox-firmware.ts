export const GAMEBOX_APPLICATION_BYTES = 62 * 1024;
export const GAMEBOX_FLASH_BASE = 0x0800_0000;
const SRAM_BASE = 0x2000_0000;
const SRAM_END = SRAM_BASE + 20 * 1024;
const MAX_INSPECTION_BYTES = 16 * 1024 * 1024;

export interface GameBoxFirmwareReport {
  name: string;
  size: number;
  crc32: string;
  initialStackPointer: number | null;
  resetVector: number | null;
  vectorValid: boolean;
  fitsInternalFlash: boolean;
  issues: string[];
}

export const GAMEBOX_GAMES: readonly { id: string; name: string; description: string; category: "游戏" | "工具" }[] = [
  { id: "dino", name: "Dino · 小恐龙", description: "Jump / Up / Enter 开始或跳跃，速度随分数提高。", category: "游戏" },
  { id: "snake", name: "Snake · 贪吃蛇", description: "方向键转向，Enter / Jump 开始或重开；最高分掉电保存。", category: "游戏" },
  { id: "air-raid", name: "Air Raid · 空袭", description: "Up / Down 连续移动，Jump 发射，Enter 开始；三条生命。", category: "游戏" },
  { id: "tetris", name: "Tetris · 俄罗斯方块", description: "左右移动，Down 软降，Up 硬降，Jump / Func 左旋 / 右旋。", category: "游戏" },
  { id: "pong", name: "Pong 2P · 双人乒乓", description: "左玩家 Up / Down，右玩家 Jump / Func，Enter 开始或重开。", category: "游戏" },
  { id: "piano", name: "Piano · 八键钢琴", description: "八个按键对应 C4–C5，长按 Back 退出。", category: "游戏" },
  { id: "stopwatch", name: "Stopwatch · 秒表", description: "Enter / Jump 启停，Func 清零。", category: "工具" },
  { id: "countdown", name: "Countdown · 倒计时", description: "上下调分钟，左右调秒，Enter / Jump 启停，Func 恢复 05:00。", category: "工具" },
  { id: "input-lab", name: "Input Lab · 按键实验室", description: "查看实体按键事件；非游戏页长按 Func 可快速打开。", category: "工具" },
  { id: "system", name: "System · 系统信息", description: "在设备上查看固件运行状态与计数。", category: "工具" },
  { id: "adc-scope", name: "ADC Scope · 波形", description: "PA0 输入，Enter / Jump 冻结或继续；波形仅在设备屏幕显示。", category: "工具" },
  { id: "i2c-scan", name: "I2C Scan · 寻址", description: "PB8 / PB9 扫描地址，Enter / Jump 重新扫描，上下浏览结果。", category: "工具" },
];

/** IEEE CRC-32 for file comparison; it is not firmware authentication. */
export function gameBoxCrc32(bytes: Uint8Array): string {
  let crc = 0xffff_ffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb8_8320 : 0);
  }
  return ((crc ^ 0xffff_ffff) >>> 0).toString(16).padStart(8, "0").toUpperCase();
}

export function analyzeGameBoxFirmware(name: string, buffer: ArrayBuffer): GameBoxFirmwareReport {
  const size = buffer.byteLength;
  const view = new DataView(buffer);
  const initialStackPointer = size >= 8 ? view.getUint32(0, true) : null;
  const resetVector = size >= 8 ? view.getUint32(4, true) : null;
  const resetAddress = resetVector === null ? null : (resetVector & 0xffff_fffe) >>> 0;
  const stackValid = initialStackPointer !== null && initialStackPointer > SRAM_BASE
    && initialStackPointer <= SRAM_END && initialStackPointer % 8 === 0;
  const entryValid = resetVector !== null && (resetVector & 1) === 1 && resetAddress !== null
    && resetAddress >= GAMEBOX_FLASH_BASE + 8
    && resetAddress < GAMEBOX_FLASH_BASE + Math.min(size, GAMEBOX_APPLICATION_BYTES);
  const fitsInternalFlash = size > 0 && size <= GAMEBOX_APPLICATION_BYTES;
  const issues: string[] = [];
  if (!/\.bin$/i.test(name)) issues.push("当前只检查从 0x08000000 开始的原始 .bin；ELF / HEX 请先转换。");
  if (size < 8) issues.push("文件不足 8 字节，缺少 Cortex-M 向量表。");
  else {
    if (!stackValid) issues.push("初始栈指针必须位于 20 KiB SRAM 内并按 8 字节对齐。");
    if (!entryValid) issues.push("复位向量必须是当前应用映像内的 Thumb 地址，基址 0x08000000。");
  }
  if (size > GAMEBOX_APPLICATION_BYTES) issues.push("超过当前 62 KiB 应用区；末尾 2 KiB 为设置保留区，不能覆盖。");
  return { name, size, crc32: gameBoxCrc32(new Uint8Array(buffer)), initialStackPointer, resetVector,
    vectorValid: stackValid && entryValid, fitsInternalFlash, issues };
}

export async function inspectGameBoxFirmware(file: File): Promise<GameBoxFirmwareReport> {
  if (!/\.bin$/i.test(file.name)) throw new Error("请选择原始 .bin 固件文件；暂不解析 ELF / HEX。");
  if (file.size > MAX_INSPECTION_BYTES) throw new Error("本地检查文件上限为 16 MiB。");
  return analyzeGameBoxFirmware(file.name, await file.arrayBuffer());
}
