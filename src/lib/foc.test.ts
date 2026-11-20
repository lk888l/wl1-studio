import { describe, expect, it } from "vitest";
import {
  canConfigure,
  defaultLink,
  driveState,
  mapEntries,
  numeric,
  objects,
  traceCsv,
  wireBytes,
  type Snapshot,
} from "./foc";

const idle: Snapshot = {
  session: 3,
  link: defaultLink,
  phase: "idle",
  mode: null,
  sample: 1,
  age_ms: 0,
  source: "SDO",
  error: null,
  io_error: null,
  reset: false,
  recent: [],
  feedback: {
    status: 0x240,
    fault: 0,
    position: 1.25,
    velocity: -1,
    id_ma: 0,
    iq_ma: -120,
    bus_mv: 24010,
    torque: -4,
    temperature: 302,
    mode: 0,
    calibration: 4,
  },
};

describe("G431 firmware contract", () => {
  it("exposes every scalar and reserves outputs, flash and mapping writes for their flows", () => {
    expect(objects).toHaveLength(286);
    expect(new Set(objects.map((item) => item.address)).size).toBe(objects.length);
    const field = (addr: string) => objects.find((item) => item.address === addr);
    for (const addr of ["2001:01", "2001:03", "2004:06", "2100:06", "6085:00"])
      expect(field(addr)?.editable).toBe(true);
    for (const addr of ["2001:04", "6064:00", "1600:01", "6040:00", "1010:01", "2003:02"])
      expect(field(addr)?.editable).toBe(false);
  });
  it("checks mapping direction, scalar width, FD wire size and the 16-entry limit", () => {
    expect(mapEntries("60FF0020 0x60400010,60600008", 1)).toEqual([0x60ff0020, 0x60400010, 0x60600008]);
    expect(mapEntries("60640020", 1)).toBeNull();
    expect(mapEntries("60640020", 8)).toEqual([0x60640020]);
    for (const text of ["60640010", "FF000020", Array(17).fill("60640020").join(" ")])
      expect(mapEntries(text, 8)).toBeNull();
    expect([7, 8, 9, 17, 19, 30, 49, 65].map(wireBytes)).toEqual([7, 8, 12, 20, 20, 32, 64, null]);
  });
  it("does not unlock writes with expired, unconfirmed, reset, faulted or calibrating telemetry", () => {
    expect(canConfigure(null)).toBe(false);
    expect(canConfigure(idle)).toBe(true);
    for (const changes of [
      { age_ms: 1200 },
      { phase: "unconfirmed" as const },
      { reset: true },
      { io_error: "断线" },
      { feedback: { ...idle.feedback, fault: 0x2310 } },
      { feedback: { ...idle.feedback, calibration: 1 } },
      { feedback: { ...idle.feedback, status: 0x227 } },
    ])
      expect(canConfigure({ ...idle, ...changes })).toBe(false);
    expect(driveState(0x1227)).toBe("功率输出已使能");
    expect(numeric(" ")).toBeNull();
    expect(numeric("NaN")).toBeNull();
    expect(numeric("0x201")).toBe(513);
  });
  it("exports native sequence and timestamps, real source and unscaled telemetry", () => {
    const csv = traceCsv([
      {
        seq: 12,
        time: 405,
        feedback: idle.feedback,
        source: "TPDO4",
        phase: "running",
      },
    ]);
    expect(csv.split("\r\n")[1]).toBe("12,405,TPDO4,running,576,0,0,4,1.25,-1,-4,0,-120,24010,302");
    expect(csv).toContain("mcu_temp_dC");
  });
});
