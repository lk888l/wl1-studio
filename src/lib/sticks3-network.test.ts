import { beforeEach, describe, expect, it, vi } from "vitest";
import type { S3Snapshot } from "./sticks3";
const { invoke, runtime } = vi.hoisted(() => ({ invoke: vi.fn(), runtime: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./device", () => ({ isTauriRuntime: runtime }));
import { ipv4Error, openOcdConfig, sticks3Network, wifiSetup, type NetworkProbe } from "./sticks3-network";

const probe: NetworkProbe = { host: "172.18.7.163", port: 4441, serial: "14C19FD536F4", vendor: "M5StickS3", product: "StickS3 CMSIS-DAP", firmwareVersion: "2.1.2", swd: true, jtag: true, packetSize: 64 };
beforeEach(() => { vi.clearAllMocks(); runtime.mockReturnValue(true); invoke.mockResolvedValue(probe); });

describe("网络 DAP 查找", () => {
  it("只接受明确的 IPv4 单播地址", () => {
    for (const valid of ["172.18.7.163", " 192.168.4.1 ", "127.0.0.1"]) expect(ipv4Error(valid)).toBeUndefined();
    for (const invalid of ["", "1.2.3", "1.2.3.256", "1.02.3.4", "http://1.2.3.4", "1.2.3.4:4441", "localhost", "::1", "0.1.2.3", "224.0.0.1", "255.255.255.255", "1.2.3.4\nexec bad"]) expect(ipv4Error(invalid)).toBeDefined();
  });
  it("手动 IP 查找与搜索结果核验均使用明确端口和预期身份", async () => {
    await sticks3Network.probe(" 172.18.7.163 ");
    expect(invoke).toHaveBeenLastCalledWith("sticks3_network_probe", { host: probe.host, port: 4441, expectedSerial: null });
    await sticks3Network.probe(probe.host, probe.port, probe.serial);
    expect(invoke).toHaveBeenLastCalledWith("sticks3_network_probe", { host: probe.host, port: 4441, expectedSerial: probe.serial });
  });
  it("浏览器和非法输入不触发设备请求", () => {
    for (const port of [0, 65536, 1.5, Number.NaN]) expect(() => sticks3Network.probe(probe.host, port)).toThrow();
    expect(() => sticks3Network.probe("bad")).toThrow();
    runtime.mockReturnValue(false);
    expect(() => sticks3Network.probe(probe.host)).toThrow("桌面应用");
    expect(() => sticks3Network.discover()).toThrow("桌面应用");
    expect(invoke).not.toHaveBeenCalled();
  });
  it("失败不重试、不伪造设备或切换传输", async () => {
    invoke.mockRejectedValueOnce(new Error("timeout"));
    await expect(sticks3Network.probe(probe.host)).rejects.toThrow("timeout");
    expect(invoke).toHaveBeenCalledTimes(1);
  });
  it("按真实能力生成 SWD / JTAG 配置且拒绝配置注入", () => {
    expect(openOcdConfig(probe, "swd")).toContain("transport select swd");
    expect(openOcdConfig(probe, "jtag")).toContain("transport select jtag");
    expect(openOcdConfig(probe, "jtag")).toContain("cmsis-dap tcp host 172.18.7.163");
    expect(() => openOcdConfig({ ...probe, jtag: false }, "jtag")).toThrow();
    expect(() => openOcdConfig({ ...probe, host: "1.2.3.4\nshutdown" }, "swd")).toThrow();
  });
});

function snapshot(): S3Snapshot {
  return { connected: true, sessionId: 7, data: { ap: "S3", apIp: "192.168.4.1", bleServer: "off", bleSecure: false, uptime: 1, updatedAt: 1, bleSaved: [], wifiSaved: [],
    wifi: { enabled: true, scanning: false, state: "connecting", ssid: "Home", ip: "", rssi: -50, reason: 0, rememberPending: true, memoryError: 0 } } };
}
describe("USB 首次配网到 IP 查找", () => {
  it("已受理命令、旧 IP 和备用热点不能冒充 STA 配网成功", () => {
    const state = snapshot();
    expect(wifiSetup(state).ip).toBe("");
    if (state.data?.wifi) state.data.wifi.ip = "172.18.7.163";
    expect(wifiSetup(state).ip).toBe("");
    expect(wifiSetup({ ...state, connected: false }).ip).toBe("");
  });
  it("取得有效 IP 后允许查找，但保存确认必须等状态和首选记忆都匹配", () => {
    const state = snapshot();
    if (!state.data?.wifi) throw new Error("fixture");
    Object.assign(state.data.wifi, { state: "connected", ip: "172.18.7.163" });
    expect(wifiSetup(state)).toMatchObject({ ip: probe.host, saved: false });
    state.data.wifiSaved = [{ slot: 3, label: "Home", preferred: true }];
    expect(wifiSetup(state).saved).toBe(false);
    state.data.wifi.rememberPending = false;
    expect(wifiSetup(state).saved).toBe(true);
    state.data.wifi.memoryError = 257;
    expect(wifiSetup(state)).toMatchObject({ ip: probe.host, saved: false });
    expect(wifiSetup(state).message).toContain("保存失败");
  });
  it("临时连接仍可转到调试查找，无效 IP 不显示成功入口", () => {
    const state = snapshot();
    if (!state.data?.wifi) throw new Error("fixture");
    Object.assign(state.data.wifi, { state: "connected", ip: probe.host, rememberPending: false });
    expect(wifiSetup(state)).toMatchObject({ ip: probe.host, saved: false });
    state.data.wifi.ip = "0.0.0.0";
    expect(wifiSetup(state).ip).toBe("");
  });
});
