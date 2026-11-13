import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import recordedV5 from "../../lib/__fixtures__/knob-v5-status.json";
import recordedV8 from "../../lib/__fixtures__/knob-v8-status.json";
import recordedV20 from "../../lib/__fixtures__/knob-v20-status.json";
import recordedReference from "../../lib/__fixtures__/knob-reference-modes-status.json";
import { parseKnobTelemetry, validateKnobReferenceConfig, type KnobReferenceModeConfig } from "../../lib/knob";
import { createKnobEditor, knobEditorConflict, knobEditorDirty, knobReferenceApplyBlocked, KnobFrictionlessState, KnobModePicker, KnobOwnershipNote, KnobPwmDiagnostics, KnobReferenceEditor, KnobStudio, KnobTimingDiagnostics, KnobVoltageReadout, parseKnobMagneticPositions, reconcileKnobEditor, replaceKnobReferenceDraft, sameKnobConfig } from "./KnobStudio";

describe("SmartKnob automatic voltage UI", () => {
  it("removes the voltage limit editor from the complete settings form", () => {
    const html = renderToStaticMarkup(<KnobStudio onBack={() => undefined} />);
    expect(html).toContain("运行电流上限");
    expect(html).toContain("电流环 Kp");
    expect(html).not.toContain("设定电压上限");
    expect(html).not.toContain("可设置的电压上限");
    expect(html).not.toContain("NaN");
  });

  it("renders real v8 telemetry without the removed config field", () => {
    const sample = parseKnobTelemetry(recordedV8);
    expect(sample.config.voltage_limit).toBeUndefined();
    const html = renderToStaticMarkup(<KnobVoltageReadout status={sample} />);
    expect(html).toContain("自动可用电压");
    expect(html).toContain("随母线自动取最大值");
    expect(html).toContain(sample.effective_voltage_limit?.toFixed(3));
    expect(html).not.toContain("旧固件");
    expect(html).not.toContain("<input");
  });

  it("follows the live bus capability while the nominal reference stays unchanged", () => {
    const sample = parseKnobTelemetry(recordedV8);
    const nominal = sample.config.bus_voltage;
    for (const bus of [12, 9, 19.4]) {
      const html = renderToStaticMarkup(<KnobVoltageReadout status={{
        ...sample, bus_voltage: bus, bus_voltage_valid: true,
        effective_voltage_limit: bus / Math.sqrt(3), available_voltage_limit: bus / Math.sqrt(3),
      }} />);
      expect(html).toContain(`${bus.toFixed(2)}<em>V</em>`);
      expect(html).toContain(`${(bus / Math.sqrt(3)).toFixed(3)}<em>V</em>`);
      expect(html).toContain(`名义参考 ${nominal.toFixed(2)} V`);
    }
  });

  it("uses available capability when effective telemetry is absent and ignores stale v8 saved limits", () => {
    const sample = parseKnobTelemetry(recordedV8);
    const html = renderToStaticMarkup(<KnobVoltageReadout status={{
      ...sample, config: { ...sample.config, voltage_limit: 2.35 },
      effective_voltage_limit: undefined, available_voltage_limit: 12 / Math.sqrt(3),
    }} />);
    expect(html).toContain("6.928<em>V</em>");
    expect(html).not.toContain("2.350");
    expect(html).not.toContain("旧固件已存上限");
  });

  it("labels the legacy saved limit read-only without presenting it as automatic", () => {
    const sample = parseKnobTelemetry(recordedV5);
    const html = renderToStaticMarkup(<KnobVoltageReadout status={sample} />);
    expect(html).toContain(`旧固件已存上限 ${sample.config.voltage_limit?.toFixed(3)} V · 只读`);
    expect(html).not.toContain("随母线自动取最大值");
    expect(html).not.toContain("<input");
  });

  it("reports timing skips and recovery as diagnostics while active", () => {
    const sample = parseKnobTelemetry(recordedV8);
    const html = renderToStaticMarkup(<dl><KnobPwmDiagnostics status={{
      ...sample, state: "active", fault: "none", adc_sample_valid: false,
      sampling_restart_required: false, timing_skips: 42, sampling_recoveries: 2,
      pwm_deferred: 0, pwm_peak_duty: 1, pwm_full_duty_cycles: 200,
    }} /></dl>);
    expect(html).toContain("本次跳过，等待有效采样");
    expect(html).toContain("0.0–100.0%");
    expect(html).toContain("100.00%");
    expect(html).toContain("100% 占空比累计周期</dt><dd>200");
    expect(html).toContain("采样 / 调度跳过次数</dt><dd>42");
    expect(html).toContain("采样自动恢复次数</dt><dd>2");
    expect(html).toContain("PWM 延后更新次数</dt><dd>0");
    expect(html).not.toContain("至少 0.0%");
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("故障停机");
  });

  it("renders v20 fractional rates, carrier dividers and the advertised voltage utilization", () => {
    const sample = parseKnobTelemetry(recordedV20);
    const html = renderToStaticMarkup(<dl><KnobPwmDiagnostics status={sample} /><KnobTimingDiagnostics status={sample} /></dl>);
    expect(html).toContain("PWM 载波频率（定时器）</dt><dd>15003.75 Hz · 15k_sampling");
    expect(html).toContain("电流控制标称频率</dt><dd>3750.94 Hz · 每 4 个 PWM 周期");
    expect(html).toContain("编码器标称频率</dt><dd>2500.63 Hz · 每 6 个 PWM 周期");
    expect(html).toContain("SVPWM 电压利用率上限</dt><dd>78.36% · 相对 Vbus / √3");
    expect(html).toContain(`电流控制实测频率</dt><dd>${sample.control_hz?.toFixed(2)} Hz`);
    expect(html).not.toContain("3750.937744");
    expect(html).not.toContain("5000.00 Hz");
  });

  it("keeps legacy integer frequency telemetry readable without inventing new capabilities", () => {
    const sample = parseKnobTelemetry(recordedV5);
    const html = renderToStaticMarkup(<dl><KnobPwmDiagnostics status={sample} /><KnobTimingDiagnostics status={sample} /></dl>);
    expect(html).toContain(`PWM 频率</dt><dd>${((sample.pwm_hz as number) / 1000).toFixed(1)} kHz`);
    expect(html).toContain("电流控制标称频率</dt><dd>5000.00 Hz");
    expect(html).not.toContain("PWM 载波频率（定时器）");
    expect(html).not.toContain("个 PWM 周期");
    expect(html).not.toContain("SVPWM 电压利用率上限");
  });
});

