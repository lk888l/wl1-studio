import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import recordedV5Packet from "./__fixtures__/knob-v5-status.json";
import recordedV8Packet from "./__fixtures__/knob-v8-status.json";
import recordedV20Packet from "./__fixtures__/knob-v20-status.json";
import recordedReferencePacket from "./__fixtures__/knob-reference-modes-status.json";
import recordedV21Packet from "./__fixtures__/knob-v21-status.json";
import recordedV21Defaults from "./__fixtures__/knob-v21-defaults.json";
import { defaultKnobConfig, parseKnobTelemetry, validateKnobConfig, sortKnobPorts, knobPortLabel, knobCurrentLimitMax, knobStrengthMax, knobVoltageLimitMax, knobMagnetStatus, knobDetentPeak, knobEditableConfig, knobConfigurePayload, KnobGateway, maxKnobCurrent, maxKnobStrength, knobMessages, knobModeCount, knobModeOptions, knobModeName, validateKnobReferenceConfig, knobReferenceChanged, knobConfigureRequestError, type KnobReferenceModeConfig, type KnobReferenceModes } from "./knob";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("./device", () => ({ isTauriRuntime: () => true }));
const packet = () => ({ device: "smartknob-s3", protocol: 1, ok: true, state: "idle", current_valid: false, fault: "none", angle: 0, velocity: 0, position: 0, sub_position: 0, iq: 0, id_current: 0, target: 0, magnet: 32, rejected_samples: 0, sample_us: 8, loop_us: 180, currents: [0,0,0], sense_volts: [1.65,1.65,1.65], offsets: [1.65,1.65,1.65], duty: [0,0,0], config: { ...defaultKnobConfig, voltage_limit: 2.35, strength: 10 }, calibration: { valid: false, direction: 1, pole_pairs: 7, electrical_zero: 0 } });
// Synthetic independent banks exercise the protocol; these are not advertised
// as captured motor settings or substitutes for firmware-provided defaults.
const referenceBank = (): KnobReferenceModes => Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
  const mode = index + 4;
  const entry: KnobReferenceModeConfig = {
    bounded: mode > 5, position: 0, min_position: 0, max_position: mode > 5 ? 31 : -1,
    width: Math.fround(Math.PI / 18), endstop: 1, snap: Math.fround(.55), bias: 0,
    strength: mode === 4 ? 0 : 20, damping: Math.fround(.1), scale: Math.fround(.0875),
    friction: 0, click: 0, magnetic_positions: mode === 14 ? [2, 10, 21, 22] : [],
  };
  return [String(mode), entry];
}));
const editableReferencePacket = () => ({ ...structuredClone(recordedReferencePacket), state: "idle" as const,
  reference_config_version: 1, reference_current_limit: Math.fround(.45),
  config: { ...structuredClone(recordedReferencePacket.config), reference_modes: referenceBank() } });
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
    for (const patch of [{ current_limit: 4.51 }, { current_limit: -.1 }, { strength: 1000.01 }, { width: 0 }, { width: NaN }, { sense_gain: .2 }, { bus_voltage: 4.5, voltage_limit: 1.5 }, { snap: .49 }, { min_position: 12, max_position: 11 }, { max_position: 1.5 }, { mode: 4 }]) {
      expect(validateKnobConfig({ ...defaultKnobConfig, ...patch })).not.toBeNull();
    }
  });
});

describe("SmartKnob fractional carrier frequencies", () => {
  it("accepts the captured v20 status without rounding carrier-derived rates", () => {
    const before = JSON.stringify(recordedV20Packet);
    const sample = parseKnobTelemetry(recordedV20Packet);
    expect(sample.firmware).toBe("dma-v20-15k-sampling");
    expect(sample.pwm_profile).toBe("15k_sampling");
    expect(sample.control_nominal_hz).toBe(3750.937744140625);
    expect(sample.encoder_nominal_hz).toBe(2500.625244140625);
    expect(sample.pwm_hz).toBe(15003);
    expect(sample.pwm_actual_hz).toBe(15003.7509765625);
    expect(sample.control_carrier_divider).toBe(4);
    expect(sample.encoder_carrier_divider).toBe(6);
    expect(sample.pwm_duty_ceiling).toBeCloseTo(.7835709, 6);
    expect(validateKnobConfig(sample.config, knobCurrentLimitMax(sample), knobStrengthMax(sample),
      knobVoltageLimitMax(sample.config.bus_voltage, sample))).toBeNull();
    expect(JSON.stringify(recordedV20Packet)).toBe(before);
  });

  it("retains integer frequencies and optional-field compatibility with older firmware", () => {
    const sample = parseKnobTelemetry(recordedV8Packet);
    expect(sample.control_nominal_hz).toBe(5000);
    expect(sample.encoder_nominal_hz).toBe(2500);
    expect(sample.pwm_actual_hz).toBeUndefined();
    expect(sample.control_carrier_divider).toBeUndefined();
    expect(sample.encoder_carrier_divider).toBeUndefined();
    expect(parseKnobTelemetry(packet()).control_nominal_hz).toBeUndefined();
  });

  it.each(["control_nominal_hz", "encoder_nominal_hz", "pwm_actual_hz"])("rejects corrupt %s values", key => {
    for (const value of [0, -1, NaN, Infinity, -Infinity, "3750.94", null]) {
      expect(() => parseKnobTelemetry({ ...recordedV20Packet, [key]: value })).toThrow(key);
    }
  });

  it.each(["pwm_hz", "control_carrier_divider", "encoder_carrier_divider"])("requires positive integer %s values", key => {
    for (const value of [0, -1, 4.5, NaN, Infinity, "4", null]) {
      expect(() => parseKnobTelemetry({ ...recordedV20Packet, [key]: value })).toThrow(key);
    }
  });
});

