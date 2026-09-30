import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime } from "./device";
import type { S3Snapshot } from "./sticks3";

export interface NetworkDevice { host: string; port: number; serial: string }
export interface NetworkProbe extends NetworkDevice {
  vendor: string; product: string; firmwareVersion: string;
  swd: boolean; jtag: boolean; packetSize: number;
}
export type DapProtocol = "swd" | "jtag";

export function ipv4Error(value: string): string | undefined {
  const parts = value.trim().split(".");
  if (parts.length !== 4 || parts.some((part) => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) {
    return "请输入 IPv4 地址，例如 192.168.1.123，不含 http:// 或端口。";
  }
  if (Number(parts[0]) === 0 || Number(parts[0]) >= 224) return "请输入单台设备地址，不能使用广播或组播地址。";
  return undefined;
}

function desktop(): void {
  if (!isTauriRuntime()) throw new Error("查找真实网络设备需要使用桌面应用。");
}
export const sticks3Network = {
  discover(): Promise<NetworkDevice[]> {
    desktop();
    return invoke("sticks3_network_discover");
  },
  probe(host: string, port = 4441, expectedSerial?: string): Promise<NetworkProbe> {
    desktop();
    const error = ipv4Error(host);
    if (error) throw new Error(error);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("DAP 端口无效。");
    return invoke("sticks3_network_probe", { host: host.trim(), port, expectedSerial: expectedSerial ?? null });
  },
};

export function wifiSetup(snapshot: S3Snapshot): { ip: string; saved: boolean; message: string } {
  const wifi = snapshot.data?.wifi;
  if (!snapshot.connected) return { ip: "", saved: false, message: "用 USB 数据线连接 S3，保持设备在主菜单，选择上方串口并连接。" };
  if (!wifi || wifi.state !== "connected" || ipv4Error(wifi.ip)) {
    return { ip: "", saved: false, message: wifi?.state === "connecting" || wifi?.state === "retry"
      ? "正在等待 S3 取得 IP，状态会自动刷新；若持续失败，请检查密码和 2.4 GHz 网络。"
      : "开启 Wi-Fi，扫描或输入网络名称，然后输入密码并连接。" };
  }
  const saved = !wifi.rememberPending && wifi.memoryError === 0
    && snapshot.data?.wifiSaved.some((row) => row.label === wifi.ssid && row.preferred) === true;
  return { ip: wifi.ip, saved, message: wifi.memoryError
    ? "网络已连接，但保存失败。可先使用当前 IP，或检查记忆槽后重新保存。"
    : wifi.rememberPending ? "已取得 IP，正在等待设备保存网络。"
    : saved ? "网络已保存到 S3，下次开机自动重连。电脑接入同一局域网后即可查找调试器。"
    : "已取得 IP；当前网络尚未确认为开机首选，可点击“记住当前网络”。" };
}

export function openOcdConfig(probe: NetworkProbe, protocol: DapProtocol): string {
  if (ipv4Error(probe.host) || !Number.isInteger(probe.port) || probe.port < 1 || probe.port > 65535) throw new Error("调试端点无效，请重新查找。");
  if ((protocol !== "swd" && protocol !== "jtag") || !probe[protocol]) throw new Error("设备未声明支持此调试协议。");
  return ["# StickS3: keep W-DAP open. Requires CMSIS-DAP TCP support.",
    "adapter driver cmsis-dap", "cmsis-dap backend tcp", `cmsis-dap tcp host ${probe.host}`,
    `cmsis-dap tcp port ${probe.port}`, "cmsis-dap tcp min_timeout 1000",
    `transport select ${protocol}`, "adapter speed 100", "reset_config none", ""].join("\n");
}