describe("SmartKnob editable reference modes", () => {
  const reference: KnobReferenceModeConfig = {
    bounded: true, position: 0, min_position: 0, max_position: 31,
    width: Math.PI / 18, strength: 28, damping: .16, endstop: 1,
    scale: .2, snap: .75, bias: 0, friction: 0, click: 0, magnetic_positions: [],
  };
  const renderEditor = (mode: number, config?: KnobReferenceModeConfig) => renderToStaticMarkup(<KnobReferenceEditor mode={mode} config={config} disabled={false} canRestore currentLimit={.45} onChange={() => undefined} onRestore={() => undefined} />);

  it("shows editable bounded geometry and gains with explicit local default restoration", () => {
    const html = renderEditor(12, reference);
    for (const label of ["参考档位间距", "初始逻辑档位", "最小逻辑档位", "最大逻辑档位", "档位增益", "速度阻尼增益", "端点增益", "输出倍率", "点击脉冲电流"]) expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('aria-label="参考档位间距" min="1" max="180" step="1" type="number" value="10"');
    expect(html).toContain("恢复当前模式默认参数");
    expect(html).toContain("恢复默认只修改当前草稿");
    expect(html).toContain("0.45 A 上限");
    expect(html).not.toContain('aria-label="磁吸逻辑档位"');
  });

  it("hides inactive boundary controls for unbounded reference modes without rewriting their stored range", () => {
    const unbounded = { ...reference, bounded: false, min_position: 0, max_position: -1 };
    const html = renderEditor(5, unbounded);
    expect(html).toContain("允许连续旋转");
    expect(html).toContain('aria-label="初始逻辑档位"');
    expect(html).not.toContain('aria-label="最小逻辑档位"');
    expect(html).not.toContain('aria-label="最大逻辑档位"');
    expect(html).not.toContain('aria-label="端点增益"');
    expect(unbounded.max_position).toBe(-1);
  });

  it("exposes magnetic positions only where used and omits the unused click amplitude", () => {
    const html = renderEditor(14, { ...reference, magnetic_positions: [2, 10, 21, 22] });
    expect(html).toContain('aria-label="磁吸逻辑档位"');
    expect(html).toContain('value="2, 10, 21, 22"');
    expect(html).toContain("最多 8 个不重复整数");
    expect(html).not.toContain('aria-label="点击脉冲电流"');
    expect(renderEditor(4, reference)).toContain("Custom 也可按这些参数定义自己的手感");
  });

  it("keeps unsupported old firmware read-only instead of inventing editable preset values", () => {
    const html = renderEditor(8);
    expect(html).toContain("升级支持参考模式参数的固件");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("恢复当前模式默认参数");
  });

  it("replaces only the selected local entry while preserving unknown fields, other modes and the base", () => {
    const config = { ...parseKnobTelemetry(recordedReference).config, reference_modes: { "4": { ...reference, future_extension: { keep: true } }, "8": { ...reference, magnetic_positions: [] } } };
    const editor = createKnobEditor(config);
    const restored = { ...reference, strength: 0, scale: .0875, future_extension: { keep: false }, new_extension: true };
    editor.draft = replaceKnobReferenceDraft(editor.draft, 4, restored);
    expect(editor.draft.reference_modes?.["4"]).toMatchObject({ strength: 0, scale: .0875, future_extension: { keep: true } });
    expect(editor.draft.reference_modes?.["4"]).not.toHaveProperty("new_extension");
    expect(editor.draft.reference_modes?.["8"]).toEqual(config.reference_modes["8"]);
    expect(editor.base.reference_modes?.["4"]?.strength).toBe(28);
    expect(config.reference_modes["4"].strength).toBe(28);
    restored.magnetic_positions.push(2);
    expect(editor.draft.reference_modes?.["4"]?.magnetic_positions).toEqual([]);
    expect(knobEditorDirty(editor)).toBe(true);
    const changedElsewhere = structuredClone(config);
    changedElsewhere.reference_modes["8"].damping = .2;
    expect(knobEditorConflict(editor, changedElsewhere)).toBe(true);
  });

  it("requires idle for changed reference parameters while retaining running mode-only switches", () => {
    const config = { ...parseKnobTelemetry(recordedReference).config, reference_modes: { "8": reference } };
    const modeOnly = { ...config, mode: 12 };
    expect(knobReferenceApplyBlocked(modeOnly, config, "active")).toBe(false);
    const edited = replaceKnobReferenceDraft(config, 8, { ...reference, strength: 20 });
    for (const state of ["active", "offsets", "align", "sweep", "settle", "fault"] as const) expect(knobReferenceApplyBlocked(edited, config, state)).toBe(true);
    expect(knobReferenceApplyBlocked(edited, config, "idle")).toBe(false);
  });

  it("does not silently drop malformed magnetic entries and leaves validation to the parameter boundary", () => {
    expect(parseKnobMagneticPositions("2，10 21;22,")).toEqual([2, 10, 21, 22]);
    expect(parseKnobMagneticPositions("  ")).toEqual([]);
    const invalid = parseKnobMagneticPositions("2, nope, 10");
    expect(invalid).toHaveLength(3);
    expect(Number.isNaN(invalid[1])).toBe(true);
    expect(validateKnobReferenceConfig({ ...reference, magnetic_positions: invalid }, 14)).not.toBeNull();
    expect(validateKnobReferenceConfig({ ...reference, magnetic_positions: parseKnobMagneticPositions("2, 2") }, 14)).not.toBeNull();
  });
});

