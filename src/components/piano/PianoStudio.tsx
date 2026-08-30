import type { CSSProperties, ChangeEvent, DragEvent, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Cable,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  CircuitBoard,
  Clock3,
  Cpu,
  FileCode2,
  FileMusic,
  FileUp,
  Gauge,
  HardDrive,
  Keyboard,
  Library,
  LoaderCircle,
  Music2,
  Pause,
  Play,
  Plus,
  RotateCcw,
  Save,
  Settings2,
  ShieldCheck,
  SlidersHorizontal,
  Square,
  Trash2,
  Upload,
  Usb,
  Volume2,
  X,
  Zap,
} from "lucide-react";

type PianoPage = "overview" | "composer" | "keymap" | "library" | "firmware";

interface PianoStudioProps {
  onBack: () => void;
}

interface PianoNote {
  id: string;
  lane: number;
  beat: number;
  duration: number;
}

interface KeyBinding {
  index: number;
  shortcut: string;
  midi: number;
}

interface DeviceSong {
  slot: number;
  title: string | null;
  notes: number;
  bytes: number;
  updatedAt?: string;
}

interface FirmwareFileMeta {
  name: string;
  size: number;
}

interface StoredPianoState {
  title?: string;
  bpm?: number;
  tonic?: number;
  octave?: number;
  notes?: PianoNote[];
  bindings?: KeyBinding[];
  slots?: DeviceSong[];
}

const TOTAL_BEATS = 32;
const MAJOR_INTERVALS = [0, 2, 4, 5, 7, 9, 11, 12];
const KEY_SHORTCUTS = ["A", "S", "D", "F", "J", "K", "L", ";"];
const STORAGE_KEY = "cf-gui.pocket-piano.studio.v1";
const DEVICE_LIBRARY_BUDGET = 2048;

const tonicOptions = [
  { value: 0, label: "C 大调" },
  { value: 1, label: "D♭ 大调" },
  { value: 2, label: "D 大调" },
  { value: 3, label: "E♭ 大调" },
  { value: 4, label: "E 大调" },
  { value: 5, label: "F 大调" },
  { value: 6, label: "G♭ 大调" },
  { value: 7, label: "G 大调" },
  { value: 8, label: "A♭ 大调" },
  { value: 9, label: "A 大调" },
  { value: 10, label: "B♭ 大调" },
  { value: 11, label: "B 大调" },
];

const defaultNotes: PianoNote[] = [
  { id: "demo-0", lane: 0, beat: 0, duration: 1 },
  { id: "demo-1", lane: 0, beat: 2, duration: 1 },
  { id: "demo-2", lane: 4, beat: 4, duration: 1 },
  { id: "demo-3", lane: 4, beat: 6, duration: 1 },
  { id: "demo-4", lane: 5, beat: 8, duration: 1 },
  { id: "demo-5", lane: 5, beat: 10, duration: 1 },
  { id: "demo-6", lane: 4, beat: 12, duration: 2 },
  { id: "demo-7", lane: 3, beat: 16, duration: 1 },
  { id: "demo-8", lane: 3, beat: 18, duration: 1 },
  { id: "demo-9", lane: 2, beat: 20, duration: 1 },
  { id: "demo-10", lane: 2, beat: 22, duration: 1 },
  { id: "demo-11", lane: 1, beat: 24, duration: 1 },
  { id: "demo-12", lane: 1, beat: 26, duration: 1 },
  { id: "demo-13", lane: 0, beat: 28, duration: 2 },
];

const defaultSlots: DeviceSong[] = [
  { slot: 1, title: "开机提示音", notes: 8, bytes: 42, updatedAt: "内置" },
  { slot: 2, title: "生日快乐", notes: 25, bytes: 91, updatedAt: "演示曲" },
  { slot: 3, title: null, notes: 0, bytes: 0 },
  { slot: 4, title: null, notes: 0, bytes: 0 },
  { slot: 5, title: null, notes: 0, bytes: 0 },
  { slot: 6, title: null, notes: 0, bytes: 0 },
  { slot: 7, title: null, notes: 0, bytes: 0 },
  { slot: 8, title: null, notes: 0, bytes: 0 },
];

const pageMeta: Record<PianoPage, { label: string; icon: LucideIcon }> = {
  overview: { label: "总览", icon: Activity },
  composer: { label: "曲谱编辑", icon: Music2 },
  keymap: { label: "琴键与调式", icon: Keyboard },
  library: { label: "设备曲库", icon: Library },
  firmware: { label: "固件烧录", icon: Cpu },
};

