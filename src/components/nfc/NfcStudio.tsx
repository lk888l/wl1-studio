import {
  AlertTriangle,
  ArrowLeft,
  BadgeCheck,
  BookOpen,
  Cable,
  Copy,
  CreditCard,
  Database,
  Download,
  KeyRound,
  LoaderCircle,
  Nfc,
  RefreshCw,
  ShieldAlert,
  Upload,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { isTauriRuntime } from "../../lib/device";
import {
  defaultWriteOptions,
  dumpGaps,
  emptyReadOptions,
  formatUid,
  hexPairs,
  hexToAscii,
  nfcGateway,
  type CardDump,
  type NfcEvent,
  type NfcSnapshot,
  type ReadOptions,
  type WriteOptions,
  type WriteReport,
} from "../../lib/nfc";
import type { SerialPortOption } from "../../types";
import "./NfcStudio.css";

type NfcPage = "read" | "write" | "data" | "help";

const pages = [
  { id: "read", label: "读取卡片", icon: CreditCard, caption: "读出整张卡的全部扇区与密钥。" },
  { id: "write", label: "复制写入", icon: Upload, caption: "把备份写进一张新卡。" },
  { id: "data", label: "数据视图", icon: Database, caption: "逐块查看十六进制与可读字符。" },
  { id: "help", label: "接线与说明", icon: BookOpen, caption: "模块跳线、接线与安全提示。" },
] as const;

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const timeLabel = (timestamp: number): string =>
  new Date(timestamp).toLocaleString("zh-CN", { hour12: false });

const keySourceLabel: Record<string, string> = {
  dictionary: "默认字典",
  harvested: "扇区尾块",
  manual: "手动填写",
  none: "未获取",
};

export function NfcStudio({ onBack }: { onBack: () => void }) {
  const [snapshot, setSnapshot] = useState<NfcSnapshot>(nfcGateway.connection);
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [portName, setPortName] = useState("");
  const [page, setPage] = useState<NfcPage>("read");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [dump, setDump] = useState<CardDump | null>(nfcGateway.lastDump);
  const [report, setReport] = useState<WriteReport | null>(nfcGateway.lastReport);

  const [extraKeysText, setExtraKeysText] = useState("");
  const [sectorKeyDrafts, setSectorKeyDrafts] = useState<Record<number, string>>({});
  const [writeOptions, setWriteOptions] = useState<WriteOptions>(defaultWriteOptions);
  const [targetKeysText, setTargetKeysText] = useState("");
  const [uidConfirmed, setUidConfirmed] = useState(false);
  const [importText, setImportText] = useState("");
  const [showImport, setShowImport] = useState(false);
  const operation = useRef(0);

  const connected = snapshot.mode === "serial";

  useEffect(
    () =>
      nfcGateway.subscribe((event: NfcEvent) => {
        if (event.type === "snapshot") {
          setSnapshot(event.snapshot);
          return;
        }
        if (event.type === "progress") {
          setProgress(event.progress.message);
          return;
        }
        operation.current += 1;
        setProgress(null);
        setBusy(false);
        setSnapshot(nfcGateway.connection);
        setNotice(`读卡器已断开：${event.reason}`);
      }),
    [],
  );

  const refreshPorts = useCallback(async (): Promise<void> => {
    setError(null);
    try {
      const next = await nfcGateway.listSerialPorts();
      setPorts(next);
      setPortName((current) => current || next[0]?.name || "");
    } catch (reason) {
      setError(errorText(reason));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void nfcGateway
      .initialize()
      .then(() => {
        if (!cancelled) {
          setSnapshot(nfcGateway.connection);
          return refreshPorts();
        }
        return undefined;
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(errorText(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [refreshPorts]);

  const connect = useCallback(async (): Promise<void> => {
    const token = ++operation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await nfcGateway.connect(portName);
      if (operation.current !== token) return;
      setSnapshot(next);
      setNotice("读卡器已连接。请把卡片平放在天线上，然后点击“读取全部数据”。");
    } catch (reason) {
      if (operation.current !== token) return;
      setError(errorText(reason));
      setSnapshot(nfcGateway.connection);
    } finally {
      if (operation.current === token) setBusy(false);
    }
  }, [portName]);

  const disconnect = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      setSnapshot(await nfcGateway.disconnect());
      setProgress(null);
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  }, []);

  const buildReadOptions = useCallback((): ReadOptions => {
    const options = emptyReadOptions();
    options.extraKeys = extraKeysText
      .split(/[\s,;]+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
    options.sectorKeys = Object.entries(sectorKeyDrafts)
      .filter(([, value]) => value.trim().length > 0)
      .map(([sector, value]) => {
        const trimmed = value.trim();
        const keyB = /^b:/i.test(trimmed);
        return {
          sector: Number(sector),
          key: keyB ? trimmed.slice(2).trim() : trimmed.replace(/^a:/i, "").trim(),
          keyB,
        };
      });
    return options;
  }, [extraKeysText, sectorKeyDrafts]);

  const readCard = useCallback(async (): Promise<void> => {
    const token = ++operation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    setReport(null);
    setUidConfirmed(false);
    try {
      const next = await nfcGateway.readCard(buildReadOptions());
      if (operation.current !== token) return;
      setDump(next);
      setPage("data");
      setNotice(
        next.unresolvedSectors > 0
          ? `已读取 ${next.label}，但有 ${next.unresolvedSectors} 个扇区未能认证。可在下方为这些扇区手动填写密钥后重试。`
          : `已完整读取 ${next.label}，UID ${formatUid(next.uid)}。`,
      );
    } catch (reason) {
      if (operation.current !== token) return;
      setError(errorText(reason));
    } finally {
      if (operation.current === token) {
        setBusy(false);
        setProgress(null);
      }
    }
  }, [buildReadOptions]);

  const cancel = useCallback(async (): Promise<void> => {
    setNotice("正在取消，请稍候…");
    await nfcGateway.cancel();
  }, []);

  const writeCard = useCallback(async (): Promise<void> => {
    if (!dump) return;
    const token = ++operation.current;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const options: WriteOptions = {
        ...writeOptions,
        targetKeys: targetKeysText
          .split(/[\s,;]+/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      };
      const next = await nfcGateway.writeCard(dump, options);
      if (operation.current !== token) return;
      setReport(next);
      // A deliberately skipped block is not a failure. Reporting both the same
      // way made a 62-of-63 copy read like a broken write.
      if (next.blocksFailed > 0) {
        setNotice(
          `写入结束：成功 ${next.blocksWritten} 个块，失败 ${next.blocksFailed} 个块。请查看下方明细。`,
        );
      } else if (next.blocksSkipped > 0) {
        setNotice(
          `写入完成：${next.blocksWritten} 个块已写入，${next.blocksSkipped} 个块按设计跳过（不是错误，原因见下方）。`,
        );
      } else {
        setNotice(`写入完成：${next.blocksWritten} 个块，${next.sectorsWritten} 个扇区。`);
      }
    } catch (reason) {
      if (operation.current !== token) return;
      setError(errorText(reason));
    } finally {
      if (operation.current === token) {
        setBusy(false);
        setProgress(null);
      }
    }
  }, [dump, targetKeysText, writeOptions]);

  const copyDump = useCallback(async (): Promise<void> => {
    if (!dump) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(dump));
      setNotice("备份 JSON 已复制到剪贴板，可粘贴保存。");
    } catch {
      setError("无法访问剪贴板，请改用导出文本。");
    }
  }, [dump]);

  const importDump = useCallback((): void => {
    setError(null);
    try {
      const parsed = JSON.parse(importText) as CardDump;
      if (!parsed || !Array.isArray(parsed.units) || typeof parsed.uid !== "string") {
        throw new Error("JSON 结构不是本工具导出的备份");
      }
      nfcGateway.setDump(parsed);
      setDump(parsed);
      setShowImport(false);
      setImportText("");
      setNotice(`已导入备份：${parsed.label} · UID ${formatUid(parsed.uid)}`);
      setPage("write");
    } catch (reason) {
      setError(`导入失败：${errorText(reason)}`);
    }
  }, [importText]);

  const returnToHub = useCallback((): void => {
    if (busy) {
      setError("读卡操作进行中，请等待完成或先取消。");
      return;
    }
    if (connected) {
      setError("请先断开读卡器再返回产品首页。");
      return;
    }
    onBack();
  }, [busy, connected, onBack]);

  const unresolvedSectors = useMemo(
    () => (dump ? dump.sectors.filter((sector) => !sector.resolved) : []),
    [dump],
  );
  const gaps = dump ? dumpGaps(dump) : 0;
  const currentPage = pages.find((entry) => entry.id === page) ?? pages[0];

  return (
    <div className="nfc-studio">
      <aside className="nfc-sidebar">
        <button className="nfc-back" type="button" onClick={returnToHub}>
          <ArrowLeft size={14} />返回产品库
        </button>
        <div className="nfc-brand">
          <span className="nfc-brand__icon" aria-hidden="true">
            <Nfc size={22} strokeWidth={2.2} />
          </span>
          <span>
            <strong>NFC 读卡器</strong>
            <span>PN532 · MIFARE 工具台</span>
          </span>
        </div>

        <nav className="nfc-nav" aria-label="NFC 工作台导航">
          {pages.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={entry.id === page ? "is-active" : undefined}
              aria-current={entry.id === page ? "page" : undefined}
              onClick={() => setPage(entry.id)}
            >
              <entry.icon size={17} />
              <span>{entry.label}</span>
            </button>
          ))}
        </nav>

        <div className="nfc-sidebar__hardware">
          <Cable size={18} />
          <strong>USB-TTL ↔ PN532</strong>
          <p>
            拨码开关设为 HSU（两个都拨到 0）<br />
            TXD 接 RXD、RXD 接 TXD、GND 共地<br />
            波特率 115200 8N1
          </p>
        </div>

        <div className={`nfc-sidebar__status${connected ? " is-connected" : ""}`}>
          <i />
          <div>
            <strong>{connected ? "读卡器在线" : "读卡器离线"}</strong>
            <span>{connected ? snapshot.label : "选择串口后点击连接"}</span>
          </div>
        </div>
      </aside>

      <div className="nfc-workspace">
        <header className="nfc-topbar">
          <div className="nfc-breadcrumb">
            <span>NFC 工作台</span>
            <strong>{currentPage.label}</strong>
          </div>
          <div className="nfc-topbar__firmware">
            {snapshot.firmware && <span>{snapshot.firmware}</span>}
          </div>
        </header>

        <main className="nfc-content">
          <section className="nfc-page-heading">
            <div>
              <span className="nfc-eyebrow">NFC · PN532</span>
              <h1>{currentPage.label}</h1>
              <p>{currentPage.caption}</p>
            </div>
            <span className={`nfc-status-pill${connected ? " is-ready" : ""}`}>
              <i />
              {busy ? "工作中" : connected ? "已连接" : "未连接"}
            </span>
          </section>

          <section className="nfc-connection">
            <div className="nfc-port-field">
              <label htmlFor="nfc-port">读卡器串口</label>
              <select
                id="nfc-port"
                value={portName}
                disabled={connected || busy}
                onChange={(event) => setPortName(event.target.value)}
              >
                <option value="">请选择串口</option>
                {ports.map((port) => (
                  <option key={port.name} value={port.name}>
                    {port.name}
                    {port.product ? ` · ${port.product}` : ""}
                  </option>
                ))}
              </select>
              <button
                className="nfc-icon-button"
                type="button"
                title="刷新串口列表"
                disabled={connected || busy}
                onClick={() => void refreshPorts()}
              >
                <RefreshCw size={15} />
              </button>
            </div>
            {connected ? (
              <>
                <button
                  className="nfc-button"
                  type="button"
                  disabled={busy}
                  onClick={() => void disconnect()}
                >
                  断开
                </button>
                {busy && (
                  <button className="nfc-button is-danger" type="button" onClick={() => void cancel()}>
                    <X size={15} />取消操作
                  </button>
                )}
              </>
            ) : (
              <button
                className="nfc-button is-primary"
                type="button"
                disabled={busy || !portName}
                onClick={() => void connect()}
              >
                {busy ? <LoaderCircle className="nfc-spin" size={15} /> : <Cable size={15} />}
                {busy ? "连接中…" : "连接读卡器"}
              </button>
            )}
          </section>

          {!isTauriRuntime() && (
            <div className="nfc-banner is-warning" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>当前在浏览器中运行</strong>
                <span>串口只能由桌面应用打开。请使用 Tauri 桌面版本进行读卡。</span>
              </div>
            </div>
          )}
          {error && (
            <div className="nfc-banner is-error" role="alert">
              <AlertTriangle size={18} />
              <div>
                <strong>操作未完成</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => setError(null)}>
                <X size={15} />
              </button>
            </div>
          )}
          {notice && (
            <div className="nfc-banner is-info" role="status">
              <BadgeCheck size={18} />
              <div>
                <strong>提示</strong>
                <span>{notice}</span>
              </div>
              <button type="button" onClick={() => setNotice(null)}>
                <X size={15} />
              </button>
            </div>
          )}
          {progress && (
            <div className="nfc-progress" role="status">
              <LoaderCircle className="nfc-spin" size={16} />
              <span>{progress}</span>
            </div>
          )}

          {page === "read" && (
            <ReadPage
              connected={connected}
              busy={busy}
              dump={dump}
              unresolved={unresolvedSectors}
              extraKeysText={extraKeysText}
              onExtraKeysChange={setExtraKeysText}
              sectorKeyDrafts={sectorKeyDrafts}
              onSectorKeyChange={(sector, value) =>
                setSectorKeyDrafts((current) => ({ ...current, [sector]: value }))
              }
              onRead={() => void readCard()}
            />
          )}

          {page === "write" && (
            <WritePage
              connected={connected}
              busy={busy}
              dump={dump}
              gaps={gaps}
              report={report}
              options={writeOptions}
              targetKeysText={targetKeysText}
              uidConfirmed={uidConfirmed}
              urls={{ showImport, importText }}
              onOptionsChange={setWriteOptions}
              onTargetKeysChange={setTargetKeysText}
              onUidConfirmedChange={setUidConfirmed}
              onWrite={() => void writeCard()}
              onShowImport={setShowImport}
              onImportText={setImportText}
              onImport={importDump}
              onCopy={copyDump}
            />
          )}

          {page === "data" && <DataPage dump={dump} onCopy={copyDump} />}

          {page === "help" && <HelpPage />}
        </main>
      </div>
    </div>
  );
}