describe("SmartKnob device-owned modes and configuration", () => {
  it("reads seventeen mode choices from the device and retains its names", () => {
    const sample = parseKnobTelemetry(recordedReference);
    const html = renderToStaticMarkup(<KnobModePicker status={sample} mode={16} disabled={false} onChange={() => undefined} />);
    expect(html.match(/<option /g)).toHaveLength(17);
    expect(html).toContain('value="16" selected=""');
    expect(html).toContain("Frictionless");
    expect(html).toContain("选择即切换");
    const next = { ...sample, mode_count: 18, modes: [...sample.modes!, "Future device mode"] };
    expect(renderToStaticMarkup(<KnobModePicker status={next} mode={17} disabled={false} onChange={() => undefined} />)).toContain("Future device mode");
  });

  it("uses four legacy mode choices when no mode list is reported", () => {
    const sample = parseKnobTelemetry(recordedV8);
    const html = renderToStaticMarkup(<KnobModePicker status={sample} mode={1} disabled={false} onChange={() => undefined} />);
    expect(html.match(/<option /g)).toHaveLength(4);
    expect(html).not.toContain("Frictionless");
  });

  it("keeps untouched nested fields and independent base while editing a mode", () => {
    const sample = parseKnobTelemetry(recordedReference);
    const config = { ...sample.config, future_config: { calibration: [1, 2, 3] } };
    const editor = createKnobEditor(config);
    editor.draft.mode = 16;
    editor.draft.frictionless!.scale = .9;
    expect(editor.base.mode).toBe(config.mode);
    expect(editor.base.frictionless?.scale).toBe(config.frictionless?.scale);
    expect(config.frictionless?.scale).toBe(1);
    expect(editor.draft).toMatchObject({ future_config: { calibration: [1, 2, 3] } });
    expect(knobEditorDirty(editor)).toBe(true);
  });

  it("refreshes clean drafts from device config while preserving unsubmitted edits", () => {
    const sample = parseKnobTelemetry(recordedReference);
    const clean = createKnobEditor(sample.config);
    const changedOnDevice = { ...sample.config, mode: 16 };
    expect(reconcileKnobEditor(clean, changedOnDevice).draft.mode).toBe(16);
    const dirty = createKnobEditor(sample.config);
    dirty.draft.current_limit = .4;
    expect(reconcileKnobEditor(dirty, changedOnDevice)).toBe(dirty);
    expect(knobEditorConflict(dirty, changedOnDevice)).toBe(true);
    expect(knobEditorConflict(dirty, sample.config)).toBe(false);
    expect(sameKnobConfig({ ...sample.config, mode: 1 }, { mode: 1, ...Object.fromEntries(Object.entries(sample.config).filter(([key]) => key !== "mode")) } as typeof sample.config)).toBe(true);
  });

  it("describes independence only for a confirmed zero host lease", () => {
    const sample = parseKnobTelemetry(recordedReference);
    const standalone = renderToStaticMarkup(<KnobOwnershipNote status={{ ...sample, host_lease_ms: 0 }} />);
    expect(standalone).toContain("设备继续保持当前运行状态");
    expect(standalone).toContain("停止力反馈");
    const leased = renderToStaticMarkup(<KnobOwnershipNote status={{ ...sample, host_lease_ms: 500 }} />);
    expect(leased).toContain("500 ms 通讯租约");
    expect(leased).not.toContain("设备继续保持当前运行状态");
    expect(renderToStaticMarkup(<KnobOwnershipNote status={null} />)).toContain("以设备报告为准");
  });

  it("renders device frictionless hold telemetry only for the active mode", () => {
    const sample = parseKnobTelemetry(recordedReference);
    const holding = { ...sample, config: { ...sample.config, mode: 16 }, frictionless: { phase: 2, reference: 10.1, correction: .012, feedforward: .025, angle_compensation: false } };
    const html = renderToStaticMarkup(<KnobFrictionlessState status={holding} />);
    expect(html).toContain("速度保持");
    expect(html).toContain("10.100 rad/s");
    expect(html).toContain("0.0120 A");
    expect(html).toContain("0.0250 A");
    expect(html).toContain("本模式不产生点击脉冲");
    expect(renderToStaticMarkup(<KnobFrictionlessState status={sample} />)).toBe("");
  });
});