function midiName(midi: number): string {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

function midiFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

function makeBindings(tonic: number, octave: number): KeyBinding[] {
  const root = (octave + 1) * 12 + tonic;
  return MAJOR_INTERVALS.map((interval, index) => ({
    index,
    shortcut: KEY_SHORTCUTS[index] ?? String(index + 1),
    midi: root + interval,
  }));
}

function readStoredState(): StoredPianoState | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) as StoredPianoState : null;
  } catch {
    return null;
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function MiniPianoIllustration({ activeLane }: { activeLane?: number | null }) {
  return (
    <div className="mini-piano" aria-hidden="true">
      <div className="mini-piano__topline">
        <span className="mini-piano__badge">51</span>
        <span className="mini-piano__power" />
      </div>
      <div className="mini-piano__speaker">
        {Array.from({ length: 18 }, (_, index) => <i key={index} />)}
      </div>
      <div className="mini-piano__display">{activeLane === null || activeLane === undefined ? "PLAY" : `K${activeLane + 1}`}</div>
      <div className="mini-piano__keys">
        {Array.from({ length: 8 }, (_, index) => (
          <span className={activeLane === index ? "is-active" : ""} key={index}><i /></span>
        ))}
      </div>
      <div className="mini-piano__shadow" />
    </div>
  );
}

export function PianoStudio({ onBack }: PianoStudioProps) {
  const restored = useMemo(readStoredState, []);
  const [page, setPage] = useState<PianoPage>("overview");
  const [title, setTitle] = useState(restored?.title ?? "我的第一首曲子");
  const [bpm, setBpm] = useState(restored?.bpm ?? 108);
  const [tonic, setTonic] = useState(restored?.tonic ?? 0);
  const [octave, setOctave] = useState(restored?.octave ?? 4);
  const [notes, setNotes] = useState<PianoNote[]>(restored?.notes ?? defaultNotes);
  const [bindings, setBindings] = useState<KeyBinding[]>(restored?.bindings ?? makeBindings(restored?.tonic ?? 0, restored?.octave ?? 4));
  const [slots, setSlots] = useState<DeviceSong[]>(restored?.slots ?? defaultSlots);
  const [selectedDuration, setSelectedDuration] = useState(1);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [playhead, setPlayhead] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [activeLane, setActiveLane] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const [port, setPort] = useState("COM3");
  const [baudRate, setBaudRate] = useState(115200);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const audioContext = useRef<AudioContext | null>(null);
  const connectionTimer = useRef<number | null>(null);
  const toastTimer = useRef<number | null>(null);

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 3200);
  }, []);

  const audition = useCallback((lane: number, duration = 260) => {
    const binding = bindings[lane];
    if (!binding) return;
    try {
      const context = audioContext.current ?? new AudioContext();
      audioContext.current = context;
      if (context.state === "suspended") void context.resume();
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const start = context.currentTime;
      const seconds = Math.max(0.08, duration / 1000);
      oscillator.type = "square";
      oscillator.frequency.setValueAtTime(midiFrequency(binding.midi), start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.075, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + seconds);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + seconds + 0.02);
      setActiveLane(lane);
      window.setTimeout(() => setActiveLane((current) => current === lane ? null : current), Math.min(duration, 420));
    } catch {
      showToast("当前环境无法启动声音预览，但曲谱编辑不受影响。");
    }
  }, [bindings, showToast]);

  useEffect(() => {
    if (!playing) return;
    const note = notes.find((item) => item.beat === playhead);
    if (note) audition(note.lane, Math.max(100, (60_000 / bpm) * note.duration * 0.82));
    const timer = window.setTimeout(() => {
      if (playhead >= TOTAL_BEATS - 1) {
        setPlaying(false);
        setPlayhead(0);
      } else {
        setPlayhead((value) => value + 1);
      }
    }, 60_000 / bpm / 2);
    return () => window.clearTimeout(timer);
  }, [audition, bpm, notes, playhead, playing]);

  useEffect(() => () => {
    if (connectionTimer.current !== null) window.clearTimeout(connectionTimer.current);
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current);
    if (audioContext.current) void audioContext.current.close();
  }, []);

  const persistStudio = useCallback((announce = true) => {
    try {
      const snapshot: StoredPianoState = { title, bpm, tonic, octave, notes, bindings, slots };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
      setDirty(false);
      if (announce) showToast("项目已保存到本机。");
    } catch {
      showToast("本机存储不可用，当前修改仅保留在本次会话中。");
    }
  }, [bindings, bpm, notes, octave, showToast, slots, title, tonic]);

  const markChanged = useCallback(() => setDirty(true), []);

  const setScale = useCallback((nextTonic: number, nextOctave = octave) => {
    setTonic(nextTonic);
    setOctave(nextOctave);
    setBindings(makeBindings(nextTonic, nextOctave));
    setDirty(true);
  }, [octave]);

  const connect = useCallback((nextPort: string, nextBaud: number) => {
    setConnectionBusy(true);
    connectionTimer.current = window.setTimeout(() => {
      setPort(nextPort);
      setBaudRate(nextBaud);
      setConnected(true);
      setConnectionBusy(false);
      setConnectionOpen(false);
      showToast(`已在前端演示模式连接 ${nextPort}。`);
    }, 780);
  }, [showToast]);

  const disconnect = useCallback(() => {
    setConnected(false);
    setConnectionOpen(false);
    showToast("演示设备已断开。");
  }, [showToast]);

  const addNote = useCallback((lane: number, beat: number) => {
    setNotes((current) => {
      const existing = current.find((item) => item.lane === lane && item.beat === beat);
      if (existing) {
        setSelectedNoteId(null);
        return current.filter((item) => item.id !== existing.id);
      }
      const id = `note-${Date.now()}-${lane}-${beat}`;
      setSelectedNoteId(id);
      return [
        ...current.filter((item) => item.beat !== beat),
        { id, lane, beat, duration: selectedDuration },
      ].sort((left, right) => left.beat - right.beat);
    });
    setPlayhead(beat);
    audition(lane);
    setDirty(true);
  }, [audition, selectedDuration]);

  const addFromKeyboard = useCallback((lane: number) => {
    addNote(lane, playhead);
    setPlayhead((current) => Math.min(TOTAL_BEATS - 1, current + Math.max(1, Math.round(selectedDuration * 2))));
  }, [addNote, playhead, selectedDuration]);

  const updateBinding = useCallback((index: number, midi: number) => {
    setBindings((current) => current.map((binding) => binding.index === index ? { ...binding, midi } : binding));
    setDirty(true);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || target?.tagName === "INPUT" || target?.tagName === "SELECT" || target?.tagName === "TEXTAREA") return;
      const pressed = event.key.length === 1 ? event.key.toUpperCase() : event.key;
      const lane = KEY_SHORTCUTS.findIndex((shortcut) => shortcut === pressed);
      if (lane < 0) return;
      event.preventDefault();
      if (page === "composer") addFromKeyboard(lane);
      else audition(lane);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [addFromKeyboard, audition, page]);

  const currentMeta = pageMeta[page];
  const currentTonicLabel = tonicOptions.find((item) => item.value === tonic)?.label ?? "C 大调";

  return (
    <div className="app-shell piano-shell">
      <div className="ambient ambient--one" /><div className="ambient ambient--two" /><div className="ambient ambient--three" />

      <aside className="sidebar glass-panel piano-sidebar" aria-label="电子琴主导航">
        <div className="brand-lockup">
          <div className="brand-mark" aria-hidden="true"><Music2 size={24} strokeWidth={2.2} /></div>
          <div><strong>KeyNest Studio</strong><span>口袋电子琴工作台</span></div>
        </div>

        <nav className="primary-nav">
          {(Object.entries(pageMeta) as Array<[PianoPage, { label: string; icon: LucideIcon }]>).map(([id, item]) => {
            const Icon = item.icon;
            return (
              <button className={`nav-item${page === id ? " is-active" : ""}`} key={id} type="button" aria-current={page === id ? "page" : undefined} onClick={() => setPage(id)}>
                <span className="nav-icon"><Icon size={19} /></span>
                <span className="nav-copy"><strong>{item.label}</strong></span>
              </button>
            );
          })}
        </nav>

        <button className={`sidebar-device${connected ? " is-online" : ""}`} type="button" onClick={() => setConnectionOpen(true)}>
          <span className="status-orb" />
          <span className="sidebar-device__copy">
            <small>{connected ? "电子琴已连接" : "串口连接"}</small>
            <strong>{connected ? "Pocket Keys · 51" : "点击选择串口"}</strong>
            <span>{connected ? `${port} · ${baudRate.toLocaleString()} baud` : "协议前端演示"}</span>
          </span>
          <Usb size={17} />
        </button>
      </aside>

      <div className="workspace">
        <header className="topbar glass-panel">
          <div className="topbar-context">
            <button className="icon-button topbar-home-button" type="button" aria-label="返回产品首页" title="返回产品首页" onClick={onBack}><ArrowLeft size={18} /></button>
            <div className="breadcrumbs"><span>口袋电子琴</span><ChevronRight size={14} /><strong>{currentMeta.label}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className="piano-prototype-pill"><CircuitBoard size={14} />51 原型</span>
            <span className="topbar-clock"><Clock3 size={15} />{new Date().toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span>
            <button className="icon-button" type="button" aria-label="帮助" onClick={() => showToast("推荐流程：编辑曲谱 → 配置琴键 → 写入设备曲库。")}><CircleHelp size={18} /></button>
            <button className={connected ? "connection-button is-online" : "connection-button"} type="button" onClick={() => setConnectionOpen(true)}>
              <span className="status-orb" /><div><small>{connected ? "DEMO CONNECTED" : "OFFLINE"}</small><strong>{connected ? port : "连接电子琴"}</strong></div><Cable size={17} />
            </button>
          </div>
        </header>

        <main className="page-content">
          {page === "overview" && (
            <PianoOverview
              connected={connected}
              title={title}
              noteCount={notes.length}
              slots={slots}
              activeLane={activeLane}
              onNavigate={setPage}
              onConnect={() => setConnectionOpen(true)}
            />
          )}
          {page === "composer" && (
            <ComposerPage
              title={title}
              bpm={bpm}
              tonicLabel={currentTonicLabel}
              notes={notes}
              bindings={bindings}
              duration={selectedDuration}
              selectedNoteId={selectedNoteId}
              playhead={playhead}
              playing={playing}
              activeLane={activeLane}
              dirty={dirty}
              onTitleChange={(value) => { setTitle(value); markChanged(); }}
              onBpmChange={(value) => { setBpm(value); markChanged(); }}
              onDurationChange={setSelectedDuration}
              onPlayheadChange={setPlayhead}
              onTogglePlay={() => setPlaying((value) => !value)}
              onStop={() => { setPlaying(false); setPlayhead(0); }}
              onAddNote={addNote}
              onKeyboardNote={addFromKeyboard}
              onClear={() => { setNotes([]); setSelectedNoteId(null); setPlaying(false); setPlayhead(0); markChanged(); }}
              onSave={() => persistStudio(true)}
              onOpenLibrary={() => setPage("library")}
            />
          )}
          {page === "keymap" && (
            <KeymapPage
              tonic={tonic}
              octave={octave}
              bindings={bindings}
              connected={connected}
              activeLane={activeLane}
              onScaleChange={setScale}
              onBindingChange={updateBinding}
              onAudition={audition}
              onSave={() => persistStudio(true)}
              onWrite={() => connected ? showToast("键位配置写入流程已准备；等待后端协议接入。") : setConnectionOpen(true)}
            />
          )}
          {page === "library" && (
            <DeviceLibraryPage
              title={title}
              noteCount={notes.length}
              slots={slots}
              connected={connected}
              onSlotsChange={(next) => { setSlots(next); setDirty(true); }}
              onConnect={() => setConnectionOpen(true)}
              onEdit={() => setPage("composer")}
              onNotice={showToast}
            />
          )}
          {page === "firmware" && <FirmwarePage connected={connected} port={port} onNotice={showToast} />}
        </main>
      </div>

      {toast && <div className="toast-notice piano-toast" role="status"><CheckCircle2 size={17} />{toast}</div>}
      <PianoConnectionModal
        open={connectionOpen}
        connected={connected}
        port={port}
        baudRate={baudRate}
        busy={connectionBusy}
        onClose={() => !connectionBusy && setConnectionOpen(false)}
        onConnect={connect}
        onDisconnect={disconnect}
      />
    </div>
  );
}

