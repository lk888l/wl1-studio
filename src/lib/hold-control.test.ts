import { describe, expect, it } from "vitest";

import type { MotionTarget } from "../types";
import { HoldCommandRepeater, neutralMotion, type RepeaterTimer } from "./hold-control";

describe("按住发送器", () => {
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