function ReadPage({
  connected,
  busy,
  dump,
  unresolved,
  extraKeysText,
  onExtraKeysChange,
  sectorKeyDrafts,
  onSectorKeyChange,
  onRead,
}: {
  connected: boolean;
  busy: boolean;
  dump: CardDump | null;
  unresolved: CardDump["sectors"];
  extraKeysText: string;
  onExtraKeysChange: (value: string) => void;
  sectorKeyDrafts: Record<number, string>;
  onSectorKeyChange: (sector: number, value: string) => void;
  onRead: () => void;
}) {
  return (
    <div className="nfc-stack">
      <section className="nfc-card">
        <div className="nfc-card__heading">
          <h2>读取整张卡</h2>
          <button
            className="nfc-button is-primary"
            type="button"
            disabled={!connected || busy}
            onClick={onRead}
          >
            {busy ? <LoaderCircle className="nfc-spin" size={15} /> : <Download size={15} />}
            {busy ? "读取中…" : "读取全部数据"}
          </button>
        </div>
        <p className="nfc-hint">
          读卡器会先寻卡，再逐扇区用默认密钥字典认证并读出所有块。门禁卡绝大多数使用出厂密钥，
          通常几秒内完成；遇到非默认密钥时该扇区会被标记出来，可在下方补充密钥后重试。
        </p>

        <div className="nfc-field">
          <label htmlFor="nfc-extra-keys">补充密钥（可选）</label>
          <input
            id="nfc-extra-keys"
            type="text"
            placeholder="例如 A0A1A2A3A4A5, FFFFFFFFFFFF"
            value={extraKeysText}
            onChange={(event) => onExtraKeysChange(event.target.value)}
          />
          <span className="nfc-field__note">多个密钥用空格或逗号分隔，会优先于内置字典尝试。</span>
        </div>
      </section>

      {dump && (
        <section className="nfc-card">
          <div className="nfc-card__heading">
            <h2>卡片摘要</h2>
            <span className="nfc-chip">{timeLabel(dump.readAt)}</span>
          </div>
          <dl className="nfc-summary">
            <div>
              <dt>卡型</dt>
              <dd>{dump.label}</dd>
            </div>
            <div>
              <dt>UID</dt>
              <dd className="nfc-mono">{formatUid(dump.uid)}</dd>
            </div>
            <div>
              <dt>ATQA / SAK</dt>
              <dd className="nfc-mono">
                {dump.atqa} / {dump.sak.toString(16).toUpperCase().padStart(2, "0")}
              </dd>
            </div>
            <div>
              <dt>扇区</dt>
              <dd>
                {dump.sectors.filter((sector) => sector.resolved).length} / {dump.sectors.length || "—"} 已读取
              </dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{(dump.durationMs / 1000).toFixed(1)} 秒</dd>
            </div>
          </dl>
          {dump.warnings.map((warning) => (
            <p className="nfc-warning-line" key={warning}>
              <ShieldAlert size={14} />
              {warning}
            </p>
          ))}
        </section>
      )}

      {unresolved.length > 0 && (
        <section className="nfc-card">
          <div className="nfc-card__heading">
            <h2>
              <KeyRound size={16} /> 未能认证的扇区
            </h2>
          </div>
          <p className="nfc-hint">
            这些扇区使用了内置字典之外的密钥。填入密钥后重新读取即可补齐；前缀 <code>b:</code> 表示
            按 Key B 认证，默认按 Key A。
          </p>
          <ul className="nfc-key-list">
            {unresolved.map((sector) => (
              <li key={sector.index}>
                <span className="nfc-key-list__sector">扇区 {sector.index}</span>
                <input
                  type="text"
                  placeholder="6 字节密钥，例如 b:FFFFFFFFFFFF"
                  value={sectorKeyDrafts[sector.index] ?? ""}
                  onChange={(event) => onSectorKeyChange(sector.index, event.target.value)}
                />
              </li>
            ))}
          </ul>
          <button
            className="nfc-button is-primary"
            type="button"
            disabled={!connected || busy}
            onClick={onRead}
          >
            <RefreshCw size={15} />使用新密钥重试读取
          </button>
        </section>
      )}
    </div>
  );
}

