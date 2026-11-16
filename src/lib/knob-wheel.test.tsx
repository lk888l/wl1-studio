import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import v22 from "./__fixtures__/knob-v22-status.json";
import { parseKnobTelemetry, type KnobOp } from "./knob";
import { KnobWorkflow, selectKnobPort, type KnobWorkflowGateway } from "./knob-workflow";
import { KnobWheelControl } from "../components/knob/KnobStudio";

const wheel = { supported: true, enabled: false, mounted: true, suspended: false, ready: false, steps_per_turn: 36, reports: 0, steps: 0 };
function packet() { return { ...structuredClone(v22), transport: "usb_otg_cdc", usb_wheel: { ...wheel } }; }

describe("Native USB wheel", () => {
  it("selects the composite port after USB re-enumeration", () => {
    const port = { name: "COM8", vid: 0x303a, pid: 0x4005, portType: "usb" };
    expect(selectKnobPort([port], "COM7")).toBe("COM8");
    expect(selectKnobPort([port, { ...port, name: "COM9" }])).toBe("");
  });
  it("reads the native OTG capability while retaining older firmware", () => {
    expect(parseKnobTelemetry(packet()).usb_wheel).toEqual(wheel);
    expect(parseKnobTelemetry(v22).usb_wheel).toBeUndefined();
  });
  it.each([null, [], {}, { ...wheel, enabled: 1 }, { ...wheel, steps_per_turn: 0 }, { ...wheel, reports: -1 }, { ...wheel, steps: .5 }, { ...wheel, steps: 0x100000000 }])("rejects malformed wheel state %j", value => {
    expect(() => parseKnobTelemetry({ ...packet(), usb_wheel: value })).toThrow("usb_wheel");
  });
  it("offers an accessible switch with device-owned state and an upgrade hint", () => {
    const sample = parseKnobTelemetry(packet());
    const render = (connected: boolean, busy = false) => renderToStaticMarkup(<KnobWheelControl status={sample} connected={connected} busy={busy} onToggle={() => undefined} />);
    expect(render(true)).toContain('aria-checked="false"');
    expect(render(true)).not.toContain('disabled=""');
    sample.usb_wheel!.enabled = true; sample.usb_wheel!.ready = true;
    expect(render(true)).toContain("关闭滚轮");
    expect(render(true)).toContain("每圈 36 个刻度");
    expect(render(false)).toContain('aria-checked="false"');
    expect(render(true, true)).toContain('disabled=""');
    expect(renderToStaticMarkup(<KnobWheelControl status={parseKnobTelemetry(v22)} connected busy={false} onToggle={() => undefined} />)).toContain("请升级固件后重连");
  });
  it("toggles while active without changing haptics, saving, or disabling the motor", async () => {
    const sample = parseKnobTelemetry(packet()); sample.state = "active";
    const before = structuredClone(sample.config);
    let connected = false;
    const calls: KnobOp[] = [];
    const gateway: KnobWorkflowGateway = {
      isConnected: () => connected,
      connect: async () => { connected = true; },
      disconnect: async () => { connected = false; },
      referenceDefaults: async () => structuredClone(sample.config.reference_modes!),
      calibrate: async () => { throw new Error("unexpected calibration"); },
      request: async (op, config) => {
        expect(config).toBeUndefined(); calls.push(op);
        if (op === "wheel_enable" || op === "wheel_disable") sample.usb_wheel!.enabled = op === "wheel_enable";
        return structuredClone(sample);
      },
    };
    const workflow = new KnobWorkflow(gateway);
    await workflow.connect("COM8"); calls.length = 0;
    await workflow.command("wheel_enable");
    expect(workflow.snapshot().status?.usb_wheel?.enabled).toBe(true);
    await workflow.command("wheel_disable");
    await workflow.disconnect();
    expect(calls).toEqual(["wheel_enable", "wheel_disable"]);
    expect(sample.state).toBe("active"); expect(sample.config).toEqual(before);
  });
});
