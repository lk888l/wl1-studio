import {
  Braces,
  Check,
  CircleStop,
  Clipboard,
  Eraser,
  RadioTower,
  Search,
  Send,
  TerminalSquare,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { validateFirmwareCommand } from "../../lib/protocol";
import type { ConnectionSnapshot, ConsoleDirection, ConsoleEntry } from "../../types";

type ConsoleFilter = "all" | ConsoleDirection;

interface DiagnosticsPageProps {
  connection: ConnectionSnapshot;
  entries: readonly ConsoleEntry[];
  telemetryEnabled: boolean;
  writesUnlocked: boolean;
  onSend: (command: string) => Promise<void>;
  onTelemetryChange: (enabled: boolean) => Promise<void>;
  onClear: () => void;
  onConnectionOpen: () => void;
}

const quickCommands = ["legheight 44.5", "anglebias 12.6", "anglepid -i 0.000", "rollpid -p 0.00"];

const directionLabel: Record<ConsoleDirection, string> = {
  rx: "RX",
  tx: "TX",
  system: "SYS",
};

export function DiagnosticsPage({
  connection,
  entries,
  telemetryEnabled,
  writesUnlocked,
  onSend,
  onTelemetryChange,
  onClear,
  onConnectionOpen,
}: DiagnosticsPageProps) {
  const [filter, setFilter] = useState<ConsoleFilter>("all");
  const [query, setQuery] = useState("");
  const [command, setCommand] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const connected = connection.mode !== "disconnected";
  const validation = command ? validateFirmwareCommand(command) : null;
  const visibleEntries = useMemo(() => entries.filter((entry) => {
    if (filter !== "all" && entry.direction !== filter) return false;
    return !query || entry.text.toLowerCase().includes(query.toLowerCase());
  }), [entries, filter, query]);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [visibleEntries.length]);

  const send = async (value = command): Promise<void> => {
    const error = validateFirmwareCommand(value);
    if (error) {
      setNotice(error);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await onSend(value.trim());
      setCommand("");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleTelemetry = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await onTelemetryChange(!telemetryEnabled);
      setNotice(`已请求${telemetryEnabled ? "停止" : "开启"} IMU + RPM 遥测；Legacy 固件不返回 ACK。`);
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const copyConsole = async (): Promise<void> => {
    const text = visibleEntries.map((entry) => `${new Date(entry.timestamp).toISOString()} ${directionLabel[entry.direction]} ${entry.text}`).join("\n");
    await navigator.clipboard.writeText(text);
    setNotice("当前筛选结果已复制到剪贴板。");
  };

  return (
    <div className="page-stack diagnostics-page">
      <section className="page-heading">
        <div><span className="section-kicker">SERIAL DIAGNOSTICS</span><h1>诊断终端</h1><p>查看 Rust 后端发出的权威串口日志，或发送安全白名单内的单条 ASCII 命令。每条命令严格限制在 32 字节以内。</p></div>
        <button className={connected ? "connection-button is-online" : "connection-button"} type="button" onClick={onConnectionOpen}><span className="status-orb" /><div><small>{connected ? "CONNECTED" : "OFFLINE"}</small><strong>{connection.label}</strong></div></button>
      </section>

      <div className="diagnostics-layout">
        <section className="terminal-card glass-card">
          <header className="terminal-toolbar">
            <div className="terminal-title"><TerminalSquare size={19} /><span><strong>Serial console</strong><small>{visibleEntries.length} / {entries.length} lines</small></span></div>
            <div className="console-filters">
              {(["all", "rx", "tx", "system"] as const).map((item) => <button key={item} type="button" className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部" : directionLabel[item]}</button>)}
            </div>
            <label className="console-search"><Search size={15} /><input value={query} placeholder="过滤日志" onChange={(event) => setQuery(event.target.value)} /></label>
            <button className="icon-button" type="button" aria-label="复制日志" onClick={() => void copyConsole()}><Clipboard size={17} /></button>
            <button className="icon-button" type="button" aria-label="清空日志" onClick={onClear}><Eraser size={17} /></button>
          </header>

          <div className="console-window" ref={scrollRef} role="log" aria-live="polite">
            {visibleEntries.map((entry) => (
              <div className={`console-line is-${entry.direction}`} key={entry.id}><time>{new Date(entry.timestamp).toLocaleTimeString("zh-CN", { hour12: false })}</time><b>{directionLabel[entry.direction]}</b><code>{entry.text}</code></div>
            ))}
            {visibleEntries.length === 0 && <div className="console-empty"><Braces size={27} /><strong>这里还很安静</strong><span>连接 Mock 或真实串口后，事件会显示在这里。</span></div>}
          </div>

          <form className="command-composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
            <span>&gt;</span><input value={command} autoComplete="off" spellCheck={false} placeholder={!connected ? "请先连接设备" : writesUnlocked ? "输入单条固件命令，例如 legheight 44.5" : "只读连接已锁定命令发送"} disabled={!writesUnlocked || busy} onChange={(event) => setCommand(event.target.value)} />
            <small className={validation ? "is-error" : ""}>{command.trim().length}/32</small>
            <button className="primary-button" type="submit" disabled={!writesUnlocked || busy || !command.trim() || Boolean(validation)}><Send size={16} />发送</button>
          </form>
          {validation && <div className="composer-error">{validation}</div>}
        </section>

        <aside className="diagnostics-sidebar">
          <section className="glass-card diagnostic-control">
            <div className="section-title-row"><div><span className="section-kicker">TELEMETRY</span><h2>遥测总开关</h2></div><RadioTower size={19} /></div>
            <p>当前 Rust 契约将 IMU 与 RPM 作为一组启停；待后端 DTO 支持后再拆分通道。</p>
            <button className={telemetryEnabled ? "telemetry-toggle is-active" : "telemetry-toggle"} type="button" disabled={!connected || busy} onClick={() => void toggleTelemetry()}>
              {telemetryEnabled ? <CircleStop size={19} /> : <RadioTower size={19} />}<span><strong>{telemetryEnabled ? "停止遥测" : "开启遥测"}</strong><small>{telemetryEnabled ? "本会话已请求开启（无 ACK）" : "本会话未请求开启 / 已请求停止（未确认）"}</small></span><i />
            </button>
          </section>

          <section className="glass-card quick-commands">
            <div className="section-title-row"><div><span className="section-kicker">SHORTCUTS</span><h2>常用命令</h2></div></div>
            {quickCommands.map((item) => <button type="button" key={item} disabled={!writesUnlocked || busy} onClick={() => void send(item)}><code>{item}</code><Send size={14} /></button>)}
          </section>

          <section className="glass-card protocol-facts">
            <div><span>传输</span><strong>115200 · 8-N-1</strong></div><div><span>协议</span><strong>Legacy ASCII</strong></div><div><span>命令 ACK</span><strong className="text-warning">不支持</strong></div><div><span>队列</span><strong>4 × 32 bytes</strong></div>
          </section>
        </aside>
      </div>
      {notice && <div className="toast-notice"><Check size={16} />{notice}</div>}
    </div>
  );
}
