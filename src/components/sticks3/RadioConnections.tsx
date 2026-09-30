import { Bluetooth, Check, ChevronRight, Info, LockKeyhole, Radio, RefreshCw, Save, Search, Signal, Trash2, Wifi } from "lucide-react";
import { useState } from "react";
import { addressTypeLabel, bleStateLabel, sticks3Gateway, wifiCredentialError, wifiStateLabel, type BlePeripheral, type Radio as RadioKind, type RadioMemory, type RadioMutation, type S3Snapshot, type ScanResults, type WifiNetwork } from "../../lib/sticks3";
import { wifiSetup } from "../../lib/sticks3-network";

export type S3Run = (label: string, work: () => Promise<unknown>, message?: string) => Promise<boolean>;
interface Props { snapshot: S3Snapshot; busy: boolean; run: S3Run; onNetwork: (ip: string) => void }
const authLabel = (auth: number) => ["开放网络", "WEP", "WPA", "WPA2", "WPA/WPA2", "企业认证", "WPA3", "WPA2/WPA3"][auth] ?? `加密类型 ${auth}`;

export function RadioConnections({ snapshot, busy, run, onNetwork }: Props) {
  const [tab, setTab] = useState<RadioKind>("wifi");
  const data = snapshot.data;
  return <div className="s3-radio-page">
    <div className="s3-radio-summary">
      <div><span className="s3-radio-icon"><Wifi size={22} /></span><div><small>S3 的 Wi-Fi</small><strong>{wifiStateLabel(data?.wifi?.state)}</strong><span>{data?.wifi?.state === "connected" ? `${data.wifi.ssid} · ${data.wifi.ip}` : data?.ap ? `备用热点 ${data.ap}` : "2.4 GHz 网络"}</span></div></div>
      <div><span className="s3-radio-icon is-blue"><Bluetooth size={22} /></span><div><small>S3 的蓝牙</small><strong>{bleStateLabel(data?.ble)}</strong><span>{data?.ble?.connected ? data.ble.address : data?.bleServer === "advertising" ? "正在广播，电脑可连接 S3" : data?.bleServer === "connected" ? "已有客户端连接 S3" : "低功耗蓝牙 BLE"}</span></div></div>
    </div>
    <div className="s3-radio-toolbar"><div className="s3-tabs" role="tablist" aria-label="无线类型">
      <button type="button" id="s3-wifi-tab" role="tab" aria-selected={tab === "wifi"} aria-controls="s3-wifi-panel" onClick={() => setTab("wifi")}><Wifi size={17} />Wi-Fi 网络</button>
      <button type="button" id="s3-ble-tab" role="tab" aria-selected={tab === "ble"} aria-controls="s3-ble-panel" onClick={() => setTab("ble")}><Bluetooth size={17} />蓝牙 BLE</button>
    </div><button type="button" className="s3-btn" disabled={!snapshot.connected || busy} onClick={() => { void run("正在读取无线状态", () => sticks3Gateway.refresh()); }}><RefreshCw size={15} />刷新状态</button></div>
    {!snapshot.connected && <p className="s3-message"><Info size={17} />通过上方 USB 连接 S3，即可扫描、选择并保存它周围的 Wi-Fi 和 BLE 设备。</p>}
    <div id="s3-wifi-panel" role="tabpanel" aria-labelledby="s3-wifi-tab" hidden={tab !== "wifi"}><WifiConnections {...{ snapshot, busy, run, onNetwork }} /></div>
    <div id="s3-ble-panel" role="tabpanel" aria-labelledby="s3-ble-tab" hidden={tab !== "ble"}><BleConnections {...{ snapshot, busy, run, onNetwork }} /></div>
  </div>;
}

