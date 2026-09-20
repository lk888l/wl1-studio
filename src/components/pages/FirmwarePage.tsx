import { ArrowDownToLine, ChevronLeft, ChevronRight, Cpu, Eraser, FileUp, LoaderCircle, RefreshCw, ShieldCheck, Usb, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauriRuntime } from "../../lib/device";
import {
  downloadFlash, firmwareApi, firmwareFormat, FLASH_PAGE_SIZE, FLASH_START, flashRows,
  hexAddress, MAX_FIRMWARE_SIZE, parseFlashAddress,
  type FirmwareChip, type FirmwareFormat, type FirmwareImage, type FirmwareReport,
  type FirmwareStatus, type ImageSummary, type ProbeConfig, type ProbeOption, type UsbSupport,
} from "../../lib/firmware";
import "./FirmwarePage.css";

interface FirmwarePageProps {
  connected: boolean;
  connectionBusy: boolean;
  onBusyChange: (busy: boolean) => void;
}

type LocalFirmware = { name: string; format: FirmwareFormat; data: number[] };
type Operation = "flash" | "erase" | "read" | "setup";
type FlashDump = { report: FirmwareReport; data: number[]; readAt: string; stale: boolean };
const emptyStatus: FirmwareStatus = { busy: false, stage: "", message: "就绪 · 选择 ST-Link 后开始操作", completed: 0, total: null };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const kib = (bytes: number): string => `${(bytes / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} KiB`;