describe("SmartKnob synchronized current limits", () => {
  it("accepts 1 A and uses the connected firmware capability", () => {
    const config = { ...defaultKnobConfig, voltage_limit: 2.35, current_limit: 1 };
    const sample = parseKnobTelemetry({ ...packet(), config, current_limit_max: 1, current_trip_limit: 1.25, current_target_limit: .9, current_limited: true });
    expect(knobCurrentLimitMax(sample)).toBe(1);
    expect(validateKnobConfig(config, knobCurrentLimitMax(sample))).toBeNull();
    expect(sample.current_limited).toBe(true);
    expect(sample.config.current_limit).toBe(1);
    expect(sample.current_target_limit).toBe(.9);
    expect(knobCurrentLimitMax(null)).toBe(4.5);
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

describe("SmartKnob v4 capabilities and telemetry", () => {
  it("keeps compatible defaults without a retired voltage knob or replacing device settings", () => {
    expect(defaultKnobConfig).toEqual({
      bus_voltage: 11.62, sense_gain: .15, current_limit: .8,
      current_kp: .4, current_ki: 200, width: Math.PI / 18, strength: 20, endstop: 8,
      damping: .003, snap: .55, min_position: 0, max_position: 11, mode: 1,
    });
    expect(maxKnobCurrent).toBe(4.5);
    expect(maxKnobStrength).toBe(1000);
    expect(knobStrengthMax(null)).toBe(1000);
    const original = { ...packet(), config: { ...packet().config, strength: 6, current_limit: .3 } };
    expect(parseKnobTelemetry(original).config).toEqual(original.config);
  });

  it("accepts the advertised 4.5 A and strength 100 boundaries, with strict user input", () => {
    const config = { ...defaultKnobConfig, voltage_limit: 2.35, current_limit: 4.5, strength: 100 };
    const sample = parseKnobTelemetry({ ...packet(), config, current_limit_max: 4.5, strength_max: 100 });
    expect(validateKnobConfig(config, knobCurrentLimitMax(sample), knobStrengthMax(sample))).toBeNull();
    expect(validateKnobConfig({ ...config, current_limit: 4.51 })).not.toBeNull();
    expect(validateKnobConfig({ ...config, strength: 100.01 }, knobCurrentLimitMax(sample), knobStrengthMax(sample))).not.toBeNull();
    expect(validateKnobConfig({ ...config, current_limit: 4.5000001 })).not.toBeNull();
    expect(validateKnobConfig({ ...config, strength: 100.000001 }, knobCurrentLimitMax(sample), knobStrengthMax(sample))).not.toBeNull();
    expect(validateKnobConfig(config, Number.NaN)).not.toBeNull();
    expect(validateKnobConfig(config, 4.5, Number.NaN)).not.toBeNull();
    const future = parseKnobTelemetry({ ...packet(), current_limit_max: 8, strength_max: 2000 });
    expect(knobCurrentLimitMax(future)).toBe(4.5);
    expect(knobStrengthMax(future)).toBe(1000);
  });

  it("uses capabilities rather than the firmware name and preserves legacy fallbacks", () => {
    const legacy = parseKnobTelemetry(packet());
    expect(knobCurrentLimitMax(legacy)).toBe(.8);
    expect(knobStrengthMax(legacy)).toBe(10);
    expect(validateKnobConfig(legacy.config, knobCurrentLimitMax(legacy), knobStrengthMax(legacy))).toBeNull();
    expect(validateKnobConfig({ ...legacy.config, current_limit: .81 }, .8, 10)).not.toBeNull();
    expect(validateKnobConfig({ ...legacy.config, strength: 10.01 }, .8, 10)).not.toBeNull();
    const v3 = parseKnobTelemetry({ ...packet(), firmware: "dma-localized-v3", current_limit_max: 1 });
    expect(knobCurrentLimitMax(v3)).toBe(1);
    expect(knobStrengthMax(v3)).toBe(10);
    const nameOnly = parseKnobTelemetry({ ...packet(), firmware: "dma-localized-v4" });
    expect(knobCurrentLimitMax(nameOnly)).toBe(.8);
    expect(knobStrengthMax(nameOnly)).toBe(10);
    for (const field of ["firmware", "encoder", "current_peak_trip", "haptic_scale", "haptic_position_filter", "current_target_slew"] as const) {
      expect(legacy[field]).toBeUndefined();
    }
  });

  it("normalizes firmware float32 values without relaxing entered limits or the PWM window", () => {
    const p = { ...packet(), current_limit_max: Math.fround(.8), strength_max: Math.fround(10), config: {
      ...defaultKnobConfig, strength: 10, current_limit: Math.fround(.8), voltage_limit: Math.fround(2.35),
      bus_voltage: Math.fround(11.62), current_kp: Math.fround(.4), damping: Math.fround(.003), snap: Math.fround(.55),
    } };
    const sample = parseKnobTelemetry(p);
    expect(knobCurrentLimitMax(sample)).toBe(.8);
    expect(validateKnobConfig(sample.config, knobCurrentLimitMax(sample), knobStrengthMax(sample))).toBeNull();
    expect(sample.config).toMatchObject({ current_limit: .8, voltage_limit: 2.35, current_kp: .4, damping: .003, snap: .55 });
    const maxVoltage = 11.62 * .36 / Math.sqrt(3);
    const atWindow = parseKnobTelemetry({ ...p, config: { ...p.config, voltage_limit: Math.fround(maxVoltage) } });
    expect(atWindow.config.voltage_limit).toBe(maxVoltage);
    expect(validateKnobConfig({ ...defaultKnobConfig, voltage_limit: maxVoltage + .001 })).not.toBeNull();
    expect(p.config.voltage_limit).toBe(Math.fround(2.35));
  });

  it("rejects corrupt optional capabilities, encoder metadata and runtime fields", () => {
    const corrupt = [
      { firmware: 4 }, { firmware: "" }, { current_sampling: null }, { detent_profile: [] },
      { encoder: 6701 }, { encoder_interface: false }, { encoder_resolution_bits: 14.5 }, { encoder_resolution_bits: 0 },
      { encoder_resolution_bits: 33 }, { encoder_dma: 1 }, { strength_max: 0 }, { strength_max: NaN },
      { current_peak_trip: -1 }, { current_peak_trip_ms: 0 }, { current_overload_trip_ms: "20" },
      { current_trip_recovery_ratio: .5 }, { current_peak_trip: 6, current_absolute_trip: 5 },
      { host_lease_ms: -1 }, { host_lease_ms: .5 }, { current_feedforward_ohms: -1 },
      { haptic_scale: 1.01 }, { haptic_scale: -0.01 }, { haptic_scale: NaN }, { speed_limited: 1 },
      { haptic_paused: "false" }, { haptic_fade_start: -1 }, { haptic_speed_cutoff: 0 },
      { haptic_fade_start: 40, haptic_speed_cutoff: 25 }, { haptic_resume_speed: NaN },
      { haptic_resume_hold_ms: 0 }, { haptic_fade_in_ms: Infinity }, { elastic_min_damping: -1 },
      { detent_assist_fade_start: -1 }, { detent_assist_cutoff: 0 }, { detent_assist_fade_start: 25, detent_assist_cutoff: 10 },
      { quiet_output: 0 }, { haptic_position_filter: "false" }, { detent_quiet_velocity: null }, { current_target_slew: 1 },
      { control_nominal_hz: 0 }, { encoder_nominal_hz: -1 }, { pwm_hz: .5 },
      { control_hz: NaN }, { control_interval_us: -1 }, { control_max_us: Infinity },
      { encoder_age_us: -1 }, { encoder_age_max_us: .5 }, { encoder_us: -1 }, { control_us: -1 },
      { weak_magnet_allowed: 1 }, { hardware_detail: {} }, { hardware_error: "-1" }, { encoder_error: NaN },
      { encoder_failures: .5 }, { encoder_retries: -1 }, { voltage_d: Infinity }, { voltage_q: "0" }, { velocity_fast: NaN },
      { reused_samples: -1 }, { missed_samples: .2 }, { control_cycles: NaN }, { reset_reason: -1 },
      { uptime_ms: -1 }, { minimum_free_heap: .5 }, { sample_start_tick: NaN }, { sample_end_tick: .5 },
      { adc_dma_words: [0] }, { adc_dma_words: [-1, 0] }, { adc_dma_words: [0x100000000, 0] },
      { fault_magnet: .5 }, { encoder: "MT6701", magnet: 16 }, { encoder: "MT6701", magnet: 0, fault_magnet: 32 },
    ];
    for (const extra of corrupt) expect(() => parseKnobTelemetry({ ...packet(), ...extra }), JSON.stringify(extra)).toThrow();
  });

  it("retains and validates optional fault context and diagnostic data", () => {
    const faultSample = { interval_us: 200, age_us: 20, start_tick: -550, end_tick: 966, duration_us: 20,
      valid: true, adc_dma_words: [28671, 45055], adc_raw: [1500, 1501], adc_phase: [0, 1] };
    const motion = { angle: 1, velocity: -2, velocity_fast: -3 };
    const diagnostic = { busy: false, cancelled: false, stage: 4, count: 1, peak_speed: 30, peak_current: .8,
      muted_samples: 0, recovered: false, offset: 0, samples: [Array<number>(16).fill(0)] };
    const sample = parseKnobTelemetry({ ...packet(), fault_sample: faultSample, fault_motion: motion, diagnostic });
    expect(sample.fault_sample).toEqual(faultSample);
    expect(sample.fault_motion).toEqual(motion);
    expect(sample.diagnostic).toEqual(diagnostic);
    expect(parseKnobTelemetry({ ...packet(), diagnostic: { ...diagnostic, samples: [Array<number>(12).fill(0)] } }).diagnostic?.samples?.[0]).toHaveLength(12);
    for (const extra of [
      { fault_motion: null }, { fault_motion: { ...motion, velocity_fast: NaN } },
      { fault_sample: [] }, { fault_sample: { ...faultSample, valid: 1 } },
      { fault_sample: { ...faultSample, adc_raw: [4096, 0] } }, { fault_sample: { ...faultSample, adc_phase: [3, 0] } },
      { fault_sample: { ...faultSample, duration_us: -1 } }, { fault_sample: { ...faultSample, interval_us: -1 } },
      { fault_sample: { ...faultSample, age_us: NaN } }, { fault_sample: { ...faultSample, age_us: Infinity } }, { diagnostic: {} },
      { diagnostic: { ...diagnostic, busy: 1 } }, { diagnostic: { ...diagnostic, peak_current: -1 } },
      { diagnostic: { ...diagnostic, samples: [[0]] } }, { diagnostic: { ...diagnostic, samples: [Array<number>(16).fill(NaN)] } },
    ]) expect(() => parseKnobTelemetry({ ...packet(), ...extra })).toThrow();
  });

  it("preserves an invalid ADC fault snapshot whose publication is newer than the task timestamp", () => {
    const snapshot = { interval_us: 200, age_us: -18, start_tick: -550, end_tick: 966,
      duration_us: 20, valid: false, adc_dma_words: [28671, 45055], adc_raw: [1500, 1501], adc_phase: [0, 1] };
    const source = { ...packet(), state: "fault", fault: "adc_window_or_control_deadline", current_valid: false, fault_sample: snapshot };
    const sample = parseKnobTelemetry(source);
    expect(sample.state).toBe("fault");
    expect(sample.fault).toBe("adc_window_or_control_deadline");
    expect(sample.fault_sample).toEqual(snapshot);
    expect(sample.fault_sample?.age_us).toBe(-18);
    expect(source.fault_sample.age_us).toBe(-18);
  });

  it("decodes the captured production v4 packet with its actual settings and optional fields", () => {
    const sample = parseKnobTelemetry(JSON.parse(JSON.stringify(recordedV4Packet)));
    expect(sample.firmware).toBe("dma-localized-v4");
    expect(sample.encoder).toBe("MT6701");
    expect(sample.encoder_interface).toBe("ssi_spi_dma");
    expect(sample.encoder_dma).toBe(true);
    expect(sample.encoder_resolution_bits).toBe(14);
    expect(sample.current_peak_trip).toBe(5);
    expect(sample.current_absolute_trip).toBe(6);
    expect(sample.current_peak_trip_ms).toBe(1);
    expect(sample.current_overload_trip_ms).toBe(20);
    expect(sample.current_trip_recovery_ratio).toBe(4);
    expect(sample.current_limit_max).toBe(4.5);
    expect(sample.strength_max).toBe(100);
    expect(sample.host_lease_ms).toBe(0);
    expect(sample.current_target_slew).toBe(false);
    expect(sample.haptic_position_filter).toBe(false);
    expect(sample.detent_quiet_velocity).toBe(false);
    expect(sample.detent_assist_fade_start).toBe(10);
    expect(sample.detent_assist_cutoff).toBe(25);
    expect(sample.config).toMatchObject({ current_limit: .8, voltage_limit: 2.35, strength: 20, endstop: 20, mode: 1 });
    expect(validateKnobConfig(sample.config, knobCurrentLimitMax(sample), knobStrengthMax(sample))).toBeNull();
    expect(knobMagnetStatus(sample)).toBe("磁场正常");
    expect(sample.diagnostic).toBeUndefined();
  });
});

describe("SmartKnob strength 1000 capability", () => {
  it.each(["dma-v6-smart-knob", "dma-v7-strength-range"])("decodes a complete %s status by advertised capability", firmware => {
    // Reuse all fields of the captured v5 packet, then model the additive
    // SmartKnob profile/capability update without inventing a shorter packet.
    const source = { ...recordedV5Packet, firmware, detent_profile: "smart_knob", strength_max: 1000,
      config: { ...recordedV5Packet.config, strength: 1000, current_limit: 4.5, mode: 1 } };
    const before = JSON.stringify(source);
    const sample = parseKnobTelemetry(source);
    expect(sample.firmware).toBe(firmware);
    expect(sample.detent_profile).toBe("smart_knob");
    expect(sample.config.strength).toBe(1000);
    expect(knobStrengthMax(sample)).toBe(1000);
    expect(knobCurrentLimitMax(sample)).toBe(4.5);
    const validateFor = (config: typeof sample.config) => validateKnobConfig(config,
      knobCurrentLimitMax(sample), knobStrengthMax(sample), knobVoltageLimitMax(config.bus_voltage, sample));
    expect(validateFor(sample.config)).toBeNull();
    expect(validateFor({ ...sample.config, strength: 1000.000001 })).not.toBeNull();
    expect(validateFor({ ...sample.config, strength: 1000.01 })).not.toBeNull();
    expect(validateFor({ ...sample.config, current_limit: 4.5000001 })).not.toBeNull();
    expect(validateFor({ ...sample.config, current_limit: 4.51 })).not.toBeNull();
    expect(JSON.stringify(source)).toBe(before);
  });

  it("keeps the connected 100 and legacy 10 limits even with the new application maximum", () => {
    for (const [extra, maximum] of [[{ strength_max: 100 }, 100], [{}, 10]] as const) {
      const sample = parseKnobTelemetry({ ...packet(), firmware: "dma-v7-strength-range", ...extra });
      expect(knobStrengthMax(sample)).toBe(maximum);
      const config = { ...sample.config, strength: maximum };
      expect(validateKnobConfig(config, knobCurrentLimitMax(sample), knobStrengthMax(sample))).toBeNull();
      expect(validateKnobConfig({ ...config, strength: maximum + .000001 }, knobCurrentLimitMax(sample), knobStrengthMax(sample))).not.toBeNull();
      expect(validateKnobConfig({ ...config, strength: 1000 }, knobCurrentLimitMax(sample), knobStrengthMax(sample))).not.toBeNull();
    }
  });
});

describe("SmartKnob static detent peak preview", () => {
  it("uses the SmartKnob snap point and one-degree dead zone for a ten-degree detent", () => {
    const config = { ...defaultKnobConfig, strength: 5, current_limit: 4.5 };
    for (const [snap, peakDegrees] of [[.55, 4.5], [.75, 6.5]] as const) {
      const peak = knobDetentPeak({ ...config, snap }, "smart_knob");
      expect(peak?.requested).toBeCloseTo(5 * peakDegrees * Math.PI / 180, 12);
      expect(peak?.target).toBe(peak?.requested);
      expect(peak?.limited).toBe(false);
    }
    expect(knobDetentPeak(config)).toEqual(knobDetentPeak(config, "smart_knob"));
    expect(knobDetentPeak({ ...config, mode: 2 })).toEqual(knobDetentPeak(config));
  });

  it("uses twenty percent of a fine detent as its dead zone and keeps the legacy profile formula", () => {
    const fine = { ...defaultKnobConfig, width: Math.PI / 180, strength: 5, current_limit: 4.5 };
    expect(knobDetentPeak(fine)?.requested).toBeCloseTo(5 * .35 * Math.PI / 180, 12);
    const legacy = knobDetentPeak(fine, "localized_barrier");
    expect(legacy?.requested).toBeCloseTo(5 * .5 * Math.PI / 180, 12);
    expect(knobDetentPeak({ ...fine, snap: .75 }, "localized_barrier")).toEqual(legacy);
  });

  it("shows current saturation independently of the strength range", () => {
    const config = { ...defaultKnobConfig, strength: 1000, current_limit: .8 };
    const peak = knobDetentPeak(config);
    expect(peak?.requested).toBeCloseTo(1000 * 4.5 * Math.PI / 180, 10);
    expect(peak?.target).toBe(.8);
    expect(peak?.limited).toBe(true);
    expect(knobDetentPeak({ ...config, current_limit: 4.5 })?.target).toBe(4.5);
    expect(knobDetentPeak({ ...config, strength: 0 })).toEqual({ requested: 0, target: 0, limited: false });
  });

  it("does not label another mode, an unknown profile or invalid numbers as a detent peak", () => {
    for (const mode of [0, 3]) expect(knobDetentPeak({ ...defaultKnobConfig, mode })).toBeNull();
    expect(knobDetentPeak(defaultKnobConfig, "unknown_profile")).toBeNull();
    for (const patch of [{ strength: NaN }, { width: Infinity }, { snap: NaN }, { current_limit: -.1 }])
      expect(knobDetentPeak({ ...defaultKnobConfig, ...patch })).toBeNull();
  });
});

describe("SmartKnob voltage capabilities", () => {
  const experiment = () => ({ ...packet(), pwm_duty_floor: Math.fround(.04), pwm_duty_ceiling: .5,
    max_voltage_limit: Math.fround(11.62 * .46 / Math.sqrt(3)), config: { ...packet().config, voltage_limit: 3 } });
  const validateFor = (sample: ReturnType<typeof parseKnobTelemetry>, config = sample.config) =>
    validateKnobConfig(config, knobCurrentLimitMax(sample), knobStrengthMax(sample), knobVoltageLimitMax(config.bus_voltage, sample));

  it("decodes the captured 19.4 V zero-clamp packet and permits its advertised voltage range", () => {
    const original = JSON.stringify(recordedV5Packet);
    const sample = parseKnobTelemetry(recordedV5Packet);
    expect(sample.config.bus_voltage).toBe(19.4);
    expect(sample).toMatchObject({ pwm_duty_floor: 0, pwm_zero_clamp: true, bus_voltage_sensing: true,
      bus_voltage_source: "adc2_gpio11", bus_voltage_valid: true, adc_sample_valid: true, sampling_restart_required: false });
    expect(sample.pwm_min_active_duty).toBeCloseTo(.04, 7);
    expect(sample.pwm_duty_ceiling).toBeCloseTo(.7, 7);
    expect(sample.bus_voltage).toBe(recordedV5Packet.bus_voltage);
    expect(sample.bus_voltage_measured).toBe(recordedV5Packet.bus_voltage_measured);
    expect(sample.configured_max_voltage_limit).toBe(recordedV5Packet.configured_max_voltage_limit);
    expect(sample.available_voltage_limit).toBe(recordedV5Packet.available_voltage_limit);
    expect(sample.effective_voltage_limit).toBe(recordedV5Packet.effective_voltage_limit);
    expect(knobVoltageLimitMax(19.4, sample)).toBeCloseTo(19.4 * .7 / Math.sqrt(3), 6);
    expect(validateFor(sample, { ...sample.config, voltage_limit: 7.2 })).toBeNull();
    expect(JSON.stringify(recordedV5Packet)).toBe(original);
  });

  it("scales verified capability with nominal bus edits, with strict user boundaries", () => {
    const sample = parseKnobTelemetry(recordedV5Packet);
    for (const bus of [4.5, 11.62, 19.4, 30]) {
      const maximum = bus * .7 / Math.sqrt(3);
      expect(knobVoltageLimitMax(bus, sample)).toBe(maximum);
      expect(validateFor(sample, { ...sample.config, bus_voltage: bus, voltage_limit: maximum })).toBeNull();
      expect(validateFor(sample, { ...sample.config, bus_voltage: bus, voltage_limit: maximum + 1e-7 })).not.toBeNull();
    }
    for (const bus of [0, 4.49, 30.01, NaN, Infinity]) expect(knobVoltageLimitMax(bus, sample)).toBe(0);
  });

  it("keeps configured voltage editable during live sag and unavailable bus readings", () => {
    const available = Math.fround(16 * .7 / Math.sqrt(3));
    const sag = parseKnobTelemetry({ ...recordedV5Packet, bus_voltage: 16, bus_voltage_measured: 16,
      available_voltage_limit: available, effective_voltage_limit: available,
      config: { ...recordedV5Packet.config, voltage_limit: Math.fround(7.2) } });
    expect(sag.config.voltage_limit).toBe(7.2);
    expect(sag.effective_voltage_limit).toBe(available);
    expect(knobVoltageLimitMax(19.4, sag)).toBeCloseTo(7.840417, 6);
    expect(validateFor(sag)).toBeNull();
    const invalid = parseKnobTelemetry({ ...recordedV5Packet, state: "fault", fault: "bus_voltage_invalid",
      bus_voltage: 0, bus_voltage_valid: false, bus_voltage_measured: 35, bus_voltage_error: -1,
      bus_voltage_age_us: 1000000000, available_voltage_limit: 0, effective_voltage_limit: 0 });
    expect(invalid.fault).toBe("bus_voltage_invalid");
    expect(invalid.bus_voltage_measured).toBe(35);
    expect(invalid.effective_voltage_limit).toBe(0);
    expect(knobVoltageLimitMax(19.4, invalid)).toBe(knobVoltageLimitMax(19.4, sag));
  });

  it("supports the new non-clamped profiles and a configured bus source", () => {
    for (const ceiling of [.5, .7]) {
      const maximum = Math.fround(recordedV5Packet.config.bus_voltage * (ceiling - .04) / Math.sqrt(3));
      const sample = parseKnobTelemetry({ ...recordedV5Packet, firmware: "future-name", pwm_profile: "future-profile",
        pwm_duty_floor: Math.fround(.04), pwm_min_active_duty: Math.fround(.04), pwm_zero_clamp: false,
        pwm_duty_ceiling: Math.fround(ceiling), max_voltage_limit: maximum, configured_max_voltage_limit: maximum,
        available_voltage_limit: maximum, bus_voltage_sensing: false, bus_voltage_source: "configured",
        bus_voltage: recordedV5Packet.config.bus_voltage, bus_voltage_measured: 0 });
      expect(knobVoltageLimitMax(30, sample)).toBeCloseTo(30 * (ceiling - .04) / Math.sqrt(3), 6);
      expect(validateFor(sample, { ...sample.config, voltage_limit: 5.1 })).toBeNull();
    }
    const restricted = parseKnobTelemetry({ ...recordedV5Packet, max_voltage_limit: 7,
      configured_max_voltage_limit: 7, available_voltage_limit: 7 });
    expect(knobVoltageLimitMax(19.4, restricted)).toBe(7);
  });

  it("does not authorize high voltage from a firmware name or incomplete new capabilities", () => {
    expect(() => parseKnobTelemetry({ ...packet(), firmware: recordedV5Packet.firmware,
      pwm_profile: recordedV5Packet.pwm_profile, max_voltage_limit: 7.84 })).toThrow();
    for (const key of ["configured_max_voltage_limit", "available_voltage_limit", "effective_voltage_limit",
      "max_voltage_limit", "pwm_duty_floor", "pwm_duty_ceiling", "pwm_min_active_duty", "pwm_zero_clamp",
      "bus_voltage", "bus_voltage_valid", "bus_voltage_sensing", "bus_voltage_source"]) {
      const incomplete: Record<string, unknown> = { ...recordedV5Packet };
      delete incomplete[key];
      expect(() => parseKnobTelemetry(incomplete), key).toThrow();
    }
  });

  it("rejects inconsistent new PWM, voltage and bus telemetry", () => {
    for (const patch of [
      { pwm_zero_clamp: false }, { pwm_duty_floor: .04 }, { pwm_min_active_duty: 0 },
      { pwm_min_active_duty: .1 }, { pwm_min_active_duty: "0.04" }, { pwm_zero_clamp: "true" },
      { configured_max_voltage_limit: 8, max_voltage_limit: 8 }, { max_voltage_limit: 7 },
      { available_voltage_limit: 8 }, { effective_voltage_limit: 1 }, { effective_voltage_limit: -1 },
      { configured_max_voltage_limit: NaN }, { available_voltage_limit: Infinity },
      { bus_voltage: 31 }, { bus_voltage: 0 }, { bus_voltage_valid: false }, { bus_voltage_valid: "true" },
      { bus_voltage_sensing: false }, { bus_voltage_source: "configured" }, { bus_voltage_source: "" },
      { bus_voltage_age_us: -1 }, { bus_voltage_age_us: 1.5 }, { bus_voltage_raw: 4096 },
      { bus_voltage_raw: "2065" }, { bus_voltage_adc_mv: -1 }, { bus_voltage_measured: NaN },
      { bus_voltage_error: .5 }, { bus_voltage_divider: 0 }, { adc_sample_valid: 1 },
      { sampling_restart_required: "false" }, { duty: [0, .02, .5] }, { duty: [0, .04, .71] },
      { bus_voltage_valid: false, bus_voltage: 0, available_voltage_limit: 0, effective_voltage_limit: .1 },
    ]) expect(() => parseKnobTelemetry({ ...recordedV5Packet, ...patch }), JSON.stringify(patch)).toThrow();
    expect(() => parseKnobTelemetry({ ...experiment(), pwm_duty_floor: 0 })).toThrow();
  });

  it("accepts the 50% device's 3 V readback and uses its capability for editing", () => {
    const source = experiment();
    const sample = parseKnobTelemetry(source);
    expect(sample.config.voltage_limit).toBe(3);
    expect(source.config.voltage_limit).toBe(3);
    expect(knobVoltageLimitMax(11.62, sample)).toBeCloseTo(3.086053, 6);
    expect(validateFor(sample)).toBeNull();
    expect(validateFor(sample, { ...sample.config, voltage_limit: 3.1 })).not.toBeNull();
  });

  it("keeps the old limit without both advertised duty bounds, regardless of firmware name", () => {
    const legacyMax = 11.62 * .36 / Math.sqrt(3);
    const config = { ...packet().config, voltage_limit: 3 };
    for (const capabilities of [{}, { firmware: "dma-localized-v4-10k50-sampling-exp3" },
      { pwm_duty_floor: .04 }, { pwm_duty_ceiling: .5 }, { max_voltage_limit: 3.09 },
      { pwm_duty_ceiling: .5, max_voltage_limit: 3.09 }]) {
      const sample = parseKnobTelemetry({ ...packet(), ...capabilities, config });
      expect(knobVoltageLimitMax(11.62, sample)).toBe(legacyMax);
      expect(validateFor(sample)).not.toBeNull();
    }
    expect(knobVoltageLimitMax(11.62, null)).toBe(legacyMax);
    expect(validateKnobConfig(config)).not.toBeNull();
  });

  it("recalculates for a changed bus setting and preserves the absolute 5 V cap", () => {
    const sample = parseKnobTelemetry(experiment());
    expect(knobVoltageLimitMax(8, sample)).toBeCloseTo(8 * .46 / Math.sqrt(3), 6);
    expect(validateFor(sample, { ...sample.config, bus_voltage: 8 })).not.toBeNull();
    expect(knobVoltageLimitMax(30, sample)).toBe(5);
    expect(validateFor(sample, { ...sample.config, bus_voltage: 30, voltage_limit: 5 })).toBeNull();
    const capped = parseKnobTelemetry({ ...experiment(), max_voltage_limit: 5,
      config: { ...sample.config, bus_voltage: 30, voltage_limit: 5 } });
    expect(knobVoltageLimitMax(11.62, capped)).toBeCloseTo(3.086053, 6);
    const restricted = parseKnobTelemetry({ ...experiment(), max_voltage_limit: 2.8 });
    expect(knobVoltageLimitMax(11.62, restricted)).toBe(2.8);
    expect(validateFor(restricted)).not.toBeNull();
  });

  it("normalizes float32 capability boundaries while rejecting user values above them", () => {
    const voltageMax = 11.62 * .46 / Math.sqrt(3);
    const source = { ...experiment(), config: { ...experiment().config,
      bus_voltage: Math.fround(11.62), voltage_limit: Math.fround(voltageMax) } };
    const sample = parseKnobTelemetry(source);
    expect(sample.config.voltage_limit).toBe(voltageMax);
    expect(validateFor(sample)).toBeNull();
    expect(validateFor(sample, { ...sample.config, voltage_limit: voltageMax + 1e-7 })).not.toBeNull();
    expect(source.config.voltage_limit).toBe(Math.fround(voltageMax));
  });

  it("rejects malformed voltage capabilities", () => {
    for (const patch of [{ pwm_duty_floor: -1 }, { pwm_duty_ceiling: 1.01 }, { pwm_duty_floor: NaN },
      { pwm_duty_ceiling: "0.5" }, { pwm_duty_floor: .5, pwm_duty_ceiling: .5 },
      { pwm_duty_floor: .6, pwm_duty_ceiling: .5 }, { max_voltage_limit: 0 },
      { max_voltage_limit: 5.01 }, { max_voltage_limit: Infinity }]) {
      expect(() => parseKnobTelemetry({ ...experiment(), ...patch })).toThrow();
    }
    expect(validateKnobConfig(defaultKnobConfig, 4.5, 100, NaN)).not.toBeNull();
  });
});

describe("SmartKnob encoder status", () => {
  it("does not report a default or stale magnetic byte as healthy after encoder data failures", () => {
    for (const fault of ["encoder_crc", "encoder_transport", "encoder_stale", "hardware_init_failed", "encoder_i2c", "encoder_magnet_or_i2c"]) {
      for (const [encoder, magnet] of [["MT6701", 0], ["MT6701", 4], ["AS5600", 0x20], [undefined, 0x20]] as const) {
        const sample = parseKnobTelemetry({ ...packet(), encoder, magnet, state: "fault", fault });
        expect(knobMagnetStatus(sample)).toBe("磁场状态未知（编码器数据无效）");
      }
    }
    for (const [fault, magnet, text] of [["encoder_magnet_strength", 1, "磁场过强"],
      ["encoder_magnet_strength", 2, "磁场过弱"], ["encoder_magnet_strength", 3, "磁场状态异常（保留值）"],
      ["encoder_loss_of_track", 8, "失去角度跟踪"]] as const) {
      const sample = parseKnobTelemetry({ ...packet(), encoder: "MT6701", magnet, state: "fault", fault, encoder_error: -1 });
      expect(knobMagnetStatus(sample)).toBe(text);
    }
  });
  it("interprets all MT6701 status codes without treating zero as missing magnet", () => {
    const expected = ["磁场正常", "磁场过强", "磁场过弱", "磁场状态异常（保留值）", "磁场正常 · 检测到按压",
      "磁场过强", "磁场过弱", "磁场状态异常（保留值）"];
    for (let magnet = 0; magnet < 16; magnet++) {
      const sample = parseKnobTelemetry({ ...packet(), encoder: "MT6701", magnet, weak_magnet_allowed: true });
      expect(knobMagnetStatus(sample)).toBe(magnet & 8 ? "失去角度跟踪" : expected[magnet]);
    }
  });
  it("keeps AS5600 and legacy status semantics and leaves unknown encoders uninterpreted", () => {
    for (const encoder of [undefined, "AS5600"]) {
      for (const [magnet, text] of [[0, "未检测到磁铁"], [0x20, "磁场正常"], [0x33, "磁场过弱"], [0x28, "磁场过强"]] as const) {
        expect(knobMagnetStatus(parseKnobTelemetry({ ...packet(), encoder, magnet }))).toBe(text);
      }
    }
    expect(knobMagnetStatus(null)).toBe("—");
    expect(knobMagnetStatus(parseKnobTelemetry({ ...packet(), encoder: "future", magnet: 0 }))).toBe("future：状态 0x0");
    for (const code of ["encoder_transport", "encoder_crc", "encoder_loss_of_track", "encoder_not_ready", "encoder_stale", "current_limit_range", "haptic_range"]) {
      expect(knobMessages[code]).toBeTruthy();
    }
  });
});

describe("SmartKnob v8 automatic voltage contract", () => {
  it("parses the complete final hardware snapshot without inventing a voltage setting", () => {
    const original = JSON.stringify(recordedV8Packet);
    const sample = parseKnobTelemetry(recordedV8Packet);
    expect(sample.voltage_limit_automatic).toBe(true);
    expect(sample.pwm_profile).toBe("20k100_svpwm");
    expect(sample.pwm_min_active_duty).toBe(0);
    expect(sample.pwm_duty_ceiling).toBe(1);
    expect(sample.config).not.toHaveProperty("voltage_limit");
    expect(defaultKnobConfig).not.toHaveProperty("voltage_limit");
    expect(validateKnobConfig(sample.config, knobCurrentLimitMax(sample), knobStrengthMax(sample))).toBeNull();
    expect(sample.max_voltage_limit).toBe(sample.available_voltage_limit);
    expect(sample.effective_voltage_limit).toBeCloseTo((sample.bus_voltage as number) / Math.sqrt(3), 5);
    expect(sample.configured_max_voltage_limit).toBeCloseTo(sample.config.bus_voltage / Math.sqrt(3), 5);
    expect(sample.configured_max_voltage_limit).not.toBe(sample.max_voltage_limit);
    for (const key of ["timing_skips", "sampling_recoveries", "pwm_deferred", "pwm_peak_duty", "pwm_full_duty_cycles"] as const) {
      expect(sample[key]).toBe(recordedV8Packet[key]);
    }
    expect(parseKnobTelemetry({ ...recordedV8Packet, duty: [0, .0001, 1] }).duty).toEqual([0, .0001, 1]);
    expect(JSON.stringify(recordedV8Packet)).toBe(original);
  });

  it("tracks bus sag and accepts zero capacity for invalid measured bus without changing nominal settings", () => {
    const maximum = Math.fround(9.6 / Math.sqrt(3));
    const sag = parseKnobTelemetry({ ...recordedV8Packet, bus_voltage: Math.fround(9.6), bus_voltage_measured: Math.fround(9.6),
      max_voltage_limit: maximum, available_voltage_limit: maximum, effective_voltage_limit: maximum });
    expect(sag.effective_voltage_limit).toBe(maximum);
    expect(sag.config.bus_voltage).toBe(19.4);
    const invalid = parseKnobTelemetry({ ...recordedV8Packet, state: "fault", fault: "bus_voltage_invalid",
      bus_voltage_valid: false, bus_voltage: 0, max_voltage_limit: 0, available_voltage_limit: 0, effective_voltage_limit: 0 });
    expect(invalid.effective_voltage_limit).toBe(0);
    expect(invalid.config.voltage_limit).toBeUndefined();
    expect(knobMessages[invalid.fault]).toContain("母线");
    expect(knobMessages.bus_voltage_stale).toContain("母线");
    expect(knobConfigurePayload(defaultKnobConfig, invalid)).not.toHaveProperty("voltage_limit");
  });

  it("rejects incomplete, inconsistent, or nonfinite automatic voltage data", () => {
    for (const key of ["voltage_limit_automatic", "available_voltage_limit", "effective_voltage_limit",
      "max_voltage_limit", "configured_max_voltage_limit", "pwm_min_active_duty", "bus_voltage"]) {
      const truncated: Record<string, unknown> = { ...recordedV8Packet };
      delete truncated[key];
      expect(() => parseKnobTelemetry(truncated), key).toThrow();
    }
    for (const patch of [
      { voltage_limit_automatic: "true" }, { voltage_limit_automatic: false },
      { max_voltage_limit: recordedV8Packet.configured_max_voltage_limit },
      { effective_voltage_limit: 2.35 }, { available_voltage_limit: 5 },
      { configured_max_voltage_limit: 2.35 }, { max_voltage_limit: Infinity },
      { bus_voltage_valid: false, bus_voltage: 0, max_voltage_limit: .1, available_voltage_limit: 0, effective_voltage_limit: 0 },
      { config: { ...recordedV8Packet.config, voltage_limit: 2.35 } },
      { pwm_min_active_duty: -.01 }, { duty: [0, 0, 1.001] },
    ]) expect(() => parseKnobTelemetry({ ...recordedV8Packet, ...patch }), JSON.stringify(patch)).toThrow();
  });

  it("validates recovery counters and actual latch duty independently of fault state", () => {
    for (const key of ["timing_skips", "sampling_recoveries", "pwm_deferred", "pwm_full_duty_cycles"]) {
      for (const bad of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "1"]) {
        expect(() => parseKnobTelemetry({ ...recordedV8Packet, [key]: bad }), `${key}=${bad}`).toThrow();
      }
    }
    for (const bad of [-.01, 1.01, NaN, Infinity, "1"]) {
      expect(() => parseKnobTelemetry({ ...recordedV8Packet, pwm_peak_duty: bad })).toThrow();
    }
    const fault = parseKnobTelemetry({ ...recordedV8Packet, state: "fault", fault: "encoder_loss_of_track",
      pwm_peak_duty: 1, pwm_full_duty_cycles: 8, sampling_recoveries: 1 });
    expect(fault.fault).toBe("encoder_loss_of_track");
    expect(fault.pwm_peak_duty).toBe(1);
    expect(fault.sampling_recoveries).toBe(1);
  });

  it("retains draft extensions but only sends device extensions and the verified legacy limit", () => {
    const v8 = parseKnobTelemetry(recordedV8Packet), legacy = parseKnobTelemetry(recordedV5Packet);
    const stale = { ...v8.config, mode: 3, voltage_limit: 999, extra_cached_field: 123 };
    expect(knobEditableConfig(stale)).toEqual({ ...v8.config, mode: 3, extra_cached_field: 123 });
    expect(knobConfigurePayload(stale, v8)).toEqual({ ...recordedV8Packet.config, mode: 3 });
    const oldPayload = knobConfigurePayload({ ...knobEditableConfig(legacy.config), voltage_limit: 999, mode: 2 }, legacy);
    expect(oldPayload.voltage_limit).toBe(recordedV5Packet.config.voltage_limit);
    expect(oldPayload.mode).toBe(2);
    expect(stale.voltage_limit).toBe(999);
    for (const bad of [NaN, Infinity, -.1, 0, 99]) {
      expect(validateKnobConfig({ ...defaultKnobConfig, voltage_limit: bad })).not.toBeNull();
    }
    expect(validateKnobConfig(defaultKnobConfig)).toBeNull();
    expect(() => parseKnobTelemetry({ ...recordedV5Packet, pwm_min_active_duty: 0 })).toThrow();
  });
});

describe("SmartKnob per-session configure serialization", () => {
  const mockedInvoke = vi.mocked(invoke);
  beforeEach(() => mockedInvoke.mockReset());

  it("sanitizes queued v8 mode/preset updates after status without sending a stale voltage field", async () => {
    const gateway = new KnobGateway();
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 71, portName: "COM7" });
    await gateway.connect("COM7");
    mockedInvoke.mockResolvedValueOnce(recordedV8Packet).mockResolvedValueOnce(recordedV8Packet);
    const status = gateway.request("status");
    const cached = { ...defaultKnobConfig, voltage_limit: 2.35, mode: 2, extra_cached_field: true };
    const configure = gateway.request("configure", cached);
    cached.mode = 3;
    await status; await configure;
    expect(mockedInvoke).toHaveBeenLastCalledWith("knob_request", { expectedSessionId: 71,
      request: { op: "configure", config: { ...defaultKnobConfig, mode: 2,
        current_limit: recordedV8Packet.config.current_limit, damping: recordedV8Packet.config.damping,
        sense_gain: recordedV8Packet.config.sense_gain, snap: recordedV8Packet.config.snap } } });
  });

  it("keeps the legacy device limit read-only even if caller mutates the returned snapshot", async () => {
    const gateway = new KnobGateway();
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 72, portName: "COM7" });
    await gateway.connect("COM7");
    mockedInvoke.mockResolvedValueOnce(recordedV5Packet);
    const sample = await gateway.request("status");
    sample.config.voltage_limit = .1;
    mockedInvoke.mockResolvedValueOnce(recordedV5Packet);
    await gateway.request("configure", { ...knobEditableConfig(sample.config), mode: 3, voltage_limit: 999 });
    expect(mockedInvoke).toHaveBeenLastCalledWith("knob_request", { expectedSessionId: 72,
      request: { op: "configure", config: { ...recordedV5Packet.config, mode: 3 } } });
  });

  it("drops old capabilities on reconnect and requires a fresh status before configuring", async () => {
    const gateway = new KnobGateway();
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 73, portName: "COM7" });
    await gateway.connect("COM7");
    mockedInvoke.mockResolvedValueOnce(recordedV5Packet);
    await gateway.request("status");
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 74, portName: "COM8" });
    await gateway.connect("COM8");
    const count = mockedInvoke.mock.calls.length;
    await expect(gateway.request("configure", defaultKnobConfig)).rejects.toThrow("先读取设备状态");
    expect(mockedInvoke).toHaveBeenCalledTimes(count);
    mockedInvoke.mockResolvedValueOnce(recordedV8Packet).mockResolvedValueOnce(recordedV8Packet);
    await gateway.request("status");
    await gateway.request("configure", { ...defaultKnobConfig, voltage_limit: 7.2 });
    expect(mockedInvoke).toHaveBeenLastCalledWith("knob_request", { expectedSessionId: 74,
      request: { op: "configure", config: { ...defaultKnobConfig,
        current_limit: recordedV8Packet.config.current_limit, damping: recordedV8Packet.config.damping,
        sense_gain: recordedV8Packet.config.sense_gain, snap: recordedV8Packet.config.snap } } });
  });

  it("invalidates cached capabilities after a corrupt reply", async () => {
    const gateway = new KnobGateway();
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 75, portName: "COM7" });
    await gateway.connect("COM7");
    mockedInvoke.mockResolvedValueOnce(recordedV8Packet);
    await gateway.request("status");
    mockedInvoke.mockResolvedValueOnce({ ...recordedV8Packet, effective_voltage_limit: 2 }).mockResolvedValueOnce(undefined);
    await expect(gateway.request("status")).rejects.toThrow("自动电压能力");
    expect(mockedInvoke).toHaveBeenLastCalledWith("knob_disconnect", { expectedSessionId: 75 });
    const count = mockedInvoke.mock.calls.length;
    await expect(gateway.request("configure", defaultKnobConfig)).rejects.toThrow("尚未连接");
    expect(mockedInvoke).toHaveBeenCalledTimes(count);
  });
});