function WifiConnections({ snapshot, busy, run, onNetwork }: Props) {
  const [results, setResults] = useState<ScanResults<WifiNetwork>>();
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const status = snapshot.data?.wifi;
  const setup = wifiSetup(snapshot);
  const supported = snapshot.capabilities?.wifi === true;
  const disabled = !snapshot.connected || busy || !supported;
  const blocked = disabled || !status?.enabled || status.scanning;
  const validation = wifiCredentialError(ssid, password);
  const action = (request: RadioMutation) => run("正在更新 Wi-Fi", () => sticks3Gateway.execute(request), "设备已受理并提交执行，请以连接状态和已记住列表为准。");
  const scan = () => run("S3 正在扫描 Wi-Fi", async () => {
    setResults(undefined);
    setResults(await sticks3Gateway.scan("wifi"));
    await sticks3Gateway.refresh();
  });
  return <>
    <section className="s3-card s3-setup" aria-label="首次 Wi-Fi 配网" aria-live="polite">
      <div className="s3-card-heading"><div><h2>首次 Wi-Fi 配网</h2><p>{setup.message}</p></div>{setup.ip && <button type="button" className="s3-btn is-primary" disabled={busy} onClick={() => onNetwork(setup.ip)}><ChevronRight size={16} />使用 {setup.ip} 查找调试器</button>}</div>
      <ol className="s3-setup-steps"><li className={snapshot.connected ? "is-complete" : ""}>1 · 连接 USB 控制台</li><li className={setup.ip ? "is-complete" : ""}>2 · 连接 Wi-Fi 并取得 IP</li><li className={setup.saved ? "is-complete" : ""}>3 · 保存到 S3</li></ol>
      <p className="s3-hint">USB 配网时保持主菜单或 WIFI 页面；USB DAP 会占用控制串口。配网完成后在设备上打开 W-DAP，再核验网络调试器。</p>
    </section>
    <RadioPower radio="wifi" enabled={status?.enabled ?? false} supported={supported} connected={snapshot.connected} disabled={disabled} action={action} />
    <div className="s3-radio-grid">
      <section className="s3-card"><div className="s3-card-heading"><div><h2>附近的 Wi-Fi</h2><p>由 S3 扫描周围的 2.4 GHz 网络</p></div><button type="button" className="s3-btn" disabled={blocked} onClick={() => { void scan(); }}><Search size={16} />扫描网络</button></div>
        <div className="s3-results">{results?.rows.length ? results.rows.map((row) => <button type="button" key={row.bssid} className={`s3-result ${ssid === row.ssid && row.ssid ? "is-selected" : ""}`} disabled={blocked} onClick={() => { setSsid(row.ssid); setPassword(""); }}><Wifi size={20} /><span><strong>{row.ssid || "隐藏网络 · 请手动输入名称"}</strong><small>{authLabel(row.auth)} · 信道 {row.channel} · {row.bssid}</small></span><span className="s3-signal"><Signal size={14} />{row.rssi} dBm</span><ChevronRight size={16} /></button>) : <Empty icon="wifi" title={results ? "未发现网络" : "选择一个网络"} detail={results ? "确认网络为 2.4 GHz，靠近路由器后再次扫描。" : "点击扫描，或在右侧直接填写网络名称。"} />}</div>
        {results && <p className="s3-hint">显示 {results.rows.length} / {results.total} 个扫描结果，设备最多缓存 16 项。</p>}
      </section>
      <section className="s3-card"><div className="s3-card-heading"><div><h2>连接网络</h2><p>支持手动填写隐藏网络</p></div><LockKeyhole size={20} /></div>
        <form autoComplete="off" onSubmit={(event) => { event.preventDefault(); if (blocked || validation) return; const request: RadioMutation = { op: "wifi.connect", ssid, password, remember }; setPassword(""); void action(request); }}>
          <label className="s3-field" htmlFor="s3-ssid">网络名称<input id="s3-ssid" type="text" value={ssid} autoComplete="off" spellCheck={false} disabled={blocked} onChange={(event) => { setSsid(event.target.value); setPassword(""); }} placeholder="输入 SSID" /></label>
          <label className="s3-field" htmlFor="s3-password">网络密码<input id="s3-password" type="password" value={password} autoComplete="new-password" disabled={blocked} onChange={(event) => setPassword(event.target.value)} placeholder="开放网络请留空" /></label>
          <label className="s3-check"><input type="checkbox" checked={remember} disabled={blocked} onChange={(event) => setRemember(event.target.checked)} /><span>连接成功后记住<small>取得 IP 后保存到 S3，下次开机自动重连。</small></span></label>
          {ssid && validation && <p className="s3-hint is-warning">{validation}</p>}
          <button type="submit" className="s3-btn is-primary s3-full" disabled={blocked || Boolean(validation)}><Wifi size={16} />{remember ? "连接并记住" : "临时连接"}</button>
        </form><p className="s3-hint">密码仅用于本次请求，不保存在电脑的设置或日志中。支持开放网络和个人密码认证。</p>
      </section>
    </div>
    <section className="s3-card s3-current"><div><h2>当前 Wi-Fi</h2><strong>{wifiStateLabel(status?.state)}</strong><p>{status?.ssid || "尚未连接网络"}{status?.ip ? ` · ${status.ip}` : ""}{status?.state === "connected" ? ` · ${status.rssi} dBm` : ""}</p>
      {status?.reason ? <p className="s3-hint is-warning">最近断开原因码：{status.reason}</p> : null}<MemoryStatus pending={status?.rememberPending} error={status?.memoryError} />
    </div><div className="s3-actions"><button type="button" className="s3-btn" disabled={disabled || status?.state !== "connected"} onClick={() => { void action({ op: "wifi.remember" }); }}><Save size={15} />记住当前网络</button><button type="button" className="s3-btn" disabled={disabled || !status?.enabled} onClick={() => { void action({ op: "wifi.disconnect" }); }}>断开网络</button></div></section>
    <Memories radio="wifi" rows={snapshot.data?.wifiSaved ?? []} disabled={disabled} connectDisabled={blocked} action={action} />
    <p className="s3-hint">备用热点：{snapshot.data?.ap || "连接后读取"}{snapshot.data?.apIp ? ` · ${snapshot.data.apIp}` : ""}。热点密码可在 S3 的 WIFI → Local hotspot 页面查看。</p>
  </>;
}