function WritePage({
  connected,
  busy,
  dump,
  gaps,
  report,
  options,
  targetKeysText,
  uidConfirmed,
  urls,
  onOptionsChange,
  onTargetKeysChange,
  onUidConfirmedChange,
  onWrite,
  onShowImport,
  onImportText,
  onImport,
  onCopy,
}: {
  connected: boolean;
  busy: boolean;
  dump: CardDump | null;
  gaps: number;
  report: WriteReport | null;
  options: WriteOptions;
  targetKeysText: string;
  uidConfirmed: boolean;
  urls: { showImport: boolean; importText: string };
  onOptionsChange: (options: WriteOptions) => void;
  onTargetKeysChange: (value: string) => void;
  onUidConfirmedChange: (value: boolean) => void;
  onWrite: () => void;
  onShowImport: (value: boolean) => void;
  onImportText: (value: string) => void;
  onImport: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="nfc-stack">
      <section className="nfc-card">
        <div className="nfc-card__heading">
          <h2>写入目标卡</h2>
          <div className="nfc-actions">
            <button className="nfc-button" type="button" onClick={() => onShowImport(!urls.showImport)}>
              <Upload size={15} />导入备份
            </button>
            <button className="nfc-button" type="button" disabled={!dump} onClick={onCopy}>
              <Copy size={15} />复制 JSON
            </button>
          </div>
        </div>

        {urls.showImport && (
          <div className="nfc-field">
            <label htmlFor="nfc-import">粘贴之前导出的备份 JSON</label>
            <textarea
              id="nfc-import"
              rows={4}
              value={urls.importText}
              onChange={(event) => onImportText(event.target.value)}
            />
            <button className="nfc-button" type="button" onClick={onImport}>
              载入备份
            </button>
          </div>
        )}

        {!dump ? (
          <p className="nfc-hint">还没有备份。请先在“读取卡片”中读取原卡，或在此导入一份备份 JSON。</p>
        ) : (
          <>
            <dl className="nfc-summary">
              <div>
                <dt>待写入备份</dt>
                <dd>{dump.label}</dd>
              </div>
              <div>
                <dt>原卡 UID</dt>
                <dd className="nfc-mono">{formatUid(dump.uid)}</dd>
              </div>
              <div>
                <dt>数据完整度</dt>
                <dd>
                  {dump.units.length - gaps} / {dump.units.length} 个块
                </dd>
              </div>
            </dl>
            {gaps > 0 && (
              <p className="nfc-warning-line">
                <ShieldAlert size={14} />
                备份中有 {gaps} 个块没有读到，写入后这些块会保持目标卡的原有内容，克隆结果可能与原卡不一致。
              </p>
            )}

            <div className="nfc-field">
              <label htmlFor="nfc-target-keys">目标卡当前密钥（可选）</label>
              <input
                id="nfc-target-keys"
                type="text"
                placeholder="留空则先用备份中的密钥，再试默认字典"
                value={targetKeysText}
                onChange={(event) => onTargetKeysChange(event.target.value)}
              />
              <span className="nfc-field__note">
                写入时需要先打开目标卡的扇区。空白新卡通常是 FFFFFFFFFFFF。
              </span>
            </div>

            <fieldset className="nfc-options">
              <legend>写入选项</legend>
              <label className="nfc-toggle">
                <input
                  type="checkbox"
                  checked={options.writeTrailers}
                  onChange={(event) =>
                    onOptionsChange({ ...options, writeTrailers: event.target.checked })
                  }
                />
                <span>写入扇区尾块（密钥与权限位）</span>
                <small>关闭后目标卡保留自己的密钥，但门禁系统可能因权限不同而拒绝识别。</small>
              </label>
              <label className="nfc-toggle">
                <input
                  type="checkbox"
                  checked={options.verify}
                  onChange={(event) => onOptionsChange({ ...options, verify: event.target.checked })}
                />
                <span>写入后回读校验</span>
                <small>逐块比对，能发现被卡片拒绝的写入。建议保持开启。</small>
              </label>
            </fieldset>

            <div className="nfc-danger">
              <label className="nfc-toggle is-danger">
                <input
                  type="checkbox"
                  checked={options.writeManufacturerBlock}
                  onChange={(event) => {
                    onOptionsChange({ ...options, writeManufacturerBlock: event.target.checked });
                    if (!event.target.checked) onUidConfirmedChange(false);
                  }}
                />
                <span>
                  <ShieldAlert size={14} /> 写入第 0 块（厂商块 / UID）
                </span>
                <small>
                  原厂 NXP 卡片会直接拒绝该写入。只有 UID 卡（俗称魔术卡）能改写，
                  写对才能完整克隆，写错会让卡片无法被识别。
                </small>
              </label>
              {options.writeManufacturerBlock && (
                <label className="nfc-confirm">
                  <input
                    type="checkbox"
                    checked={uidConfirmed}
                    onChange={(event) => onUidConfirmedChange(event.target.checked)}
                  />
                  <span>
                    我确认目标卡是 UID 卡，并已知晓写坏第 0 块会导致卡片报废。
                  </span>
                </label>
              )}
            </div>

            <button
              className="nfc-button is-primary"
              type="button"
              disabled={
                !connected || busy || (options.writeManufacturerBlock && !uidConfirmed)
              }
              onClick={onWrite}
            >
              {busy ? <LoaderCircle className="nfc-spin" size={15} /> : <Upload size={15} />}
              {busy ? "写入中…" : "写入到目标卡"}
            </button>
            <p className="nfc-hint">
              点击后请把<strong>目标卡</strong>放到读卡器上。写入会先校验卡型是否与备份一致，
              不一致会直接中止。
            </p>
          </>
        )}
      </section>

      {report && (
        <section className="nfc-card">
          <div className="nfc-card__heading">
            <h2>写入结果</h2>
            <span className={`nfc-chip${report.verified ? " is-ok" : ""}`}>
              {report.verified ? "回读一致" : "未通过回读校验"}
            </span>
          </div>
          <dl className="nfc-summary">
            <div>
              <dt>目标卡 UID</dt>
              <dd className="nfc-mono">{formatUid(report.uid)}</dd>
            </div>
            <div>
              <dt>写入块数</dt>
              <dd>{report.blocksWritten}</dd>
            </div>
            <div>
              <dt>失败块数</dt>
              <dd>{report.blocksFailed}</dd>
            </div>
            {report.blocksSkipped > 0 && (
              <div>
                <dt>按设计跳过</dt>
                <dd>{report.blocksSkipped}</dd>
              </div>
            )}
            <div>
              <dt>UID 块</dt>
              <dd>
                {report.manufacturerBlockWritten === undefined
                  ? "未尝试"
                  : report.manufacturerBlockWritten
                    ? "已写入"
                    : "被卡片拒绝"}
              </dd>
            </div>
            <div>
              <dt>耗时</dt>
              <dd>{(report.durationMs / 1000).toFixed(1)} 秒</dd>
            </div>
          </dl>
          {report.warnings.map((warning) => (
            <p className="nfc-warning-line" key={warning}>
              <ShieldAlert size={14} />
              {warning}
            </p>
          ))}
          {report.skips.map((skip) => (
            <p className="nfc-warning-line" key={skip}>
              <ShieldAlert size={14} />
              {skip}
            </p>
          ))}
          {report.failures.map((failure) => (
            <p className="nfc-warning-line is-error" key={failure}>
              <AlertTriangle size={14} />
              {failure}
            </p>
          ))}
        </section>
      )}
    </div>
  );
}

