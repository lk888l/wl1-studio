import { ArrowLeftRight, Download, FileJson, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useMemo, useRef, useState, type Dispatch } from "react";

import { downloadCardDump, formatUid, parseCardDump, type CardDump } from "../../lib/nfc";
import {
  compareCardDumps,
  type ComparedUnit,
  type ComparisonAction,
  type ComparisonByte,
  type ComparisonStatus,
  type ComparisonWorkspace,
} from "../../lib/nfc-comparison";

const statusLabels: Record<ComparisonStatus, string> = { equal: "一致", different: "不同", unknown: "无法确认" };
const unitLabels: Record<ComparedUnit["kind"], string> = { data: "数据", trailer: "尾块", manufacturer: "厂商 / UID" };
const timestampLabel = (value: number): string => new Date(value).toLocaleString("zh-CN", { hour12: false });
const maxJsonSize = 2 * 1024 * 1024;

function ByteValues({ values, other }: { values: ComparisonByte[]; other: ComparisonByte[] }) {
  return (
    <div className="nfc-compare-bytes nfc-mono">
      {values.map((value, offset) => {
        const unknown = value === null || other[offset] == null;
        const changed = !unknown && value !== other[offset];
        return (
          <span key={offset} className={unknown ? "is-unknown" : changed ? "is-different" : undefined}
            title={`字节 ${offset}：${value ?? "未取得"}${unknown ? "（无法确认）" : changed ? "（不同）" : "（一致）"}`}>
            {value ?? "??"}
          </span>
        );
      })}
    </div>
  );
}