export function FirmwarePage({ connected, connectionBusy, onBusyChange }: FirmwarePageProps) {
  const desktop = isTauriRuntime();
  const [probes, setProbes] = useState<ProbeOption[]>([]);
  const [probeId, setProbeId] = useState("");
  const [chip, setChip] = useState<FirmwareChip>("stm32f411xe");
  const [speedKhz, setSpeedKhz] = useState(1000);
  const [underReset, setUnderReset] = useState(false);
  const [firmware, setFirmware] = useState<LocalFirmware | null>(null);
  const [baseAddress, setBaseAddress] = useState("0x08000000");
  const [image, setImage] = useState<FirmwareImage | null>(null);
  const [summary, setSummary] = useState<ImageSummary | null>(null);
  const [inspectionError, setInspectionError] = useState<string | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [choosingFile, setChoosingFile] = useState(false);
  const [status, setStatus] = useState<FirmwareStatus>(emptyStatus);
  const [statusReady, setStatusReady] = useState(false);
  const [working, setWorking] = useState<Operation | null>(null);
  const [scanning, setScanning] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<FirmwareReport | null>(null);
  const [dump, setDump] = useState<FlashDump | null>(null);
  const [page, setPage] = useState(0);
  const [jumpAddress, setJumpAddress] = useState("0x08000000");
  const [confirm, setConfirm] = useState<"flash" | "erase" | "setup" | null>(null);
  const [eraseText, setEraseText] = useState("");
  const [support, setSupport] = useState<UsbSupport | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const operationLatch = useRef(false);
  const fileGeneration = useRef(0);
  const busy = working !== null || status.busy;
  const size = chip === "stm32f411xe" ? 512 * 1024 : 256 * 1024;
  const blocked = !desktop || !statusReady || busy || connected || connectionBusy;
  const formLocked = busy || confirm !== null;
  const config: ProbeConfig = { probeId, chip, speedKhz, connectUnderReset: underReset };
  const selectedProbe = probes.find((probe) => probe.id === probeId);
  const rows = useMemo(() => flashRows(dump?.data ?? [], page), [dump, page]);
  const pages = Math.ceil((dump?.data.length ?? 0) / FLASH_PAGE_SIZE);
  const progress = status.total ? Math.min(100, Math.floor(status.completed / status.total * 100)) : undefined;

  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  const refreshProbes = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      const found = await firmwareApi.listProbes();
      setProbes(found);
      setProbeId((current) => found.some((probe) => probe.id === current) ? current : found.length === 1 ? (found[0]?.id ?? "") : "");
    } catch (reason) { setError(errorText(reason)); }
    finally { setScanning(false); }
  }, []);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const next = await firmwareApi.status();
        if (!disposed) { setStatus(next); setStatusReady(true); }
      } catch (reason) {
        if (!disposed) { setStatusReady(false); setError(errorText(reason)); }
      } finally {
        if (!disposed) timer = setTimeout(() => { void poll(); }, 500);
      }
    };
    void poll();
    void refreshProbes();
    void firmwareApi.usbSupport().then((value) => { if (!disposed) setSupport(value); }).catch((reason: unknown) => { if (!disposed) setError(errorText(reason)); });
    return () => { disposed = true; clearTimeout(timer); };
  }, [desktop, refreshProbes]);

  useEffect(() => {
    setSummary(null);
    setImage(null);
    setInspectionError(null);
    if (!firmware || !desktop) return;
    let cancelled = false;
    setInspecting(true);
    void (async () => {
      try {
        const candidate: FirmwareImage = { format: firmware.format, data: firmware.data, chip,
          baseAddress: firmware.format === "bin" ? parseFlashAddress(baseAddress, size) : FLASH_START };
        const checked = await firmwareApi.inspect(candidate);
        if (!cancelled) { setSummary(checked); setImage(candidate); }
      } catch (reason) { if (!cancelled) setInspectionError(errorText(reason)); }
      finally { if (!cancelled) setInspecting(false); }
    })();
    return () => { cancelled = true; };
  }, [firmware, chip, baseAddress, size, desktop]);

  useEffect(() => {
    if (confirm && dialog.current && !dialog.current.open) dialog.current.showModal();
    else if (!confirm) dialog.current?.close();
  }, [confirm]);

  const chooseFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const generation = ++fileGeneration.current;
    setChoosingFile(true);
    setFirmware(null);
    setInspectionError(null);
    setInspecting(false);
    setSummary(null);
    setImage(null);
    try {
      const format = firmwareFormat(file.name);
      if (file.size === 0 || file.size > MAX_FIRMWARE_SIZE) throw new Error("固件必须非空且不超过 16 MiB。");
      const data = Array.from(new Uint8Array(await file.arrayBuffer()));
      if (generation === fileGeneration.current) setFirmware({ name: file.name, format, data });
    } catch (reason) { if (generation === fileGeneration.current) setInspectionError(errorText(reason)); }
    finally { if (generation === fileGeneration.current) setChoosingFile(false); }
  };

  const run = async (operation: Operation): Promise<void> => {
    if (operationLatch.current || blocked) return;
    if (operation === "flash" && (!image || !summary || inspecting || choosingFile)) return;
    operationLatch.current = true;
    setWorking(operation);
    onBusyChange(true);
    setConfirm(null);
    setError(null);
    setNotice(null);
    setReport(null);
    setStatus({ ...emptyStatus, stage: "connecting", message: operation === "setup" ? "正在设置 USB 支持，请完成系统授权…" : "正在连接并核对芯片…" });
    if (operation === "flash" || operation === "erase") setDump((current) => current ? { ...current, stale: true } : null);
    try {
      if (operation === "setup") {
        setNotice(await firmwareApi.installUsbSupport());
        await refreshProbes();
      } else {
        const result = operation === "read" ? await firmwareApi.read(config)
          : operation === "erase" ? await firmwareApi.erase(config, eraseText)
            : await firmwareApi.flash(config, image as FirmwareImage, summary?.sha256 ?? "");
        setReport(result);
        setNotice(result.message);
        if (operation === "read" && result.data) {
          setDump({ report: result, data: result.data, readAt: new Date().toISOString(), stale: false });
          setPage(0);
          setJumpAddress(hexAddress(FLASH_START));
        }
      }
    } catch (reason) { setError(errorText(reason)); }
    finally {
      try { setStatus(await firmwareApi.status()); } catch { setStatusReady(false); }
      setWorking(null);
      operationLatch.current = false;
    }
  };

  const canOperate = !blocked && !scanning && !!selectedProbe?.accessible;
  return (
    <div className="page-stack wl1-firmware">
      <div className="page-heading"><div><span className="section-kicker">STM32F411 · ST-LINK / SWD</span><h1>固件与 Flash</h1><p>选择本地固件更新小车，或独立擦除、读取整片主 Flash。</p></div><span className="wl1-fw-badge"><Cpu size={17} />内置烧录引擎 · 离线可用</span></div>
      <div className="wl1-fw-warning"><ShieldCheck size={21} /><p>操作前断开电机电源，保留主控供电；连接 GND、SWDIO、SWCLK 和目标参考电压。烧录成功会复位启动，读取也会短暂影响程序运行。操作期间请勿拔线或断电。</p></div>
      {!desktop && <p className="wl1-fw-notice">当前为浏览器预览。请通过安装包或 npm run tauri dev 打开桌面应用以使用真实 ST-Link。</p>}
      {(connected || connectionBusy) && <p className="wl1-fw-notice">请先在顶部断开串口或 Mock 会话；SWD 操作独立于串口连接。</p>}

      <section className="glass-card wl1-fw-card">
        <header><Usb size={20} /><h2>烧录器与目标</h2><button className="secondary-button" type="button" disabled={!desktop || busy || scanning || confirm !== null} onClick={() => void refreshProbes()}><RefreshCw size={15} className={scanning ? "spin" : undefined} />{scanning ? "正在搜索" : "刷新 ST-Link"}</button></header>
        <fieldset disabled={formLocked} className="wl1-fw-fields">
          <label className="wl1-fw-probe">ST-Link<select value={probeId} onChange={(event) => setProbeId(event.target.value)}><option value="">{probes.length ? "请选择烧录器" : "未发现 ST-Link，请连接 USB 后刷新"}</option>{probes.map((probe, index) => <option key={`${probe.id}-${index}`} value={probe.id}>{probe.name} · {probe.serialNumber || "无序列号"}{probe.accessible ? "" : "（需要 USB 权限）"}</option>)}</select></label>
          <label>芯片容量<select value={chip} onChange={(event) => setChip(event.target.value as FirmwareChip)}><option value="stm32f411xe">STM32F411xE · 512 KiB</option><option value="stm32f411xc">STM32F411xC · 256 KiB</option></select></label>
          <label>SWD 频率<select value={speedKhz} onChange={(event) => setSpeedKhz(Number(event.target.value))}>{[100, 400, 1000, 1800, 4000].map((speed) => <option key={speed} value={speed}>{speed} kHz</option>)}</select></label>
          <label className="wl1-fw-checkbox"><input type="checkbox" checked={underReset} onChange={(event) => setUnderReset(event.target.checked)} /><span>复位下连接<small>连接失败时尝试；必须接 NRST</small></span></label>
        </fieldset>
        <p className="wl1-fw-hint">{hexAddress(FLASH_START)} — {hexAddress(FLASH_START + size - 1)} · 自动核对真实芯片 ID 和容量。主 Flash 不包含系统 ROM、OTP 或选项字节。</p>
        <details className="wl1-fw-support"><summary>USB 驱动与权限设置</summary><p>{support?.description ?? "Linux 需要 ST-Link USB 访问权限；Windows 需要 ST-Link 驱动。"}</p>{support?.canInstall && <button className="secondary-button" type="button" disabled={blocked} onClick={() => setConfirm("setup")}>设置 USB 支持（系统授权）</button>}{support?.license && <details><summary>第三方驱动许可</summary><pre>{support.license}</pre></details>}</details>
      </section>

      <div className="wl1-fw-operations">
        <section className="glass-card wl1-fw-card wl1-fw-flash">
          <header><FileUp size={20} /><h2>烧录 / 更新固件</h2><span>01</span></header>
          <label className="wl1-fw-file"><FileUp size={26} /><strong>{firmware?.name ?? "选择已下载的固件"}</strong><span>BIN / Intel HEX / ELF / AXF · 最大 16 MiB</span><input type="file" accept=".bin,.hex,.elf,.axf" disabled={!desktop || formLocked} onChange={(event) => { void chooseFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
          <label className="wl1-fw-address">BIN 起始地址<input value={baseAddress} spellCheck={false} disabled={formLocked || firmware?.format !== "bin"} onChange={(event) => setBaseAddress(event.target.value)} /><small>HEX / ELF 使用文件内地址；BIN 默认从 0x08000000 写入。</small></label>
          {(inspecting || choosingFile) && <p className="wl1-fw-hint">正在检查固件内容与地址…</p>}
          {inspectionError && <p role="alert" className="wl1-fw-error">{inspectionError}</p>}
          {summary && <div className="wl1-fw-image"><span>文件 {kib(summary.fileSize)} · 写入 {kib(summary.programmedSize)} · {summary.regions.length} 段</span><code title="文件 SHA-256">SHA-256 {summary.sha256}</code><details><summary>查看写入地址</summary>{summary.regions.map((region) => <code key={region.address}>{hexAddress(region.address)} — {hexAddress(region.address + region.length - 1)}（{kib(region.length)}）</code>)}</details></div>}
          <p className="wl1-fw-hint">自动擦除涉及的扇区，保留未覆盖字节，写后回读校验并复位启动。文件格式通过不代表固件适配这台小车。</p>
          <button className="primary-button" type="button" disabled={!canOperate || !summary || !image || inspecting || choosingFile} onClick={() => setConfirm("flash")}><Zap size={17} />烧录固件</button>
        </section>

        <section className="glass-card wl1-fw-card">
          <header><ArrowDownToLine size={20} /><h2>读取完整 Flash</h2><span>02</span></header>
          <p>读取全部 {kib(size)} 主 Flash，包括固件、参数和空白区域。支持十六进制查看和原始 BIN 备份。</p>
          <p className="wl1-fw-hint">不擦除、不写入 Flash。若芯片开启读保护，将报错并停止，不会自动解锁。</p>
          <button className="secondary-button" type="button" disabled={!canOperate} onClick={() => void run("read")}><ArrowDownToLine size={17} />读取全部 Flash</button>
        </section>

        <section className="glass-card wl1-fw-card wl1-fw-erase">
          <header><Eraser size={20} /><h2>擦除全部 Flash</h2><span>03</span></header>
          <p>清空全部 {kib(size)} 主 Flash，包含现有程序、bootloader 和存放其中的参数。</p>
          <p className="wl1-fw-hint">建议先读取并导出备份。擦除后逐字节检查是否全部为 FF；不会写入新固件。</p>
          <button className="danger-button" type="button" disabled={!canOperate} onClick={() => { setEraseText(""); setConfirm("erase"); }}><Eraser size={17} />擦除全部 Flash</button>
        </section>
      </div>

      <section className="glass-card wl1-fw-card wl1-fw-progress" aria-live="polite">
        <header>{busy ? <LoaderCircle className="spin" size={20} /> : <ShieldCheck size={20} />}<h2>{busy ? "操作进行中" : "操作状态"}</h2><span>{progress !== undefined ? `${progress}%` : busy ? "处理中" : ""}</span></header>
        <p role={error ? "alert" : undefined} className={error ? "wl1-fw-error" : undefined}>{error ?? notice ?? (status.message || emptyStatus.message)}</p>
        {(busy || status.stage === "complete") && <progress aria-label={status.message} max={100} value={progress} />}
        {busy && <small>请等待当前操作完成。此时无法切换页面、连接串口或正常关闭窗口。</small>}
        {report && <div className="wl1-fw-chip"><span>{report.chip.name} · 实测 {kib(report.chip.flashSize)} · {report.chip.speedKhz} kHz</span><code>UID {report.chip.uid} · ID {hexAddress(report.chip.deviceId)}</code></div>}
      </section>

      <section className="glass-card wl1-fw-card wl1-fw-viewer">
        <header><Cpu size={20} /><h2>Flash 数据</h2><button className="secondary-button" type="button" disabled={!dump} onClick={() => { if (dump) downloadFlash(dump.data, `WL1-${dump.report.chip.uid}-${dump.readAt.replace(/[:.]/g, "-")}.bin`); }}><ArrowDownToLine size={16} />导出 BIN 备份</button></header>
        {!dump ? <div className="wl1-fw-empty"><Cpu size={32} /><p>读取后，在这里查看芯片内的每个字节。</p><span>地址 · 十六进制 · ASCII</span></div> : <>
          <p className="wl1-fw-hint">{dump.report.chip.name} · UID {dump.report.chip.uid} · {new Date(dump.readAt).toLocaleString("zh-CN")} · {kib(dump.data.length)}</p>
          {dump.stale && <p className="wl1-fw-notice">这是写入/擦除前的读取快照，仍可导出备份；查看最新内容请重新读取。</p>}
          <code className="wl1-fw-digest">SHA-256 {dump.report.sha256}</code>
          <div className="wl1-fw-pager"><form onSubmit={(event) => { event.preventDefault(); try { setPage(Math.floor((parseFlashAddress(jumpAddress, dump.data.length) - FLASH_START) / FLASH_PAGE_SIZE)); setError(null); } catch (reason) { setError(errorText(reason)); } }}><label>跳转地址<input value={jumpAddress} spellCheck={false} onChange={(event) => setJumpAddress(event.target.value)} /></label><button className="secondary-button" type="submit">跳转</button></form><div><button className="icon-button" type="button" aria-label="上一页 Flash" disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><span>{page + 1} / {pages}</span><button className="icon-button" type="button" aria-label="下一页 Flash" disabled={page >= pages - 1} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></div>
          <div className="wl1-fw-hex"><table><thead><tr><th>地址</th><th>00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F</th><th>ASCII</th></tr></thead><tbody>{rows.map((row) => <tr key={row.address}><th scope="row">{row.address}</th><td>{row.hex}</td><td>{row.ascii}</td></tr>)}</tbody></table></div>
        </>}
      </section>

      <dialog className="wl1-fw-dialog" ref={dialog} onCancel={() => setConfirm(null)}>
        <h2>{confirm === "erase" ? "确认擦除整片主 Flash" : confirm === "setup" ? "设置 ST-Link USB 支持" : "确认烧录固件"}</h2>
        {confirm === "setup" ? <><p>{support?.description}</p><p>点击继续后系统才会请求管理员授权，可以在系统授权窗口取消。不会烧录、擦除或读取芯片。完成后请重新插拔 ST-Link。</p>{support?.platform === "windows" && <p>继续设置表示接受“USB 驱动与权限设置”中展示的 ST 第三方驱动许可。</p>}</> : <><p>目标：{chip === "stm32f411xe" ? "STM32F411xE · 512 KiB" : "STM32F411xC · 256 KiB"}</p><code>{selectedProbe?.name} · {selectedProbe?.serialNumber ?? probeId}</code><p>请确认电机电源已断开，主控供电与 SWD 接线稳定。</p></>}
        {confirm === "flash" && <><strong>{firmware?.name}</strong><code>SHA-256 {summary?.sha256}</code><div className="wl1-fw-confirm-ranges">{summary?.regions.map((region) => <code key={region.address}>{hexAddress(region.address)} — {hexAddress(region.address + region.length - 1)}</code>)}</div><p>将写入 {kib(summary?.programmedSize ?? 0)} 数据，覆盖范围之外的数据保留。校验完成后自动复位启动。</p></>}
        {confirm === "erase" && <><p className="wl1-fw-error">固件、bootloader 和 Flash 中的参数将全部丢失，此操作无法撤销。</p><label>输入 ERASE 确认<input value={eraseText} autoComplete="off" spellCheck={false} onChange={(event) => setEraseText(event.target.value)} /></label></>}
        <footer><button className="secondary-button" type="button" onClick={() => setConfirm(null)}>取消</button><button className={confirm === "erase" ? "danger-button" : "primary-button"} type="button" disabled={blocked || (confirm === "erase" && eraseText !== "ERASE")} onClick={() => { if (confirm) void run(confirm); }}>{confirm === "erase" ? "确认擦除" : confirm === "setup" ? "继续设置" : "确认烧录"}</button></footer>
      </dialog>
    </div>
  );
}