function BleConnections({ snapshot, busy, run }: Props) {
  const [results, setResults] = useState<ScanResults<BlePeripheral>>();
  const [selected, setSelected] = useState<BlePeripheral>();
  const [remember, setRemember] = useState(true);
  const [services, setServices] = useState<{ address: string; values: string[] }>();
  const status = snapshot.data?.ble;
  const supported = snapshot.capabilities?.ble === true;
  const disabled = !snapshot.connected || busy || !supported;
  const blocked = disabled || !status?.enabled || status.scanning;
  const action = (request: RadioMutation) => run("正在更新 BLE", () => sticks3Gateway.execute(request), "设备已受理并提交执行，请以连接状态和已记住列表为准。");
  const scan = () => run("S3 正在扫描 BLE 外设", async () => {
    setSelected(undefined); setResults(undefined);
    setResults(await sticks3Gateway.scan("ble"));
    await sticks3Gateway.refresh();
  });
  return <>
    <RadioPower radio="ble" enabled={status?.enabled ?? false} supported={supported} connected={snapshot.connected} disabled={disabled} action={action} />
    <p className="s3-message"><Info size={17} /><span>B-DAP 调试时，由电脑连接 S3。下面的扫描用于 <strong>S3 主动连接其他 BLE 外设</strong>，可供后续功能使用。</span></p>
    <div className="s3-radio-grid">
      <section className="s3-card"><div className="s3-card-heading"><div><h2>附近的 BLE 外设</h2><p>保留扫描到的地址类型，不需要手动填写</p></div><button type="button" className="s3-btn" disabled={blocked} onClick={() => { void scan(); }}><Search size={16} />扫描外设</button></div>
        <div className="s3-results">{results?.rows.length ? results.rows.map((row) => <button type="button" key={`${row.address}/${row.addressType}`} className={`s3-result ${selected?.address === row.address && selected.addressType === row.addressType ? "is-selected" : ""}`} disabled={blocked || !row.connectable} onClick={() => setSelected(row)}><Bluetooth size={20} /><span><strong>{row.name || "未命名 BLE 设备"}</strong><small>{row.address} · {addressTypeLabel(row.addressType)}</small></span><span className="s3-signal">{row.connectable ? `${row.rssi} dBm` : "不可连接"}</span><ChevronRight size={16} /></button>) : <Empty icon="ble" title={results ? "未发现外设" : "发现附近设备"} detail={results ? "让外设处于广播状态，靠近 S3 后再次扫描。" : "扫描约需 8 秒，仅可选择允许连接的广播设备。"} />}</div>
        {results && <p className="s3-hint">显示 {results.rows.length} / {results.total} 个广播设备，最多缓存 16 项。</p>}
      </section>
      <section className="s3-card"><div className="s3-card-heading"><h2>连接外设</h2><Bluetooth size={20} /></div><div className="s3-peer-selection"><strong>{selected?.name || (selected ? "未命名 BLE 设备" : "从左侧选择设备")}</strong><span>{selected?.address ?? "选择后显示设备地址"}</span>{selected && <small>{addressTypeLabel(selected.addressType)}</small>}</div>
        <label className="s3-check"><input type="checkbox" checked={remember} disabled={blocked} onChange={(event) => setRemember(event.target.checked)} /><span>连接成功后记住<small>保存稳定身份；重启后需手动选择连接。</small></span></label>
        <button type="button" className="s3-btn is-primary s3-full" disabled={blocked || !selected?.connectable} onClick={() => { if (selected) void action({ op: "ble.connect", address: selected.address, address_type: selected.addressType, remember }); }}><Bluetooth size={16} />{remember ? "连接并记住" : "临时连接"}</button><p className="s3-hint">保存连接目标与安全配对是两回事。私有地址无法保存时，可取消勾选后临时连接。ESP32-S3 不支持经典蓝牙 SPP / A2DP。</p>
      </section>
    </div>
    <section className="s3-card s3-current"><div><h2>当前主动连接</h2><strong>{bleStateLabel(status)}</strong><p>{status?.address || "尚未选择外设"}{status?.connected ? ` · ${status.encrypted ? "已加密" : "未加密"} · ${status.bonded ? "已配对" : "未配对"}` : ""}</p>{status?.identity && <p className="s3-hint">稳定身份：{status.identity}</p>}<MemoryStatus pending={status?.rememberPending} error={status?.memoryError} /></div>
      <div className="s3-actions"><button type="button" className="s3-btn" disabled={disabled || !status?.connected} onClick={() => { void action({ op: "ble.remember" }); }}><Save size={15} />记住当前外设</button><button type="button" className="s3-btn" disabled={disabled || !status?.enabled} onClick={() => { setServices(undefined); void action({ op: "ble.disconnect" }); }}>断开外设</button></div>
    </section>
    <Memories radio="ble" rows={snapshot.data?.bleSaved ?? []} disabled={disabled} connectDisabled={blocked} action={action} />
    <section className="s3-card"><div className="s3-card-heading"><div><h2>BLE 服务与入站连接</h2><p>入站客户端：{snapshot.data?.bleServer === "connected" ? (snapshot.data.bleSecure ? "已连接 · 已加密" : "已连接 · 未加密") : snapshot.data?.bleServer === "advertising" ? "广播中，等待电脑连接" : "尚未就绪"}</p></div><button type="button" className="s3-btn" disabled={disabled || !status?.connected} onClick={() => { void run("正在读取外设主服务", async () => { const address = status?.address ?? ""; setServices({ address, values: await sticks3Gateway.services() }); }); }}>读取外设服务</button></div>
      {services && status?.connected && services.address === status.address ? <div className="s3-services">{services.values.length ? services.values.map((service, index) => <code key={`${index}/${service}`}>{service}</code>) : <p className="s3-hint">尚未发现主服务，可稍后重试。</p>}</div> : <p className="s3-hint">主动连接后可读取最多 8 个主服务 UUID。断开外设会保留电脑到 S3 的入站连接；关闭 BLE 会同时断开所有蓝牙连接。</p>}
    </section>
  </>;
}

