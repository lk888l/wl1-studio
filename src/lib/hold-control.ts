import type { MotionTarget } from "../types";

export interface RepeaterTimer {
  set(callback: () => void, intervalMs: number): unknown;
  clear(handle: unknown): void;
}
const defaultTimer: RepeaterTimer = {
  set: (callback, intervalMs) => window.setInterval(callback, intervalMs),
  clear: (handle) => window.clearInterval(handle as number),
};

export function neutralMotion(height: number): MotionTarget {
  return { turn: 0, velocity: 0, roll: 0, height };
}

export type MotionDirection = "forward" | "backward" | "left" | "right";

/** Match the WL1 remote and WeChat client: forward uses negative velocity. */
export function directionalMotion(directions: ReadonlySet<MotionDirection>, settings: { speed: number; roll: number; height: number }): MotionTarget {
  return {
    turn: (directions.has("right") ? settings.speed : 0) - (directions.has("left") ? settings.speed : 0),
    velocity: (directions.has("backward") ? settings.speed : 0) - (directions.has("forward") ? settings.speed : 0),
    roll: settings.roll,
    height: settings.height,
  };
}

export class HoldCommandRepeater {
  private handle: unknown;
  private target: MotionTarget | null = null;
  private pending: MotionTarget | null = null;
  private inFlight = false;

  constructor(
    private readonly emit: (target: MotionTarget) => void | Promise<void>,
    private readonly intervalMs = 50,
    private readonly timer: RepeaterTimer = defaultTimer,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  begin(target: MotionTarget): void {
    this.stopTimer();
    this.target = { ...target };
    this.handle = this.timer.set(() => this.sendCurrent(), this.intervalMs);
    this.sendCurrent();
  }

  update(target: MotionTarget): void {
    if (!this.target) return;
    this.target = { ...target };
    if (this.pending) this.pending = { ...target };
  }

  release(): void {
    if (!this.target) return;
    const height = this.target.height;
    this.stopTimer();
    this.target = null;
    this.send(neutralMotion(height));
  }

  dispose(): void {
    this.release();
  }

  private sendCurrent(): void {
    if (this.target) this.send(this.target);
  }

  private send(target: MotionTarget): void {
    this.pending = { ...target };
    this.drain();
  }

  private drain(): void {
    if (this.inFlight || !this.pending) return;
    const next = this.pending;
    this.pending = null;
    this.inFlight = true;
    try {
      const result = this.emit({ ...next });
      if (result && typeof result.then === "function") {
        void result
          .catch((error: unknown) => this.fail(error))
          .finally(() => {
            this.inFlight = false;
            this.drain();
          });
      } else {
        this.inFlight = false;
        this.drain();
      }
    } catch (error) {
      this.inFlight = false;
      this.fail(error);
      this.drain();
    }
  }

  private fail(error: unknown): void {
    this.stopTimer();
    this.target = null;
    this.pending = null;
    this.onError(error);
  }

  private stopTimer(): void {
    if (this.handle === undefined) return;
    this.timer.clear(this.handle);
    this.handle = undefined;
  }
}
