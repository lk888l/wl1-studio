import {
  defaultKnobConfig, knobConfigureRequestError, knobCurrentLimitMax, knobEditableConfig,
  knobMessages, knobModeCount, knobReferenceEditableKeys, knobStrengthMax, validateKnobConfig,
  type KnobCalibrationOptions, type KnobConfig, type KnobFrictionlessConfig,
  type KnobOp, type KnobReferenceModeConfig, type KnobReferenceModes, type KnobTelemetry,
} from "./knob";
import type { SerialPortOption } from "../types";

export const electricalKeys = ["bus_voltage", "sense_gain", "current_kp", "current_ki"] as const;
const legacyKeys = ["width", "strength", "endstop", "damping", "snap", "min_position", "max_position"] as const;
export type KnobField = Exclude<keyof KnobConfig, "voltage_limit" | "frictionless" | "reference_modes">;
export type ElectricalDraft = Pick<KnobConfig, typeof electricalKeys[number]>;
export interface KnobEditor { base: KnobConfig; draft: KnobConfig }
export function sameKnobValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  return keys.length === Object.keys(right).length && keys.every(key => Object.hasOwn(right, key) && sameKnobValue(left[key], right[key]));
}
export const sameKnobConfig = (a: KnobConfig, b: KnobConfig) => sameKnobValue(a, b);
export function createKnobEditor(config: KnobConfig): KnobEditor {
  return { base: knobEditableConfig(config), draft: knobEditableConfig(config) };
}
export function knobEditorDirty(editor: KnobEditor): boolean { return !sameKnobConfig(editor.base, editor.draft); }
export function reconcileKnobEditor(editor: KnobEditor, config: KnobConfig): KnobEditor {
  return knobEditorDirty(editor) ? editor : createKnobEditor(config);
}
export function knobEditorConflict(editor: KnobEditor, config: KnobConfig | undefined): boolean {
  return config !== undefined && knobEditorDirty(editor) && !sameKnobConfig(editor.base, knobEditableConfig(config));
}
// Acknowledgements may normalize float32 values. Rebase only unchanged input;
// a newer keystroke, mode selection or reference edit must survive the reply.
function rebase(base: unknown, draft: unknown, sent: unknown, actual: unknown, submitted: unknown): unknown {
  if (sameKnobValue(draft, submitted) && (sameKnobValue(submitted, sent) || sameKnobValue(submitted, base))) return structuredClone(actual);
  if (!draft || typeof draft !== "object" || Array.isArray(draft) || !actual || typeof actual !== "object") return structuredClone(draft);
  const b = (base ?? {}) as Record<string, unknown>, d = draft as Record<string, unknown>;
  const s = (sent ?? {}) as Record<string, unknown>, a = actual as Record<string, unknown>;
  const before = (submitted ?? {}) as Record<string, unknown>;
  return Object.fromEntries([...new Set([...Object.keys(d), ...Object.keys(a)])].map(key => [key, rebase(b[key], d[key], s[key], a[key], before[key])]));
}
export function acknowledgeKnobEditor(editor: KnobEditor, sent: KnobConfig, actual: KnobConfig, submitted = sent): KnobEditor {
  const next = knobEditableConfig(actual);
  return { base: next, draft: rebase(editor.base, editor.draft, sent, next, submitted) as KnobConfig };
}
const electricalFrom = (c: KnobConfig): ElectricalDraft => Object.fromEntries(electricalKeys.map(key => [key, c[key]])) as ElectricalDraft;
export function selectKnobPort(ports: SerialPortOption[], selected = ""): string {
  if (ports.some(port => port.name === selected)) return selected;
  const candidates = ports.filter(port => port.vid === 0x303a && port.pid === 0x1001);
  return candidates.length === 1 ? candidates[0]!.name : "";
}
export interface KnobWorkflowGateway {
  connect(port: string): Promise<void>; disconnect(): Promise<void>; isConnected(): boolean;
  request(op: KnobOp, config?: KnobConfig): Promise<KnobTelemetry>;
  calibrate(options: KnobCalibrationOptions): Promise<KnobTelemetry>;
  referenceDefaults(): Promise<KnobReferenceModes>;
}
export interface KnobWorkflowView {
  connected: boolean; busy: boolean; sending: boolean; status: KnobTelemetry | null;
  editor: KnobEditor; electrical: ElectricalDraft; conflict: boolean;
  applyState: "editing" | "pending" | "applied" | "failed";
  phase: string; error: string; notice: string;
}
type Unit = "mode" | "current_limit" | `legacy:${number}` | "frictionless" | `reference:${number}`;
interface Pending { value: unknown; at: number }
class Cancelled extends Error { constructor() { super("操作已取消"); } }
const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
const message = (sample: KnobTelemetry) => knobMessages[sample.error ?? sample.fault] ?? sample.error ?? sample.fault;