function RadioPower({ radio, enabled, supported, connected, disabled, action }: { radio: RadioKind; enabled: boolean; supported: boolean; connected: boolean; disabled: boolean; action: (request: RadioMutation) => Promise<boolean> }) {
  const label = radio === "wifi" ? "Wi-Fi" : "BLE";
  return <div className="s3-radio-power"><div><strong>{label} 无线开关</strong><p>{!connected ? "连接 S3 后可更改" : !supported ? `当前固件未启用 ${label} 支持` : enabled ? (radio === "wifi" ? "关闭会断开网络和备用热点，影响 W-DAP。" : "关闭会停止广播并断开所有蓝牙连接，影响 B-DAP。") : "当前已关闭，开启后可扫描和连接。"}</p></div><button type="button" className={`s3-btn ${enabled ? "" : "is-primary"}`} disabled={disabled} onClick={() => { void action({ op: `${radio}.${enabled ? "disable" : "enable"}` }); }}>{enabled ? `关闭 ${label}` : `开启 ${label}`}</button></div>;
}
function MemoryStatus({ pending, error }: { pending?: boolean; error?: number }) {
  return <>{pending && <p className="s3-hint">正在等待连接成功，再保存到设备…</p>}{Boolean(error) && <p className="s3-hint is-warning">记忆保存失败（{error}）。请检查空闲槽位或 BLE 稳定身份；无线是否连通请以上方状态为准。</p>}</>;
}
function Memories({ radio, rows, disabled, connectDisabled, action }: { radio: RadioKind; rows: RadioMemory[]; disabled: boolean; connectDisabled: boolean; action: (request: RadioMutation) => Promise<boolean> }) {
  const [removing, setRemoving] = useState<RadioMemory>();
  const label = radio === "wifi" ? "网络" : "外设";
  return <section className="s3-card"><div className="s3-card-heading"><div><h2><Save size={17} />已记住的{label}</h2><p>保存在 S3 上 · {rows.length} / 4 个记忆槽</p></div></div><div className="s3-memories">{[0, 1, 2, 3].map((slot) => {
    const row = rows.find((memory) => memory.slot === slot);
    return <div className={`s3-memory ${row ? "" : "is-empty"}`} key={slot}><span className="s3-slot">{slot + 1}</span><div><strong>{row?.label || "空闲记忆槽"}</strong><small>{row?.preferred ? (radio === "wifi" ? "开机首选网络" : "首选外设 · 手动重连") : row ? (row.addressType == null ? "已保存" : addressTypeLabel(row.addressType)) : "成功记住后显示在这里"}</small></div>{row && <><button type="button" className="s3-btn" disabled={connectDisabled} onClick={() => { void action({ op: `${radio}.use`, slot }); }}>连接</button><button type="button" className="s3-btn" aria-label={`忘记${row.label}`} disabled={disabled} onClick={() => setRemoving(row)}><Trash2 size={15} /></button></>}</div>;
  })}</div>{removing && <div className="s3-forget" role="alert"><span>从 S3 删除“{removing.label}”的连接记忆？当前连接会保留{radio === "ble" ? "，配对密钥也会保留" : ""}。</span><div className="s3-actions"><button type="button" className="s3-btn" disabled={disabled || !rows.some((row) => row.slot === removing.slot && row.label === removing.label)} onClick={() => { void action({ op: `${radio}.forget`, slot: removing.slot }).then((ok) => { if (ok) setRemoving(undefined); }); }}><Check size={15} />确认忘记</button><button type="button" className="s3-btn" onClick={() => setRemoving(undefined)}>取消</button></div></div>}</section>;
}
function Empty({ icon, title, detail }: { icon: RadioKind; title: string; detail: string }) {
  return <div className="s3-empty">{icon === "wifi" ? <Wifi size={34} /> : <Radio size={34} />}<strong>{title}</strong><p>{detail}</p></div>;
}