describe("SmartKnob firmware-owned reference modes", () => {
  it("parses the actual reference-mode image independently of the older v20 sampling image", () => {
    const original = structuredClone(recordedReferencePacket);
    const sample = parseKnobTelemetry(recordedReferencePacket);
    expect(sample.firmware).toBe("dma-v20-reference-modes");
    expect(sample.mode_count).toBe(17);
    expect(sample.reference_preset).toBe(4);
    expect(knobModeOptions(sample)).toHaveLength(17);
    expect(knobModeName(16, sample)).toBe("Frictionless");
    expect(sample.frictionless).toEqual(recordedReferencePacket.frictionless);
    expect(sample.config.frictionless).toEqual(recordedReferencePacket.config.frictionless);
    expect(sample.calibration_quality?.verified).toBe(true);
    expect(sample.calibration_report?.stage).toBe("not_run");
    expect(sample.host_lease_ms).toBe(0);
    expect(recordedReferencePacket).toEqual(original);
    expect(parseKnobTelemetry(recordedV20Packet).control_nominal_hz).toBe(3750.937744140625);
  });

  it("uses advertised choices and retains the four-mode fallback without guessing by firmware name", () => {
    expect(knobModeCount(null)).toBe(4);
    expect(knobModeCount(parseKnobTelemetry(recordedV8Packet))).toBe(4);
    for (let mode = 0; mode < 17; mode++) {
      const sample = parseKnobTelemetry({ ...recordedReferencePacket, config: { ...recordedReferencePacket.config, mode } });
      expect(validateKnobConfig(sample.config, knobCurrentLimitMax(sample), knobStrengthMax(sample),
        knobVoltageLimitMax(sample.config.bus_voltage, sample), knobModeCount(sample))).toBeNull();
      expect(knobConfigurePayload(knobEditableConfig(sample.config), sample).mode).toBe(mode);
    }
    const future = parseKnobTelemetry({ ...recordedReferencePacket, mode_count: 18,
      modes: [...recordedReferencePacket.modes, "Future device preset"], config: { ...recordedReferencePacket.config, mode: 17 } });
    expect(knobModeOptions(future)[17]).toEqual({ value: 17, label: "Future device preset" });
    expect(knobConfigurePayload(knobEditableConfig(future.config), future).mode).toBe(17);
    expect(() => parseKnobTelemetry({ ...recordedReferencePacket, mode_count: undefined, modes: undefined,
      config: { ...recordedReferencePacket.config, mode: 16 } })).toThrow("config.mode");
  });

  it("rejects malformed mode capabilities and out-of-range mode selections", () => {
    for (const patch of [{ mode_count: 0 }, { mode_count: 257 }, { mode_count: 17.5 },
      { modes: [] }, { modes: ["Free"] }, { mode_name: "" }, { modes: [...recordedReferencePacket.modes.slice(0, 16), null] },
      { reference_preset: -2 }, { reference_preset: 1.5 }, { mode_count: "17" }]) {
      expect(() => parseKnobTelemetry({ ...recordedReferencePacket, ...patch })).toThrow();
    }
    const sample = parseKnobTelemetry(recordedReferencePacket);
    expect(() => knobConfigurePayload({ ...sample.config, mode: 17 }, sample)).toThrow("模式");
  });

  it("preserves exact untouched device values and unknown extensions when choosing a mode", () => {
    const wire = { ...recordedReferencePacket, config: { ...recordedReferencePacket.config,
      future_setting: { values: [1, 2.125], enabled: true },
      frictionless: { ...recordedReferencePacket.config.frictionless, future_gain: 0.123456789 } } };
    const sample = parseKnobTelemetry(wire);
    const draft = { ...knobEditableConfig(sample.config), mode: 16, cached_host_only: 42 };
    const { frictionless: unchangedFrictionless, ...common } = wire.config;
    expect(unchangedFrictionless.future_gain).toBe(0.123456789);
    expect(knobConfigurePayload(draft, sample)).toEqual({ ...common, mode: 16 });
    const clone = knobEditableConfig(sample.config);
    clone.frictionless!.friction = .03;
    expect(sample.config.frictionless!.friction).toBe(wire.config.frictionless.friction);
    expect(knobConfigurePayload(clone, sample)).toEqual({ ...wire.config,
      frictionless: { ...wire.config.frictionless, friction: .03 } });
  });

  it("requires complete finite frictionless parameters and permits inclusive float32 readbacks", () => {
    const sample = parseKnobTelemetry(recordedReferencePacket);
    for (const [key, max] of Object.entries({ friction: .8, viscous: .02, scale: 10, hold_kp: 1, hold_ki: 5 })) {
      for (const bad of [undefined, -1, NaN, Infinity, max + .01, "0"]) {
        const config = { ...sample.config, frictionless: { ...sample.config.frictionless!, [key]: bad } };
        expect(() => parseKnobTelemetry({ ...recordedReferencePacket, config })).toThrow(`config.frictionless.${key}`);
        expect(() => knobConfigurePayload(config, sample)).toThrow("无摩擦");
      }
      const atBoundary = parseKnobTelemetry({ ...recordedReferencePacket,
        config: { ...recordedReferencePacket.config, frictionless: { ...recordedReferencePacket.config.frictionless, [key]: Math.fround(max) } } });
      expect(() => knobConfigurePayload(atBoundary.config, atBoundary)).not.toThrow();
    }
    for (const patch of [{ phase: -1 }, { phase: .5 }, { reference: NaN }, { correction: Infinity },
      { feedforward: "0" }, { angle_compensation: 1 }]) {
      expect(() => parseKnobTelemetry({ ...recordedReferencePacket, frictionless: { ...recordedReferencePacket.frictionless, ...patch } })).toThrow("frictionless");
    }
    expect(parseKnobTelemetry({ ...recordedReferencePacket, config: { ...recordedReferencePacket.config, frictionless: undefined } }).config.frictionless).toBeUndefined();
  });

  it("accepts additive d/q diagnostic columns and validates available calibration evidence", () => {
    const diagnostic = { busy: false, cancelled: false, recovered: false, stage: 4, count: 1,
      peak_speed: 10, peak_current: .1, muted_samples: 0 };
    for (const length of [12, 16, 17, 20]) {
      expect(parseKnobTelemetry({ ...recordedReferencePacket, diagnostic: { ...diagnostic, samples: [Array(length).fill(0)] } }).diagnostic?.samples?.[0]).toHaveLength(length);
    }
    expect(() => parseKnobTelemetry({ ...recordedReferencePacket,
      calibration_quality: { ...recordedReferencePacket.calibration_quality, verified: "yes" } })).toThrow("verified");
    expect(() => parseKnobTelemetry({ ...recordedReferencePacket,
      calibration_report: { ...recordedReferencePacket.calibration_report, elapsed_s: Infinity } })).toThrow("elapsed_s");
    expect(() => parseKnobTelemetry({ ...recordedReferencePacket,
      calibration_report: { ...recordedReferencePacket.calibration_report, elapsed_s: "1" } })).toThrow("elapsed_s");
  });
});

