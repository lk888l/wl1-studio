import {
  ArrowLeft, Cable, Check, Copy, Download, Eraser, FileUp, Heart,
  ImagePlus, LoaderCircle, Moon, MousePointer2, Paintbrush, Pause,
  PawPrint, Play, Plus, RefreshCw, RotateCcw, Save, Smile, Sparkles,
  Trash2, Unplug, Upload, Wifi, X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent, KeyboardEvent, PointerEvent } from "react";
import { isTauriRuntime } from "../../lib/device";
import { PetCancelled, petGateway } from "../../lib/pet";
import {
  PET_ACTIONS, PET_ACTION_LABELS, PET_FRAME_BYTES, PET_HEIGHT, PET_MAX_FRAMES, PET_PRESETS, PET_WIDTH,
  blankPetFrame, encodePetPackage, loadPetProject, makePetPreset, newPetProject,
  petFrameBytes, petFrameCount, petFrameHex, pixelOn, savePetProject, setPetPixel, validatePetProject,
} from "../../lib/pet-model";
import type { PetAction, PetProject, PetStyle } from "../../lib/pet-model";
import type { SerialPortOption } from "../../types";
import { PcMonitorPanel } from "./PcMonitorPanel";
import { LiquidGlass } from "../LiquidGlass";
import "./PetStudio.css";

const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
const presetThumbnails = PET_PRESETS.map((preset) => ({ ...preset, thumbnail: makePetPreset(preset.style).actions.idle.frames[0] ?? blankPetFrame() }));

function paintCanvas(canvas: HTMLCanvasElement, frame: string): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const bytes = petFrameBytes(frame);
  context.fillStyle = "#111c26";
  context.fillRect(0, 0, PET_WIDTH, PET_HEIGHT);
  context.fillStyle = "#dafcea";
  for (let y = 0; y < PET_HEIGHT; y++) for (let x = 0; x < PET_WIDTH; x++) if (pixelOn(bytes, x, y)) context.fillRect(x, y, 1, 1);
}

function PetPixels({ frame, label, className = "" }: { frame: string; label: string; className?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (ref.current) paintCanvas(ref.current, frame); }, [frame]);
  return <canvas ref={ref} width={PET_WIDTH} height={PET_HEIGHT} className={`pet-pixels ${className}`} role="img" aria-label={label} />;
}

function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function imageToFrame(image: ImageBitmap, threshold: number, invert: boolean): string {
  const canvas = document.createElement("canvas");
  canvas.width = PET_WIDTH; canvas.height = PET_HEIGHT;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("浏览器无法处理图片。");
  context.fillStyle = "black"; context.fillRect(0, 0, PET_WIDTH, PET_HEIGHT);
  const scale = Math.min(PET_WIDTH / image.width, PET_HEIGHT / image.height);
  const width = Math.max(1, Math.round(image.width * scale));
  const height = Math.max(1, Math.round(image.height * scale));
  context.imageSmoothingEnabled = true;
  context.drawImage(image, Math.floor((PET_WIDTH - width) / 2), Math.floor((PET_HEIGHT - height) / 2), width, height);
  const rgba = context.getImageData(0, 0, PET_WIDTH, PET_HEIGHT).data;
  const bytes = new Uint8Array(PET_FRAME_BYTES);
  for (let i = 0; i < PET_WIDTH * PET_HEIGHT; i++) {
    const luminance = (rgba[i * 4] ?? 0) * .2126 + (rgba[i * 4 + 1] ?? 0) * .7152 + (rgba[i * 4 + 2] ?? 0) * .0722;
    setPetPixel(bytes, i % PET_WIDTH, Math.floor(i / PET_WIDTH), (luminance >= threshold) !== invert);
  }
  return petFrameHex(bytes);
}

