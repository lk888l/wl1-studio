import { ArrowRight, Cable, Download, Search, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../../lib/device";
import { ipv4Error, openOcdConfig, sticks3Network, type DapProtocol, type NetworkDevice, type NetworkProbe as ProbeInfo } from "../../lib/sticks3-network";
import type { S3Run } from "./RadioConnections";

export const networkHostKey = "studio.sticks3.network-host.v1";
export function preferredNetworkHost(): string {
  try { const value = localStorage.getItem(networkHostKey) ?? ""; return ipv4Error(value) ? "" : value; } catch { return ""; }
}

interface Props { host: string; onHost: (host: string) => void; busy: boolean; run: S3Run; onSetup: () => void; onUse: (probe: ProbeInfo, protocol: DapProtocol) => void }

export function NetworkProbe({ host, onHost, busy, run, onSetup, onUse }: Props) {
  const [devices, setDevices] = useState<NetworkDevice[]>();
  const [probe, setProbe] = useState<ProbeInfo>();
  const [checkedAt, setCheckedAt] = useState("");
  const [protocol, setProtocol] = useState<DapProtocol>("swd");
  const generation = useRef(0);
  useEffect(() => () => { ++generation.current; }, []);
  const disabled = busy || !isTauriRuntime();
  const validation = ipv4Error(host);
  const current = probe?.host === host.trim() ? probe : undefined;
  const lookup = (device?: NetworkDevice) => {
    let found: ProbeInfo | undefined;
    void run("正在核验网络调试器", async () => {
      const token = ++generation.current;
      setProbe(undefined);
      const address = device?.host ?? host.trim();
      onHost(address);
      const result = await sticks3Network.probe(address, device?.port ?? 4441, device?.serial);
      if (token !== generation.current) return;
      setProbe(result); setProtocol(result.swd ? "swd" : "jtag");
      found = result;
      setCheckedAt(new Date().toLocaleTimeString());
      try { localStorage.setItem(networkHostKey, result.host); } catch { /* Optional preference. */ }
    }).then((ok) => { if (ok && found) onUse(found, found.swd ? "swd" : "jtag"); });
  };
  const discover = () => {
    void run("正在搜索局域网中的 S3", async () => {
      const token = ++generation.current;
      setDevices(undefined); setProbe(undefined);
      const found = await sticks3Network.discover();
      if (token === generation.current) setDevices(found);
    });
  };
  const download = () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([openOcdConfig(current, protocol)], { type: "text/plain;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url; link.download = "sticks3-wifi.cfg";
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };
  return <section className="s3-network" aria-label="网络调试器查找">
    <div className="s3-heading"><div><span className="s3-eyebrow">WIFI · CMSIS-DAP</span><h1>找到你的网络调试器</h1><p>电脑与 S3 接入同一局域网，在设备屏幕打开 W-DAP，再输入 IP 或搜索设备。</p></div></div>
    <section className="s3-card">
      <div className="s3-card-heading"><div><h2><Wifi size={19} />通过 IP 查找</h2><p>填写设备 W-DAP 页面显示的 IPv4 地址 · TCP 4441</p></div><button type="button" className="s3-btn" disabled={busy} onClick={onSetup}><Cable size={16} />首次使用？USB 配网</button></div>
      <form className="s3-network-form" onSubmit={(event) => { event.preventDefault(); if (!disabled && !validation) lookup(); }}>
        <label className="s3-field" htmlFor="s3-network-ip">设备 IP<input id="s3-network-ip" value={host} disabled={disabled} onChange={(event) => { ++generation.current; setProbe(undefined); onHost(event.target.value); }} placeholder="例如 192.168.1.123" inputMode="decimal" autoComplete="off" spellCheck={false} /></label>
        <button type="submit" className="s3-btn is-primary" disabled={disabled || Boolean(validation)}><Search size={16} />连接并打开工作区</button>
        <button type="button" className="s3-btn" disabled={disabled} onClick={discover}><Wifi size={16} />搜索局域网</button>
      </form>
      {host && validation && <p className="s3-hint is-warning">{validation}</p>}
      {!isTauriRuntime() && <p className="s3-hint">查找真实设备需要使用桌面应用。</p>}
      <p className="s3-hint">查找只读取探针身份和能力，完成后释放连接。离开或暂停 W-DAP 后设备不再应答；打开 OpenOCD / IDE 调试时，请先停止其他客户端。</p>
      {devices && <div className="s3-discovered" aria-live="polite">
        <p className="s3-hint">{devices.length ? `发现 ${devices.length} 台设备，请选择并核验：` : "未收到设备应答。确认已打开 W-DAP；多网卡、跨子网或路由器客户端隔离时，请直接输入 IP。"}</p>
        {devices.map((device) => <button type="button" key={device.serial} className="s3-result" disabled={disabled} onClick={() => lookup(device)}><Wifi size={20} /><span><strong>{device.host}:{device.port}</strong><small>StickS3 · {device.serial} · 待核验</small></span><ArrowRight size={17} /></button>)}
      </div>}
    </section>
    {current && <section className="s3-card" aria-live="polite">
      <div className="s3-card-heading"><div><h2>{current.product}</h2><p>{checkedAt} 核验成功 · 已可加入 USB / Wi-Fi 共用调试工作区</p></div><button type="button" className="s3-btn is-primary" disabled={disabled} onClick={() => onUse(current, protocol)}><ArrowRight size={16} />进入调试工作区</button></div>
      <dl className="s3-probe-facts"><div><dt>网络端点</dt><dd>{current.host}:{current.port}</dd></div><div><dt>序列号</dt><dd>{current.serial}</dd></div><div><dt>支持协议</dt><dd>{[current.swd && "SWD", current.jtag && "JTAG"].filter(Boolean).join(" / ")}</dd></div><div><dt>CMSIS-DAP 版本</dt><dd>{current.firmwareVersion}</dd></div></dl>
      <details><summary>其他工具：OpenOCD / IDE 配置</summary><div className="s3-card-heading"><div><h2>用于 OpenOCD / IDE</h2><p>也可下载适配器配置，配合实际目标芯片的配置使用。</p></div><div className="s3-actions"><label className="s3-protocol">协议<select aria-label="网络调试协议" value={protocol} disabled={busy} onChange={(event) => setProtocol(event.target.value as DapProtocol)}><option value="swd" disabled={!current.swd}>SWD</option><option value="jtag" disabled={!current.jtag}>JTAG</option></select></label><button type="button" className="s3-btn" disabled={busy} onClick={download}><Download size={16} />下载配置</button></div></div>
      <pre className="s3-config">{openOcdConfig(current, protocol)}</pre>
      <p className="s3-hint">使用支持 CMSIS-DAP TCP 的 OpenOCD，在配置文件所在目录运行；将 YOUR_TARGET 替换为实际芯片配置：</p><pre className="s3-config">openocd -f sticks3-wifi.cfg -f target/YOUR_TARGET.cfg</pre>
      </details><p className="s3-hint">此处核验的是探针，目标芯片尚未识别。进入调试工作区后点击“连接并识别”，再进行 Flash 操作。TCP 通道用于可信局域网。</p>
    </section>}
  </section>;
}