describe("SmartKnob editable reference presets", () => {
  it("accepts captured v21 status/default replies and preserves every preset during single-mode edits", () => {
    // COM7 first boot and read-only defaults query after v21 was flashed on
    // 2026-11-07. Existing electrical config and calibration came from NVS;
    // the newly introduced reference bank initially uses firmware defaults.
    const before = JSON.stringify(recordedV21Packet), defaultsBefore = JSON.stringify(recordedV21Defaults);
    const sample = parseKnobTelemetry(recordedV21Packet), defaults = parseKnobTelemetry(recordedV21Defaults);
    expect(sample.firmware).toBe("dma-v21-reference-parameters");
    expect(sample.state).toBe("idle"); expect(sample.fault).toBe("none");
    expect(sample.calibration_quality?.verified).toBe(true);
    expect(sample.reference_config_version).toBe(1);
    expect(sample.reference_defaults).toBeUndefined();
    expect(sample.config.reference_modes).toEqual(defaults.reference_defaults);
    expect(Object.keys(sample.config.reference_modes!)).toHaveLength(12);
    expect(new TextEncoder().encode(JSON.stringify(recordedV21Packet)).byteLength).toBeGreaterThan(8192);
    expect(new TextEncoder().encode(JSON.stringify(recordedV21Defaults)).byteLength).toBeLessThan(32768);
    const { reference_modes: bank, frictionless: unchangedFrictionless, ...common } = recordedV21Packet.config;
    expect(unchangedFrictionless).toEqual(sample.config.frictionless);
    for (const [mode, reference] of Object.entries(bank)) {
      const draft = knobEditableConfig(sample.config);
      draft.mode = Number(mode);
      expect(knobConfigurePayload(draft, sample)).toEqual({ ...common, mode: Number(mode) });
      draft.reference_modes![mode]!.strength += 1;
      expect(knobConfigurePayload(draft, sample)).toEqual({ ...common, mode: Number(mode),
        reference_modes: { [mode]: { ...reference, strength: reference.strength + 1 } } });
      expect(knobConfigureRequestError(draft, sample)).toBeNull();
    }
    expect(JSON.stringify(recordedV21Packet)).toBe(before);
    expect(JSON.stringify(recordedV21Defaults)).toBe(defaultsBefore);
  });

  it("can restore a customized preset from the captured firmware defaults without touching another entry", () => {
    const wire = structuredClone(recordedV21Packet);
    wire.config.reference_modes["8"].strength = 27;
    const sample = parseKnobTelemetry(wire), defaults = parseKnobTelemetry(recordedV21Defaults);
    const draft = knobEditableConfig(sample.config);
    draft.reference_modes!["8"] = structuredClone(defaults.reference_defaults!["8"]!);
    expect(knobConfigurePayload(draft, sample).reference_modes).toEqual({ "8": recordedV21Defaults.reference_defaults["8"] });
    expect(sample.config.reference_modes!["8"]!.strength).toBe(27);
    expect(draft.reference_modes!["14"]).toEqual(sample.config.reference_modes!["14"]);
    expect(knobConfigureRequestError(draft, sample)).toBeNull();
  });

  it("parses independently stored presets and optional firmware defaults without aliasing", () => {
    const wire = { ...editableReferencePacket(), reference_defaults: referenceBank() };
    const sample = parseKnobTelemetry(wire);
    expect(sample.reference_config_version).toBe(1);
    expect(sample.config.reference_modes).toEqual(wire.config.reference_modes);
    expect(sample.reference_defaults).toEqual(wire.reference_defaults);
    expect(sample.config.reference_modes).not.toBe(wire.config.reference_modes);
    sample.config.reference_modes!["14"]!.magnetic_positions.push(23);
    expect(wire.config.reference_modes["14"]!.magnetic_positions).toEqual([2, 10, 21, 22]);
    expect(sample.reference_defaults!["14"]!.magnetic_positions).toEqual([2, 10, 21, 22]);
    expect(parseKnobTelemetry(recordedReferencePacket).config.reference_modes).toBeUndefined();
  });

  it("requires a complete supported reference capability and validates advertised defaults", () => {
    const wire = editableReferencePacket();
    for (const patch of [{ reference_config_version: 0 }, { reference_config_version: 2 },
      { reference_config_version: undefined }, { reference_current_limit: undefined },
      { reference_current_limit: .451 }, { reference_defaults: {} }, { reference_defaults: null },
      { config: { ...wire.config, reference_modes: { "8": wire.config.reference_modes["8"] } } }]) {
      expect(() => parseKnobTelemetry({ ...wire, ...patch })).toThrow();
    }
    const bank = structuredClone(wire.config.reference_modes);
    bank["04"] = bank["4"]!; delete bank["4"];
    expect(() => parseKnobTelemetry({ ...wire, config: { ...wire.config, reference_modes: bank } })).toThrow("reference_modes");
  });

  it("validates bounded positions, unique magnetic locations and per-mode applicability", () => {
    const base = referenceBank()["14"]!;
    for (const patch of [{ bounded: "yes" }, { position: 32 }, { position: .5 },
      { min_position: 2 }, { max_position: -1 }, { magnetic_positions: [2, 2] },
      { magnetic_positions: [32] }, { magnetic_positions: [1.2] }, { magnetic_positions: Array.from({ length: 9 }, (_, i) => i) },
      { magnetic_positions: null }]) {
      expect(validateKnobReferenceConfig({ ...base, ...patch } as KnobReferenceModeConfig, 14)).not.toBeNull();
    }
    expect(validateKnobReferenceConfig(base, 13)).toMatch("只有磁性");
    expect(validateKnobReferenceConfig({ ...base, magnetic_positions: [] }, 13)).toBeNull();
    expect(validateKnobReferenceConfig({ ...base, bounded: false, min_position: 0, max_position: -1 }, 14)).toBeNull();
    expect(validateKnobReferenceConfig(base, 16)).not.toBeNull();
  });

  it("accepts exact float32 boundaries and enforces reference gain and snap constraints", () => {
    const base = referenceBank()["8"]!;
    for (const [key, min, max] of [
      ["width", Math.PI / 180, Math.PI], ["endstop", 0, 20], ["strength", 0, 100],
      ["damping", 0, 5], ["scale", 0, 1], ["friction", 0, .45], ["click", 0, .45], ["snap", .5, 2],
    ] as const) {
      for (const value of [Math.fround(min), Math.fround(max)]) expect(validateKnobReferenceConfig({ ...base, [key]: value }, 8)).toBeNull();
      for (const value of [min - .01, max + .01, NaN, Infinity, undefined, "0"]) expect(validateKnobReferenceConfig({ ...base, [key]: value }, 8)).not.toBeNull();
    }
    expect(validateKnobReferenceConfig({ ...base, snap: .55, bias: .5 }, 8)).toBeNull();
    expect(validateKnobReferenceConfig({ ...base, snap: .55, bias: .50001 }, 8)).toMatch("中心偏置");
    const sample = parseKnobTelemetry(editableReferencePacket());
    const draft = knobEditableConfig(sample.config);
    draft.reference_modes!["8"]!.width = 0;
    expect(validateKnobConfig(draft, 4.5, 1000, undefined, 17)).toMatch("模式 8");
  });

  it("omits unchanged banks during mode selection and sends only the edited mode", () => {
    const wire = editableReferencePacket(), sample = parseKnobTelemetry(wire);
    const selected = { ...knobEditableConfig(sample.config), mode: 14 };
    expect(knobReferenceChanged(selected, sample.config)).toBe(false);
    expect(knobConfigurePayload(selected, sample).reference_modes).toBeUndefined();
    const draft = knobEditableConfig(sample.config);
    draft.reference_modes!["8"]!.strength = 28;
    expect(knobReferenceChanged(draft, sample.config)).toBe(true);
    const payload = knobConfigurePayload(draft, sample);
    expect(payload.reference_modes).toEqual({ "8": { ...wire.config.reference_modes["8"], strength: 28 } });
    expect(payload.frictionless).toBeUndefined();
    expect(sample.config.reference_modes!["8"]!.strength).toBe(20);
    expect(knobConfigureRequestError(draft, sample)).toBeNull();
  });

  it("preserves raw nested numbers and device extensions while ignoring injected cache fields", () => {
    const wire = editableReferencePacket();
    Object.assign(wire.config.reference_modes["14"]!, { firmware_extension: { keep: true } });
    const sample = parseKnobTelemetry(wire), draft = knobEditableConfig(sample.config);
    Object.assign(draft.reference_modes!["14"]!, { cached_host_only: true });
    draft.reference_modes!["14"]!.magnetic_positions = [3, 12];
    const payload = knobConfigurePayload(draft, sample);
    expect(payload.reference_modes).toEqual({ "14": { ...wire.config.reference_modes["14"], magnetic_positions: [3, 12] } });
    expect(payload.reference_modes!["14"]!.damping).toBe(Math.fround(.1));
    expect(payload.reference_modes!["14"]!.scale).toBe(Math.fround(.0875));
    expect(payload.reference_modes!["14"]).not.toHaveProperty("cached_host_only");
  });

  it("does not introduce editable banks into old firmware and requires idle only for changed reference settings", () => {
    const old = parseKnobTelemetry(recordedReferencePacket);
    expect(() => knobConfigurePayload({ ...old.config, reference_modes: referenceBank() }, old)).toThrow("尚未开放");
    for (const state of ["active", "fault", "offsets"] as const) {
      const sample = parseKnobTelemetry({ ...editableReferencePacket(), state });
      expect(() => knobConfigurePayload({ ...sample.config, mode: 14 }, sample)).not.toThrow();
      const draft = knobEditableConfig(sample.config); draft.reference_modes!["8"]!.strength = 21;
      expect(() => knobConfigurePayload(draft, sample)).toThrow("请先停机");
    }
  });

  it("checks the USB byte budget using UTF-8 rather than character count", () => {
    const wire = editableReferencePacket();
    Object.assign(wire.config.reference_modes["8"]!, { extension: "参".repeat(500) });
    const sample = parseKnobTelemetry(wire), draft = knobEditableConfig(sample.config);
    draft.reference_modes!["8"]!.strength = 21;
    const payload = knobConfigurePayload(draft, sample);
    expect(JSON.stringify({ op: "configure", config: payload }).length).toBeLessThan(1900);
    expect(knobConfigureRequestError(draft, sample)).toMatch("单帧容量");
    expect(knobConfigureRequestError({ ...sample.config, mode: 14 }, sample)).toBeNull();
  });
});