export function NfcComparePage({ dump, dumpSource, connected, busy, workspace, dispatch, onRead, onReadSettings }: {
  dump: CardDump | null;
  dumpSource: string;
  connected: boolean;
  busy: boolean;
  workspace: ComparisonWorkspace;
  dispatch: Dispatch<ComparisonAction>;
  onRead: () => void;
  onReadSettings: () => void;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [importText, setImportText] = useState("");
  const [showPaste, setShowPaste] = useState(false);
  const [importBusy, setImportBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState("changes");
  const [kind, setKind] = useState("all");
  const [sector, setSector] = useState("all");
  const a = workspace.entries.find((entry) => entry.id === workspace.a);
  const b = workspace.entries.find((entry) => entry.id === workspace.b);
  const result = useMemo(() => a && b ? compareCardDumps(a.dump, b.dump) : null, [a, b]);
  const sectorCount = a?.dump.kind === "classic1k" ? 16 : a?.dump.kind === "classic4k" ? 40 : 0;
  const activeKind = !sectorCount && kind === "trailer" ? "all" : kind;
  const activeSector = sectorCount && Number(sector) < sectorCount ? sector : "all";
  const visibleUnits = result?.units.filter((unit) =>
    (filter === "all" || (filter === "unknown" ? unit.unknownOffsets.length > 0 : unit.status !== "equal"))
    && (activeKind === "all" || unit.kind === activeKind)
    && (activeSector === "all" || unit.sector === Number(activeSector))) ?? [];
  const visibleKeys = result?.keys.filter((key) =>
    (filter === "all" || (filter === "unknown" ? key.status === "unknown" : key.status !== "equal"))
    && (activeSector === "all" || key.sector === Number(activeSector))) ?? [];

  const addCurrent = () => {
    if (!dump) return;
    dispatch({ type: "add", entries: [{ dump, source: dumpSource }] });
    setError(null);
    setMessage("当前备份已加入待对比区。可以换卡读取下一张，再点击加入。");
  };

  const importFiles = async (files: File[]) => {
    if (!files.length) return;
    setImportBusy(true);
    setError(null);
    setMessage(null);
    try {
      // Validate the whole batch before changing the workspace.
      const entries = await Promise.all(files.map(async (file) => {
        try {
          if (file.size > maxJsonSize) throw new Error("JSON 文件不能超过 2 MB");
          return { dump: parseCardDump(await file.text()), name: file.name, source: "JSON 文件" };
        } catch (reason) {
          throw new Error(`${file.name}：${reason instanceof Error ? reason.message : String(reason)}`);
        }
      }));
      dispatch({ type: "add", entries });
      setMessage(`已加入 ${entries.length} 份 JSON 备份。`);
    } catch (reason) {
      setError(`本次导入未加入任何记录：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setImportBusy(false);
    }
  };

  const importPaste = () => {
    setError(null);
    setMessage(null);
    try {
      if (importText.length > maxJsonSize) throw new Error("JSON 内容不能超过 2 MB");
      const parsed = parseCardDump(importText);
      dispatch({ type: "add", entries: [{ dump: parsed, source: "粘贴 JSON" }] });
      setImportText("");
      setShowPaste(false);
      setMessage("JSON 备份已加入待对比区。");
    } catch (reason) {
      setError(`导入失败：${reason instanceof Error ? reason.message : String(reason)}`);
    }
  };

  return (
    <div className="nfc-stack">
      <section className="nfc-card">
        <div className="nfc-card__heading">
          <h2>加入对比数据</h2>
          <div className="nfc-actions">
            <button className="nfc-button" type="button" disabled={!connected || busy} onClick={onRead}>
              <RefreshCw size={15} />{busy ? "操作进行中…" : "读取下一张卡"}
            </button>
            <button className="nfc-button" type="button" disabled={busy} onClick={onReadSettings}>读取设置 / 补充密钥</button>
          </div>
        </div>
        <p className="nfc-hint">读取一张卡后点击“加入待对比区”，换卡读取后再次加入。前两份记录自动组成 A / B；也可以选择两份 JSON 直接对比。</p>
        <div className="nfc-compare-current">
          <div>
            <strong>当前备份{dump ? ` · ${dump.label}` : " · 暂无数据"}</strong>
            <p className="nfc-hint">{dump ? `${dumpSource} · UID ${formatUid(dump.uid)} · ${timestampLabel(dump.readAt)}` : "先读取一张卡，或使用下方 JSON 导入。"}</p>
          </div>
          <button className="nfc-button is-primary" type="button" disabled={!dump || busy} onClick={addCurrent}>
            <Plus size={15} />加入待对比区
          </button>
        </div>
        <div className="nfc-actions">
          <input ref={fileInput} type="file" accept=".json,application/json" multiple hidden aria-label="选择对比用 JSON 备份"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void importFiles(files);
            }} />
          <button className="nfc-button" type="button" disabled={importBusy} onClick={() => fileInput.current?.click()}>
            <FileJson size={15} />{importBusy ? "导入中…" : "导入 JSON 文件（可多选）"}
          </button>
          <button className="nfc-button" type="button" disabled={importBusy} aria-expanded={showPaste} onClick={() => setShowPaste(!showPaste)}>粘贴 JSON</button>
        </div>
        {showPaste && (
          <div className="nfc-field">
            <label htmlFor="nfc-compare-json">粘贴本工具导出的卡片备份 JSON</label>
            <textarea id="nfc-compare-json" rows={5} value={importText} onChange={(event) => setImportText(event.target.value)} />
            <button className="nfc-button" type="button" disabled={importBusy || !importText.trim()} onClick={importPaste}>校验并加入待对比区</button>
          </div>
        )}
        {error && <p className="nfc-warning-line is-error" role="alert">{error}</p>}
        {message && <p className="nfc-hint" role="status">{message}</p>}
      </section>

      <section className="nfc-card">
        <div className="nfc-card__heading">
          <h2>待对比区 <span className="nfc-chip">{workspace.entries.length} 份记录</span></h2>
          <button className="nfc-button" type="button" disabled={!workspace.entries.length || importBusy}
            onClick={() => { dispatch({ type: "clear" }); setMessage(null); }}><Trash2 size={15} />清空对比区</button>
        </div>
        <p className="nfc-hint">加入后保留独立快照，再次读卡不会覆盖。相同 UID 的两次读取也能对比。记录在切换 NFC 页面时保留，退出 NFC 工作台后清空；需要留存时请保存 JSON。</p>
        {!workspace.entries.length ? <p className="nfc-compare-empty">加入两份卡片记录，开始对比。</p> : (
          <div className="nfc-compare-pool">
            {workspace.entries.map((entry) => (
              <article className={`nfc-compare-entry${workspace.a === entry.id || workspace.b === entry.id ? " is-selected" : ""}`} key={entry.id}>
                <div className="nfc-card__heading">
                  <strong>{entry.name}</strong>
                  <span className="nfc-chip">{workspace.a === entry.id ? "A · 基准" : workspace.b === entry.id ? "B · 对照" : "待选择"}</span>
                </div>
                <p className="nfc-mono">UID {formatUid(entry.dump.uid)}</p>
                <p className="nfc-hint">{entry.dump.label} · {entry.source}<br />{timestampLabel(entry.dump.readAt)}</p>
                {entry.dump.warnings.length > 0 && <details className="nfc-compare-notes"><summary>备份提示（{entry.dump.warnings.length}）</summary>
                  {entry.dump.warnings.map((warning, index) => <p key={index} className="nfc-warning-line">{warning}</p>)}
                </details>}
                <div className="nfc-actions">
                  <button className="nfc-button" type="button" aria-pressed={workspace.a === entry.id} onClick={() => dispatch({ type: "select", side: "a", id: entry.id })}>设为 A</button>
                  <button className="nfc-button" type="button" aria-pressed={workspace.b === entry.id} onClick={() => dispatch({ type: "select", side: "b", id: entry.id })}>设为 B</button>
                  <button className="nfc-icon-button" type="button" aria-label={`保存 ${entry.name}`} title="保存 JSON" onClick={() => downloadCardDump(entry.dump)}><Download size={15} /></button>
                  <button className="nfc-icon-button" type="button" aria-label={`移除 ${entry.name}`} title="移除记录" onClick={() => dispatch({ type: "remove", id: entry.id })}><Trash2 size={15} /></button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {(!a || !b) && workspace.entries.length > 0 && <section className="nfc-card"><p className="nfc-hint">{!a ? "请选择 A 基准记录。" : "A 已就绪。请再加入一份记录，或将已有记录设为 B。"}选择 A 和 B 后自动显示对比结果。</p></section>}

      {a && b && result && (
        <>
          <section className="nfc-card">
            <div className="nfc-card__heading">
              <h2>对比结果 <span className={`nfc-compare-status is-${result.status}`} role="status">
                {result.status === "equal" ? "已记录内容一致" : result.status === "different" ? "发现差异" : "数据不全，无法确认一致"}
              </span></h2>
              <button className="nfc-button" type="button" onClick={() => dispatch({ type: "swap" })}><ArrowLeftRight size={15} />交换 A / B</button>
            </div>
            <div className="nfc-compare-pair">
              <div><strong>A · {a.name}</strong><p className="nfc-mono">UID {formatUid(a.dump.uid)}</p></div>
              <div><strong>B · {b.name}</strong><p className="nfc-mono">UID {formatUid(b.dump.uid)}</p></div>
            </div>
            <div className="nfc-table-wrap">
              <table className="nfc-table"><thead><tr><th>卡片信息</th><th>A</th><th>B</th><th>结果</th></tr></thead>
                <tbody>{result.metadata.map((field) => <tr key={field.label}><td>{field.label}</td><td className="nfc-mono">{field.a}</td><td className="nfc-mono">{field.b}</td><td><span className={`nfc-compare-status is-${field.status}`}>{statusLabels[field.status]}</span></td></tr>)}</tbody>
              </table>
            </div>
            {!result.compatible ? <p className="nfc-warning-line">卡型或块 / 页大小不兼容，仅比较卡片信息，无法逐地址比较数据。</p> : (
              <dl className="nfc-summary nfc-compare-summary">
                <div><dt>完全一致的块 / 页</dt><dd>{result.equalUnits} / {result.units.length}</dd></div>
                <div><dt>存在差异的块 / 页</dt><dd>{result.differentUnits}（{result.differentBytes} 字节不同）</dd></div>
                <div><dt>包含未知内容的块 / 页</dt><dd>{result.incompleteUnits}</dd></div>
                {result.keys.length > 0 && <div><dt>密钥字段</dt><dd>{result.keys.filter((key) => key.status === "different").length} 项不同 · {result.keys.filter((key) => key.status === "unknown").length} 项未知</dd></div>}
              </dl>
            )}
            <p className="nfc-hint">比较仅覆盖两份备份记录的范围，不代表门禁可用。未知内容不计为一致；同一块可以同时存在差异与未知内容。备份时间、耗时及诊断信息不参与内容比较。</p>
          </section>

          {result.compatible && <section className="nfc-card">
            <div className="nfc-card__heading"><h2>逐{a.dump.unitSize === 16 ? "块" : "页"}对比</h2><span className="nfc-chip">显示 {visibleUnits.length} / {result.units.length}</span></div>
            <div className="nfc-compare-filters">
              <label>显示范围<select value={filter} onChange={(event) => setFilter(event.target.value)}><option value="changes">差异及未知内容</option><option value="all">全部内容</option><option value="unknown">含未知内容</option></select></label>
              <label>数据区域<select value={activeKind} onChange={(event) => setKind(event.target.value)}><option value="all">全部区域</option><option value="data">数据块 / 页</option><option value="manufacturer">厂商 / UID</option>{sectorCount > 0 && <option value="trailer">扇区尾块</option>}</select></label>
              {sectorCount > 0 && <label>扇区<select value={activeSector} onChange={(event) => setSector(event.target.value)}><option value="all">全部扇区</option>{Array.from({ length: sectorCount }, (_, index) => <option key={index} value={String(index)}>扇区 {index}</option>)}</select></label>}
            </div>
            <p className="nfc-hint">红色字节为已确认的差异，黄色字节表示至少一侧未知；?? 表示该侧未取得。尾块使用备份中已确认的 Key A / Key B 替换回读掩码，中间 4 字节为权限位及通用字节。</p>
            <div className="nfc-table-wrap is-tall nfc-compare-table">
              <table className="nfc-table"><thead><tr><th>地址 / 区域</th><th>A · {a.name}</th><th>B · {b.name}</th><th>结果</th></tr></thead>
                <tbody>{visibleUnits.map((unit) => <tr key={unit.index}>
                  <td><strong>{a.dump.unitSize === 16 ? "块" : "页"} {unit.index}</strong><small>{unit.sector !== null && `扇区 ${unit.sector} · `}{unitLabels[unit.kind]}</small></td>
                  <td><ByteValues values={unit.a} other={unit.b} /></td><td><ByteValues values={unit.b} other={unit.a} /></td>
                  <td><span className={`nfc-compare-status is-${unit.status}`}>{statusLabels[unit.status]}</span>{unit.changedOffsets.length > 0 && <small>{unit.changedOffsets.length} 字节不同</small>}{unit.unknownOffsets.length > 0 && <small>{unit.unknownOffsets.length} 字节未知</small>}</td>
                </tr>)}</tbody>
              </table>
              {!visibleUnits.length && <p className="nfc-compare-empty">当前筛选下没有数据；可切换“全部内容”查看。</p>}
            </div>
            {result.keys.length > 0 && (activeKind === "all" || activeKind === "trailer") && <details className="nfc-compare-notes" open>
              <summary>扇区密钥对比（当前范围 {visibleKeys.length} 项）</summary>
              <div className="nfc-table-wrap"><table className="nfc-table"><thead><tr><th>扇区</th><th>字段</th><th>A</th><th>B</th><th>结果</th></tr></thead>
                <tbody>{visibleKeys.map((key) => <tr key={`${key.sector}-${key.label}`}><td>{key.sector}</td><td>{key.label}</td><td className="nfc-mono">{key.a ?? "未取得"}</td><td className="nfc-mono">{key.b ?? "未取得"}</td><td><span className={`nfc-compare-status is-${key.status}`}>{statusLabels[key.status]}</span></td></tr>)}</tbody>
              </table>{!visibleKeys.length && <p className="nfc-compare-empty">当前显示范围内没有密钥项目。</p>}</div>
            </details>}
          </section>}
        </>
      )}
    </div>
  );
}
