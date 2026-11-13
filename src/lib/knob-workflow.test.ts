import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import v22 from "./__fixtures__/knob-v22-status.json";
import { knobConfigurePayload, parseKnobTelemetry, type KnobCalibrationOptions, type KnobConfig, type KnobOp, type KnobTelemetry } from "./knob";
import { KnobWorkflow, selectKnobPort, type KnobWorkflowGateway } from "./knob-workflow";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
class Device implements KnobWorkflowGateway {
  connected = false;
  sample: KnobTelemetry = { ...parseKnobTelemetry(v22), live_haptics_config: true, state: "idle", fault: "none", adc_sample_valid: true, encoder_age_us: 100, sampling_restart_required: false };
  calls: { op: string; config?: KnobConfig; options?: KnobCalibrationOptions }[] = [];
  gate?: ReturnType<typeof deferred>;
  rejected = "";
  transportFailure = "";
  calibrationFinishes = true;
  calibrationFails = false;
  private calibrating = false;
  private enabling = false;
  async connect() { this.connected = true; }
  async disconnect() { this.connected = false; }
  isConnected() { return this.connected; }
  async referenceDefaults() { return structuredClone(this.sample.config.reference_modes!); }
  async calibrate(options: KnobCalibrationOptions) {
    this.calls.push({ op: "calibrate", options }); this.calibrating = true; this.sample.state = "offsets";
    return structuredClone(this.sample);
  }
  async request(op: KnobOp, config?: KnobConfig): Promise<KnobTelemetry> {
    const wire = config ? knobConfigurePayload(config, this.sample) : undefined;
    this.calls.push({ op, config: wire });
    if (this.transportFailure === op) { this.connected = false; throw new Error("USB timeout"); }
    if (this.rejected === op) return { ...structuredClone(this.sample), ok: false, error: `${op}_failed` };
    if (op === "configure") {
      const gate = this.gate; this.gate = undefined; if (gate) await gate.promise;
      const references = { ...this.sample.config.reference_modes, ...wire?.reference_modes };
      this.sample.config = { ...this.sample.config, ...wire!, reference_modes: references };
    }
    if (op === "status" && this.calibrating && this.calibrationFinishes) {
      this.sample.state = "idle"; this.sample.calibration.valid = !this.calibrationFails;
      this.sample.calibration_report = { stage: this.calibrationFails ? "failed" : "complete", error: "none", passed: !this.calibrationFails };
      this.calibrating = false;
    }
    if (op === "status" && this.enabling) { this.sample.state = "active"; this.enabling = false; }
    if (op === "enable") { this.enabling = true; this.sample.state = "offsets"; }
    if (op === "disable") { this.sample.state = "idle"; this.enabling = this.calibrating = false; }
    return structuredClone(this.sample);
  }
  writes() { return this.calls.filter(call => call.op !== "status"); }
}
describe("SmartKnob live workflow", () => {
  let device: Device, workflow: KnobWorkflow;
  beforeEach(() => { vi.useFakeTimers(); device = new Device(); workflow = new KnobWorkflow(device); });
  afterEach(async () => { await workflow.disconnect(); vi.useRealTimers(); });
  const tick = () => vi.advanceTimersByTimeAsync(5);
  const tune = (value: number) => {
    const entry = workflow.snapshot().editor.draft.reference_modes!["12"]!;
    workflow.editReference({ ...entry, strength: value }); workflow.commit(150);
  };
  async function active(mode = 12) { device.sample.state = "active"; device.sample.config.mode = mode; await workflow.connect("COM_TEST"); }

  it("merges repeated adjustments, preserves editing during polling, and never restarts the motor", async () => {
    await active(); tune(21); await vi.advanceTimersByTimeAsync(80); tune(22);
    await workflow.poll(); expect(workflow.snapshot().editor.draft.reference_modes!["12"]!.strength).toBe(22);
    await vi.advanceTimersByTimeAsync(149); expect(device.writes()).toHaveLength(0);
    await tick(); expect(device.writes()).toHaveLength(1);
    expect(device.writes()[0]!.config!.reference_modes!["12"]!.strength).toBe(22);
    expect(device.sample.state).toBe("active"); expect(workflow.snapshot().applyState).toBe("applied");
  });
  it("keeps new input when a configure acknowledgement arrives late", async () => {
    await active(); device.gate = deferred(); const gate = device.gate;
    tune(30); await vi.advanceTimersByTimeAsync(150);
    tune(31); gate.resolve(); await tick();
    expect(workflow.snapshot().editor.draft.reference_modes!["12"]!.strength).toBe(31);
    await vi.advanceTimersByTimeAsync(150);
    expect(device.writes().map(call => call.config!.reference_modes!["12"]!.strength)).toEqual([30, 31]);
    expect(workflow.snapshot().conflict).toBe(false);
  });
  it("sends a reversion to the previous value even while its replacement is in flight", async () => {
    await active(); const initial = device.sample.config.reference_modes!["12"]!.strength;
    device.gate = deferred(); const gate = device.gate; tune(35); await vi.advanceTimersByTimeAsync(150);
    tune(initial); gate.resolve(); await vi.advanceTimersByTimeAsync(160);
    expect(device.sample.config.reference_modes!["12"]!.strength).toBe(initial);
    expect(device.writes()).toHaveLength(2);
  });
  it("allows switching away from invalid input and restores it when returning", async () => {
    await active(); tune(Number.NaN); workflow.switchMode(16); await tick();
    expect(device.sample.config.mode).toBe(16);
    expect(device.writes()).toHaveLength(1); expect(device.writes()[0]!.config!.reference_modes).toBeUndefined();
    workflow.switchMode(12); await tick();
    expect(Number.isNaN(workflow.snapshot().editor.draft.reference_modes!["12"]!.strength)).toBe(true);
    expect(device.sample.config.reference_modes!["12"]!.strength).toBe(20);
  });
  it("submits a valid outgoing mode before a quick sequence of mode selections", async () => {
    await active(); tune(27); workflow.switchMode(14); workflow.switchMode(16); await tick();
    const writes = device.writes(); expect(writes).toHaveLength(2);
    expect(writes[0]!.config!.reference_modes!["12"]!.strength).toBe(27);
    expect(writes[1]!.config!.mode).toBe(16); expect(workflow.snapshot().editor.draft.mode).toBe(16);
    for (const write of writes) expect(new TextEncoder().encode(JSON.stringify(write)).length).toBeLessThan(1900);
  });
  it("preserves invalid old-mode numbers without preventing a different mode", async () => {
    await active(1); workflow.edit("width", NaN); workflow.switchMode(12); await tick();
    expect(device.sample.config.mode).toBe(12);
    workflow.switchMode(1); await tick(); expect(Number.isNaN(workflow.snapshot().editor.draft.width)).toBe(true);
  });
  it("never includes electrical input or unchanged frictionless parameters in live requests", async () => {
    await active(); workflow.edit("current_kp", 9); tune(24); await vi.advanceTimersByTimeAsync(160);
    const config = device.writes()[0]!.config!;
    expect(config.current_kp).toBe(device.sample.config.current_kp); expect(config.frictionless).toBeUndefined();
    expect(workflow.snapshot().electrical.current_kp).toBe(9);
  });
  it("pauses on external configuration changes without overwriting either device or input", async () => {
    await active(); tune(32); device.sample.config.current_limit = .3; await workflow.poll(); await vi.advanceTimersByTimeAsync(200);
    expect(workflow.snapshot().conflict).toBe(true); expect(device.writes()).toHaveLength(0);
    expect(workflow.snapshot().editor.draft.reference_modes!["12"]!.strength).toBe(32);
    workflow.restore(); expect(workflow.snapshot().conflict).toBe(false); expect(workflow.snapshot().editor.draft.current_limit).toBe(.3);
  });
  it("keeps old firmware reference edits pending while still switching modes", async () => {
    await active(); device.sample.live_haptics_config = false; await workflow.poll();
    tune(34); workflow.switchMode(16); await tick();
    expect(device.writes()).toHaveLength(1); expect(device.writes()[0]!.config!.mode).toBe(16);
    expect(workflow.snapshot().error).toContain("升级固件");
  });
  it("aborts queued configuration on stop, disconnect or rejected writes", async () => {
    await active(); tune(25); await workflow.stop(); await vi.advanceTimersByTimeAsync(200);
    expect(device.writes().map(call => call.op)).toEqual(["disable"]);
    tune(26); await workflow.disconnect(); await vi.advanceTimersByTimeAsync(200);
    expect(device.writes()).toHaveLength(1);
    await workflow.connect("COM_TEST"); device.rejected = "configure"; tune(27); await vi.advanceTimersByTimeAsync(200);
    expect(workflow.snapshot().applyState).toBe("failed");
    await vi.advanceTimersByTimeAsync(1000); expect(device.writes()).toHaveLength(2);
  });
  it("does not replay offline preview and starts a calibrated device without save or recalibration", async () => {
    workflow.edit("strength", 999); workflow.commit(); const saved = device.sample.config.strength;
    await workflow.start("COM_TEST");
    expect(device.sample.config.strength).toBe(saved);
    expect(device.writes().map(call => call.op)).toEqual(["enable"]);
    expect(workflow.snapshot().status!.state).toBe("active");
  });
  it("treats connecting to an already running device as successful startup", async () => {
    device.sample.state = "active"; await workflow.start("COM_TEST"); expect(device.writes()).toHaveLength(0);
  });
  it("flushes valid outgoing old-mode input when startup overtakes the debounce queue", async () => {
    await workflow.connect("COM_TEST");
    workflow.edit("strength", 17); workflow.switchMode(12);
    await workflow.start("COM_TEST");
    expect(device.sample.state).toBe("active");
    expect(device.sample.config.strength).toBe(17); expect(device.sample.config.mode).toBe(12);
    expect(device.writes().map(call => call.op)).toEqual(["configure", "configure", "enable"]);
  });
  it("calibrates within the current budget, saves once and then enables", async () => {
    device.sample.calibration.valid = false; device.sample.config.current_limit = .1;
    await workflow.start("COM_TEST");
    expect(device.writes().map(call => call.op)).toEqual(["calibrate", "save", "enable"]);
    expect(device.writes()[0]!.options).toEqual({ current: .1, max_current: .1, voltage: 3 });
    await workflow.stop(); await workflow.start("COM_TEST");
    expect(device.writes().filter(call => call.op === "save")).toHaveLength(1);
  });
  it.each(["calibration", "save"])("does not enable after %s failure", async kind => {
    device.sample.calibration.valid = false; device.calibrationFails = kind === "calibration"; device.rejected = kind === "save" ? "save" : "";
    await workflow.start("COM_TEST"); expect(workflow.snapshot().error).not.toBe("");
    expect(device.writes().some(call => call.op === "enable")).toBe(false);
  });
  it("cancels an in-progress calibration and never saves or enables later", async () => {
    device.sample.calibration.valid = false; device.calibrationFinishes = false;
    const starting = workflow.start("COM_TEST"); await tick();
    expect(workflow.snapshot().phase).toContain("自动校准");
    await workflow.stop(); await starting; device.calibrationFinishes = true; await vi.advanceTimersByTimeAsync(150000);
    expect(device.writes().map(call => call.op)).toEqual(["calibrate", "disable"]);
  });
  it("times out calibration without retries or automatic enable", async () => {
    device.sample.calibration.valid = false; device.calibrationFinishes = false;
    const starting = workflow.start("COM_TEST"); await vi.advanceTimersByTimeAsync(130100); await starting;
    expect(workflow.snapshot().error).toContain("超时"); expect(device.writes().map(call => call.op)).toEqual(["calibrate"]);
  });
  it("reports a lost enable reply as unknown state and never repeats enable", async () => {
    device.transportFailure = "enable"; await workflow.start("COM_TEST");
    expect(workflow.snapshot().connected).toBe(false); expect(workflow.snapshot().error).toContain("timeout");
    await vi.advanceTimersByTimeAsync(6000); expect(device.writes().map(call => call.op)).toEqual(["enable"]);
  });
  it("requires electrical changes to be applied separately before startup", async () => {
    await workflow.connect("COM_TEST"); workflow.edit("current_kp", 2); await workflow.start("COM_TEST");
    expect(device.writes()).toHaveLength(0); expect(workflow.snapshot().error).toContain("电气");
    await workflow.applyElectrical(); expect(device.sample.config.current_kp).toBe(2);
    await workflow.start("COM_TEST"); expect(device.writes().map(call => call.op)).toEqual(["configure", "enable"]);
  });
  it("validates advertised hot-update capability instead of guessing from version text", () => {
    expect(parseKnobTelemetry({ ...v22, live_haptics_config: true }).live_haptics_config).toBe(true);
    expect(parseKnobTelemetry(v22).live_haptics_config).toBeUndefined();
    expect(() => parseKnobTelemetry({ ...v22, live_haptics_config: "true" })).toThrow("live_haptics_config");
  });
  it("restores only known fields of the selected mode and preserves device extensions", async () => {
    await active();
    const original = structuredClone(device.sample.config.reference_modes!);
    Object.assign(device.sample.config.reference_modes!["12"]!, { future: { keep: true } });
    await workflow.poll();
    device.referenceDefaults = async () => {
      const defaults = structuredClone(original);
      Object.assign(defaults["12"]!, { strength: 19, future: { keep: false } });
      return defaults;
    };
    await workflow.restoreReferenceDefaults(); await tick();
    expect(device.sample.config.reference_modes!["12"]).toMatchObject({ strength: 19, future: { keep: true } });
    expect(device.sample.config.reference_modes!["11"]).toEqual(original["11"]);
    expect(device.writes().map(call => call.op)).toEqual(["configure"]);
  });
  it("only auto-selects a unique ESP32 port, retaining explicit user selection", () => {
    const ports = [{ name: "COM1", portType: "unknown" }, { name: "COM7", portType: "usb", vid: 0x303a, pid: 0x1001 }];
    expect(selectKnobPort(ports)).toBe("COM7"); expect(selectKnobPort(ports, "COM1")).toBe("COM1");
    expect(selectKnobPort([...ports, { ...ports[1]!, name: "COM8" }])).toBe("");
    expect(selectKnobPort(ports.slice(0, 1))).toBe("");
  });
});