function DataPage({ dump, onCopy }: { dump: CardDump | null; onCopy: () => void }) {
  if (!dump) {
    return (
      <section className="nfc-card">
        <p className="nfc-hint">还没有读取到卡片数据。请先在“读取卡片”中读取一张卡。</p>
      </section>
    );
  }
  const bySector = new Map<number, typeof dump.units>();
  for (const unit of dump.units) {
    const list = bySector.get(unit.sector) ?? [];
    list.push(unit);
    bySector.set(unit.sector, list);
  }

  return (
    <div className="nfc-stack">
      <section className="nfc-card">
        <div className="nfc-card__heading">
          <h2>
            {dump.label} · UID <span className="nfc-mono">{formatUid(dump.uid)}</span>
          </h2>
          <button className="nfc-button" type="button" onClick={onCopy}>
            <Copy size={15} />复制 JSON
          </button>
        </div>
        {dump.sectors.length > 0 && (
          <div className="nfc-table-wrap">
            <table className="nfc-table">
              <thead>
                <tr>
                  <th>扇区</th>
                  <th>块范围</th>
                  <th>Key A</th>
                  <th>Key B</th>
                  <th>来源</th>
                  <th>权限位 C1C2C3</th>
                  <th>状态</th>
                </tr>
              </thead>
              <tbody>
                {dump.sectors.map((sector) => (
                  <tr key={sector.index} className={sector.resolved ? undefined : "is-muted"}>
                    <td>{sector.index}</td>
                    <td className="nfc-mono">
                      {sector.firstBlock}–{sector.trailerBlock}
                    </td>
                    <td className="nfc-mono">{sector.keyA ?? "—"}</td>
                    <td className="nfc-mono">{sector.keyB ?? "未获取"}</td>
                    <td>{keySourceLabel[sector.keySource] ?? sector.keySource}</td>
                    <td className="nfc-mono">{sector.accessSummary ?? "—"}</td>
                    <td>{sector.resolved ? "已读取" : (sector.message ?? "未读取")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="nfc-card">
        <div className="nfc-card__heading">
          <h2>{dump.unitSize === 16 ? "逐块数据" : "逐页数据"}</h2>
          <span className="nfc-chip">
            {dump.unitSize} 字节 / {dump.unitSize === 16 ? "块" : "页"}
          </span>
        </div>
        <div className="nfc-table-wrap is-tall">
          <table className="nfc-table is-blocks">
            <thead>
              <tr>
                <th>{dump.unitSize === 16 ? "块" : "页"}</th>
                <th>十六进制</th>
                <th>ASCII</th>
              </tr>
            </thead>
            <tbody>
              {dump.units.map((unit) => (
                <tr
                  key={unit.index}
                  className={
                    unit.isManufacturer ? "is-manufacturer" : unit.isTrailer ? "is-trailer" : undefined
                  }
                >
                  <td className="nfc-mono">{unit.index}</td>
                  <td className="nfc-mono nfc-bytes">
                    {unit.data ? (
                      hexPairs(unit.data).map((pair, index) => (
                        <span key={index}>{pair}</span>
                      ))
                    ) : (
                      <em>未读取</em>
                    )}
                  </td>
                  <td className="nfc-mono">{unit.data ? hexToAscii(unit.data) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="nfc-hint">
          第 0 块是厂商块（UID），每个扇区的最后一块是尾块（保存 Key A / 权限位 / Key B）。
        </p>
      </section>
    </div>
  );
}

function HelpPage() {
  return (
    <div className="nfc-stack">
      <section className="nfc-card">
        <h2>接线与跳线</h2>
        <ol className="nfc-steps">
          <li>
            <strong>接口模式</strong>：把 PN532 模块上的两个拨码开关都拨到 <code>0</code>（HSU / 串口模式）。
            改成 HSU 后需要重新上电。这是“串口完全没反应”最常见的原因。
          </li>
          <li>
            <strong>接线</strong>：USB-TTL 的 <code>TXD → PN532 RXD</code>、<code>RXD → PN532 TXD</code>、
            <code>GND ↔ GND</code>。收发必须交叉，直连会完全没有数据。
          </li>
          <li>
            <strong>供电</strong>：按模块标注接 3.3V 或 5V。射频工作时电流可达 180 mA，
            供电不足会导致寻卡时断时续。
          </li>
          <li>
            <strong>串口参数</strong>：115200、8 数据位、无校验、1 停止位、无流控。
          </li>
        </ol>
      </section>

      <section className="nfc-card">
        <h2>常见问题</h2>
        <dl className="nfc-faq">
          <div>
            <dt>连接时报“PN532 未响应”</dt>
            <dd>
              大概率是拨码开关不在 HSU 模式，或 TXD/RXD 没有交叉。也可能是模块处于掉电模式，
              重新插拔 USB 后重试。
            </dd>
          </div>
          <div>
            <dt>读到一半提示“卡片已离开射频场”</dt>
            <dd>卡片与天线的耦合变差。把卡片平放贴紧天线，读取过程中不要移动。</dd>
          </div>
          <div>
            <dt>某些扇区认证失败</dt>
            <dd>
              这些扇区改过密钥。在“读取卡片”页填入密钥重试；前缀 <code>b:</code> 表示按 Key B 认证。
            </dd>
          </div>
          <div>
            <dt>为什么有的扇区拿不到 Key A？</dt>
            <dd>
              MIFARE Classic 规定 <strong>Key A 永远不可回读</strong>：在常见的权限位下，卡片读到 Key A
              字段时一律返回 6 个零字节，而不是真实密钥。所以 Key A 只能靠“用它认证成功”来确定。
              如果某个扇区是用 Key B 打开的，它的 Key A 就是未知的——复制时该扇区会保留目标卡原有的
              Key A，并在结果里提示。若你知道密钥，在读取页填进去重新备份即可补齐。
            </dd>
          </div>
          <div>
            <dt>读卡中途出现大量“认证失败”</dt>
            <dd>
              卡片在被拒绝一次后会进入 halt 状态，之后连正确密钥也会被拒。本工具会在每次失败后自动
              重新选卡，所以正常流程不会受影响；若仍频繁出现，说明卡片耦合不稳，把卡片贴紧天线重试。
            </dd>
          </div>
          <div>
            <dt>写入后新卡刷不开门</dt>
            <dd>
              门禁系统可能校验 UID。普通原厂卡的 UID 无法改写，只有 UID 卡（魔术卡）能完整克隆；
              确认系统是否还校验其他扇区数据。
            </dd>
          </div>
        </dl>
      </section>

      <section className="nfc-card">
        <h2>使用范围</h2>
        <p className="nfc-hint">
          本工具用于读取与备份<strong>你自己持有或已获授权</strong>的卡片，例如给自己的门禁卡做备用卡。
          复制他人卡片可能违反法律或单位规定，请自行确认授权范围。
        </p>
      </section>
    </div>
  );
}
