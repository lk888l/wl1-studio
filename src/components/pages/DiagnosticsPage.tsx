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

import { commandByteLength, isReadOnlyFirmwareCommand, validateFirmwareCommand } from "../../lib/protocol";
import { isRemoteConnection } from "../../lib/connection";
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
  const remote = isRemoteConnection(connection);
  const validation = command ? validateFirmwareCommand(command, connection.connectionTarget ?? "robot") : null;
  const commandAllowed = writesUnlocked || isReadOnlyFirmwareCommand(command);
  const visibleEntries = useMemo(() => entries.filter((entry) => {
    if (filter !== "all" && entry.direction !== filter) return false;
    return !query || entry.text.toLowerCase().includes(query.toLowerCase());
  }), [entries, filter, query]);

  useEffect(() => {
    const element = scrollRef.current;
    void visibleEntries.length;
    if (element) element.scrollTop = element.scrollHeight;
  }, [visibleEntries.length]);

  const send = async (value = command): Promise<void> => {
    if (!connected || busy) return;
    if (!writesUnlocked && !isReadOnlyFirmwareCommand(value)) {
      setNotice("只读连接仅允许查询 uid 和 autoleg status。");
      return;
    }
    const error = validateFirmwareCommand(value, connection.connectionTarget ?? "robot");
    if (error) {
      setNotice(error);
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await onSend(value.trim());
      setCommand("");
      if (remote) setNotice("已写入遥控器串口；小车是否收到或执行需现场确认。");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const toggleTelemetry = async (): Promise<void> => {
    if (!connected || remote || busy) return;
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
    try {
      await navigator.clipboard.writeText(text);
      setNotice("当前筛选结果已复制到剪贴板。");
    } catch {
      setNotice("复制失败，请检查剪贴板权限后重试。");
    }
  };

  return (
    <div className="page-stack diagnostics-page">
      <section className="page-heading">
        <div><h1>诊断终端</h1><p>{remote ? "查看遥控器串口日志，并无线下发单条参数命令。" : "查看串口日志，并发送安全白名单内的单条 ASCII 命令。"}</p></div>
        <button className={connected ? "connection-button is-online" : "connection-button"} type="button" onClick={onConnectionOpen}><span className="status-orb" /><div><small>{remote ? "REMOTE SERIAL OPEN" : connected ? "CONNECTED" : "OFFLINE"}</small><strong>{connection.label}</strong></div></button>
      </section>

      {remote && <div className="inline-notice"><RadioTower size={18} /><span>TX 表示电脑已写入遥控器串口。遥控器的无线投递日志也不代表小车执行确认；当前桥接不提供小车遥测、参数回读或运动控制。</span></div>}

      <div className="diagnostics-layout">
        <section className="terminal-card glass-card">
          <header className="terminal-toolbar">
            <div className="terminal-title"><TerminalSquare size={19} /><span><strong>Serial console</strong><small>{visibleEntries.length} / {entries.length} lines</small></span></div>
            <div className="console-filters">
              {(["all", "rx", "tx", "system"] as const).map((item) => <button key={item} type="button" className={filter === item ? "is-active" : ""} onClick={() => setFilter(item)}>{item === "all" ? "全部" : directionLabel[item]}</button>)}
            </div>
            <div className="console-search"><Search size={15} aria-hidden="true" /><input aria-label="过滤日志" value={query} placeholder="过滤日志" onChange={(event) => setQuery(event.target.value)} /></div>
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
            <span>&gt;</span><input aria-label="固件命令" value={command} autoComplete="off" spellCheck={false} placeholder={!connected ? "请先连接设备" : writesUnlocked ? remote ? "例如 autoleg off（不含换行）" : "输入单条固件命令，例如 uid" : remote ? "只读遥控器链路无法查询小车" : "只读连接可查询 uid 或 autoleg status"} disabled={!connected || busy} onChange={(event) => setCommand(event.target.value)} />
            <small className={validation ? "is-error" : ""}>{commandByteLength(command)}/{remote ? 31 : 32}</small>
            <button className="primary-button" type="submit" disabled={!connected || !commandAllowed || busy || !command.trim() || Boolean(validation)}><Send size={16} />发送</button>
          </form>
          {validation && <div className="composer-error">{validation}</div>}
        </section>

        <aside className="diagnostics-sidebar">
          <section className="glass-card diagnostic-control">
            <div className="section-title-row"><div><span className="section-kicker">TELEMETRY</span><h2>遥测总开关</h2></div><RadioTower size={19} /></div>
            <p>{remote ? "遥控器无线桥接仅支持参数下发；查看 IMU 和 RPM 请切换为直连小车。" : "一起开启或停止姿态与轮速遥测。固件不返回 ACK，请以收到的实时数据为准。"}</p>
            <button className={!remote && telemetryEnabled ? "telemetry-toggle is-active" : "telemetry-toggle"} type="button" disabled={!connected || remote || busy} onClick={() => void toggleTelemetry()}>
              {!remote && telemetryEnabled ? <CircleStop size={19} /> : <RadioTower size={19} />}<span><strong>{remote ? "无线模式不支持遥测" : telemetryEnabled ? "停止遥测" : "开启遥测"}</strong><small>{remote ? "需要直连小车串口" : telemetryEnabled ? "本会话已请求开启（无 ACK）" : "本会话未请求开启 / 已请求停止（未确认）"}</small></span><i />
            </button>
          </section>

          <section className="glass-card quick-commands">
            <div className="section-title-row"><div><span className="section-kicker">SHORTCUTS</span><h2>常用命令</h2></div></div>
            {quickCommands.filter((item) => !remote || !item.startsWith("legheight ")).map((item) => <button type="button" key={item} disabled={!connected || !writesUnlocked || busy} onClick={() => void send(item)}><code>{item}</code><Send size={14} /></button>)}
          </section>

          <section className="glass-card protocol-facts">
            <div><span>传输</span><strong>115200 · 8-N-1</strong></div><div><span>目标</span><strong>{remote ? "遥控器串口桥接" : "小车本体 / 仿真"}</strong></div><div><span>回执</span><strong>{remote ? "不回传小车回执" : "UID / autoleg 可查询"}</strong></div><div><span>{remote ? "命令上限" : "队列"}</span><strong>{remote ? "31 bytes + 换行" : "4 × 32 bytes"}</strong></div>
          </section>
        </aside>
      </div>
      {notice && <div className="toast-notice"><Check size={16} />{notice}</div>}
    </div>
  );
}