export class KnobWorkflow {
  private view: KnobWorkflowView = {
    connected: false, busy: false, sending: false, status: null,
    editor: createKnobEditor(defaultKnobConfig), electrical: electricalFrom(defaultKnobConfig),
    conflict: false, applyState: "applied", phase: "", error: "", notice: "",
  };
  private listeners = new Set<() => void>();
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<Unit, Pending>();
  private inFlight?: { unit: Unit; value: unknown };
  private timer?: ReturnType<typeof setTimeout>;
  private epoch = 0;
  private cancellation = new AbortController();
  // Old modes share their wire settings. Only unsubmitted input is kept per
  // mode; an ordinary switch always starts from the latest device settings.
  private legacyDrafts = new Map<number, Pick<KnobConfig, typeof legacyKeys[number]>>();
  constructor(private gateway: KnobWorkflowGateway, private now = () => Date.now()) {}
  snapshot = (): KnobWorkflowView => this.view;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<KnobWorkflowView>) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private enqueue<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action, action); this.tail = result.catch(() => undefined); return result;
  }
  private check(token: number) { if (token !== this.epoch) throw new Cancelled(); }
  private failed(error: unknown, token: number) {
    if (token !== this.epoch || error instanceof Cancelled) return;
    this.pending.clear(); clearTimeout(this.timer);
    this.publish({ error: errorText(error), applyState: "failed", connected: this.gateway.isConnected() });
  }
  private accept(sample: KnobTelemetry, sent?: KnobConfig, fresh = false, submitted?: KnobConfig) {
    const editor = this.view.editor;
    const electricDirty = this.electricalDirty();
    const changed = !sameKnobConfig(editor.base, knobEditableConfig(sample.config));
    const conflict = !fresh && !sent && changed && (knobEditorDirty(editor) || electricDirty || this.legacyDrafts.size > 0);
    if (conflict) { this.pending.clear(); clearTimeout(this.timer); }
    this.publish({ status: sample, connected: true,
      editor: fresh ? createKnobEditor(sample.config) : sent ? acknowledgeKnobEditor(editor, sent, sample.config, submitted) : conflict || !changed ? editor : createKnobEditor(sample.config),
      electrical: fresh || !electricDirty ? electricalFrom(sample.config) : this.view.electrical,
      conflict: fresh ? false : conflict || this.view.conflict,
      ...(conflict ? { error: "设备配置已变化，请还原设备参数后重新编辑", applyState: "failed" as const } : {}),
    });
  }
  private async request(op: KnobOp, token: number, config?: KnobConfig): Promise<KnobTelemetry> {
    this.check(token);
    const submitted = config ? structuredClone(this.view.editor.draft) : undefined;
    const sample = await this.gateway.request(op, config); this.check(token);
    this.accept(sample, sample.ok ? config : undefined, false, submitted);
    if (!sample.ok) throw new Error(message(sample));
    return sample;
  }
  private configError(config: KnobConfig, sample = this.view.status): string | null {
    return validateKnobConfig(config, knobCurrentLimitMax(sample), knobStrengthMax(sample), undefined,
      knobModeCount(sample), sample?.reference_config_version);
  }
  electricalDirty(): boolean { return !sameKnobValue(this.view.electrical, electricalFrom(this.view.editor.base)); }
  dirty(): boolean { return knobEditorDirty(this.view.editor) || this.electricalDirty() || this.legacyDrafts.size > 0; }
  private unitValue(unit: Unit, config: KnobConfig): unknown {
    if (unit.startsWith("legacy:")) return Object.fromEntries(legacyKeys.map(key => [key, config[key]]));
    if (unit.startsWith("reference:")) return config.reference_modes?.[unit.slice(10)];
    return config[unit as "mode" | "current_limit" | "frictionless"];
  }
  private withUnit(base: KnobConfig, unit: Unit, value: unknown): KnobConfig {
    if (unit.startsWith("legacy:")) return { ...base, ...(value as Pick<KnobConfig, typeof legacyKeys[number]>) };
    if (unit.startsWith("reference:")) return { ...base, reference_modes: { ...base.reference_modes, [unit.slice(10)]: structuredClone(value) as KnobReferenceModeConfig } };
    return { ...base, [unit]: structuredClone(value) };
  }
  private modeUnit(mode: number): Unit | undefined {
    return mode <= 3 ? `legacy:${mode}` : mode <= 15 ? `reference:${mode}` : mode === 16 ? "frictionless" : undefined;
  }
  private stage(unit: Unit, delay: number): boolean {
    const { base, draft } = this.view.editor;
    const value = this.unitValue(unit, draft);
    const reverting = this.inFlight?.unit === unit && !sameKnobValue(value, this.inFlight.value);
    if (value === undefined || (sameKnobValue(value, this.unitValue(unit, base)) && !reverting)) { this.pending.delete(unit); return true; }
    const config = this.withUnit(base, unit, value), validation = this.configError(config);
    if (validation) { this.pending.delete(unit); this.publish({ error: validation, applyState: "editing" }); return false; }
    if (unit.startsWith("reference:") && this.view.status?.state === "active" && this.view.status.live_haptics_config !== true) {
      this.pending.delete(unit);
      this.publish({ error: "此固件需停机应用参考参数；升级固件后可运行中自动生效", applyState: "editing" }); return false;
    }
    if (this.view.connected) this.pending.set(unit, { value: structuredClone(value), at: this.now() + delay });
    return true;
  }
  commit(delay = 0) {
    if (this.view.busy || this.view.conflict) return;
    this.publish({ error: "" });
    const common = this.stage("current_limit", delay), unit = this.modeUnit(this.view.editor.draft.mode);
    const mode = unit ? this.stage(unit, delay) : true;
    this.publish({ applyState: this.pending.size ? "pending" : common && mode && !this.dirty() ? "applied" : "editing" });
    this.schedule();
  }
  edit(key: KnobField, value: number) {
    if (this.view.busy) return;
    if ((electricalKeys as readonly string[]).includes(key)) {
      this.publish({ electrical: { ...this.view.electrical, [key]: value }, error: "" }); return;
    }
    if (key === "mode") { this.switchMode(value); return; }
    this.pending.delete(key === "current_limit" ? "current_limit" : `legacy:${this.view.editor.draft.mode}`);
    this.publish({ editor: { ...this.view.editor, draft: { ...this.view.editor.draft, [key]: value } }, applyState: "editing", error: "", notice: "" });
  }
  editReference(value: KnobReferenceModeConfig) {
    if (this.view.busy) return;
    const mode = this.view.editor.draft.mode;
    this.pending.delete(`reference:${mode}`);
    this.publish({ editor: { ...this.view.editor, draft: this.withUnit(this.view.editor.draft, `reference:${mode}`, value) }, applyState: "editing", error: "", notice: "" });
  }
  editFrictionless(key: keyof KnobFrictionlessConfig, value: number) {
    const config = this.view.editor.draft.frictionless;
    if (this.view.busy || !config) return;
    this.pending.delete("frictionless");
    this.publish({ editor: { ...this.view.editor, draft: { ...this.view.editor.draft, frictionless: { ...config, [key]: value } } }, applyState: "editing", error: "", notice: "" });
  }
  switchMode(mode: number) {
    if (this.view.busy || !Number.isInteger(mode) || mode < 0 || mode >= knobModeCount(this.view.status)) return;
    this.commit();
    const old = this.view.editor.draft, base = this.view.editor.base;
    if (old.mode <= 3 && !sameKnobValue(this.unitValue(`legacy:${old.mode}`, old), this.unitValue(`legacy:${old.mode}`, base))) {
      this.legacyDrafts.set(old.mode, this.unitValue(`legacy:${old.mode}`, old) as Pick<KnobConfig, typeof legacyKeys[number]>);
    }
    const legacy = mode <= 3 ? this.legacyDrafts.get(mode) ?? this.unitValue(`legacy:${mode}`, base) : this.unitValue("legacy:0", base);
    if (mode <= 3) this.legacyDrafts.delete(mode);
    const draft = { ...old, ...(legacy as Pick<KnobConfig, typeof legacyKeys[number]>), mode };
    this.publish({ editor: { ...this.view.editor, draft }, notice: "" });
    this.pending.delete("mode"); this.stage("mode", 0); this.schedule();
  }
  preset(values: Partial<KnobConfig> & { mode: number }) {
    if (this.view.busy) return;
    this.switchMode(values.mode);
    this.publish({ editor: { ...this.view.editor, draft: { ...this.view.editor.draft, ...values } } });
    this.commit();
  }
  private schedule() {
    clearTimeout(this.timer);
    if (!this.view.connected || this.view.busy || this.view.sending || this.view.conflict || !this.pending.size) return;
    const at = Math.min(...[...this.pending.values()].map(item => item.at));
    this.timer = setTimeout(() => { void this.drain(); }, Math.max(0, at - this.now()));
  }
  private async send(unit: Unit, item: Pending, token: number) {
    const sample = await this.request("status", token);
    if (this.view.conflict) throw new Error("设备配置已变化，请还原设备参数后重新编辑");
    if (sample.state !== "idle" && sample.state !== "active") throw new Error("请等待当前动作结束或处理故障后再调参");
    // It may have been replaced or withdrawn while the status read was in flight.
    if (this.pending.get(unit) !== item) return;
    const config = this.withUnit(knobEditableConfig(sample.config), unit, item.value);
    const error = knobConfigureRequestError(config, sample);
    if (error) throw new Error(error);
    this.pending.delete(unit);
    if (!sameKnobConfig(config, knobEditableConfig(sample.config))) {
      this.inFlight = { unit, value: item.value };
      try { await this.request("configure", token, config); }
      finally { this.inFlight = undefined; }
    }
    if (unit.startsWith("legacy:")) {
      for (const [mode, draft] of this.legacyDrafts) if (sameKnobValue(draft, item.value)) this.legacyDrafts.delete(mode);
    }
  }
  private async drain() {
    if (this.view.sending || this.view.busy || !this.view.connected || this.view.conflict) return;
    const token = this.epoch;
    this.publish({ sending: true });
    try {
      await this.enqueue(async () => {
        this.check(token);
        while (this.pending.size && !this.view.busy) {
          const entry = [...this.pending].find(([, item]) => item.at <= this.now());
          if (!entry) break;
          await this.send(entry[0], entry[1], token); this.check(token);
        }
        this.publish({ applyState: this.pending.size ? "pending" : this.dirty() ? "editing" : "applied" });
      });
    } catch (error) { this.failed(error, token); }
    finally { if (token === this.epoch) { this.publish({ sending: false }); this.schedule(); } }
  }
  async poll() {
    if (!this.view.connected || this.view.busy || this.view.sending) return;
    const token = this.epoch;
    try { await this.enqueue(async () => { if (!this.view.busy && !this.view.sending) await this.request("status", token); }); }
    catch (error) { this.failed(error, token); }
  }
  private cancel() {
    ++this.epoch; this.cancellation.abort(); this.cancellation = new AbortController();
    clearTimeout(this.timer); this.pending.clear();
    this.publish({ busy: false, sending: false, phase: "" });
  }
  async disconnect() {
    this.cancel(); this.legacyDrafts.clear(); this.publish({ connected: false });
    await this.gateway.disconnect();
  }
  private async operation(action: (token: number) => Promise<void>) {
    if (this.view.busy) return;
    const token = this.epoch;
    clearTimeout(this.timer); this.publish({ busy: true, error: "", notice: "" });
    try { await this.enqueue(async () => { this.check(token); await action(token); }); }
    catch (error) { this.failed(error, token); }
    finally { if (token === this.epoch) { this.publish({ busy: false, phase: "" }); this.schedule(); } }
  }
  private async attach(port: string, token: number) {
    if (!port) throw new Error("请选择要连接的旋钮串口");
    this.publish({ phase: "连接并读取设备" });
    await this.gateway.connect(port); this.check(token);
    const sample = await this.gateway.request("status"); this.check(token);
    if (!sample.ok) throw new Error(message(sample));
    this.pending.clear(); this.legacyDrafts.clear(); this.accept(sample, undefined, true);
    this.publish({ applyState: "applied" });
  }
  connect(port: string) { return this.operation(token => this.attach(port, token)); }
  private async flush(token: number) {
    if (this.view.conflict) throw new Error("设备配置已变化，请还原设备参数后重新编辑");
    const error = this.configError(this.view.editor.draft);
    if (error) throw new Error(error);
    for (const [mode, value] of this.legacyDrafts) {
      const unit: Unit = `legacy:${mode}`;
      const invalid = this.configError(this.withUnit(this.view.editor.base, unit, value));
      if (invalid) throw new Error(`模式 ${mode} 还有无效输入：${invalid}`);
      this.pending.set(unit, { value: structuredClone(value), at: this.now() });
    }
    for (const unit of ["current_limit", `legacy:${this.view.editor.draft.mode}`, "frictionless", ...Object.keys(this.view.editor.draft.reference_modes ?? {}).map(id => `reference:${id}`), "mode"] as Unit[]) {
      if (!this.stage(unit, 0)) throw new Error(this.view.error);
    }
    while (this.pending.size) { const [unit, item] = [...this.pending][0]!; await this.send(unit, item, token); }
    this.publish({ applyState: "applied" });
  }
  private sleep(token: number): Promise<void> {
    this.check(token);
    const signal = this.cancellation.signal;
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new Cancelled()); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, 100);
      signal.addEventListener("abort", abort, { once: true });
    });
  }
  private async waitFor(token: number, timeout: number, predicate: (sample: KnobTelemetry) => boolean, failure: string) {
    const deadline = this.now() + timeout;
    while (this.now() < deadline) {
      const sample = await this.request("status", token);
      if (sample.state === "fault" || sample.fault !== "none") throw new Error(message(sample));
      if (predicate(sample)) return sample;
      await this.sleep(token);
    }
    throw new Error(failure);
  }
  private ready(sample: KnobTelemetry): boolean {
    return sample.state === "idle" && sample.sampling_restart_required !== true &&
      (sample.bus_voltage_sensing !== true || sample.bus_voltage_valid === true) &&
      sample.adc_sample_valid !== false && (sample.encoder_age_us === undefined || sample.encoder_age_us <= 2000);
  }
  start(port: string) {
    return this.operation(async token => {
      if (!this.view.connected) await this.attach(port, token);
      let sample = await this.request("status", token);
      if (sample.state === "active") { this.publish({ notice: "设备已在运行" }); return; }
      if (sample.state !== "idle" || sample.fault !== "none") throw new Error("请等待当前动作结束或清除故障后启动");
      if (this.electricalDirty()) throw new Error("请先应用或还原电气设置");
      await this.flush(token);
      this.publish({ phase: "等待采样就绪" });
      sample = await this.waitFor(token, 5000, value => this.ready(value), "采样或母线未就绪，请检查设备");
      if (!sample.calibration.valid) {
        this.publish({ phase: "自动校准 · 保持旋钮静置" });
        const max = Math.min(.25, sample.config.current_limit);
        const calibrated = await this.gateway.calibrate({ current: Math.min(.16, max), max_current: max, voltage: 3 });
        this.check(token); this.accept(calibrated);
        if (!calibrated.ok) throw new Error(message(calibrated));
        await this.waitFor(token, 130000, value => {
          if (value.state !== "idle") return false;
          if (!value.calibration.valid || (value.calibration_report && (!value.calibration_report.passed || value.calibration_report.cancelled))) throw new Error("自动校准未完成，启动已取消");
          return true;
        }, "自动校准超时，启动已取消");
        this.publish({ phase: "保存本次校准和配置" });
        await this.request("save", token);
        await this.waitFor(token, 5000, value => this.ready(value), "保存后采样未就绪，启动已取消");
      }
      this.publish({ phase: "启动力反馈 · 采样零点" });
      await this.request("enable", token);
      await this.waitFor(token, 5000, value => value.state === "active", "启动超时，请读取设备状态");
      this.publish({ notice: "力反馈已启动；模式与手感参数可直接调整" });
    });
  }
  async stop() {
    this.cancel();
    if (!this.view.connected) await this.gateway.disconnect();
    return this.operation(async token => { if (this.view.connected) await this.request("disable", token); });
  }
  command(op: Exclude<KnobOp, "status" | "configure" | "enable" | "disable">) {
    return this.operation(async token => {
      if (!this.view.connected) throw new Error("请先连接旋钮");
      if (op === "save" || op === "calibrate") {
        if (this.electricalDirty()) throw new Error("请先应用或还原电气设置");
        await this.flush(token);
        const sample = await this.request("status", token);
        if (sample.state !== "idle") throw new Error("请先停止力反馈");
      }
      await this.request(op, token);
      if (op === "save") this.publish({ notice: "设备配置和校准已保存；重新上电仍等待启动" });
    });
  }
  apply() { return this.operation(token => this.flush(token)); }
  applyElectrical() {
    return this.operation(async token => {
      const sample = await this.request("status", token);
      if (sample.state !== "idle") throw new Error("请先停止力反馈再应用电气设置");
      if (this.view.conflict) throw new Error("请先还原设备参数");
      const config = { ...knobEditableConfig(sample.config), ...this.view.electrical };
      const error = knobConfigureRequestError(config, sample); if (error) throw new Error(error);
      await this.request("configure", token, config);
      this.publish({ electrical: electricalFrom(this.view.editor.base), notice: "电气设置已应用；启动时会按需要校准" });
    });
  }
  restore() {
    if (this.view.busy || this.view.sending || !this.view.status) return;
    this.pending.clear(); clearTimeout(this.timer); this.legacyDrafts.clear();
    this.accept(this.view.status, undefined, true);
    this.publish({ error: "", notice: "", applyState: "applied" });
  }
  restoreReferenceDefaults() {
    return this.operation(async token => {
      const mode = this.view.editor.draft.mode;
      const bank = await this.gateway.referenceDefaults(); this.check(token);
      const current = this.view.editor.draft.reference_modes?.[String(mode)], defaults = bank[String(mode)];
      if (!current || !defaults) throw new Error("设备没有提供当前模式默认参数");
      // Preserve extensions on the current record; only known existing keys change.
      const value = { ...current, ...Object.fromEntries(knobReferenceEditableKeys.filter(key => Object.hasOwn(defaults, key)).map(key => [key, structuredClone(defaults[key])])) };
      this.publish({ editor: { ...this.view.editor, draft: this.withUnit(this.view.editor.draft, `reference:${mode}`, value) } });
      this.stage(`reference:${mode}`, 0);
    });
  }
}