describe("SmartKnob reference parameter transport", () => {
  const mockedInvoke = vi.mocked(invoke);
  beforeEach(() => mockedInvoke.mockReset());
  it("reads firmware defaults without applying, saving or stopping and keeps them detached from the live bank", async () => {
    const wire = editableReferencePacket(), defaults = referenceBank(); defaults["8"]!.strength = 38;
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 91, portName: "COM7" })
      .mockResolvedValueOnce(wire).mockResolvedValueOnce({ ...wire, reference_defaults: defaults });
    const gateway = new KnobGateway(); await gateway.connect("COM7"); await gateway.request("status");
    const result = await gateway.referenceDefaults();
    expect(mockedInvoke).toHaveBeenLastCalledWith("knob_request", { expectedSessionId: 91, request: { op: "status", reference_defaults: true } });
    expect(result).toEqual(defaults); result["8"]!.strength = 40;
    expect(defaults["8"]!.strength).toBe(38);
    expect(wire.config.reference_modes["8"]!.strength).toBe(20);
    expect(mockedInvoke.mock.calls.filter(([command]) => command === "knob_request").map(([, args]) => (args as { request?: { op: string } }).request?.op)).toEqual(["status", "status"]);
  });

  it("does not query defaults on unsupported devices or disconnect when defaults are unavailable", async () => {
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 92, portName: "COM7" }).mockResolvedValueOnce(recordedReferencePacket);
    const old = new KnobGateway(); await old.connect("COM7"); await old.request("status");
    await expect(old.referenceDefaults()).rejects.toThrow("尚未开放");
    expect(mockedInvoke).toHaveBeenCalledTimes(2); expect(old.isConnected()).toBe(true);
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 93, portName: "COM7" })
      .mockResolvedValueOnce(editableReferencePacket()).mockResolvedValueOnce(editableReferencePacket());
    const current = new KnobGateway(); await current.connect("COM7"); await current.request("status");
    await expect(current.referenceDefaults()).rejects.toThrow("没有提供");
    expect(current.isConnected()).toBe(true);
  });

  it("clones queued reference edits and never retries rejected or oversized writes", async () => {
    const wire = editableReferencePacket();
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 94, portName: "COM7" }).mockResolvedValueOnce(wire);
    const gateway = new KnobGateway(); await gateway.connect("COM7"); const sample = await gateway.request("status");
    const draft = knobEditableConfig(sample.config); draft.reference_modes!["14"]!.magnetic_positions = [3, 12];
    mockedInvoke.mockResolvedValueOnce({ ...wire, ok: false, error: "disable_before_reference_config" });
    const pending = gateway.request("configure", draft); draft.reference_modes!["14"]!.magnetic_positions.push(13);
    expect((await pending).ok).toBe(false);
    expect(mockedInvoke.mock.calls[2]?.[1]).toMatchObject({ request: { config: { reference_modes: { "14": { magnetic_positions: [3, 12] } } } } });
    expect(gateway.isConnected()).toBe(true); expect(mockedInvoke).toHaveBeenCalledTimes(3);
    const hugeWire = editableReferencePacket(); Object.assign(hugeWire.config.reference_modes["14"]!, { extension: "参".repeat(600) });
    mockedInvoke.mockResolvedValueOnce(hugeWire);
    const huge = knobEditableConfig((await gateway.request("status")).config); huge.reference_modes!["14"]!.strength = 21;
    const before = mockedInvoke.mock.calls.length;
    await expect(gateway.request("configure", huge)).rejects.toThrow("单帧容量");
    expect(mockedInvoke).toHaveBeenCalledTimes(before); expect(gateway.isConnected()).toBe(true);
  });
});

