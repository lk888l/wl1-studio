import type { ConnectionTarget } from "../types";

export type ParsedFirmwareLine =
  | { type: "imu"; roll: number; pitch: number; yaw: number; accelerationNormG?: number; accelerationTrusted?: boolean }
  | { type: "rpm"; left: number; right: number }
  | { type: "servo"; angle: number; x: number; bias: number }
  | { type: "log"; text: string };

export type RobotFeatureReply =
  | { type: "uid"; uid: string }
  | { type: "autoleg"; enabled: boolean; active: boolean };

export function parseRobotFeatureReply(raw: string): RobotFeatureReply | null {
  const line = raw.trim();
  const uid = /^uid: ([0-9A-F]{24})$/.exec(line);
  if (uid) return { type: "uid", uid: uid[1] ?? "" };
  const autoleg = /^autoleg: enabled=([01]) active=([01])$/.exec(line);
  if (autoleg) return { type: "autoleg", enabled: autoleg[1] === "1", active: autoleg[2] === "1" };
  return null;
}

export function isReadOnlyFirmwareCommand(command: string): boolean {
  return command.trim() === "uid" || command.trim() === "autoleg status" || command.trim() === "rollbias";
}

export type FlashSaveReply =
  | { status: "saved" | "unchanged" }
  | { status: "error"; message: string; unconfirmed?: boolean };

export function parseFlashSaveReply(raw: string): FlashSaveReply | null {
  const line = raw.trim();
  if (line === "save: ok (all motion parameters)") return { status: "saved" };
  if (line === "save: unchanged (no flash write)") return { status: "unchanged" };
  if (!line.startsWith("save:")) return null;
  const errors: Record<string, string> = {
    "save: usage: save [all|recycle]": "固件拒绝保存命令，请检查固件版本。",
    "save: busy; system is starting": "小车正在启动，当前未保存；请启动完成后手动重试。",
    "save: full; use save recycle to erase journal and save": "Flash 参数存储区已满，当前未保存；需要使用固件维护工具清理后再保存。",
    "save: invalid parameters": "固件检测到无效参数，当前未保存；请检查已下发的参数。",
    "save: flash error; RAM settings retained": "Flash 写入失败，参数仍保留在 SRAM，尚未确认断电保存。",
    "save: busy; recycle requires stopped control, or another save is active": "固件正忙或已有保存操作，当前未保存；请稍后手动重试。",
  };
  return errors[line]
    ? { status: "error", message: errors[line] }
    : { status: "error", message: `固件未确认保存：${line}`, unconfirmed: true };
}

const finite = (value: number) => Number.isFinite(value);

export function parseFirmwareLine(raw: string): ParsedFirmwareLine {
  const line = raw.trim();
  const imuFields = line.split(",").map((part) => part.trim());
  const imu = imuFields.slice(0, 3).map(Number);
  const [roll, pitch, yaw] = imu;
  if (
    (imuFields.length === 3 || imuFields.length === 5) &&
    roll !== undefined &&
    pitch !== undefined &&
    yaw !== undefined &&
    imu.every(finite) &&
    imuFields.slice(0, 3).every((field) => field.length > 0)
  ) {
    if (imuFields.length === 3) return { type: "imu", roll, pitch, yaw };
    const accelerationText = imuFields[3]?.match(/^a=([+-]?[\d.]+)$/)?.[1];
    const trustedText = imuFields[4]?.match(/^ok=([01])$/)?.[1];
    const accelerationNormG = Number(accelerationText);
    if (Number.isFinite(accelerationNormG) && trustedText !== undefined) {
      return {
        type: "imu",
        roll,
        pitch,
        yaw,
        accelerationNormG,
        accelerationTrusted: trustedText === "1",
      };
    }
  }

  const rpm = /^A:\s*([+-]?[\d.]+)\s+B:\s*([+-]?[\d.]+)$/i.exec(line);
  if (rpm) {
    const left = Number(rpm[1]);
    const right = Number(rpm[2]);
    if (finite(left) && finite(right)) {
      return { type: "rpm", left, right };
    }
  }

  const servo = /^Servo angel:\s*([+-]?[\d.]+)\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)$/i.exec(
    line,
  );
  if (servo) {
    const values = servo.slice(1).map(Number);
    const [angle, x, bias] = values;
    if (
      angle !== undefined &&
      x !== undefined &&
      bias !== undefined &&
      values.every(finite)
    ) {
      return { type: "servo", angle, x, bias };
    }
  }

  return { type: "log", text: line };
}

export function commandByteLength(command: string): number {
  return new TextEncoder().encode(command.trim()).length;
}

