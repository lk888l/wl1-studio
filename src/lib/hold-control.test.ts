import { describe, expect, it } from "vitest";

import type { MotionTarget } from "../types";
import { directionalMotion, HoldCommandRepeater, neutralMotion, type RepeaterTimer } from "./hold-control";

describe("按住发送器", () => {
  it("同步发送失败也能清理周期；慢链路不会发送已被更新覆盖的目标", async () => {
    let tick: (() => void) | undefined;
    const timer: RepeaterTimer = {
      set(callback) { tick = callback; return 1; },
      clear() { tick = undefined; },
    };
    const first = { turn: 0, velocity: -18, roll: 0, height: 60 };
    new HoldCommandRepeater(() => { throw new Error("同步断开"); }, 100, timer).begin(first);
    expect(tick).toBeUndefined();
    const sent: MotionTarget[] = [];
    let complete: (() => void) | undefined;
    const repeater = new HoldCommandRepeater((target) => {
      sent.push(target);
      if (sent.length === 1) return new Promise<void>((resolve) => { complete = resolve; });
    }, 100, timer);
    repeater.begin(first);
    tick?.();
    const latest = { ...first, turn: 9 };
    repeater.update(latest);
    complete?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(sent).toEqual([first, latest]);
    repeater.dispose();
  });
  it("前进符号与小程序一致，组合方向和相反方向可正确叠加", () => {
    const settings = { speed: 18, roll: 3, height: 61.5 };
    expect(directionalMotion(new Set(["forward", "right"]), settings)).toEqual({ turn: 18, velocity: -18, roll: 3, height: 61.5 });
    expect(directionalMotion(new Set(["backward", "left"]), settings)).toEqual({ turn: -18, velocity: 18, roll: 3, height: 61.5 });
    expect(directionalMotion(new Set(["forward", "backward", "left", "right"]), settings)).toEqual({ turn: 0, velocity: 0, roll: 3, height: 61.5 });
  });

  it("BLE 以 100 ms 续发，只保留最新目标，写入失败后停止并丢弃队列", async () => {
    const sent: MotionTarget[] = [];
    const errors: unknown[] = [];
    let tick: (() => void) | undefined;
    let rejectWrite: ((error: Error) => void) | undefined;
    const timer: RepeaterTimer = {
      set(callback, intervalMs) { expect(intervalMs).toBe(100); tick = callback; return 1; },
      clear() { tick = undefined; },
    };
    const target = { turn: 0, velocity: -18, roll: 0, height: 60 };
    const repeater = new HoldCommandRepeater((value) => {
      sent.push(value);
      return new Promise<void>((_resolve, reject) => { rejectWrite = reject; });
    }, 100, timer, (error) => errors.push(error));
    repeater.begin(target);
    repeater.update({ ...target, velocity: -30 });
    tick?.();
    rejectWrite?.(new Error("蓝牙断开"));
    await Promise.resolve();
    await Promise.resolve();
    expect(tick).toBeUndefined();
    expect(errors).toHaveLength(1);
    repeater.release();
    expect(sent).toEqual([target]);
  });
  it("按下立即发送、定时续发，松开只发送一次中立帧", () => {
    const sent: MotionTarget[] = [];
    let tick: (() => void) | undefined;
    const timer: RepeaterTimer = {
      set(callback) {
        tick = callback;
        return 1;
      },
      clear() {
        tick = undefined;
      },
    };
    const target = { turn: 3, velocity: 8, roll: 1, height: 50 };
    const repeater = new HoldCommandRepeater((value) => {
      sent.push(value);
    }, 50, timer);

    repeater.begin(target);
    tick?.();
    repeater.release();
    repeater.release();

    expect(sent).toEqual([target, target, neutralMotion(50)]);
  });

  it("写入仍在进行时释放会让中立帧覆盖待发送的非零帧", async () => {
    const sent: MotionTarget[] = [];
    let tick: (() => void) | undefined;
    let finishFirst: (() => void) | undefined;
    const timer: RepeaterTimer = {
      set(callback) {
        tick = callback;
        return 1;
      },
      clear() {
        tick = undefined;
      },
    };
    const target = { turn: 2, velocity: 9, roll: 0, height: 61.5 };
    const repeater = new HoldCommandRepeater((value) => {
      sent.push(value);
      if (sent.length === 1) {
        return new Promise<void>((resolve) => {
          finishFirst = resolve;
        });
      }
    }, 50, timer);

    repeater.begin(target);
    tick?.();
    repeater.release();
    finishFirst?.();
    await Promise.resolve();
    await Promise.resolve();

    expect(sent).toEqual([target, neutralMotion(61.5)]);
  });
});