describe("SmartKnob detached lifecycle", () => {
  const mockedInvoke = vi.mocked(invoke);
  beforeEach(() => mockedInvoke.mockReset());
  it("initialization and teardown without an owned session send no unscoped action", async () => {
    const gateway = new KnobGateway();
    await gateway.initialize(); await gateway.disconnect();
    expect(mockedInvoke).not.toHaveBeenCalled();
    expect(gateway.isConnected()).toBe(false);
  });
  it("connect/read/detach never issue a motor mutation", async () => {
    const gateway = new KnobGateway();
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 81, portName: "COM7" })
      .mockResolvedValueOnce(recordedReferencePacket).mockResolvedValueOnce(undefined);
    await gateway.connect("COM7"); await gateway.request("status"); await gateway.disconnect();
    expect(mockedInvoke.mock.calls.map(([command]) => command)).toEqual(["knob_connect", "knob_request", "knob_disconnect"]);
    expect(mockedInvoke.mock.calls[1]?.[1]).toEqual({ expectedSessionId: 81, request: { op: "status" } });
    expect(mockedInvoke.mock.calls[2]?.[1]).toEqual({ expectedSessionId: 81 });
  });
  it("cancels a pending connect by releasing only its returned session", async () => {
    let resolveConnect!: (value: unknown) => void;
    mockedInvoke.mockImplementationOnce(() => new Promise(resolve => { resolveConnect = resolve; }));
    const gateway = new KnobGateway();
    const connected = gateway.connect("COM7");
    const rejected = expect(connected).rejects.toThrow("会话已改变");
    await gateway.disconnect();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    mockedInvoke.mockResolvedValueOnce(undefined);
    resolveConnect({ connected: true, sessionId: 82, portName: "COM7" });
    await rejected;
    expect(mockedInvoke).toHaveBeenLastCalledWith("knob_disconnect", { expectedSessionId: 82 });
    expect(gateway.isConnected()).toBe(false);
  });
  it("snapshots queued nested parameters and keeps firmware rejections connected", async () => {
    const gateway = new KnobGateway();
    mockedInvoke.mockResolvedValueOnce({ connected: true, sessionId: 83, portName: "COM7" })
      .mockResolvedValueOnce(recordedReferencePacket);
    await gateway.connect("COM7");
    const sample = await gateway.request("status");
    const draft = knobEditableConfig(sample.config);
    draft.frictionless!.friction = .03;
    mockedInvoke.mockResolvedValueOnce({ ...recordedReferencePacket, ok: false, error: "busy" });
    const configured = gateway.request("configure", draft);
    draft.frictionless!.friction = .04;
    const reply = await configured;
    expect(reply.ok).toBe(false);
    expect(gateway.isConnected()).toBe(true);
    expect(mockedInvoke).toHaveBeenLastCalledWith("knob_request", { expectedSessionId: 83,
      request: { op: "configure", config: { ...recordedReferencePacket.config, frictionless: { ...recordedReferencePacket.config.frictionless, friction: .03 } } } });
  });
});