export function validateFirmwareCommand(command: string, connectionTarget: ConnectionTarget = "robot"): string | null {
  const trimmed = command.trim();
  if (!trimmed) {
    return "命令不能为空";
  }
  if (!/^[\x20-\x7e]+$/.test(trimmed)) {
    return "当前固件仅接受 ASCII 文本命令";
  }
  if (commandByteLength(trimmed) > 32) {
    return "命令超过固件 32 字节队列上限";
  }
  if (connectionTarget === "remote" && commandByteLength(trimmed) > 31) {
    return "遥控器无线命令最多 31 字节，32 字节载荷需保留字符串结束符";
  }
  if (/[\r\n]/.test(trimmed)) {
    return "一次只能发送一条命令";
  }
  const parts = trimmed.split(/\s+/);
  if (parts.join(" ") !== trimmed) {
    return "Legacy 固件命令必须使用单个空格分隔参数";
  }
  if (/^R(?:\s|$)/.test(trimmed)) {
    return "R 运动指令只能通过实时控制安全通道发送";
  }

  const [name] = parts;
  if (name === "save") {
    if (parts.length !== 1) return "保存只接受无参数的 save 命令，不支持清理或擦除 Flash";
    return connectionTarget === "remote" ? "遥控器链路不支持保存参数到 Flash；请通过串口或蓝牙直连小车。" : null;
  }
  if (name === "uid") {
    if (parts.length !== 1) return "uid 命令不接受参数";
    return connectionTarget === "remote" ? "遥控器链路不回传小车 UID；请直连小车读取。" : null;
  }
  if (name === "autoleg") {
    if (parts.length !== 2 || !["on", "off", "status"].includes(parts[1] ?? "")) {
      return "自适应腿高命令只接受 autoleg on、off 或 status";
    }
    if (parts[1] === "status" && connectionTarget === "remote") {
      return "遥控器链路不回传小车自适应腿高状态；请直连小车查询。";
    }
    return null;
  }
  if (name === "legheight") {
    if (connectionTarget === "remote") return "遥控器模式的腿高由实体摇杆控制，周期 R 帧会覆盖 legheight；请直连小车调整。";
    return validateNumericCommand(parts, 44.5, 78.5, "腿高");
  }
  if (name === "rollbias") {
    if (connectionTarget === "remote") return "遥控器桥接不支持角度中心设置或查询；请通过串口或蓝牙直连小车。";
    if (parts.length === 1) return null;
    return validateNumericCommand(parts, -20, 20, "自适应腿高角度中心");
  }
  if (name === "anglebias") {
    if (parts.length === 2 && parts[1] === "auto") return null;
    return validateNumericCommand(parts, -20, 20, "俯仰静态偏置");
  }
  if (name === "anglepid" && parts.length === 2 && parts[1] === "auto") return null;
  if (name === "anglepid") return validatePidCommand(parts, [0, 150], [0, 1], [-107, 100]);
  if (name === "velocitypid") return validatePidCommand(parts, [0, 10], [0, 100], [0, 100]);
  if (name === "differpid") return validatePidCommand(parts, [-50, 50], [0, 1], [0, 100]);
  if (name === "rollpid") return validatePidCommand(parts, [-100, 100], [-10, 10]);
  return `当前安全配置不允许发送命令: ${name ?? ""}`;
}

function validateNumericCommand(
  parts: string[],
  min: number,
  max: number,
  label: string,
): string | null {
  if (parts.length !== 2) return "命令参数数量错误：应为 1 项";
  return validateDecimal(parts[1] ?? "", min, max, label);
}

function validatePidCommand(
  parts: string[],
  pRange: [number, number],
  iRange: [number, number],
  dRange?: [number, number],
): string | null {
  if (parts.length !== 3) return "命令参数数量错误：应为 2 项";
  const range = parts[1] === "-p" ? pRange : parts[1] === "-i" ? iRange : parts[1] === "-d" ? dRange : undefined;
  if (!range) return parts[1] === "-d" ? "该控制环没有 D 项" : "PID 参数项只接受 -p、-i 或 -d";
  return validateDecimal(parts[2] ?? "", range[0], range[1], "PID 参数");
}

function validateDecimal(text: string, min: number, max: number, label: string): string | null {
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(text)) return `${label}必须使用普通十进制数字`;
  const value = Number(text);
  if (!Number.isFinite(value)) return `${label}必须是有限数值`;
  if (value < min || value > max) return `${label}必须在 ${min}..=${max} 范围内`;
  return null;
}

export function buildMotionCommand(target: {
  turn: number;
  velocity: number;
  roll: number;
  height: number;
}): string {
  const values = [target.turn, target.velocity, target.roll, target.height];
  if (!values.every(Number.isFinite)) {
    throw new Error("实时控制目标必须是有限数值");
  }
  if (Math.abs(target.turn) > 100 || Math.abs(target.velocity) > 100) {
    throw new Error("转向与速度目标必须位于 -100 到 100");
  }
  if (Math.abs(target.roll) > 18) {
    throw new Error("横滚目标必须位于 -18° 到 18°");
  }
  if (target.height < 44.5 || target.height > 78.5) {
    throw new Error("腿高目标必须位于 44.5 mm 到 78.5 mm");
  }
  return `R ${target.turn.toFixed(1)} ${target.velocity.toFixed(1)} ${target.roll.toFixed(1)} ${target.height.toFixed(1)}`;
}
