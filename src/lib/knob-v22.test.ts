import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import v22 from "./__fixtures__/knob-v22-status.json";
import v22Defaults from "./__fixtures__/knob-v22-defaults.json";
import v21 from "./__fixtures__/knob-v21-status.json";
import { KnobReferenceEditor, replaceKnobReferenceDraft, knobReferenceApplyBlocked } from "../components/knob/KnobStudio";
import { knobConfigurePayload, knobReferenceChanged, parseKnobTelemetry, validateKnobReferenceConfig, type KnobTelemetry } from "./knob";

// Synthetic v2 capability variations; the captured v21 baseline remains untouched.
function modern() {
  const sample = structuredClone(v21) as KnobTelemetry;
  sample.reference_config_version = 2; sample.reference_current_limit = 4.5; sample.state = "idle";
  for (const entry of Object.values(sample.config.reference_modes!)) {
    entry.strength = 20; entry.damping = .003; entry.endstop = 8; entry.scale = 1;
    entry.endstop_damping = .04; entry.click_enabled = false; entry.click = .08;
  }
  return sample;
}
describe("Independent detent v2 contract", () => {
  it("parses actual v22 COM7 replies and device-provided defaults without inventing settings", () => {
    const sample = parseKnobTelemetry(v22), defaults = parseKnobTelemetry(v22Defaults);
    expect(sample.firmware).toBe("dma-v22-independent-detents");
    expect(sample.config.reference_modes).toEqual(defaults.reference_defaults);
    expect(sample.config.reference_modes!["12"]!).toMatchObject({ strength: 20, scale: 1, click_enabled: false });
    expect(sample.config.reference_modes!["11"]!.strength).toBeGreaterThan(0);
    const draft = structuredClone(sample.config); draft.mode = 12;
    expect(knobConfigurePayload(draft, sample).reference_modes).toBeUndefined();
  });
  it("accepts physical gains and explicit disabled clicks while retaining v21 support", () => {
    const current = parseKnobTelemetry(modern());
    expect(current.config.reference_modes!["12"]!.click_enabled).toBe(false);
    expect(current.reference_current_limit).toBe(4.5);
    expect(parseKnobTelemetry(v21).reference_config_version).toBe(1);
  });
  it("requires both v2 fields and rejects invalid booleans and endpoint damping", () => {
    for (const [key, value] of [["click_enabled", undefined], ["click_enabled", 1], ["endstop_damping", undefined], ["endstop_damping", .50001]] as const) {
      const current = modern(); Object.assign(current.config.reference_modes!["12"]!, { [key]: value });
      expect(() => parseKnobTelemetry(current)).toThrow();
    }
    const future = modern(); future.reference_config_version = 3;
    expect(() => parseKnobTelemetry(future)).toThrow();
  });
  it("uses version-specific strength and damping bounds", () => {
    const entry = modern().config.reference_modes!["12"]!;
    expect(validateKnobReferenceConfig({ ...entry, strength: 1000, damping: .5 }, 12, 2)).toBeNull();
    expect(validateKnobReferenceConfig({ ...entry, strength: 1000.1 }, 12, 2)).not.toBeNull();
    expect(validateKnobReferenceConfig({ ...entry, damping: .501 }, 12, 2)).not.toBeNull();
    expect(validateKnobReferenceConfig({ ...entry, strength: 101 }, 12, 1)).not.toBeNull();
    expect(validateKnobReferenceConfig({ ...entry, strength: 20, damping: 5 }, 12, 1)).toBeNull();
  });
  it("sends only the changed mode, retains pulse amplitude when disabled, and preserves endpoint damping", () => {
    const sample = parseKnobTelemetry(modern()); const before = structuredClone(sample.config);
    const draft = structuredClone(sample.config);
    Object.assign(draft.reference_modes!["12"]!, { click_enabled: true, endstop_damping: .07, strength: 250 });
    const sent = knobConfigurePayload(draft, sample);
    expect(Object.keys(sent.reference_modes!)).toEqual(["12"]);
    expect(sent.reference_modes!["12"]).toMatchObject({ click_enabled: true, click: .08, endstop_damping: .07, strength: 250 });
    expect(JSON.stringify({ op: "configure", config: sent }).length).toBeLessThan(1900);
    expect(sample.config).toEqual(before);
    const enabled = parseKnobTelemetry({ ...modern(), config: draft });
    const off = structuredClone(draft); off.reference_modes!["12"]!.click_enabled = false;
    expect(knobConfigurePayload(off, enabled).reference_modes!["12"]).toMatchObject({ click_enabled: false, click: .08 });
  });
  it("detects click-only or endpoint-only edits and blocks running application", () => {
    const sample = parseKnobTelemetry(modern()); const draft = structuredClone(sample.config);
    draft.reference_modes!["12"]!.click_enabled = true;
    expect(knobReferenceChanged(draft, sample.config)).toBe(true);
    expect(knobReferenceApplyBlocked(draft, sample.config, "active")).toBe(true);
    expect(() => knobConfigurePayload(draft, { ...sample, state: "active" })).toThrow("停机");
    expect(knobConfigurePayload(sample.config, { ...sample, state: "active" }).reference_modes).toBeUndefined();
  });
  it("restores all editable v2 fields only into the selected local draft", () => {
    const sample = modern(); const before = structuredClone(sample.config);
    const defaults = { ...sample.config.reference_modes!["12"]!, click_enabled: true, endstop_damping: .1, strength: 30 };
    const draft = replaceKnobReferenceDraft(sample.config, 12, defaults);
    expect(draft.reference_modes!["12"]).toEqual(defaults);
    expect(draft.reference_modes!["11"]).toEqual(before.reference_modes!["11"]);
    expect(sample.config).toEqual(before);
  });
  it("renders physical units, independent endpoint damping and an optional click toggle", () => {
    const props = { mode: 12, version: 2, config: modern().config.reference_modes!["12"]!, disabled: false, canRestore: true, currentLimit: 4.5, onChange: () => undefined, onRestore: () => undefined };
    const html = renderToStaticMarkup(createElement(KnobReferenceEditor, props));
    expect(html).toContain("档位力度"); expect(html).toContain("端点阻尼"); expect(html).toContain("A/rad");
    expect(html).toContain('aria-label="启用切档点击"');
    expect(html).toMatch(/aria-label="点击脉冲电流"[^>]*disabled/);
    const enabled = renderToStaticMarkup(createElement(KnobReferenceEditor, { ...props, config: { ...props.config, click_enabled: true } }));
    expect(enabled).not.toMatch(/aria-label="点击脉冲电流"[^>]*disabled/);
    const old = renderToStaticMarkup(createElement(KnobReferenceEditor, { ...props, version: 1, config: v21.config.reference_modes["12"] }));
    expect(old).not.toContain('aria-label="启用切档点击"'); expect(old).toContain("旧版参考算法");
  });
});
