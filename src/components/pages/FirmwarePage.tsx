import { ArrowDownToLine, ChevronLeft, ChevronRight, Cpu, Eraser, FileUp, LoaderCircle, RefreshCw, ShieldCheck, Usb, Wifi, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { isTauriRuntime } from "../../lib/device";
import {
  downloadFlash, firmwareApi, firmwareFormat, FLASH_PAGE_SIZE, FLASH_START, flashRows,
  hexAddress, MAX_FIRMWARE_SIZE, parseFlashAddress, resolveFirmwareTarget, firmwareImageRangeError, sameFlashTarget, mergeStickS3Probes,
  type ChipInfo, type FirmwareProduct, type FirmwareFormat, type FirmwareImage, type FirmwareReport,
  type FirmwareStatus, type ImageSummary, type ProbeConfig, type ProbeOption, type UsbSupport,
} from "../../lib/firmware";
import type { DapProtocol, NetworkProbe } from "../../lib/sticks3-network";
import "./FirmwarePage.css";

interface FirmwarePageProps {
  product: FirmwareProduct;
  connected: boolean;
  connectionBusy: boolean;
  onBusyChange: (busy: boolean) => void;
  networkProbes?: readonly NetworkProbe[];
  requestedProbe?: { id: string; protocol: DapProtocol; revision: number };
  onFindNetwork?: () => void;
}

type LocalFirmware = { name: string; format: FirmwareFormat; data: number[] };
type Operation = "flash" | "erase" | "read" | "setup" | "identify" | "verify" | "reset";
type FlashDump = { report: FirmwareReport; data: number[]; readAt: string; backupPrefix: string; stale: boolean };
const emptyStatus: FirmwareStatus = { busy: false, stage: "", message: "就绪 · 选择烧录器后连接并识别目标", completed: 0, total: null };
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
const kib = (bytes: number): string => `${(bytes / 1024).toLocaleString("zh-CN", { maximumFractionDigits: 2 })} KiB`;
const noNetworkProbes: readonly NetworkProbe[] = [];

export function FirmwarePage({ product, connected, connectionBusy, onBusyChange, networkProbes = noNetworkProbes, requestedProbe, onFindNetwork }: FirmwarePageProps) {
  const desktop = isTauriRuntime();
  const [usbProbes, setUsbProbes] = useState<ProbeOption[]>([]);
  const probes = useMemo(() => product === "sticks3" ? mergeStickS3Probes(usbProbes, networkProbes) : usbProbes, [product, usbProbes, networkProbes]);
  const [probeId, setProbeId] = useState("");
  const [protocol, setProtocol] = useState<DapProtocol>("swd");
  const [identified, setIdentified] = useState<ChipInfo | null>(null);
  const detected = identified?.probeId === probeId && (identified.protocol ?? "swd") === protocol ? identified : null;
  const target = resolveFirmwareTarget(product, detected);
  const { chip, flashSize: size, programSize } = target;
  const capacityLabel = size === null ? "待识别" : kib(size);
  const [speedKhz, setSpeedKhz] = useState(product === "sticks3" ? 100 : 1000);
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
  const blocked = !desktop || !statusReady || busy || connected || connectionBusy;
  const formLocked = busy || confirm !== null || connectionBusy;
  const selectedProbe = probes.find((probe) => probe.id === probeId);
  const config: ProbeConfig = { probeId, chip, speedKhz, connectUnderReset: underReset,
    ...(product === "sticks3" ? { protocol, ...(selectedProbe?.network ? { network: selectedProbe.network } : {}) } : {}),
    ...(chip === "auto" && detected ? { expectedTarget: { deviceId: detected.deviceId, flashSize: detected.flashSize, uid: detected.uid } } : {}) };
  const rows = useMemo(() => flashRows(dump?.data ?? [], page), [dump, page]);
  const pages = Math.ceil((dump?.data.length ?? 0) / FLASH_PAGE_SIZE);
  const progress = status.total ? Math.min(100, Math.floor(status.completed / status.total * 100)) : undefined;
  const imageError = inspectionError ?? (summary ? firmwareImageRangeError(summary, size) : null);

  useEffect(() => { onBusyChange(busy); }, [busy, onBusyChange]);

  const refreshProbes = useCallback(async (): Promise<void> => {
    setScanning(true);
    try {
      setUsbProbes(await firmwareApi.listProbes());
    } catch (reason) { setError(errorText(reason)); }
    finally { setScanning(false); }
  }, []);

  useEffect(() => {
    setProbeId((current) => probes.some((probe) => probe.id === current) ? current : probes.length === 1 ? (probes[0]?.id ?? "") : "");
  }, [probes]);

  useEffect(() => {
    if (!requestedProbe) return;
    setProbeId(requestedProbe.id); setProtocol(requestedProbe.protocol);
  }, [requestedProbe]);

  useEffect(() => {
    const matches = (info: ChipInfo) => info.probeId === probeId && (info.protocol ?? "swd") === protocol && (product === "sticks3" || info.name === resolveFirmwareTarget(product, null).label);
    setIdentified((current) => current && matches(current) ? current : null);
    setReport((current) => current && matches(current.chip) ? current : null);
    setNotice(null); setError(null);
    setDump((current) => current && !matches(current.report.chip) ? { ...current, stale: true } : current);
  }, [product, probeId, protocol]);

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
    void firmwareApi.usbSupport(product === "sticks3").then((value) => { if (!disposed) setSupport(value); }).catch((reason: unknown) => { if (!disposed) setError(errorText(reason)); });
    return () => { disposed = true; clearTimeout(timer); };
  }, [desktop, refreshProbes, product]);

  useEffect(() => {
    setSummary(null);
    setImage(null);
    setInspectionError(null);
    if (!firmware || !desktop) { setInspecting(false); return; }
    let cancelled = false;
    setInspecting(true);
    void (async () => {
      try {
        const candidate: FirmwareImage = { format: firmware.format, data: firmware.data, chip,
          baseAddress: firmware.format === "bin" ? parseFlashAddress(baseAddress, programSize ?? MAX_FIRMWARE_SIZE) : FLASH_START };
        const checked = await firmwareApi.inspect(candidate);
        if (!cancelled) { setSummary(checked); setImage(candidate); }
      } catch (reason) { if (!cancelled) setInspectionError(errorText(reason)); }
      finally { if (!cancelled) setInspecting(false); }
    })();
    return () => { cancelled = true; };
  }, [firmware, chip, baseAddress, programSize, desktop]);

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
    if (operation === "erase" && !target.canErase) return;
    if (chip === "auto" && (operation === "erase" || operation === "flash") && !detected) return;
    if ((operation === "flash" || operation === "verify") && (!image || !summary || imageError || inspecting || choosingFile)) return;
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
        setNotice(await firmwareApi.installUsbSupport(product === "sticks3"));
        await refreshProbes();
      } else {
        const result = operation === "read" ? await firmwareApi.read(config)
          : operation === "erase" ? await firmwareApi.erase(config, eraseText)
            : operation === "identify" ? await firmwareApi.identify(config)
              : operation === "reset" ? await firmwareApi.reset(config)
                : operation === "verify" ? await firmwareApi.verify(config, image as FirmwareImage)
            : await firmwareApi.flash(config, image as FirmwareImage, summary?.sha256 ?? "");
        setReport(result);
        setIdentified(result.chip);
        setNotice(result.message);
        setDump((current) => current && !sameFlashTarget(current.report.chip, result.chip) ? { ...current, stale: true } : current);
        if (operation === "read" && result.data) {
          setDump({ report: result, data: result.data, readAt: new Date().toISOString(), backupPrefix: resolveFirmwareTarget(product, result.chip).backupPrefix, stale: false });
          setPage(0);
          setJumpAddress(hexAddress(FLASH_START));
        }
      }
    } catch (reason) {
      setError(errorText(reason));
      if (operation !== "setup") {
        setIdentified(null);
        setDump((current) => current ? { ...current, stale: true } : current);
      }
    }
    finally {
      try { setStatus(await firmwareApi.status()); } catch { setStatusReady(false); }
      setWorking(null);
      operationLatch.current = false;
    }
  };

  const canOperate = !blocked && !scanning && !!selectedProbe?.accessible;
  const canModify = canOperate && (chip !== "auto" || detected !== null);
  return (
    <div className="page-stack wl1-firmware" data-product={product}>
      <div className="page-heading"><div><span className="section-kicker">{target.label} · {product === "sticks3" ? `CMSIS-DAP / ${protocol.toUpperCase()}` : "ST-LINK / SWD"}</span><h1>固件与 Flash</h1><p>{product === "sticks3" ? "选择 USB 或 Wi-Fi StickS3，通过 SWD / JTAG 识别目标、读取 Flash、备份、烧写与校验固件。" : product === "wl1" ? "选择本地固件更新小车，或独立擦除、读取整片主 Flash。" : "通过 SWD 更新游戏机固件，或读取完整 64 KiB Flash 进行查看与备份。"}</p></div><span className="wl1-fw-badge"><Cpu size={17} />内置烧录引擎 · 离线可用</span></div>
      <div className="wl1-fw-warning"><ShieldCheck size={21} /><p>{product === "sticks3" ? (protocol === "jtag" ? "StickS3 JTAG：G6 → TCK、G7 → TMS、G1 → TDI、G2 → TDO、G8 → NRST、GND → GND。目标板需支持 JTAG，自行供电，使用 3.3 V 电平。" : "StickS3 SWD：G6 → SWCLK、G7 → SWDIO、G8 → NRST、GND → GND。目标板自行供电，使用 3.3 V 调试电平。") : product === "wl1" ? "操作前断开电机电源，保留主控供电；连接 GND、SWDIO、SWCLK 和目标参考电压。" : "保持游戏机供电，连接 GND、PA13（SWDIO）、PA14（SWCLK）和目标参考电压，使用 3.3 V 电平。"}烧录成功会复位启动，读取也会短暂影响程序运行。操作期间请勿拔线或断电。</p></div>
      {!desktop && <p className="wl1-fw-notice">当前为浏览器预览。请打开桌面应用以使用真实 USB / Wi-Fi 烧录器。</p>}
      {(connected || connectionBusy) && <p className="wl1-fw-notice">请先在顶部断开串口或演示会话；目标调试独立于配网控制台。</p>}

      <section className="glass-card wl1-fw-card">
        <header><Usb size={20} /><h2>烧录器与目标</h2><div className="wl1-fw-probe-actions">{product === "sticks3" && onFindNetwork && <button className="secondary-button" type="button" disabled={formLocked || scanning} onClick={onFindNetwork}><Wifi size={15} />添加无线设备</button>}<button className="secondary-button" type="button" disabled={!desktop || formLocked || scanning} onClick={() => void refreshProbes()}><RefreshCw size={15} className={scanning ? "spin" : undefined} />{scanning ? "正在搜索" : "刷新烧录器"}</button></div></header>
        <fieldset disabled={formLocked} className="wl1-fw-fields">
          <label className="wl1-fw-probe">{product === "sticks3" ? "StickS3 设备（USB / Wi-Fi）" : "ST-Link / CMSIS-DAP"}<select aria-label="烧录器设备" value={probeId} onChange={(event) => { setProbeId(event.target.value); const next = probes.find((p) => p.id === event.target.value); if (next?.protocols && !next.protocols.includes(protocol)) setProtocol(next.protocols[0] ?? "swd"); }}><option value="">{probes.length ? "请选择烧录器" : product === "sticks3" ? "请刷新 USB 或添加无线设备" : "未发现烧录器，请连接 USB 后刷新"}</option>{probes.map((probe, index) => <option key={`${probe.id}-${index}`} value={probe.id}>{probe.network ? probe.name : `USB · ${probe.name}`} · {probe.serialNumber || "无序列号"}{probe.accessible ? "" : "（需要 USB 权限）"}</option>)}</select></label>
          <label>{product === "sticks3" ? "目标芯片（自动识别）" : "目标芯片（固定）"}<input readOnly value={`${target.label} · ${capacityLabel}`} /></label>
          {product === "sticks3" && <label>调试协议<select aria-label="调试协议" value={protocol} onChange={(event) => setProtocol(event.target.value as DapProtocol)}><option value="swd" disabled={selectedProbe?.protocols && !selectedProbe.protocols.includes("swd")}>SWD</option><option value="jtag" disabled={selectedProbe?.protocols && !selectedProbe.protocols.includes("jtag")}>JTAG</option></select></label>}
          <label>{protocol.toUpperCase()} 频率<select value={speedKhz} onChange={(event) => setSpeedKhz(Number(event.target.value))}>{[100, 250, 400, 1000, 1800, 4000].map((speed) => <option key={speed} value={speed}>{speed} kHz</option>)}</select></label>
          <label className="wl1-fw-checkbox"><input type="checkbox" checked={underReset} onChange={(event) => setUnderReset(event.target.checked)} /><span>复位下连接<small>连接失败时尝试；必须接 NRST</small></span></label>
        </fieldset>
        <div className="wl1-fw-actions"><button className="primary-button" type="button" disabled={!canOperate} onClick={() => void run("identify")}><Cpu size={16} />连接并识别</button><button className="secondary-button" type="button" disabled={!canOperate} onClick={() => void run("reset")}><RefreshCw size={16} />复位运行</button></div>
        {selectedProbe && !selectedProbe.accessible && <p role="alert" className="wl1-fw-error">已找到 {product === "sticks3" ? "StickS3 USB DAP" : "烧录器"}，但当前用户没有 USB 读写权限。请展开下方“USB 驱动与权限设置”，完成系统授权后刷新烧录器。</p>}
        {product === "sticks3" && <p className="wl1-fw-hint">{selectedProbe?.network ? `通过 Wi-Fi ${selectedProbe.network.host}:${selectedProbe.network.port} 连接。请在 StickS3 屏幕保持 W-DAP 开启；每次操作先核对序列号。` : "在 StickS3 屏幕保持 USB DAP 开启，并断开 USB 配网控制台。"}每次操作完成后释放探针；关闭占用它的 OpenOCD / IDE。</p>}
        {product === "sticks3" && <p className="wl1-fw-hint">按器件 ID 与容量寄存器自动匹配 Flash，无需选择 C8 / CB 或封装型号。当前支持 STM32F1 中容量、STM32F411、STM32G431。</p>}
        <p className="wl1-fw-hint">{size === null ? "连接或读取后显示实际 Flash 容量与地址范围。" : `${hexAddress(FLASH_START)} — ${hexAddress(FLASH_START + size - 1)} · ${capacityLabel} 主 Flash。`}主 Flash 不包含系统 ROM、OTP 或选项字节。</p>
        {product === "gamebox" && <p className="wl1-fw-notice">固件仅写入前 62 KiB（至 0x0800F7FF），保留末尾 2 KiB 设置区；读取和导出的备份包含完整 64 KiB。</p>}
        {!selectedProbe?.network && <details className="wl1-fw-support"><summary>USB 驱动与权限设置</summary><p>{support?.description ?? (product === "sticks3" ? "Linux 需要 StickS3 USB 访问权限；Windows 使用 CMSIS-DAP / WinUSB。" : "Linux 需要烧录器 USB 访问权限；Windows 需要对应的 USB 驱动。")}</p>{support?.canInstall && <button className="secondary-button" type="button" disabled={blocked} onClick={() => setConfirm("setup")}>设置 USB 支持（系统授权）</button>}{support?.license && <details><summary>第三方驱动许可</summary><pre>{support.license}</pre></details>}</details>}
      </section>

      <div className="wl1-fw-operations">
        <section className="glass-card wl1-fw-card wl1-fw-flash">
          <header><FileUp size={20} /><h2>烧录 / 更新固件</h2><span>01</span></header>
          <label className="wl1-fw-file"><FileUp size={26} /><strong>{firmware?.name ?? "选择已下载的固件"}</strong><span>BIN / Intel HEX / ELF / AXF · 最大 16 MiB</span><input type="file" accept=".bin,.hex,.elf,.axf" aria-label={`选择 ${target.backupPrefix} 烧录固件`} disabled={!desktop || formLocked} onChange={(event) => { void chooseFile(event.target.files?.[0]); event.target.value = ""; }} /></label>
          <label className="wl1-fw-address">BIN 起始地址<input value={baseAddress} spellCheck={false} disabled={formLocked || firmware?.format !== "bin"} onChange={(event) => setBaseAddress(event.target.value)} /><small>HEX / ELF 使用文件内地址；BIN 默认从 0x08000000 写入。</small></label>
          {(inspecting || choosingFile) && <p className="wl1-fw-hint">正在检查固件内容与地址…</p>}
          {imageError && <p role="alert" className="wl1-fw-error">{imageError}</p>}
          {summary && <div className="wl1-fw-image"><span>文件 {kib(summary.fileSize)} · 写入 {kib(summary.programmedSize)} · {summary.regions.length} 段</span><code title="文件 SHA-256">SHA-256 {summary.sha256}</code><details><summary>查看写入地址</summary>{summary.regions.map((region) => <code key={region.address}>{hexAddress(region.address)} — {hexAddress(region.address + region.length - 1)}（{kib(region.length)}）</code>)}</details></div>}
          <p className="wl1-fw-hint">自动擦除涉及的扇区，保留未覆盖字节，写后回读校验并复位启动。请使用与目标板匹配的固件。</p>
          {chip === "auto" && !detected && <p className="wl1-fw-hint">先连接并识别目标，或读取 Flash，即可按实际容量检查文件并启用烧录、擦除。</p>}
          <button className="primary-button" type="button" disabled={!canModify || !summary || !image || Boolean(imageError) || inspecting || choosingFile} onClick={() => setConfirm("flash")}><Zap size={17} />烧录固件</button>
          <button className="secondary-button wl1-fw-verify" type="button" disabled={!canOperate || !summary || !image || Boolean(imageError) || inspecting || choosingFile} onClick={() => void run("verify")}><ShieldCheck size={17} />仅校验文件与 Flash</button>
        </section>

        <section className="glass-card wl1-fw-card">
          <header><ArrowDownToLine size={20} /><h2>读取完整 Flash</h2><span>02</span></header>
          <p>{size === null ? "自动识别目标并读取完整主 Flash" : `读取全部 ${capacityLabel} 主 Flash`}，包括固件、参数和空白区域。支持十六进制查看和原始 BIN 备份。</p>
          <p className="wl1-fw-hint">不擦除、不写入 Flash。若芯片开启读保护，将报错并停止，不会自动解锁。</p>
          <button className="secondary-button" type="button" disabled={!canOperate} onClick={() => void run("read")}><ArrowDownToLine size={17} />读取全部 Flash</button>
        </section>

        {target.canErase && <section className="glass-card wl1-fw-card wl1-fw-erase">
          <header><Eraser size={20} /><h2>擦除全部 Flash</h2><span>03</span></header>
          <p>{size === null ? "识别容量后可清空全部主 Flash" : `清空全部 ${capacityLabel} 主 Flash`}，包含现有程序、bootloader 和存放其中的参数。</p>
          <p className="wl1-fw-hint">建议先读取并导出备份。擦除后逐字节检查是否全部为 FF；不会写入新固件。</p>
          <button className="danger-button" type="button" disabled={!canModify} onClick={() => { setEraseText(""); setConfirm("erase"); }}><Eraser size={17} />擦除全部 Flash</button>
        </section>}
      </div>

      <section className="glass-card wl1-fw-card wl1-fw-progress" aria-live="polite">
        <header>{busy ? <LoaderCircle className="spin" size={20} /> : <ShieldCheck size={20} />}<h2>{busy ? "操作进行中" : "操作状态"}</h2><span>{progress !== undefined ? `${progress}%` : busy ? "处理中" : ""}</span></header>
        <p role={error ? "alert" : undefined} className={error ? "wl1-fw-error" : undefined}>{error ?? notice ?? (status.message || emptyStatus.message)}</p>
        {(busy || status.stage === "complete") && <progress aria-label={status.message} max={100} value={progress} />}
        {busy && <small>请等待当前操作完成。此时无法切换页面、连接串口或正常关闭窗口。</small>}
        {report && <div className="wl1-fw-chip"><span>{report.chip.name} · 实测 {kib(report.chip.flashSize)} · {report.chip.speedKhz} kHz</span><code>UID {report.chip.uid} · ID {hexAddress(report.chip.deviceId)}</code></div>}
      </section>

      <section className="glass-card wl1-fw-card wl1-fw-viewer">
        <header><Cpu size={20} /><h2>Flash 数据</h2><button className="secondary-button" type="button" disabled={!dump} onClick={() => { if (dump) downloadFlash(dump.data, `${dump.backupPrefix}-${dump.report.chip.uid}-${dump.readAt.replace(/[:.]/g, "-")}.bin`); }}><ArrowDownToLine size={16} />导出 BIN 备份</button></header>
        {!dump ? <div className="wl1-fw-empty"><Cpu size={32} /><p>读取后，在这里查看芯片内的每个字节。</p><span>地址 · 十六进制 · ASCII</span></div> : <>
          <p className="wl1-fw-hint">{dump.report.chip.name} · UID {dump.report.chip.uid} · {new Date(dump.readAt).toLocaleString("zh-CN")} · {kib(dump.data.length)}</p>
          {dump.stale && <p className="wl1-fw-notice">这是先前读取的快照，当前目标或内容可能已改变。仍可导出这份备份；查看最新内容请重新读取。</p>}
          <code className="wl1-fw-digest">SHA-256 {dump.report.sha256}</code>
          <div className="wl1-fw-pager"><form onSubmit={(event) => { event.preventDefault(); try { setPage(Math.floor((parseFlashAddress(jumpAddress, dump.data.length) - FLASH_START) / FLASH_PAGE_SIZE)); setError(null); } catch (reason) { setError(errorText(reason)); } }}><label>跳转地址<input value={jumpAddress} spellCheck={false} onChange={(event) => setJumpAddress(event.target.value)} /></label><button className="secondary-button" type="submit">跳转</button></form><div><button className="icon-button" type="button" aria-label="上一页 Flash" disabled={page === 0} onClick={() => setPage((value) => value - 1)}><ChevronLeft size={18} /></button><span>{page + 1} / {pages}</span><button className="icon-button" type="button" aria-label="下一页 Flash" disabled={page >= pages - 1} onClick={() => setPage((value) => value + 1)}><ChevronRight size={18} /></button></div></div>
          <div className="wl1-fw-hex"><table><thead><tr><th>地址</th><th>00 01 02 03 04 05 06 07 08 09 0A 0B 0C 0D 0E 0F</th><th>ASCII</th></tr></thead><tbody>{rows.map((row) => <tr key={row.address}><th scope="row">{row.address}</th><td>{row.hex}</td><td>{row.ascii}</td></tr>)}</tbody></table></div>
        </>}
      </section>

      <dialog className="wl1-fw-dialog" ref={dialog} onCancel={() => setConfirm(null)}>
        <h2>{confirm === "erase" ? "确认擦除整片主 Flash" : confirm === "setup" ? "设置 USB 支持" : "确认烧录固件"}</h2>
        {confirm === "setup" ? <><p>{support?.description}</p><p>点击继续后系统才会请求管理员授权，可以在系统授权窗口取消。不会烧录、擦除或读取芯片。{product === "sticks3" ? "完成后请刷新烧录器。" : "完成后请重新插拔烧录器。"}</p>{support?.platform === "windows" && <p>继续设置表示接受“USB 驱动与权限设置”中展示的 ST 第三方驱动许可。</p>}</> : <><p>目标：{target.label} · {capacityLabel}</p><code>{selectedProbe?.name} · {selectedProbe?.serialNumber ?? probeId}</code>{detected && <code>UID {detected.uid}</code>}<p>{product === "sticks3" ? "请确认目标芯片、供电与所选 SWD/JTAG 接线，并保存需要保留的 Flash 备份。" : product === "wl1" ? "请确认电机电源已断开，主控供电与 SWD 接线稳定。" : "请确认游戏机供电与 SWD 接线稳定；末尾 2 KiB 设置区将保留。"}</p></>}
        {confirm === "flash" && <><strong>{firmware?.name}</strong><code>SHA-256 {summary?.sha256}</code><div className="wl1-fw-confirm-ranges">{summary?.regions.map((region) => <code key={region.address}>{hexAddress(region.address)} — {hexAddress(region.address + region.length - 1)}</code>)}</div><p>将写入 {kib(summary?.programmedSize ?? 0)} 数据，覆盖范围之外的数据保留。校验完成后自动复位启动。</p></>}
        {confirm === "erase" && <><p className="wl1-fw-error">固件、bootloader 和 Flash 中的参数将全部丢失，此操作无法撤销。</p><label>输入 ERASE 确认<input value={eraseText} autoComplete="off" spellCheck={false} onChange={(event) => setEraseText(event.target.value)} /></label></>}
        <footer><button className="secondary-button" type="button" onClick={() => setConfirm(null)}>取消</button><button className={confirm === "erase" ? "danger-button" : "primary-button"} type="button" disabled={blocked || (confirm === "erase" && eraseText !== "ERASE")} onClick={() => { if (confirm) void run(confirm); }}>{confirm === "erase" ? "确认擦除" : confirm === "setup" ? "继续设置" : "确认烧录"}</button></footer>
      </dialog>
    </div>
  );
}