interface PianoOverviewProps {
  connected: boolean;
  title: string;
  noteCount: number;
  slots: DeviceSong[];
  activeLane: number | null;
  onNavigate: (page: PianoPage) => void;
  onConnect: () => void;
}

function PianoOverview({ connected, title, noteCount, slots, activeLane, onNavigate, onConnect }: PianoOverviewProps) {
  const occupied = slots.filter((slot) => slot.title).length;
  return (
    <div className="page-stack piano-page">
      <section className="piano-hero glass-card liquid-card">
        <div className="piano-hero__copy">
          <span className="section-kicker">POCKET KEYS · 51 MCU</span>
          <h1>把一段旋律，<em>装进掌心。</em></h1>
          <p>为低成本无源蜂鸣器电子琴设计的创作工作台：编曲、配键、管理片上曲库，并预留串口烧录入口。</p>
          <div className="hero-actions">
            <button className="primary-button" type="button" onClick={() => onNavigate("composer")}><Music2 size={17} />继续编辑</button>
            <button className="secondary-button" type="button" onClick={connected ? () => onNavigate("library") : onConnect}><Usb size={17} />{connected ? "打开设备曲库" : "连接电子琴"}</button>
          </div>
        </div>
        <div className="piano-hero__device">
          <MiniPianoIllustration activeLane={activeLane} />
          <span className={`piano-device-status${connected ? " is-online" : ""}`}><i />{connected ? "演示设备在线" : "等待串口连接"}</span>
        </div>
      </section>

      <section className="metric-grid piano-metrics" aria-label="电子琴项目概览">
        <article className="metric-card glass-card"><span className="metric-icon is-coral"><Music2 size={20} /></span><div><span>当前曲目</span><strong>{noteCount}<small> 音符</small></strong></div><em>{title}</em></article>
        <article className="metric-card glass-card"><span className="metric-icon is-blue"><Keyboard size={20} /></span><div><span>物理琴键</span><strong>8<small> 键</small></strong></div><em>支持逐键映射</em></article>
        <article className="metric-card glass-card"><span className="metric-icon is-violet"><Volume2 size={20} /></span><div><span>发声通道</span><strong>1<small> 路</small></strong></div><em>无源蜂鸣器 · 单音</em></article>
        <article className="metric-card glass-card"><span className="metric-icon is-mint"><HardDrive size={20} /></span><div><span>曲目槽位</span><strong>{occupied}<small> / 8</small></strong></div><em>容量为前端规划值</em></article>
      </section>

      <section className="piano-workflow">
        {[
          { step: "01", icon: Music2, title: "写旋律", copy: "在 8 音轨步进编辑器中落下音符、设置节拍与速度。", page: "composer" as PianoPage },
          { step: "02", icon: SlidersHorizontal, title: "配琴键", copy: "选择大调，一键生成音阶，也可以逐键覆盖音高。", page: "keymap" as PianoPage },
          { step: "03", icon: Upload, title: "装进芯片", copy: "选择槽位并生成待写入数据，后续接入串口协议。", page: "library" as PianoPage },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button className="piano-flow-card glass-card" key={item.step} type="button" onClick={() => onNavigate(item.page)}>
              <span className="piano-flow-card__step">{item.step}</span><span className="piano-flow-card__icon"><Icon size={21} /></span>
              <span><strong>{item.title}</strong><small>{item.copy}</small></span><ArrowRight size={18} />
            </button>
          );
        })}
      </section>

      <section className="piano-overview-grid">
        <article className="glass-card piano-project-card">
          <div className="section-title-row"><div><span className="section-kicker">CURRENT PROJECT</span><h2>{title}</h2></div><button className="small-action" type="button" onClick={() => onNavigate("composer")}>打开</button></div>
          <div className="piano-project-timeline">
            {Array.from({ length: 16 }, (_, index) => <i className={index < Math.min(16, Math.ceil(noteCount / 2)) ? "is-filled" : ""} key={index} />)}
          </div>
          <div className="piano-project-meta"><span><Music2 size={14} />{noteCount} 个音符</span><span><Gauge size={14} />108 BPM</span><span><Clock3 size={14} />约 18 秒</span></div>
        </article>
        <article className="glass-card piano-boundary-card">
          <span className="piano-boundary-card__icon"><CircuitBoard size={23} /></span>
          <div><span className="section-kicker">硬件边界</span><h2>先围绕低成本做对</h2><p>首版按 51 单片机、8 个按键、单个无源蜂鸣器建模。曲库容量和协议字段标记为“暂定”，待固件确定后再固化。</p></div>
        </article>
      </section>
    </div>
  );
}