// Captured from COM7 after the production restart, 2026-11-04:
// esp32s3-usb-foc/build/haptic-v4-20261104/final.json. Kept inline so the
// regression does not depend on a hardware log directory on the test machine.
const recordedV4Packet = {
  id: 60, device: "smartknob-s3", protocol: 1, firmware: "dma-localized-v4",
  current_sampling: "pwm_triggered_adc_gdma", control_nominal_hz: 5000, encoder_nominal_hz: 2500, pwm_hz: 20000,
  detent_profile: "localized_barrier", detent_quiet_velocity: false, haptic_position_filter: false, current_target_slew: false,
  host_lease_ms: 0, current_feedforward_ohms: 0, reset_reason: 11, uptime_ms: 131312, minimum_free_heap: 266304,
  current_limit_max: 4.5, strength_max: 100, current_absolute_trip: 6, current_peak_trip: 5,
  current_peak_trip_ms: 1, current_overload_trip_ms: 20, current_trip_recovery_ratio: 4,
  current_trip_limit: 1, current_target_limit: 0, current_limited: false, quiet_output: false,
  haptic_scale: 0, speed_limited: false, haptic_paused: false, haptic_fade_start: 25, haptic_speed_cutoff: 40,
  haptic_resume_speed: 5, haptic_resume_hold_ms: 30, haptic_fade_in_ms: 500, detent_assist_fade_start: 10,
  detent_assist_cutoff: 25, elastic_min_damping: 0.03999999910593033, fault_current_valid: false,
  fault_current_trip_limit: 0, fault_currents: [0, 0, 0], transport: "usb_serial_jtag", encoder: "MT6701",
  encoder_interface: "ssi_spi_dma", encoder_resolution_bits: 14, encoder_dma: true, weak_magnet_allowed: false,
  ok: true, state: "idle", fault: "none", hardware_detail: "none", hardware_error: 0, encoder_error: 0,
  fault_magnet: 0, encoder_failures: 0, encoder_retries: 0, voltage_d: 0, voltage_q: 0,
  angle: 3.507063627243042, velocity: 1.5414283107572988e-44, velocity_fast: 0, position: 0, sub_position: 0,
  iq: 0.017465807497501373, id_current: -0.0012009999481961131, target: 0, magnet: 0, current_valid: false,
  rejected_samples: 36, reused_samples: 0, missed_samples: 41, control_cycles: 656044, control_hz: 4990,
  control_interval_us: 200, control_max_us: 58, encoder_age_us: 232, encoder_age_max_us: 437,
  adc_dma_words: [28671, 45055], sample_us: 20, loop_us: 10, encoder_us: 50, control_us: 2,
  sample_start_tick: -547, sample_end_tick: 967,
  currents: [0.01245498564094305, 0.004427433013916016, -0.01688241958618164],
  sense_volts: [1.630000114440918, 1.6290000677108765, 1.6200001239776611],
  offsets: [1.6281318664550781, 1.628335952758789, 1.6247588396072388], duty: [0, 0, 0],
  config: { bus_voltage: 11.619999885559082, sense_gain: 0.15000000596046448, current_limit: 0.800000011920929,
    voltage_limit: 2.3499999046325684, current_kp: 0.4000000059604645, current_ki: 200, width: 0.1745329201221466,
    strength: 20, endstop: 20, damping: 0.003000000026077032, snap: 0.550000011920929,
    mode: 1, min_position: 0, max_position: 11 },
  calibration: { valid: true, direction: 1, pole_pairs: 7, electrical_zero: 0.2768845558166504 },
};