export function PetStudio({ onBack }: { onBack: () => void }) {
  const [tab, setTab] = useState<"pet" | "monitor">("pet");
  const [project, setProject] = useState<PetProject>(loadPetProject);
  const [style, setStyle] = useState<PetStyle>(4);
  const [action, setAction] = useState<PetAction>("idle");
  const [frameIndex, setFrameIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [previewIndex, setPreviewIndex] = useState(0);
  const [tool, setTool] = useState<"draw" | "erase">("draw");
  const [grid, setGrid] = useState(true);
  const [history, setHistory] = useState<string[]>([]);
  const [snapshot, setSnapshot] = useState(petGateway.snapshot);
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [portName, setPortName] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saved, setSaved] = useState(true);
  const [savePending, setSavePending] = useState(false);
  const [uploadSaving, setUploadSaving] = useState(false);
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [threshold, setThreshold] = useState(128);
  const [invertImage, setInvertImage] = useState(false);
  const [imageName, setImageName] = useState("");
  const [deviceAction, setDeviceAction] = useState<PetAction | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const jsonInput = useRef<HTMLInputElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageRef = useRef<ImageBitmap | null>(null);
  const latestProject = useRef(project);
  const active = useRef(false);
  const mounted = useRef(true);
  const uploadCancel = useRef(false);
  const stroke = useRef<{ pointerId: number; x: number; y: number; bytes: Uint8Array; on: boolean } | null>(null);
  const keyboardCursor = useRef({ x: 32, y: 16 });
  const animation = project.actions[action];
  const currentFrame = animation.frames[frameIndex] ?? blankPetFrame();
  const previewAnimation = animation.frames.length ? animation : project.actions.idle;
  const previewFrame = previewAnimation.frames[(playing ? previewIndex : frameIndex) % Math.max(previewAnimation.frames.length, 1)] ?? blankPetFrame();
  const frameCount = petFrameCount(project);
  const nameValid = /^[\x20-\x7e]{1,16}$/.test(project.name) && Boolean(project.name.trim());
  const tauri = isTauriRuntime();

  useEffect(() => petGateway.subscribe(setSnapshot), []);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; uploadCancel.current = true; imageRef.current?.close(); savePetProject(latestProject.current); };
  }, []);
  useEffect(() => {
    latestProject.current = project;
    setSavePending(true);
    const timer = setTimeout(() => { setSaved(savePetProject(project)); setSavePending(false); }, 350);
    return () => clearTimeout(timer);
  }, [project]);
  useEffect(() => { if (canvasRef.current) paintCanvas(canvasRef.current, currentFrame); }, [currentFrame]);
  useEffect(() => {
    if (!playing || previewAnimation.frames.length < 2) return;
    const timer = setInterval(() => setPreviewIndex((index) => index + 1), previewAnimation.interval);
    return () => clearInterval(timer);
  }, [playing, previewAnimation.interval, previewAnimation.frames.length]);

  const run = useCallback(async (label: string, work: () => Promise<unknown>, success = "") => {
    if (active.current) return;
    active.current = true; setBusy(label); setError(""); setNotice("");
    try { await work(); if (mounted.current) setNotice(success); }
    catch (reason) { if (mounted.current) { if (reason instanceof PetCancelled) setNotice("操作已取消，设备上的原有宠物保留。"); else setError(errorText(reason)); } }
    finally { active.current = false; if (mounted.current) setBusy(""); }
  }, []);
  const refreshPorts = useCallback(async () => {
    const next = await petGateway.listSerialPorts();
    if (!mounted.current) return;
    setPorts(next);
    setPortName((current) => next.some((port) => port.name === current) ? current : next.find((port) => port.name.includes("ttyACM"))?.name ?? next[0]?.name ?? "");
  }, []);
  useEffect(() => { void run("查找 USB 串口", refreshPorts); }, [run, refreshPorts]);

  function changeAction(next: PetAction) {
    setAction(next); setFrameIndex(0); setPreviewIndex(0); setHistory([]); setImageName("");
  }
  function replaceFrame(frame: string, remember = true) {
    if (remember) setHistory((previous) => [...previous, currentFrame].slice(-30));
    setProject((previous) => {
      const old = previous.actions[action];
      const frames = [...old.frames];
      if (!frames.length) {
        if (petFrameCount(previous) >= PET_MAX_FRAMES) return previous;
        frames.push(frame);
      } else frames[Math.min(frameIndex, frames.length - 1)] = frame;
      return { ...previous, actions: { ...previous.actions, [action]: { ...old, frames } } };
    });
    setStyle(4);
  }
  function loadProject(next: PetProject, nextStyle: PetStyle = 4) {
    setProject(next); setStyle(nextStyle); changeAction("idle"); setError("");
  }
  function choosePreset(next: PetStyle) {
    loadProject(makePetPreset(next), next);
    setNotice("已载入样式到工作台。可以直接在设备显示，也可以继续修改像素。");
  }
  function addFrame(copy: boolean) {
    if (animation.frames.length >= 4 || frameCount >= PET_MAX_FRAMES) return;
    const frames = [...animation.frames, copy ? currentFrame : blankPetFrame()];
    setProject((previous) => ({ ...previous, actions: { ...previous.actions, [action]: { ...previous.actions[action], frames } } }));
    setFrameIndex(frames.length - 1); setHistory([]); setStyle(4);
  }
  function deleteFrame() {
    if (!animation.frames.length || (action === "idle" && animation.frames.length === 1)) return;
    const frames = animation.frames.filter((_, index) => index !== frameIndex);
    setProject((previous) => ({ ...previous, actions: { ...previous.actions, [action]: { ...previous.actions[action], frames } } }));
    setFrameIndex(Math.max(0, frameIndex - 1)); setHistory([]); setStyle(4);
  }
  function point(event: PointerEvent<HTMLCanvasElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.min(63, Math.floor((event.clientX - rect.left) / rect.width * 64))), y: Math.max(0, Math.min(31, Math.floor((event.clientY - rect.top) / rect.height * 32))) };
  }
  function drawTo(x: number, y: number) {
    const drawing = stroke.current;
    if (!drawing || active.current) return;
    const steps = Math.max(Math.abs(x - drawing.x), Math.abs(y - drawing.y), 1);
    for (let i = 0; i <= steps; i++) setPetPixel(drawing.bytes, Math.round(drawing.x + (x - drawing.x) * i / steps), Math.round(drawing.y + (y - drawing.y) * i / steps), drawing.on);
    drawing.x = x; drawing.y = y;
    replaceFrame(petFrameHex(drawing.bytes), false);
  }
  function pointerDown(event: PointerEvent<HTMLCanvasElement>) {
    if (active.current || event.button !== 0 || (!animation.frames.length && frameCount >= PET_MAX_FRAMES)) return;
    event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId);
    const { x, y } = point(event);
    setHistory((previous) => [...previous, currentFrame].slice(-30));
    stroke.current = { pointerId: event.pointerId, x, y, bytes: petFrameBytes(currentFrame), on: tool === "draw" };
    drawTo(x, y);
  }
  function keyboardDraw(event: KeyboardEvent<HTMLCanvasElement>) {
    if (active.current) return;
    const cursor = keyboardCursor.current;
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", " ", "Enter"].includes(event.key)) event.preventDefault();
    if (event.key === "ArrowLeft") cursor.x = Math.max(0, cursor.x - 1);
    else if (event.key === "ArrowRight") cursor.x = Math.min(63, cursor.x + 1);
    else if (event.key === "ArrowUp") cursor.y = Math.max(0, cursor.y - 1);
    else if (event.key === "ArrowDown") cursor.y = Math.min(31, cursor.y + 1);
    else if (event.key === " " || event.key === "Enter") {
      const bytes = petFrameBytes(currentFrame); setPetPixel(bytes, cursor.x, cursor.y, tool === "draw"); replaceFrame(petFrameHex(bytes));
    }
    event.currentTarget.setAttribute("aria-label", `像素画布，光标 ${cursor.x + 1}, ${cursor.y + 1}。方向键移动，空格绘制。`);
  }
  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    await run("导入桌宠工程", async () => {
      if (file.size > 100_000) throw new Error("工程文件过大，请选择桌宠 JSON 工程。");
      const text = await file.text();
      if (!mounted.current) throw new PetCancelled();
      loadProject(validatePetProject(JSON.parse(text)));
    }, `已导入 ${file.name}，可以编辑或上传到设备。`);
  }
  async function importImage(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    await run("导入像素图片", async () => {
      if (!file.type.startsWith("image/") || file.size > 10 * 1024 * 1024) throw new Error("请选择 10 MB 以内的 PNG、JPEG 或 WebP 图片。");
      if (!animation.frames.length && frameCount >= PET_MAX_FRAMES) throw new Error("帧数已满，请先删除一帧。");
      const image = await createImageBitmap(file);
      if (!mounted.current) { image.close(); throw new PetCancelled(); }
      imageRef.current?.close(); imageRef.current = image;
      setImageName(file.name); replaceFrame(imageToFrame(image, threshold, invertImage));
    }, "图片已等比缩放并居中到当前帧，可调整阈值或继续绘制。");
  }
  function exportJson() {
    try { const valid = validatePetProject(project); download(`${valid.name}.pet.json`, JSON.stringify(valid, null, 2), "application/json"); }
    catch (reason) { setError(errorText(reason)); }
  }
  function exportBinary() {
    try { const bytes = encodePetPackage(project); download(`${project.name}.pet`, bytes.buffer as ArrayBuffer, "application/octet-stream"); }
    catch (reason) { setError(errorText(reason)); }
  }
  function upload() {
    uploadCancel.current = false; setUploadSaving(false);
    void run("上传自定义宠物", async () => {
      try {
        await petGateway.upload(project, (sent, total) => { if (mounted.current) setProgress({ sent, total }); }, () => uploadCancel.current, () => { if (mounted.current) setUploadSaving(true); });
        setStyle(4); setDeviceAction("idle");
      } finally { if (mounted.current) { setProgress(null); setUploadSaving(false); } }
    }, "宠物已保存到设备，并以全屏桌宠模式显示。重启后仍可使用。");
  }
  function showOnDevice() {
    if (style === 4) { upload(); return; }
    void run("切换设备宠物", async () => { await petGateway.command(`pet open ${style}`); setDeviceAction("idle"); }, "设备已进入全屏桌宠模式。");
  }
  function trigger(next: PetAction) {
    changeAction(next); setPlaying(true);
    if (snapshot.connected) void run(`让宠物${PET_ACTION_LABELS[next]}`, async () => { await petGateway.command(`pet action ${next}`); setDeviceAction(next); });
  }
  function back() {
    if (active.current) return;
    setSaved(savePetProject(project));
    void run("释放 USB 串口", async () => { await petGateway.disconnect(); onBack(); });
  }

  return <div className="pet-studio">
    <LiquidGlass as="aside" className="pet-sidebar">
      <button type="button" className="pet-back" disabled={Boolean(busy)} onClick={back}><ArrowLeft size={16} />返回产品库</button>
      <div className="pet-brand"><span><PawPrint size={27} /></span><div><strong>Pet Studio</strong><small>ESP32-C3 · 像素陪伴</small></div></div>
      {tab === "pet" ? <>
      <div className="pet-sidebar-heading">领养一个小伙伴 <Sparkles size={14} /></div>
      <div className="pet-presets">
        {presetThumbnails.map((preset) => <button type="button" key={preset.style} className={`pet-preset${style === preset.style ? " is-active" : ""}`} disabled={Boolean(busy)} onClick={() => choosePreset(preset.style)}>
          <PetPixels frame={preset.thumbnail} label={preset.title} />
          <span><strong>{preset.title}</strong><small>{preset.name}</small></span>{style === preset.style && <Check size={15} />}
        </button>)}
        <button type="button" className={`pet-preset pet-preset--new${style === 4 ? " is-active" : ""}`} disabled={Boolean(busy)} onClick={() => { loadProject(newPetProject()); setNotice("空白宠物已创建，从待机动作开始绘制吧。"); }}><span className="pet-new-icon"><Plus size={23} /></span><span><strong>自己画一个</strong><small>64 × 32，任你想象</small></span></button>
      </div>
      <div className="pet-sidebar-note"><Heart size={21} /><strong>小屏幕，也有小情绪</strong><p>眨眼、吃东西、打瞌睡。每个动作都能亲手画出来。</p></div>
      </> : <div className="pet-monitor-sidebar"><Wifi size={30} /><h2>电脑状态，随时可见</h2><p>电脑采集系统指标，ESP32-C3 通过 Wi-Fi 接收。无需 USB 连接，切换页面后也会继续运行。</p></div>}
      {tab === "pet" && <div className={`pet-connection-state${snapshot.connected ? " is-online" : ""}`}><i /><span><strong>{snapshot.connected ? "ESP32-C3 已连接" : "本地创作模式"}</strong><small>{snapshot.portName ?? "可随时编辑、预览和导出"}</small></span></div>}
    </LiquidGlass>

    <main className="pet-workspace">
      <LiquidGlass as="header" className="pet-topbar"><span>设备控制中心 <span>/</span> ESP32-C3 工作台</span>{tab === "pet" && <span className="pet-save-state"><Save size={13} />{savePending ? "正在保存草稿…" : saved ? "草稿已自动保存" : "草稿未保存，请检查名称或导出备份"}</span>}</LiquidGlass>
      <nav className="pet-workbench-tabs" aria-label="ESP32-C3 工作台功能"><button type="button" className={tab === "pet" ? "is-active" : ""} aria-pressed={tab === "pet"} disabled={Boolean(busy)} onClick={() => setTab("pet")}><PawPrint size={15} />桌宠</button><button type="button" className={tab === "monitor" ? "is-active" : ""} aria-pressed={tab === "monitor"} disabled={Boolean(busy)} onClick={() => setTab("monitor")}><Wifi size={15} />电脑监控</button></nav>
      {tab === "monitor" && <PcMonitorPanel />}
      <div className="pet-content" hidden={tab !== "pet"}>
        <div className="pet-heading"><div><span className="pet-eyebrow">A LITTLE COMPANY</span><h1>让像素，变成陪伴。</h1><p>挑一位小伙伴，给它画上表情，再带到你的 OLED 屏幕。</p></div><span className="pet-fullscreen-tag">128 × 64 OLED · 全屏桌宠</span></div>
        <LiquidGlass as="section" className="pet-connectbar" aria-label="ESP32-C3 设备连接">
          <Cable size={20} /><label htmlFor="pet-port">USB 设备</label>
          <select id="pet-port" value={portName} disabled={!tauri || snapshot.connected || Boolean(busy)} onChange={(event) => setPortName(event.target.value)}><option value="">{ports.length ? "请选择串口" : "未发现可用串口"}</option>{ports.map((port) => <option key={port.name} value={port.name}>{port.name}{port.product ? ` · ${port.product}` : ""}</option>)}</select>
          <button type="button" className="pet-button" aria-label="刷新串口" disabled={!tauri || snapshot.connected || Boolean(busy)} onClick={() => { void run("查找 USB 串口", refreshPorts); }}><RefreshCw size={15} /></button>
          {snapshot.connected ? <button type="button" className="pet-button" disabled={Boolean(busy)} onClick={() => { void run("断开 USB", () => petGateway.disconnect(), "USB 已断开，宠物继续在设备上运行。"); }}><Unplug size={15} />断开</button> : <button type="button" className="pet-button is-primary" disabled={!tauri || !portName || Boolean(busy)} onClick={() => { void run("连接并确认桌宠固件", () => petGateway.connect(portName), "设备已连接。选择样式后即可在屏幕显示。"); }}>连接设备</button>}
        </LiquidGlass>
        {!tauri && <p className="pet-message">浏览器支持全部创作与预览功能；连接 USB、上传宠物请使用桌面应用。</p>}
        {error && <div className="pet-message is-error" role="alert"><span>{error}</span><button type="button" aria-label="关闭错误提示" onClick={() => setError("")}><X size={16} /></button></div>}
        {notice && <p className="pet-message is-success" role="status">{notice}</p>}
        {busy && <div className="pet-message" role="status"><LoaderCircle size={16} className="pet-spin" /><span>{uploadSaving ? "保存到设备中" : busy}…{progress && ` ${Math.round(progress.sent / progress.total * 100)}%`}</span>{progress && !uploadSaving && <button type="button" onClick={() => { uploadCancel.current = true; }}>取消上传</button>}</div>}
        {progress && <progress className="pet-upload-progress" value={progress.sent} max={progress.total} aria-label="宠物上传进度" />}

        <div className="pet-main-grid">
          <LiquidGlass as="section" variant="panel" className="pet-card pet-editor">
            <div className="pet-section-title"><div><h2><Paintbrush size={18} />像素创作台</h2><p>64 × 32 单色像素，在设备上放大 2 倍铺满屏幕。</p></div><span className="pet-count">{frameCount} / 24 帧</span></div>
            <div className="pet-editor-meta"><label htmlFor="pet-name">宠物名称<input id="pet-name" value={project.name} maxLength={16} spellCheck={false} aria-invalid={!nameValid} aria-describedby={!nameValid ? "pet-name-error" : undefined} disabled={Boolean(busy)} onChange={(event) => { setProject((previous) => ({ ...previous, name: event.target.value })); setStyle(4); }} placeholder="最多 16 个 ASCII 字符" />{!nameValid && <small id="pet-name-error" className="pet-name-error">名称需为 1–16 个英文字母、数字或 ASCII 符号；原有草稿已保留。</small>}</label><div className="pet-file-actions"><button type="button" className="pet-button" disabled={Boolean(busy)} onClick={() => jsonInput.current?.click()}><FileUp size={14} />导入工程</button><button type="button" className="pet-button" onClick={exportJson}><Download size={14} />导出 JSON</button></div></div>
            <fieldset className="pet-actions" aria-label="动作选择">{PET_ACTIONS.map((item) => <button type="button" key={item} className={action === item ? "is-active" : ""} aria-pressed={action === item} disabled={Boolean(busy)} onClick={() => changeAction(item)}>{PET_ACTION_LABELS[item]}<small>{project.actions[item].frames.length}</small></button>)}</fieldset>
            <div className="pet-tools"><div><button type="button" className={`pet-tool${tool === "draw" ? " is-active" : ""}`} aria-pressed={tool === "draw"} onClick={() => setTool("draw")}><Paintbrush size={15} />画笔</button><button type="button" className={`pet-tool${tool === "erase" ? " is-active" : ""}`} aria-pressed={tool === "erase"} onClick={() => setTool("erase")}><Eraser size={15} />橡皮</button><button type="button" className="pet-tool" disabled={!history.length || Boolean(busy)} onClick={() => { const previous = history[history.length - 1]; if (previous) replaceFrame(previous, false); setHistory((items) => items.slice(0, -1)); }} aria-label="撤销绘制"><RotateCcw size={15} /></button></div><label><input type="checkbox" checked={grid} onChange={(event) => setGrid(event.target.checked)} />像素网格</label></div>
            <div className={`pet-canvas-wrap${grid ? " has-grid" : ""}${busy ? " is-disabled" : ""}`}>
              <canvas ref={canvasRef} width={64} height={32} className="pet-pixels pet-drawing-canvas" tabIndex={busy ? -1 : 0} role="img" aria-label="像素画布，拖动绘制；方向键移动光标，空格绘制。" onPointerDown={pointerDown} onPointerMove={(event) => { if (stroke.current?.pointerId === event.pointerId) { const p = point(event); drawTo(p.x, p.y); } }} onPointerUp={() => { stroke.current = null; }} onPointerCancel={() => { stroke.current = null; }} onLostPointerCapture={() => { stroke.current = null; }} onKeyDown={keyboardDraw} />
              {!animation.frames.length && <span className="pet-empty-frame">尚未绘制此动作 · 可直接落笔，空动作使用待机画面</span>}
            </div>
            <div className="pet-canvas-caption"><span><MousePointer2 size={12} />拖动绘制 · 每格 1 像素</span><div><button type="button" disabled={Boolean(busy)} onClick={() => replaceFrame(petFrameHex(petFrameBytes(currentFrame).map((byte) => byte ^ 255)))}>反相</button><button type="button" disabled={Boolean(busy)} onClick={() => replaceFrame(blankPetFrame())}>清空当前帧</button></div></div>
            <div className="pet-frame-toolbar"><strong>{PET_ACTION_LABELS[action]} · 动画帧</strong><div><button type="button" className="pet-button" disabled={Boolean(busy) || animation.frames.length >= 4 || frameCount >= PET_MAX_FRAMES} onClick={() => addFrame(false)}><Plus size={14} />新帧</button><button type="button" className="pet-button" disabled={Boolean(busy) || !animation.frames.length || animation.frames.length >= 4 || frameCount >= PET_MAX_FRAMES} onClick={() => addFrame(true)}><Copy size={14} />复制</button><button type="button" className="pet-button" aria-label="删除当前帧" disabled={Boolean(busy) || !animation.frames.length || (action === "idle" && animation.frames.length === 1)} onClick={deleteFrame}><Trash2 size={14} /></button></div></div>
            <div className="pet-filmstrip">{animation.frames.map((frame, index) => <button type="button" key={`${action}-${index}`} disabled={Boolean(busy)} className={index === frameIndex ? "is-active" : ""} aria-label={`选择第 ${index + 1} 帧`} aria-pressed={index === frameIndex} onClick={() => { setFrameIndex(index); setHistory([]); setImageName(""); }}><PetPixels frame={frame} label={`第 ${index + 1} 帧`} /><span>{String(index + 1).padStart(2, "0")}</span></button>)}{!animation.frames.length && <p>为这个动作添加第一帧。每个动作最多 4 帧，全部动作合计最多 24 帧。</p>}</div>
            <label className="pet-speed" htmlFor="pet-interval"><span>帧间隔 <strong>{animation.interval} ms</strong></span><input id="pet-interval" type="range" min={80} max={1000} step={10} value={animation.interval} disabled={Boolean(busy)} onChange={(event) => { const interval = Number(event.target.value); setProject((previous) => ({ ...previous, actions: { ...previous.actions, [action]: { ...previous.actions[action], interval } } })); setStyle(4); }} /><small>80 ms 更灵动 <span>1000 ms 更悠闲</span></small></label>
            <details className="pet-image-import"><summary><ImagePlus size={16} />从图片开始创作</summary><p>图片等比缩放到 64 × 32 并居中，亮色转为 OLED 发光像素；支持透明 PNG。</p><button type="button" className="pet-button" disabled={Boolean(busy)} onClick={() => imageInput.current?.click()}><ImagePlus size={15} />{imageName || "选择图片"}</button><label htmlFor="pet-threshold">黑白阈值 <strong>{threshold}</strong><input id="pet-threshold" type="range" min={1} max={254} value={threshold} disabled={Boolean(busy)} onChange={(event) => { const value = Number(event.target.value); setThreshold(value); if (imageRef.current && imageName) replaceFrame(imageToFrame(imageRef.current, value, invertImage), false); }} /></label><label className="pet-checkbox"><input type="checkbox" checked={invertImage} disabled={Boolean(busy)} onChange={(event) => { const value = event.target.checked; setInvertImage(value); if (imageRef.current && imageName) replaceFrame(imageToFrame(imageRef.current, threshold, value), false); }} />反转图片明暗</label></details>
          </LiquidGlass>

          <div className="pet-right-column">
            <LiquidGlass as="section" variant="panel" className="pet-card pet-preview-card"><div className="pet-section-title"><div><h2><Sparkles size={18} />它在这里</h2><p>动画预览 · {PET_ACTION_LABELS[action]}</p></div><button type="button" className="pet-preview-toggle" aria-label={playing ? "暂停动画" : "播放动画"} onClick={() => setPlaying((value) => !value)}>{playing ? <Pause size={17} /> : <Play size={17} />}</button></div><div className="pet-device"><div className="pet-device-top"><span>POCKET COMPANION</span><i /></div><div className="pet-oled"><PetPixels frame={previewFrame} label={`${project.name}，${PET_ACTION_LABELS[action]}动作预览`} /></div><div className="pet-device-bottom"><span>ESP32-C3</span><span>● ● ●</span></div></div><div className="pet-preview-name"><strong>{project.name || "MyPet"}</strong><span>{animation.frames.length ? `${animation.frames.length} 帧 · ${animation.interval} ms / 帧` : `使用待机动画 · ${previewAnimation.interval} ms / 帧`}</span></div><p className="pet-preview-note">预览为当前工程像素。选择内置样式可直接显示，修改后上传为自定义宠物。</p><button type="button" className="pet-button is-primary pet-show-button" disabled={!snapshot.connected || Boolean(busy) || !nameValid} onClick={showOnDevice}><Upload size={16} />{style === 4 ? "上传并在设备显示" : "在设备显示这个样式"}</button>{style !== 4 && <button type="button" className="pet-button pet-show-button" disabled={!snapshot.connected || Boolean(busy) || !nameValid} onClick={upload}>将当前像素上传为自定义宠物</button>}<button type="button" className="pet-export-binary" onClick={exportBinary}><Download size={13} />下载 PET1 像素包 · {64 + frameCount * 256} B</button></LiquidGlass>
            <LiquidGlass as="section" variant="panel" className="pet-card pet-interaction"><div className="pet-section-title"><div><h2><Heart size={18} />陪它玩一会儿</h2><p>{snapshot.connected ? "同步触发设备上的宠物动作" : "先试试表情，连接设备后同步互动"}</p></div></div><div className="pet-interaction-grid">{PET_ACTIONS.map((item) => <button type="button" key={item} className={deviceAction === item && snapshot.connected ? "is-active" : ""} disabled={Boolean(busy)} onClick={() => trigger(item)}>{item === "sleep" ? <Moon size={18} /> : item === "happy" ? <Heart size={18} /> : item === "dance" ? <Sparkles size={18} /> : <Smile size={18} />}<span>{PET_ACTION_LABELS[item]}</span></button>)}</div><button type="button" className="pet-close-mode" disabled={!snapshot.connected || Boolean(busy)} onClick={() => { void run("退出桌宠模式", async () => { await petGateway.command("pet close"); setDeviceAction(null); }, "设备已返回主页。"); }}>退出设备桌宠模式</button></LiquidGlass>
            <LiquidGlass as="section" variant="panel" className="pet-card pet-guide"><h2><PawPrint size={17} />它会怎么回应你</h2><div><strong>确认键</strong><span>单击开心，双击喂食，长按睡觉。</span></div><div><strong>上 / 下键</strong><span>切换宠物；同时按下返回主页。</span></div><div><strong>安静陪伴</strong><span>自然呼吸、眨眼，闲置 60 秒后入睡。</span></div><p>睡眠中按任意键先唤醒。左右键控制视线；扩展 Jump 键跳舞，Function 键惊讶。</p></LiquidGlass>
          </div>
        </div>
        <footer className="pet-footer"><span>草稿保存在本机 · JSON 工程可分享和继续编辑</span><span>8 个动作 · 最多 24 帧 · 单个像素包 ≤ 6208 B</span></footer>
      </div>
    </main>
    <input ref={jsonInput} type="file" accept=".json,application/json" hidden onChange={(event) => { void importJson(event); }} />
    <input ref={imageInput} type="file" accept="image/png,image/jpeg,image/webp,image/bmp" hidden onChange={(event) => { void importImage(event); }} />
  </div>;
}
