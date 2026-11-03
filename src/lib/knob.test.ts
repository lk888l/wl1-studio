import { describe, expect, it } from "vitest";
import { defaultKnobConfig, parseKnobTelemetry, validateKnobConfig, sortKnobPorts, knobPortLabel, knobCurrentLimitMax } from "./knob";
const packet = () => ({ device: "smartknob-s3", protocol: 1, ok: true, state: "idle", current_valid: false, fault: "none", angle: 0, velocity: 0, position: 0, sub_position: 0, iq: 0, id_current: 0, target: 0, magnet: 32, rejected_samples: 0, sample_us: 8, loop_us: 180, currents: [0,0,0], sense_volts: [1.65,1.65,1.65], offsets: [1.65,1.65,1.65], duty: [0,0,0], config: { ...defaultKnobConfig }, calibration: { valid: false, direction: 1, pole_pairs: 7, electrical_zero: 0 } });
describe("SmartKnob protocol", () => {
  it("decodes firmware float gain without losing select/validation compatibility", () => {
    const p = packet(); p.config.sense_gain = 0.15000000596046448;
    expect(parseKnobTelemetry(p).config.sense_gain).toBe(.15);
    expect(validateKnobConfig(parseKnobTelemetry(p).config)).toBeNull();
  });
  it("accepts float32 boundary settings and keeps the incoming packet unchanged", () => {
    const p = packet();
    p.config.current_limit = Math.fround(.8);
    p.config.width = Math.fround(Math.PI);
    p.config.bus_voltage = Math.fround(11.62);
    const normalized = parseKnobTelemetry(p);
    expect(validateKnobConfig(normalized.config)).toBeNull();
    expect(normalized.config.current_limit).toBe(.8);
    expect(normalized.config.bus_voltage).toBe(11.62);
    expect(normalized.config.width).toBe(Math.PI);
    expect(p.config.current_limit).toBe(Math.fround(.8));
    p.config.width = Math.fround(Math.PI / 180);
    p.config.current_limit = Math.fround(.02);
    expect(validateKnobConfig(parseKnobTelemetry(p).config)).toBeNull();
  });
  it("rejects another device, stale protocol, truncated data and nonfinite telemetry", () => {
    expect(() => parseKnobTelemetry({ ...packet(), device: "other" })).toThrow();
    expect(() => parseKnobTelemetry({ ...packet(), protocol: 2 })).toThrow();
    expect(() => parseKnobTelemetry({ ...packet(), currents: [0,0] })).toThrow();
    expect(() => parseKnobTelemetry({ ...packet(), config: {} })).toThrow();
    expect(() => parseKnobTelemetry({ ...packet(), angle: Number.NaN })).toThrow();
    expect(() => parseKnobTelemetry({ ...packet(), calibration: null })).toThrow();
  });
  it("retains rejected command and fault details for the UI", () => {
    const reply = parseKnobTelemetry({ ...packet(), ok: false, error: "calibrate_first", state: "fault", fault: "encoder_jump" });
    expect(reply.ok).toBe(false); expect(reply.error).toBe("calibrate_first"); expect(reply.state).toBe("fault");
  });
  it("enforces motor current, sampling headroom, gain and detent limits", () => {
    expect(validateKnobConfig(defaultKnobConfig)).toBeNull();
    for (const patch of [{ current_limit: 1.01 }, { current_limit: -.1 }, { width: 0 }, { width: NaN }, { sense_gain: .2 }, { bus_voltage: 4.5, voltage_limit: 1.5 }, { snap: .49 }, { min_position: 12, max_position: 11 }, { max_position: 1.5 }, { mode: 4 }]) {
      expect(validateKnobConfig({ ...defaultKnobConfig, ...patch })).not.toBeNull();
    }
  });
});

describe("SmartKnob synchronized current limits", () => {
  it("accepts 1 A and uses the connected firmware capability", () => {
    const config = { ...defaultKnobConfig, current_limit: 1 };
    const sample = parseKnobTelemetry({ ...packet(), config, current_limit_max: 1, current_trip_limit: 1.25, current_target_limit: .9, current_limited: true });
    expect(knobCurrentLimitMax(sample)).toBe(1);
    expect(validateKnobConfig(config, knobCurrentLimitMax(sample))).toBeNull();
    expect(sample.current_limited).toBe(true);
    expect(sample.config.current_limit).toBe(1);
    expect(sample.current_target_limit).toBe(.9);
    expect(knobCurrentLimitMax(null)).toBe(1);
    expect(knobCurrentLimitMax(parseKnobTelemetry(packet()))).toBe(.8);
    expect(validateKnobConfig(config, .8)).not.toBeNull();
  });
  it("rejects corrupt current protection telemetry", () => {
    for (const extra of [{ current_limit_max: 0 }, { current_trip_limit: Number.NaN }, { current_absolute_trip: -1 }, { current_target_limit: -1 }, { current_limited: 1 }, { fault_current_valid: 1 }, { fault_current_valid: true }, { fault_currents: [0, 0] }, { fault_currents: [0, NaN, 0] }, { fault_current_trip_limit: -1 }]) {
      expect(() => parseKnobTelemetry({ ...packet(), ...extra })).toThrow();
    }
  });
  it("preserves the fault sample after live current readings become invalid", () => {
    const sample = parseKnobTelemetry({ ...packet(), state: "fault", fault: "overcurrent_isr", current_valid: false,
      fault_current_valid: true, fault_currents: [-.01, .42, -.41], fault_current_trip_limit: .35, current_absolute_trip: 1.25 });
    expect(sample.fault_currents).toEqual([-.01, .42, -.41]);
    expect(sample.fault_current_trip_limit).toBe(.35);
    expect(sample.current_absolute_trip).toBe(1.25);
  });
});

describe("SmartKnob USB connection", () => {
  it("prefers the native ESP32 USB port without filtering other bridges", () => {
    const native = { name: "/dev/ttyACM1", portType: "usb", vid: 0x303a, pid: 0x1001 };
    const ports = [
      { name: "/dev/ttyS0", portType: "unknown" },
      { name: "/dev/ttyACM0", portType: "usb", vid: 0x1a86, pid: 0x55d3 },
      native,
    ];
    expect(sortKnobPorts(ports).map(p => p.name)).toEqual(["/dev/ttyACM1", "/dev/ttyACM0", "/dev/ttyS0"]);
    expect(ports[0]?.name).toBe("/dev/ttyS0");
    expect(knobPortLabel(native)).toBe("ESP32 原生 USB");
  });
  it("accepts the additive transport field and legacy firmware without it", () => {
    expect(parseKnobTelemetry({ ...packet(), transport: "usb_serial_jtag" }).transport).toBe("usb_serial_jtag");
    expect(parseKnobTelemetry(packet()).transport).toBeUndefined();
  });
  it("does not show synthetic fallback telemetry as real control state", () => {
    expect(() => parseKnobTelemetry({ ...packet(), ok: false, error: "control_unavailable" })).toThrow("控制任务不可用");
    expect(() => parseKnobTelemetry({ ...packet(), calibration: { ...packet().calibration, direction: "1" } })).toThrow("无效校准状态");
  });
});
