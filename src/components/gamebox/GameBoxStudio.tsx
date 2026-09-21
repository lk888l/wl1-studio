import {
  Activity, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, BookOpen, Cable,
  Check, CheckCircle2, ChevronRight, CircleHelp, CircuitBoard, Clock3, Cpu,
  Download, FileCode2, FileUp, Gamepad2, HardDrive, Layers3, LoaderCircle,
  Radio, RefreshCw, Terminal, Trash2, Unplug, X, Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import {
  gameboxGateway, type GameBoxButtonFrame, type GameBoxEvent, type GameBoxSnapshot,
} from "../../lib/gamebox";
import {
  GAMEBOX_GAMES, inspectGameBoxFirmware, type GameBoxFirmwareReport,
} from "../../lib/gamebox-firmware";
import type { SerialPortOption } from "../../types";
import { isTauriRuntime } from "../../lib/device";
import { FirmwarePage } from "../pages/FirmwarePage";
import "./GameBoxStudio.css";

type GameBoxPage = "overview" | "games" | "console" | "firmware" | "storage";
type Key = GameBoxButtonFrame["key"];
type LogEntry = { id: number; timestamp: number; text: string; kind: "button" | "ready" | "raw" | "system" };
type LastButton = { frame: GameBoxButtonFrame; timestamp: number };

const pages = [
  { id: "overview", label: "设备总览", icon: Gamepad2, caption: "连接设备，发现每一次按下。" },
  { id: "games", label: "游戏图鉴", icon: BookOpen, caption: "小小的屏幕，装下许多好玩的世界。" },
  { id: "console", label: "串口监视", icon: Terminal, caption: "从一行行事件，了解设备的每个动作。" },
  { id: "firmware", label: "固件与 Flash", icon: Cpu, caption: "通过 ST-Link 更新固件、读取和备份完整 Flash。" },
  { id: "storage", label: "存储与检查", icon: HardDrive, caption: "检查本地 BIN 与存储布局，了解后续扩展。" },
] as const;
const keys: Key[] = ["UP", "DOWN", "LEFT", "RIGHT", "JUMP", "FUNC", "ENTER", "BACK"];
const actionLabels: Record<GameBoxButtonFrame["action"], string> = {
  PRESSED: "按下", RELEASED: "松开", CLICK: "单击", DOUBLE: "双击", LONG: "长按", REPEAT: "连发",
};
const zeroCounts = (): Record<Key, number> => ({ UP: 0, DOWN: 0, LEFT: 0, RIGHT: 0, JUMP: 0, FUNC: 0, ENTER: 0, BACK: 0 });
const timeLabel = (timestamp: number): string => new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
const hex = (value: number | null): string => value === null ? "无法读取" : `0x${value.toString(16).toUpperCase().padStart(8, "0")}`;
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

function PixelArtwork({ variant = 0 }: { variant?: number }) {
  return (
    <svg viewBox="0 0 128 64" fill="currentColor" shapeRendering="crispEdges" aria-hidden="true">
      {variant % 4 === 0 ? <>
        <path d="M20 20h8v8h8v-8h8v8h8v8h-8v8h-8v-8h-8v8h-8v-8h-8v-8h8zM84 36h8v8h8v-8h8v16H84z" />
        <path d="M68 16h4v4h-4zM100 12h4v4h-4zM56 48h4v4h-4zM20 54h92v2H20z" opacity=".4" />
      </> : variant % 4 === 1 ? <>
        <path d="M20 12h28v8H28v20h28v8H20zM48 24h20v8H48zM60 28h8v20h20V28h8v28H60zM88 16h16v8H88z" />
        <path d="M106 42h8v8h-8zM36 28h4v4h-4zM100 18h2v2h-2z" opacity=".5" />
      </> : variant % 4 === 2 ? <>
        <path d="M36 12h12v12H36zM48 12h12v12H48zM48 24h12v12H48zM60 24h12v12H60zM72 36h12v12H72zM84 36h12v12H84zM84 48h12v12H84zM96 48h12v12H96z" />
        <path d="M20 48h12v12H20zM32 48h12v12H32zM44 48h12v12H44z" opacity=".35" />
      </> : <>
        <path d="M18 12h92v4H18zM18 24h24v6H18zM50 24h24v6H50zM82 24h28v6H82zM18 36h24v6H18zM50 36h24v6H50z" opacity=".55" />
        <path d="M80 42h6v6h-6zM44 56h40v4H44z" />
      </>}
    </svg>
  );
}

function Handheld({ snapshot, activeKeys, lastButton }: {
  snapshot: GameBoxSnapshot; activeKeys: Set<Key>; lastButton: LastButton | null;
}) {
  const state = snapshot.mode === "demo" ? "DEMO MODE" : snapshot.identified ? "DEVICE READY" : snapshot.mode === "serial" ? "WAITING RX" : "STANDBY";
  return (
    <div className="gb-device-scene">
      <span className="gb-scene-label"><span />128 × 64 OLED</span>
      <div className="gb-handheld" role="img" aria-label="GameBox 设备状态示意，按键仅显示接收事件">
        <div className="gb-handheld__top"><span>STM · GAMEBOX</span><span className={`gb-power-led${snapshot.mode !== "disconnected" ? " is-on" : ""}`} /></div>
        <div className="gb-screen-bezel">
          <div className="gb-oled">
            <div className="gb-oled__bar"><span>{state}</span><span>●</span></div>
            <strong>GAME<span>BOX</span></strong>
            <PixelArtwork />
            <div className="gb-oled__footer">{lastButton ? `${lastButton.frame.key} · ${lastButton.frame.action}` : "READY WHEN YOU ARE"}</div>
          </div>
          <span className="gb-oled-caption">DOT MATRIX · STATUS PREVIEW</span>
        </div>
        <div className="gb-device-controls">
          <div className="gb-dpad">
            {([ ["UP", ArrowUp], ["LEFT", ArrowLeft], ["RIGHT", ArrowRight], ["DOWN", ArrowDown] ] as const).map(([key, Icon]) => (
              <div key={key} className={`gb-key gb-key--${key.toLowerCase()}${activeKeys.has(key) ? " is-active" : ""}`} title={`${key} · 串口接收指示`}><Icon size={17} strokeWidth={2.7} /></div>
            ))}
            <div className="gb-dpad__center"><i /></div>
          </div>
          <div className="gb-round-keys">
            <div className={`gb-round-key gb-round-key--func${activeKeys.has("FUNC") ? " is-active" : ""}`}><span>F</span><small>FUNC</small></div>
            <div className={`gb-round-key gb-round-key--jump${activeKeys.has("JUMP") ? " is-active" : ""}`}><span>J</span><small>JUMP</small></div>
          </div>
        </div>
        <div className="gb-device-bottom">
          <div className="gb-menu-keys">
            {(["BACK", "ENTER"] as const).map((key) => <div key={key} className={activeKeys.has(key) ? "is-active" : ""}><i /><small>{key}</small></div>)}
          </div>
          <div className="gb-speaker" aria-hidden="true"><i /><i /><i /><i /></div>
        </div>
      </div>
      <span className="gb-scene-note">状态示意 · 非设备屏幕镜像</span>
    </div>
  );
}

export function GameBoxStudio({ onBack }: { onBack: () => void }) {
  const [page, setPage] = useState<GameBoxPage>("overview");
  const [snapshot, setSnapshot] = useState<GameBoxSnapshot>(gameboxGateway.connection);
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [port, setPort] = useState("");
  const [busy, setBusy] = useState(true);
  const [firmwareVisited, setFirmwareVisited] = useState(false);
  const [firmwareBusy, setFirmwareBusy] = useState(false);
  const [startupReady, setStartupReady] = useState(false);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [counts, setCounts] = useState<Record<Key, number>>(zeroCounts);
  const [lastButton, setLastButton] = useState<LastButton | null>(null);
  const [activeKeys, setActiveKeys] = useState<Set<Key>>(() => new Set());
  const [autoScroll, setAutoScroll] = useState(true);
  const [report, setReport] = useState<GameBoxFirmwareReport | null>(null);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileError, setFileError] = useState<string | null>(null);
  const [gameFilter, setGameFilter] = useState<"全部" | "游戏" | "工具">("全部");
  const mounted = useRef(false);
  const busyRef = useRef(true);
  const firmwareBusyRef = useRef(false);
  const refreshingRef = useRef(false);
  const logId = useRef(0);
  const currentSession = useRef<number | undefined>(snapshot.sessionId);
  const logSource = useRef("尚无接收会话");
  const keyTimers = useRef<Partial<Record<Key, ReturnType<typeof setTimeout>>>>({});
  const firmwareRequest = useRef(0);
  const consoleEnd = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const handleFirmwareBusy = useCallback((next: boolean) => {
    firmwareBusyRef.current = next;
    setFirmwareBusy(next);
  }, []);

  const changePage = (next: GameBoxPage) => {
    if (firmwareBusyRef.current) return;
    if (next === "firmware") setFirmwareVisited(true);
    setPage(next);
  };

  const applySnapshot = useCallback((next: GameBoxSnapshot) => {
    if (!mounted.current) return;
    if (next.sessionId !== currentSession.current || next.mode === "disconnected") {
      if (next.sessionId !== undefined && next.sessionId !== currentSession.current) {
        setLogs([]);
        logSource.current = `${next.mode === "demo" ? "演示数据 · 无硬件" : "真实串口"} · ${next.label}`;
      }
      currentSession.current = next.sessionId;
      setCounts(zeroCounts());
      setLastButton(null);
      setActiveKeys(new Set());
      for (const timer of Object.values(keyTimers.current)) clearTimeout(timer);
      keyTimers.current = {};
    }
    setSnapshot(next);
  }, []);

  const refreshPorts = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const next = await gameboxGateway.listSerialPorts();
      if (!mounted.current) return;
      setPorts(next);
      setPort((previous) => next.some((item) => item.name === previous) ? previous : next[0]?.name ?? "");
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      refreshingRef.current = false;
      if (mounted.current) setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void startupAttempt;
    mounted.current = true;
    busyRef.current = true;
    setBusy(true);
    setStartupReady(false);
    let cancelled = false;
    const onEvent = (event: GameBoxEvent) => {
      if (cancelled) return;
      if (event.type === "snapshot") { applySnapshot(event.snapshot); return; }
      if (event.type === "line" && event.sessionId !== currentSession.current) return;
      if (event.type === "disconnected") setError(event.text);
      const entry: LogEntry = {
        id: ++logId.current, timestamp: event.timestamp, text: event.text,
        kind: event.type === "disconnected" ? "system" : event.frame?.type ?? "raw",
      };
      setLogs((previous) => [...previous, entry].slice(-300));
      if (event.type !== "line" || event.frame?.type !== "button") return;
      const frame = event.frame;
      setLastButton({ frame, timestamp: event.timestamp });
      setCounts((previous) => ({ ...previous, [frame.key]: previous[frame.key] + 1 }));
      setActiveKeys((previous) => new Set([...previous, frame.key]));
      clearTimeout(keyTimers.current[frame.key]);
      keyTimers.current[frame.key] = setTimeout(() => {
        if (!cancelled) setActiveKeys((previous) => { const next = new Set(previous); next.delete(frame.key); return next; });
      }, 480);
    };
    const unsubscribe = gameboxGateway.subscribe(onEvent);
    void gameboxGateway.initialize().then((next) => {
      if (!cancelled) { applySnapshot(next); setStartupReady(true); void refreshPorts(); }
    }).catch((cause: unknown) => {
      if (!cancelled) setError(errorText(cause));
    }).finally(() => {
      if (!cancelled) { busyRef.current = false; setBusy(false); }
    });
    return () => {
      cancelled = true;
      mounted.current = false;
      unsubscribe();
      for (const timer of Object.values(keyTimers.current)) clearTimeout(timer);
      firmwareRequest.current += 1;
    };
  }, [applySnapshot, refreshPorts, startupAttempt]);

  useEffect(() => {
    if (autoScroll && page === "console" && logs.length) consoleEnd.current?.scrollIntoView({ block: "nearest" });
  }, [logs, autoScroll, page]);

  async function connectionAction(action: "serial" | "demo" | "disconnect" | "back") {
    if (busyRef.current || firmwareBusyRef.current || !startupReady) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const next = action === "serial" ? await gameboxGateway.connect(port)
        : action === "demo" ? await gameboxGateway.connectDemo()
          : await gameboxGateway.disconnect();
      if (!mounted.current) return;
      applySnapshot(next);
      if (action === "back") onBack();
    } catch (cause) {
      if (mounted.current) setError(errorText(cause));
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  async function selectFirmware(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const request = ++firmwareRequest.current;
    setFileBusy(true);
    setFileError(null);
    setReport(null);
    try {
      const next = await inspectGameBoxFirmware(file);
      if (mounted.current && request === firmwareRequest.current) setReport(next);
    } catch (cause) {
      if (mounted.current && request === firmwareRequest.current) setFileError(errorText(cause));
    } finally {
      if (mounted.current && request === firmwareRequest.current) setFileBusy(false);
    }
  }

  function exportLogs() {
    const body = ["STM GameBox · 接收日志", `来源：${logSource.current}`, "", ...logs.map((line) => `${new Date(line.timestamp).toISOString()} [${line.kind.toUpperCase()}] ${line.text}`)].join("\r\n");
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `gamebox-${new Date().toISOString().replace(/[:.]/g, "-")}.txt`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const meta = pages.find((item) => item.id === page) ?? pages[0];
  const connected = snapshot.mode !== "disconnected";
  const totalEvents = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const statusLabel = snapshot.mode === "demo" ? "演示数据" : snapshot.identified ? "GameBox 已识别" : connected ? "串口已打开 · 等待识别" : "尚未连接";
  const filteredGames = GAMEBOX_GAMES.filter((game) => gameFilter === "全部" || game.category === gameFilter);

  return (
    <div className="gb-studio">
      <aside className="gb-sidebar">
        <button className="gb-back" type="button" disabled={busy || firmwareBusy || !startupReady} onClick={() => void connectionAction("back")}><ArrowLeft size={16} />返回产品库</button>
        <div className="gb-brand"><span className="gb-brand__icon"><Gamepad2 size={27} /></span><div><strong>GameBox</strong><span>掌上游戏机工作台</span></div></div>
        <span className="gb-nav-label">工作空间</span>
        <nav className="gb-nav" aria-label="游戏机工作空间">
          {pages.map(({ id, label, icon: Icon }) => <button key={id} type="button" disabled={firmwareBusy} className={page === id ? "is-active" : ""} aria-current={page === id ? "page" : undefined} onClick={() => changePage(id)}><Icon size={19} /><span>{label}</span>{page === id && <ChevronRight size={14} />}</button>)}
        </nav>
        <div className="gb-sidebar__hardware"><CircuitBoard size={28} /><strong>一块芯片，无限乐趣</strong><p>STM32F103C8T6<br />128 × 64 OLED · 8 枚按键</p><span>GAMEBOX / 01</span></div>
        <div className={`gb-sidebar__status${connected ? " is-connected" : ""}`}><i /><div><strong>{statusLabel}</strong><span>{connected ? snapshot.label : "连接设备，或先体验演示"}</span></div></div>
      </aside>

      <main className="gb-workspace">
        <header className="gb-topbar"><div className="gb-breadcrumb">设备控制中心<ChevronRight size={14} /><strong>GameBox</strong></div><span className="gb-topbar__tag"><Radio size={13} />串口与固件工作台</span></header>
        <div className="gb-content">
          {page !== "firmware" && <div className="gb-page-heading"><div><span className="gb-eyebrow">STM GAMEBOX / {String(pages.findIndex((item) => item.id === page) + 1).padStart(2, "0")}</span><h1>{meta.label}</h1><p>{meta.caption}</p></div><span className={`gb-status-pill${snapshot.identified ? " is-ready" : ""}${snapshot.mode === "demo" ? " is-demo" : ""}`}><i />{statusLabel}</span></div>}
          <section className="gb-connection" aria-label="串口连接设置">
            <span className="gb-connection__icon"><Cable size={21} /></span>
            <div className="gb-port-field"><label htmlFor="gb-port">设备串口</label><select id="gb-port" value={port} disabled={busy || firmwareBusy || connected || refreshing} onChange={(event) => setPort(event.target.value)}>{ports.length === 0 && <option value="">{refreshing ? "正在查找串口…" : "暂无串口"}</option>}{ports.map((item) => <option key={item.name} value={item.name}>{item.name}{item.product ? ` · ${item.product}` : ""}</option>)}</select></div>
            <button type="button" className="gb-icon-button" aria-label="刷新串口列表" title="刷新串口列表" disabled={busy || firmwareBusy || connected || refreshing} onClick={() => void refreshPorts()}><RefreshCw size={17} className={refreshing ? "gb-spin" : ""} /></button>
            <span className="gb-serial-spec">115200 <i />8N1</span>
            {connected ? <button type="button" className="gb-button gb-button--neutral" disabled={busy || firmwareBusy} onClick={() => void connectionAction("disconnect")}>{busy ? <LoaderCircle size={16} className="gb-spin" /> : <Unplug size={16} />}断开连接</button> : <button type="button" className="gb-button" disabled={busy || firmwareBusy || !startupReady || !port || refreshing} onClick={() => void connectionAction("serial")}>{busy ? <LoaderCircle size={16} className="gb-spin" /> : <Cable size={16} />}连接设备</button>}
            <div className="gb-connection__divider" />
            <button type="button" className="gb-button gb-button--ghost" disabled={busy || firmwareBusy || !startupReady || connected} onClick={() => void connectionAction("demo")}><Gamepad2 size={17} />体验演示</button>
          </section>

          {!isTauriRuntime() && snapshot.mode !== "demo" && <p className="gb-fineprint">浏览器预览可体验演示和本地检查；真实串口与 ST-Link 烧录、读取请使用桌面应用。</p>}
          {error && <div className="gb-alert gb-alert--error" role="alert"><CircleHelp size={18} /><span>{error}</span><button type="button" className="gb-icon-button" aria-label="关闭错误提示" onClick={() => setError(null)}><X size={15} /></button></div>}
          {!startupReady && !busy && <div className="gb-note"><CircleHelp size={17} /><p>接收服务初始化未完成，请重试后连接设备或返回产品库。</p><button type="button" className="gb-button" onClick={() => { setError(null); setStartupAttempt((value) => value + 1); }}>重新初始化</button></div>}
          {(snapshot.droppedLines ?? 0) > 0 && <div className="gb-note" role="status"><CircleHelp size={17} /><p>串口流量超过显示速率，后端已丢弃 {snapshot.droppedLines?.toLocaleString()} 行排队日志；当前按键统计只覆盖已显示事件。</p></div>}
          {snapshot.mode === "demo" && <div className="gb-demo-notice"><span>DEMO</span>当前使用本地模拟事件，未连接真实设备。<button type="button" disabled={busy} onClick={() => void connectionAction("disconnect")}>退出演示<ArrowRight size={13} /></button></div>}

          {page === "overview" && <div className="gb-page">
            <div className="gb-overview-grid">
              <section className="gb-panel gb-preview-panel"><div className="gb-panel-heading"><div><span className="gb-eyebrow">MEET YOUR GAMEBOX</span><h2>把快乐，握在手里。</h2></div><span className="gb-small-tag">硬件示意</span></div><Handheld snapshot={snapshot} activeKeys={activeKeys} lastButton={lastButton} /><div className="gb-preview-footer"><span><Cpu size={15} />Cortex-M3</span><span><Layers3 size={15} />64 KiB Flash</span><span><Zap size={15} />8 键输入</span></div></section>
              <div className="gb-overview-right">
                <section className="gb-panel gb-device-status"><div className="gb-panel-heading"><h2>设备状态</h2><Activity size={17} /></div><div className={`gb-recognition${snapshot.identified ? " is-ready" : ""}`}><span>{snapshot.identified ? <CheckCircle2 size={25} /> : <Radio size={25} />}</span><div><strong>{statusLabel}</strong><p>{snapshot.mode === "demo" ? "正在模拟启动与八键事件" : snapshot.identified ? "已收到 GameBox 协议标识" : connected ? "识别需收到开机标识；连接后可复位设备" : "串口就绪后，在这里查看设备状态"}</p></div></div><dl className="gb-spec-list"><div><dt>通讯方式</dt><dd>USART1 · 115200 8N1</dd></div><div><dt>设备识别</dt><dd>{snapshot.mode === "demo" ? "模拟识别" : snapshot.identified ? "协议已确认" : "尚未确认"}</dd></div><div><dt>最后接收</dt><dd>{snapshot.lastActivity ? timeLabel(snapshot.lastActivity) : "等待数据"}</dd></div></dl></section>
                <section className="gb-panel gb-key-panel"><div className="gb-panel-heading"><h2>按键观测</h2><span className="gb-small-tag">只接收</span></div><div className="gb-last-key"><span className={lastButton ? "is-lit" : ""}>{lastButton?.frame.key ?? "—"}</span><div><strong>{lastButton ? actionLabels[lastButton.frame.action] : "等待第一个按键"}</strong><p>{lastButton ? `持续 ${lastButton.frame.heldMs} ms · ${timeLabel(lastButton.timestamp)}` : "在游戏机上按下任意按键"}</p></div></div><div className="gb-key-meter">{keys.map((key) => <div key={key} className={activeKeys.has(key) ? "is-active" : ""}><span>{key}</span><strong>{counts[key]}</strong></div>)}</div><p className="gb-fineprint">显示各按键事件数，包含按下、松开、单击等事件；面板不发送遥控指令。</p></section>
              </div>
            </div>
            <div className="gb-stat-grid"><div className="gb-stat"><span className="gb-stat__icon"><Terminal size={19} /></span><div><span>本次接收行数</span><strong>{snapshot.receivedLines.toLocaleString()}<small>行</small></strong></div></div><div className="gb-stat"><span className="gb-stat__icon"><Gamepad2 size={20} /></span><div><span>本次按键事件</span><strong>{totalEvents.toLocaleString()}<small>次</small></strong></div></div><div className="gb-stat"><span className="gb-stat__icon"><Clock3 size={19} /></span><div><span>设备事件运行时间</span><strong>{lastButton ? (lastButton.frame.uptimeMs / 1000).toFixed(1) : "—"}<small>{lastButton ? "秒" : "等待事件"}</small></strong></div></div></div>
            <section className="gb-quickstart"><span className="gb-quickstart__icon"><Cable size={22} /></span><div><h3>第一次连接？从这里开始。</h3><p>设备 PA9（TX）接 USB-TTL 的 RX，两端 GND 共地，使用 3.3 V 电平。选择串口后连接，按下设备按键查看事件。</p></div><button className="gb-text-button" type="button" onClick={() => setPage("console")}>查看串口监视<ArrowRight size={15} /></button></section>
          </div>}

          {page === "games" && <div className="gb-page">
            <section className="gb-library-hero"><div><span className="gb-eyebrow">SMALL SCREEN. BIG ADVENTURES.</span><h2>像素里的游乐场</h2><p>从经典小游戏到随身小工具，探索 STM-GameBox 源码中的内置内容。</p><span className="gb-library-count">{GAMEBOX_GAMES.filter((game) => game.category === "游戏").length} 款游戏 <i /> {GAMEBOX_GAMES.filter((game) => game.category === "工具").length} 个工具</span></div><div className="gb-library-art"><PixelArtwork variant={2} /></div></section>
            <div className="gb-section-toolbar"><fieldset className="gb-segmented" aria-label="图鉴分类">{(["全部", "游戏", "工具"] as const).map((filter) => <button key={filter} type="button" className={gameFilter === filter ? "is-active" : ""} aria-pressed={gameFilter === filter} onClick={() => setGameFilter(filter)}>{filter}</button>)}</fieldset><span>源码内置清单 · {filteredGames.length} 项</span></div>
            <div className="gb-game-grid">{filteredGames.map((game, index) => <article key={game.id} className={`gb-game-card gb-game-card--${index % 4}`}><div className="gb-game-card__art"><span>{String(GAMEBOX_GAMES.findIndex((item) => item.id === game.id) + 1).padStart(2, "0")}</span><PixelArtwork variant={index} /><span className="gb-small-tag">{game.category}</span></div><div className="gb-game-card__body"><h3>{game.name}</h3><p>{game.description}</p><span><Gamepad2 size={14} />在游戏机上选择体验</span></div></article>)}</div>
            <div className="gb-note"><CircleHelp size={17} /><p>图鉴根据本地固件源码整理，不是从设备读取的游戏列表。当前串口协议不支持读取游戏状态或从上位机启动游戏。</p></div>
          </div>}

          {page === "console" && <div className="gb-page">
            <section className="gb-panel gb-console-panel"><div className="gb-console-toolbar"><div><span className="gb-terminal-dot" /><h2>接收终端</h2><span>{logs.length} / 300 行</span></div><div><label className="gb-checkbox"><input type="checkbox" checked={autoScroll} onChange={(event) => setAutoScroll(event.target.checked)} />自动滚动</label><button type="button" className="gb-icon-button" title="导出接收日志" aria-label="导出接收日志" disabled={!logs.length} onClick={exportLogs}><Download size={17} /></button><button type="button" className="gb-icon-button" title="清空日志" aria-label="清空日志" disabled={!logs.length} onClick={() => setLogs([])}><Trash2 size={17} /></button></div></div><div className="gb-terminal" role="log" aria-label="GameBox 串口接收日志" aria-live="off">{logs.length ? logs.map((line) => <div key={line.id} className={`gb-log-line is-${line.kind}`}><time>{timeLabel(line.timestamp)}</time><span className="gb-log-kind">{line.kind === "system" ? "SYS" : "RX"}</span><code>{line.text}</code></div>) : <div className="gb-terminal-empty"><Terminal size={31} /><strong>等待第一行数据</strong><span>{connected ? "按下设备按键，或复位设备以接收开机标识。" : "连接串口，或点击「体验演示」查看事件流。"}</span></div>}<div ref={consoleEnd} /></div><div className="gb-console-footer"><span><i />{connected ? snapshot.label : "接收通道未连接"}</span><span>UTF-8 / 按行解析 / 仅保留最近 300 行</span></div></section>
            <section className="gb-panel gb-protocol"><div><span className="gb-eyebrow">SERIAL PROTOCOL</span><h2>读懂一条按键事件</h2><p>当前固件主动上报启动标识与按键状态，上位机被动接收。</p></div><div className="gb-protocol-example"><code>BTN 1234 UP CLICK 80</code><div><span><b>1234</b>设备运行时间 ms</span><span><b>UP</b>按键名称</span><span><b>CLICK</b>事件类型</span><span><b>80</b>持续时间 ms</span></div></div></section>
          </div>}

          {firmwareVisited && <div hidden={page !== "firmware"}><FirmwarePage product="gamebox" connected={connected} connectionBusy={busy || !startupReady} onBusyChange={handleFirmwareBusy} /></div>}

          {page === "storage" && <div className="gb-page">
            <div className="gb-firmware-grid"><section className="gb-panel gb-firmware-file"><div className="gb-panel-heading"><div><span className="gb-eyebrow">LOCAL FIRMWARE</span><h2>先了解你的固件</h2></div><FileCode2 size={21} /></div><p className="gb-panel-description">选择本地 .bin 文件，检查大小、向量表与 CRC32。文件只在本机分析。</p><input ref={fileInput} className="gb-file-input" type="file" accept=".bin,application/octet-stream" aria-label="选择 GameBox 固件文件" onChange={(event) => void selectFirmware(event)} /><button className="gb-file-picker" type="button" onClick={() => fileInput.current?.click()}>{fileBusy ? <LoaderCircle size={27} className="gb-spin" /> : <FileUp size={29} />}<strong>{fileBusy ? "正在分析固件…" : report ? "重新选择固件文件" : "选择 .bin 固件"}</strong><span>{report ? report.name : "原始二进制 · 本地校验 · 不写入设备"}</span></button>{fileError && <div className="gb-alert gb-alert--error" role="alert"><CircleHelp size={17} /><span>{fileError}</span></div>}{report && <div className="gb-firmware-report"><dl className="gb-spec-list"><div><dt>固件大小</dt><dd>{report.size.toLocaleString()} B · {(report.size / 1024).toFixed(2)} KiB</dd></div><div><dt>CRC32</dt><dd><code>{report.crc32}</code></dd></div><div><dt>初始栈指针</dt><dd><code>{hex(report.initialStackPointer)}</code></dd></div><div><dt>复位向量</dt><dd><code>{hex(report.resetVector)}</code></dd></div></dl><div className="gb-report-checks"><span className={report.vectorValid ? "is-good" : "is-warning"}>{report.vectorValid ? <Check size={14} /> : <CircleHelp size={14} />}{report.vectorValid ? "向量表基础检查通过" : "向量表需要检查"}</span><span className={report.fitsInternalFlash ? "is-good" : "is-warning"}>{report.fitsInternalFlash ? <Check size={14} /> : <CircleHelp size={14} />}{report.fitsInternalFlash ? "适配当前 62 KiB 应用区" : "不适配当前 62 KiB 应用区"}</span></div>{report.issues.length > 0 && <ul className="gb-firmware-issues">{report.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}<p className="gb-fineprint">基础检查不验证板型、功能兼容性或固件签名，不能替代设备验证。</p></div>}</section>
              <section className="gb-panel gb-flash-panel"><div className="gb-panel-heading"><div><span className="gb-eyebrow">ON-CHIP FLASH</span><h2>64 KiB，精打细算。</h2></div><Cpu size={21} /></div><div className="gb-memory-headline"><strong>62<small>KiB</small></strong><span>当前应用程序区<br /><b>另有 2 KiB 保存设置</b></span></div><div className="gb-flash-bar" role="img" aria-label="内置 Flash 分区：62 KiB 应用，2 KiB 设置"><span className="gb-flash-bar__app">应用程序 · 62 KiB</span><span className="gb-flash-bar__settings" /></div><div className="gb-memory-legend"><span><i />应用区</span><span><i />设置页 · 2 KiB</span></div><dl className="gb-address-list"><div><dt>应用程序</dt><dd>0x08000000 – 0x0800F7FF</dd></div><div><dt>设置页 A / B</dt><dd>0x0800F800 / 0x0800FC00</dd></div></dl><div className="gb-baseline"><span>源码构建产物参考</span><div><strong>59.19 KiB<small>SPI OLED 版本</small></strong><strong>60.34 KiB<small>I²C OLED 版本</small></strong></div><p>本地固件基线，并非从当前设备读取；以重新构建后的文件为准。</p></div></section></div>
            <section className="gb-storage-roadmap"><div className="gb-storage-roadmap__intro"><span className="gb-eyebrow">NEXT CHAPTER</span><h2>把空间，留给更多可能。</h2><p>为外置 SPI Flash 预留工作流；容量与引脚待硬件方案确定。</p><span><HardDrive size={16} />外置存储规划中</span></div><div className="gb-roadmap-steps"><div><span className="is-current">01</span><div><h3>现在 · 串口观测</h3><p>接收事件、本地固件检查。当前通过 SWD / probe-rs 更新。</p></div></div><div><span>02</span><div><h3>下一步 · 外置存储</h3><p>规划镜像暂存、元数据和校验区；选型、分区与引脚尚未确定。</p></div></div><div><span>03</span><div><h3>后续 · 可靠升级</h3><p>增加 Bootloader 与双端升级协议，完成分包传输、校验与异常恢复。</p></div></div></div></section>
            <div className="gb-note"><CircleHelp size={17} /><p>当前没有串口刷写接口，选择文件不会更新设备。外置 SPI Flash 仅保存镜像，不会直接扩大 F103 的可执行程序空间；升级仍需 Bootloader 将镜像写入内部应用区。</p></div>
          </div>}
          <footer className="gb-page-footer"><span>STM GAMEBOX</span><span>从一枚按键开始。</span></footer>
        </div>
      </main>
    </div>
  );
}