interface ComposerPageProps {
  title: string;
  bpm: number;
  tonicLabel: string;
  notes: PianoNote[];
  bindings: KeyBinding[];
  duration: number;
  selectedNoteId: string | null;
  playhead: number;
  playing: boolean;
  activeLane: number | null;
  dirty: boolean;
  onTitleChange: (value: string) => void;
  onBpmChange: (value: number) => void;
  onDurationChange: (value: number) => void;
  onPlayheadChange: (value: number) => void;
  onTogglePlay: () => void;
  onStop: () => void;
  onAddNote: (lane: number, beat: number) => void;
  onKeyboardNote: (lane: number) => void;
  onClear: () => void;
  onSave: () => void;
  onOpenLibrary: () => void;
}

function ComposerPage({ title, bpm, tonicLabel, notes, bindings, duration, selectedNoteId, playhead, playing, activeLane, dirty, onTitleChange, onBpmChange, onDurationChange, onPlayheadChange, onTogglePlay, onStop, onAddNote, onKeyboardNote, onClear, onSave, onOpenLibrary }: ComposerPageProps) {
  const rows = [...bindings].reverse();
  const selectedNote = notes.find((note) => note.id === selectedNoteId) ?? null;
  const selectedBinding = selectedNote ? bindings[selectedNote.lane] : undefined;
  const estimate = 18 + notes.length * 3;
  return (
    <div className="page-stack piano-page composer-page">
      <section className="page-heading">
        <div><span className="section-kicker">MONOPHONIC COMPOSER</span><h1>曲谱编辑器</h1><p>点击格子放置音符；同一时刻仅保留一个音高，符合单路无源蜂鸣器的发声方式。</p></div>
        <div className="heading-actions"><span className={`composer-save-state${dirty ? " is-dirty" : ""}`}><i />{dirty ? "有未保存修改" : "已保存到本机"}</span><button className="secondary-button" type="button" onClick={onSave}><Save size={16} />保存</button><button className="primary-button" type="button" onClick={onOpenLibrary}><Upload size={16} />写入设备</button></div>
      </section>

      <section className="composer-toolbar glass-card">
        <label className="composer-title-input"><span>曲目名称</span><input value={title} maxLength={32} onChange={(event) => onTitleChange(event.target.value)} /></label>
        <label className="compact-field"><span>速度</span><div><input type="number" min={40} max={240} value={bpm} onChange={(event) => onBpmChange(Math.min(240, Math.max(40, Number(event.target.value) || 40)))} /><small>BPM</small></div></label>
        <label className="compact-field"><span>拍号</span><div className="compact-static">4 / 4</div></label>
        <label className="compact-field"><span>调式</span><div className="compact-static">{tonicLabel}</div></label>
        <div className="composer-toolbar__spacer" />
        <button className="icon-button icon-button--danger" type="button" aria-label="清空曲谱" title="清空曲谱" disabled={notes.length === 0} onClick={onClear}><Trash2 size={17} /></button>
      </section>

      <section className="composer-layout">
        <article className="glass-card score-card">
          <header className="score-card__header">
            <div className="transport-controls">
              <button className="transport-play" type="button" aria-label={playing ? "暂停" : "播放"} onClick={onTogglePlay}>{playing ? <Pause size={19} fill="currentColor" /> : <Play size={19} fill="currentColor" />}</button>
              <button className="transport-stop" type="button" aria-label="停止" onClick={onStop}><Square size={15} fill="currentColor" /></button>
              <span className="transport-position"><b>{String(Math.floor(playhead / 8) + 1).padStart(2, "0")}</b><i />{String((playhead % 8) + 1).padStart(2, "0")}</span>
            </div>
            <div className="score-legend"><span><i className="is-note" />音符</span><span><i className="is-playhead" />播放头</span><span>每格 = 1/8 拍</span></div>
          </header>
          <div className="piano-roll-scroll">
            <div className="piano-roll">
              <span className="piano-roll__corner">音高</span>
              {Array.from({ length: TOTAL_BEATS }, (_, beat) => <button className={`piano-roll__beat${beat % 8 === 0 ? " is-measure" : ""}`} type="button" key={`head-${beat}`} onClick={() => onPlayheadChange(beat)}>{beat % 8 === 0 ? `${Math.floor(beat / 8) + 1}` : "·"}</button>)}
              {rows.map((binding) => (
                <div className="piano-roll__row" key={binding.index}>
                  <span className="piano-roll__label"><b>{midiName(binding.midi)}</b><small>K{binding.index + 1}</small></span>
                  {Array.from({ length: TOTAL_BEATS }, (_, beat) => {
                    const note = notes.find((item) => item.lane === binding.index && item.beat === beat);
                    return (
                      <button
                        className={`piano-roll__cell${note ? " is-note" : ""}${note?.id === selectedNoteId ? " is-selected" : ""}${beat % 8 === 0 ? " is-measure" : ""}`}
                        style={note ? { "--note-duration": note.duration, "--lane": binding.index } as CSSProperties : { "--lane": binding.index } as CSSProperties}
                        type="button"
                        key={`${binding.index}-${beat}`}
                        aria-label={`${midiName(binding.midi)}，第 ${beat + 1} 格${note ? "，已有音符" : ""}`}
                        onClick={() => onAddNote(binding.index, beat)}
                      >{note && <span>{note.duration >= 2 ? "—" : "♪"}</span>}</button>
                    );
                  })}
                </div>
              ))}
              <span className="piano-roll__playhead" style={{ "--playhead": playhead } as CSSProperties} />
            </div>
          </div>
        </article>

        <aside className="composer-inspector glass-card">
          <div><span className="section-kicker">NOTE TOOL</span><h3>落笔长度</h3><p>选择后，再点击谱面或下方琴键。</p></div>
          <div className="duration-picker">
            {[{ value: 0.5, symbol: "♪", label: "八分" }, { value: 1, symbol: "♩", label: "四分" }, { value: 2, symbol: "𝅗𝅥", label: "二分" }].map((item) => (
              <button className={duration === item.value ? "is-active" : ""} type="button" key={item.value} onClick={() => onDurationChange(item.value)}><b>{item.symbol}</b><span>{item.label}</span></button>
            ))}
          </div>
          <div className="selected-note-card">
            <span>{selectedNote ? "当前音符" : "尚未选择"}</span>
            {selectedNote && selectedBinding ? <><strong>{midiName(selectedBinding.midi)}</strong><small>第 {selectedNote.beat + 1} 格 · {selectedNote.duration} 拍</small></> : <><strong>—</strong><small>点击已有音符查看信息</small></>}
          </div>
          <div className="score-budget"><span><HardDrive size={15} />编码预估</span><strong>{estimate} B</strong><div><i style={{ width: `${Math.min(100, estimate / 5)}%` }} /></div><small>按“曲目头 + 每音符 3 B”暂估</small></div>
          <button className="secondary-button inspector-reset" type="button" onClick={() => onPlayheadChange(0)}><RotateCcw size={15} />回到开头</button>
        </aside>
      </section>

      <section className="virtual-keyboard-card glass-card">
        <header><div><span className="section-kicker">LIVE INPUT</span><h3>虚拟琴键</h3></div><span><Keyboard size={15} />点击试听并写入播放头位置</span></header>
        <div className="virtual-keyboard">
          {bindings.map((binding) => (
            <button className={`virtual-key${activeLane === binding.index ? " is-active" : ""}`} style={{ "--lane": binding.index } as CSSProperties} type="button" key={binding.index} onClick={() => onKeyboardNote(binding.index)}>
              <kbd>{binding.shortcut}</kbd><span>{binding.index === 7 ? "高音 1" : binding.index + 1}</span><strong>{midiName(binding.midi)}</strong>
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

interface KeymapPageProps {
  tonic: number;
  octave: number;
  bindings: KeyBinding[];
  connected: boolean;
  activeLane: number | null;
  onScaleChange: (tonic: number, octave?: number) => void;
  onBindingChange: (index: number, midi: number) => void;
  onAudition: (lane: number) => void;
  onSave: () => void;
  onWrite: () => void;
}

function KeymapPage({ tonic, octave, bindings, connected, activeLane, onScaleChange, onBindingChange, onAudition, onSave, onWrite }: KeymapPageProps) {
  const noteOptions = Array.from({ length: 37 }, (_, index) => 48 + index);
  return (
    <div className="page-stack piano-page">
      <section className="page-heading">
        <div><span className="section-kicker">KEY & SCALE</span><h1>琴键与调式</h1><p>先用大调快速生成 8 键音阶，再按你的外壳丝印或玩法逐键调整。</p></div>
        <div className="heading-actions"><button className="secondary-button" type="button" onClick={onSave}><Save size={16} />保存配置</button><button className="primary-button" type="button" onClick={onWrite}><Upload size={16} />{connected ? "写入设备" : "连接后写入"}</button></div>
      </section>

      <section className="keymap-layout">
        <div className="keymap-main">
          <article className="glass-card scale-generator">
            <div className="section-title-row"><div><span className="section-kicker">AUTO MAPPING</span><h2>一键生成大调音阶</h2><p>生成后仍可在下方覆盖任意一个按键。</p></div><span className="soft-badge">全音阶</span></div>
            <div className="scale-controls">
              <label><span>主音 / 大调</span><div className="select-shell"><select value={tonic} onChange={(event) => onScaleChange(Number(event.target.value))}>{tonicOptions.map((option) => <option value={option.value} key={option.value}>{option.label}</option>)}</select><ChevronDown size={15} /></div></label>
              <label><span>起始八度</span><div className="octave-stepper"><button type="button" disabled={octave <= 3} onClick={() => onScaleChange(tonic, octave - 1)}>−</button><strong>{octave}</strong><button type="button" disabled={octave >= 5} onClick={() => onScaleChange(tonic, octave + 1)}>＋</button></div></label>
              <div className="scale-result"><span>生成结果</span><strong>{bindings.map((binding) => midiName(binding.midi)).join(" · ")}</strong></div>
            </div>
          </article>

          <article className="glass-card key-binding-card">
            <header><div><span className="section-kicker">PHYSICAL KEYS</span><h2>逐键映射</h2></div><span>8 路 GPIO 按键</span></header>
            <div className="binding-table">
              <div className="binding-table__head"><span>琴键</span><span>电脑键盘</span><span>音高</span><span>频率</span><span>试听</span></div>
              {bindings.map((binding) => (
                <div className={`binding-row${activeLane === binding.index ? " is-active" : ""}`} key={binding.index}>
                  <span className="binding-key-number" style={{ "--lane": binding.index } as CSSProperties}>K{binding.index + 1}</span>
                  <kbd>{binding.shortcut}</kbd>
                  <div className="select-shell"><select value={binding.midi} onChange={(event) => onBindingChange(binding.index, Number(event.target.value))}>{noteOptions.map((midi) => <option value={midi} key={midi}>{midiName(midi)}</option>)}</select><ChevronDown size={14} /></div>
                  <code>{midiFrequency(binding.midi).toFixed(1)} Hz</code>
                  <button className="audition-button" type="button" aria-label={`试听 ${midiName(binding.midi)}`} onClick={() => onAudition(binding.index)}><Volume2 size={16} /></button>
                </div>
              ))}
            </div>
          </article>
        </div>

        <aside className="keymap-preview glass-card">
          <span className="section-kicker">DEVICE PREVIEW</span><h2>按键预览</h2><p>点击下方琴键可直接试听方波音色。</p>
          <MiniPianoIllustration activeLane={activeLane} />
          <div className="keymap-mini-keys">{bindings.map((binding) => <button className={activeLane === binding.index ? "is-active" : ""} style={{ "--lane": binding.index } as CSSProperties} type="button" key={binding.index} onClick={() => onAudition(binding.index)}><span>K{binding.index + 1}</span><strong>{midiName(binding.midi)}</strong></button>)}</div>
          <div className="keymap-note"><Zap size={16} /><p><strong>蜂鸣器提示</strong>试听使用浏览器方波近似音色；最终音准取决于定时器频率和晶振误差。</p></div>
        </aside>
      </section>
    </div>
  );
}

interface DeviceLibraryPageProps {
  title: string;
  noteCount: number;
  slots: DeviceSong[];
  connected: boolean;
  onSlotsChange: (slots: DeviceSong[]) => void;
  onConnect: () => void;
  onEdit: () => void;
  onNotice: (message: string) => void;
}

function DeviceLibraryPage({ title, noteCount, slots, connected, onSlotsChange, onConnect, onEdit, onNotice }: DeviceLibraryPageProps) {
  const [transfer, setTransfer] = useState<{ slot: number; progress: number } | null>(null);
  const usedBytes = slots.reduce((sum, slot) => sum + slot.bytes, 0);
  const estimate = 18 + noteCount * 3;

  useEffect(() => {
    if (!transfer) return;
    const timer = window.setInterval(() => {
      setTransfer((current) => {
        if (!current) return null;
        const nextProgress = Math.min(100, current.progress + 8);
        if (nextProgress >= 100) {
          const nextSlots = slots.map((slot) => slot.slot === current.slot ? { ...slot, title, notes: noteCount, bytes: estimate, updatedAt: "刚刚" } : slot);
          onSlotsChange(nextSlots);
          onNotice(`“${title}”已写入槽位 ${current.slot}（前端演示）。`);
          window.clearInterval(timer);
          return null;
        }
        return { ...current, progress: nextProgress };
      });
    }, 90);
    return () => window.clearInterval(timer);
  }, [estimate, noteCount, onNotice, onSlotsChange, slots, title, transfer]);

  const writeToSlot = (slot: number) => {
    if (!connected) { onConnect(); return; }
    setTransfer({ slot, progress: 0 });
  };

  return (
    <div className="page-stack piano-page">
      <section className="page-heading">
        <div><span className="section-kicker">ON-DEVICE LIBRARY</span><h1>设备曲库</h1><p>把上位机曲目编码后写入指定槽位。容量和数据帧目前是前端规划，固件协议确定后即可对接。</p></div>
        <div className="heading-actions"><button className="secondary-button" type="button" onClick={onEdit}><Music2 size={16} />返回编辑</button><button className="primary-button" type="button" onClick={() => writeToSlot(slots.find((slot) => !slot.title)?.slot ?? 8)} disabled={Boolean(transfer)}><Upload size={16} />写入空闲槽位</button></div>
      </section>

      <section className="library-summary glass-card">
        <div className="library-source"><span className="library-source__icon"><FileMusic size={22} /></span><div><span>准备写入</span><strong>{title}</strong><small>{noteCount} 个音符 · 预计 {estimate} B</small></div></div>
        <div className="library-capacity"><div><span>曲库预算（暂定）</span><strong>{formatBytes(usedBytes)} <small>/ {formatBytes(DEVICE_LIBRARY_BUDGET)}</small></strong></div><div className="capacity-track"><i style={{ width: `${Math.min(100, usedBytes / DEVICE_LIBRARY_BUDGET * 100)}%` }} /></div></div>
        <div className={`library-link${connected ? " is-online" : ""}`}><span className="status-orb" /><div><small>{connected ? "DEVICE READY" : "DEVICE OFFLINE"}</small><strong>{connected ? "Pocket Keys · 51" : "请先连接电子琴"}</strong></div></div>
      </section>

      <section className="device-slots">
        {slots.map((slot) => {
          const writing = transfer?.slot === slot.slot;
          return (
            <article className={`device-slot glass-card${slot.title ? " is-used" : " is-empty"}${writing ? " is-writing" : ""}`} key={slot.slot}>
              <header><span>槽位 {String(slot.slot).padStart(2, "0")}</span>{slot.title ? <span className="slot-state"><i />已占用</span> : <span className="slot-state is-empty"><Plus size={13} />空闲</span>}</header>
              <div className="device-slot__body"><span className="device-slot__disc"><DiscGraphic active={writing} /></span><div><strong>{slot.title ?? "写入新曲目"}</strong><small>{slot.title ? `${slot.notes} 音符 · ${formatBytes(slot.bytes)}` : "可用曲目槽位"}</small></div></div>
              {writing ? <div className="slot-progress"><span><i style={{ width: `${transfer.progress}%` }} /></span><strong>{transfer.progress}%</strong></div> : <button type="button" disabled={Boolean(transfer)} onClick={() => writeToSlot(slot.slot)}>{slot.title ? "用当前曲目覆盖" : "写入此槽"}<ArrowRight size={15} /></button>}
              <footer><Clock3 size={13} />{slot.updatedAt ?? "从未写入"}</footer>
            </article>
          );
        })}
      </section>

      <section className="protocol-draft glass-card">
        <div><span className="protocol-draft__icon"><CircuitBoard size={22} /></span><div><span className="section-kicker">PROTOCOL DRAFT</span><h2>串口写曲草案</h2><p>上位机已为后端预留“握手 → 擦除槽位 → 分包写入 → 校验 → 更新目录”的状态。这里的帧结构只用于界面表达，不会向真实设备发命令。</p></div></div>
        <code><span>AA 55</span><span>CMD_WRITE_SONG</span><span>SLOT</span><span>LEN</span><span>DATA…</span><span>CRC8</span></code>
      </section>
    </div>
  );
}

function DiscGraphic({ active }: { active: boolean }) {
  return <span className={`disc-graphic${active ? " is-active" : ""}`}><i /><b /></span>;
}

interface FirmwarePageProps {
  connected: boolean;
  port: string;
  onNotice: (message: string) => void;
}

function FirmwarePage({ connected, port, onNotice }: FirmwarePageProps) {
  const [file, setFile] = useState<FirmwareFileMeta | null>(null);
  const [target, setTarget] = useState("STC89C52RC");
  const [selectedPort, setSelectedPort] = useState(connected ? port : "COM3");
  const [baud, setBaud] = useState(115200);
  const [eraseFlash, setEraseFlash] = useState(true);
  const [verify, setVerify] = useState(true);
  const [powerPrompt, setPowerPrompt] = useState(true);
  const [progress, setProgress] = useState(0);
  const [burning, setBurning] = useState(false);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!burning) return;
    const timer = window.setInterval(() => {
      setProgress((current) => {
        const next = Math.min(100, current + 3);
        if (next >= 100) {
          window.clearInterval(timer);
          setBurning(false);
          onNotice("固件烧录前端流程演示完成；本次未向硬件发送数据。");
        }
        return next;
      });
    }, 95);
    return () => window.clearInterval(timer);
  }, [burning, onNotice]);

  const acceptFile = (candidate: File) => {
    if (!/\.(hex|bin)$/i.test(candidate.name)) {
      onNotice("请选择 .hex 或 .bin 固件文件。");
      return;
    }
    setFile({ name: candidate.name, size: candidate.size });
    setProgress(0);
  };

  const onFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const candidate = event.target.files?.[0];
    if (candidate) acceptFile(candidate);
  };

  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const candidate = event.dataTransfer.files[0];
    if (candidate) acceptFile(candidate);
  };

  const stage = progress >= 100 ? "完成" : progress >= 82 ? "校验" : progress >= 18 ? "写入" : progress > 0 ? "握手" : "等待开始";

  return (
    <div className="page-stack piano-page firmware-page">
      <section className="page-heading">
        <div><span className="section-kicker">FIRMWARE FLASHER</span><h1>固件烧录</h1><p>先完成文件、芯片、串口和烧录选项的前端流程；后端 ISP 工具链将在协议确定后接入。</p></div>
        <span className="firmware-prototype-badge"><CircuitBoard size={16} />前端原型 · 不会操作硬件</span>
      </section>

      <section className="firmware-warning"><ShieldCheck size={20} /><div><strong>安全说明</strong><span>当前“开始烧录”仅演示进度与状态，不会打开串口、擦除芯片或发送固件。</span></div></section>

      <section className="firmware-layout">
        <div className="firmware-main">
          <article className="glass-card firmware-step">
            <header><span>01</span><div><h2>选择固件</h2><p>支持 Intel HEX 或原始 BIN 文件</p></div>{file && <CheckCircle2 size={20} />}</header>
            <label className={`firmware-dropzone${dragging ? " is-dragging" : ""}${file ? " has-file" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragging(true); }} onDragOver={(event) => event.preventDefault()} onDragLeave={() => setDragging(false)} onDrop={onDrop}>
              <input type="file" accept=".hex,.bin" onChange={onFileChange} />
              {file ? <><span className="firmware-file-icon"><FileCode2 size={25} /></span><div><strong>{file.name}</strong><small>{formatBytes(file.size)} · 文件已就绪</small></div><span className="file-replace">重新选择</span></> : <><span className="firmware-file-icon"><FileUp size={25} /></span><div><strong>拖入固件，或点击浏览</strong><small>.hex / .bin · 建议保留版本号</small></div></>}
            </label>
            {!file && <button className="firmware-demo-file" type="button" onClick={() => setFile({ name: "pocket-keys-v0.1.0.hex", size: 6144 })}>没有文件？使用演示固件</button>}
          </article>

          <article className="glass-card firmware-step">
            <header><span>02</span><div><h2>目标与串口</h2><p>匹配芯片型号和 ISP 下载参数</p></div><Settings2 size={20} /></header>
            <div className="firmware-fields">
              <label><span>目标芯片</span><div className="select-shell"><select value={target} onChange={(event) => setTarget(event.target.value)}><option>STC89C52RC</option><option>STC89C51RC</option><option>AT89S52</option></select><ChevronDown size={15} /></div><small>首选低成本 8 位 51 方案</small></label>
              <label><span>串口</span><div className="select-shell"><select value={selectedPort} onChange={(event) => setSelectedPort(event.target.value)}><option>COM3</option><option>COM5</option><option>COM8</option></select><ChevronDown size={15} /></div><small>{connected && selectedPort === port ? "当前演示设备端口" : "等待后端枚举"}</small></label>
              <label><span>最高波特率</span><div className="select-shell"><select value={baud} onChange={(event) => setBaud(Number(event.target.value))}><option value={9600}>9,600</option><option value={57600}>57,600</option><option value={115200}>115,200</option></select><ChevronDown size={15} /></div><small>实际速率由 ISP 握手协商</small></label>
            </div>
          </article>

          <article className="glass-card firmware-step firmware-options-step">
            <header><span>03</span><div><h2>烧录选项</h2><p>开始前检查擦除、校验与上电方式</p></div><SlidersHorizontal size={20} /></header>
            <div className="firmware-options">
              <label><input type="checkbox" checked={eraseFlash} onChange={(event) => setEraseFlash(event.target.checked)} /><span><b>烧录前擦除代码区</b><small>避免旧固件残留</small></span></label>
              <label><input type="checkbox" checked={verify} onChange={(event) => setVerify(event.target.checked)} /><span><b>写入后校验</b><small>读取并核对内容</small></span></label>
              <label><input type="checkbox" checked={powerPrompt} onChange={(event) => setPowerPrompt(event.target.checked)} /><span><b>提示重新上电</b><small>适配 STC 冷启动下载</small></span></label>
            </div>
          </article>
        </div>

        <aside className="firmware-console glass-card">
          <div className="firmware-target-visual"><span><Cpu size={34} /></span><i /><b>{target}</b><small>8051 TARGET</small></div>
          <div className="firmware-ready-list">
            <span className={file ? "is-ready" : ""}>{file ? <Check size={15} /> : <span>1</span>}固件文件</span>
            <span className="is-ready"><Check size={15} />{selectedPort} · {baud.toLocaleString()}</span>
            <span className="is-ready"><Check size={15} />{target}</span>
          </div>
          <div className="firmware-progress-block">
            <div><span>{stage}</span><strong>{progress}%</strong></div><span className="firmware-progress-track"><i style={{ width: `${progress}%` }} /></span>
          </div>
          <div className="firmware-log" aria-live="polite">
            <span><i />烧录器前端已就绪</span>
            {progress > 0 && <span><i />正在等待 ISP 握手…</span>}
            {progress >= 18 && <span><i />正在写入代码区（演示）</span>}
            {progress >= 82 && verify && <span><i />正在校验固件（演示）</span>}
            {progress >= 100 && <span className="is-success"><i />演示流程完成，未操作硬件</span>}
          </div>
          <button className="primary-button firmware-start" type="button" disabled={!file || burning} onClick={() => { setProgress(1); setBurning(true); }}>{burning ? <><LoaderCircle className="spin" size={17} />正在演示烧录…</> : <><Zap size={17} />开始烧录（界面演示）</>}</button>
          <p className="firmware-power-tip"><Zap size={14} />真实接入后，这里会提示断电并重新上电以进入 ISP。</p>
        </aside>
      </section>
    </div>
  );
}

interface PianoConnectionModalProps {
  open: boolean;
  connected: boolean;
  port: string;
  baudRate: number;
  busy: boolean;
  onClose: () => void;
  onConnect: (port: string, baud: number) => void;
  onDisconnect: () => void;
}

function PianoConnectionModal({ open, connected, port, baudRate, busy, onClose, onConnect, onDisconnect }: PianoConnectionModalProps) {
  const [draftPort, setDraftPort] = useState(port);
  const [draftBaud, setDraftBaud] = useState(baudRate);
  if (!open) return null;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConnect(draftPort, draftBaud);
  };

  return (
    <div className="modal-backdrop piano-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="connection-modal piano-connection-modal" role="dialog" aria-modal="true" aria-labelledby="piano-connection-title">
        <header><div><span className="connection-modal__icon"><Usb size={21} /></span><div><span className="section-kicker">SERIAL LINK</span><h2 id="piano-connection-title">连接口袋电子琴</h2></div></div><button className="icon-button" type="button" aria-label="关闭" disabled={busy} onClick={onClose}><X size={18} /></button></header>
        {connected ? (
          <div className="piano-connected-panel">
            <span className="piano-connected-panel__visual"><MiniPianoIllustration /></span>
            <div><span className="soft-badge is-success"><i />演示设备在线</span><h3>Pocket Keys · 51</h3><p>{port} · {baudRate.toLocaleString()} baud</p></div>
            <div className="piano-link-facts"><span><small>协议</small><strong>前端演示</strong></span><span><small>琴键</small><strong>8</strong></span><span><small>蜂鸣器</small><strong>单音</strong></span></div>
          </div>
        ) : (
          <form onSubmit={submit}>
            <div className="piano-modal-note"><CircuitBoard size={18} /><p><strong>当前先验证上位机交互</strong>尚未绑定电子琴串口协议；“模拟连接”不会打开真实端口。</p></div>
            <div className="piano-connection-fields">
              <label><span>串口</span><div className="select-shell"><select value={draftPort} onChange={(event) => setDraftPort(event.target.value)}><option>COM3</option><option>COM5</option><option>COM8</option></select><ChevronDown size={15} /></div></label>
              <label><span>波特率</span><div className="select-shell"><select value={draftBaud} onChange={(event) => setDraftBaud(Number(event.target.value))}><option value={9600}>9,600</option><option value={57600}>57,600</option><option value={115200}>115,200</option></select><ChevronDown size={15} /></div></label>
            </div>
            <div className="piano-protocol-preview"><span><i />TX</span><code>AA 55 01 00 CRC</code><small>握手帧草案</small></div>
            <div className="modal-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>取消</button><button className="primary-button" type="submit" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={17} />正在建立演示会话…</> : <><Usb size={17} />模拟连接</>}</button></div>
          </form>
        )}
        {connected && <div className="modal-actions piano-disconnect-actions"><button className="secondary-button" type="button" onClick={onClose}>完成</button><button className="danger-button" type="button" onClick={onDisconnect}>断开演示设备</button></div>}
      </section>
    </div>
  );
}
