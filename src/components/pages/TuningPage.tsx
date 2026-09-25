import { CloudUpload, FolderOpen, Info, RotateCcw, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { formatParameterValue, parameterDefinitions, parameterGroups } from "../../data/parameters";
import type { ParameterDefinition, ParameterProfile, ParameterValues } from "../../types";
import "./TuningPage.css";

const bodyParameterIds = ["angleBias", "rollBias", "legHeight"];

interface TuningPageProps {
  connected: boolean;
  remote?: boolean;
  writesUnlocked: boolean;
  draft: ParameterValues;
  applied: Partial<ParameterValues>;
  requestedIds: readonly string[];
  profiles: readonly ParameterProfile[];
  sending: boolean;
  saving: boolean;
  saveUnavailableReason: string | null;
  saveNotice: string | null;
  notice: string | null;
  controlPanel?: ReactNode;
  telemetryPanel?: ReactNode;
  featurePanel?: ReactNode;
  onChange: (id: string, value: number) => void;
  onSendOne: (id: string) => void;
  onSendMany: (ids: string[]) => void;
  onSaveToFlash: () => void;
  onRestoreAuto: (id: string) => void;
  onLoadProfile: (profile: ParameterProfile) => void;
  onSaveProfile: (name: string, description: string) => void;
  onDeleteProfile: (id: string) => void;
  onResetDraft: () => void;
}

interface ParameterRowProps {
  definition: ParameterDefinition;
  value: number;
  previous?: number;
  requested: boolean;
  sending: boolean;
  unavailable: boolean;
  onChange: (id: string, value: number) => void;
  onSend: (id: string) => void;
  onAuto: (id: string) => void;
  onValidity: (id: string, valid: boolean) => void;
}

function ParameterRow({ definition, value, previous, requested, sending, unavailable, onChange, onSend, onAuto, onValidity }: ParameterRowProps) {
  // Keep unfinished input (a minus sign, decimal point, or empty field) editable.
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const numeric = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(numeric) && numeric >= definition.min && numeric <= definition.max;
  useEffect(() => onValidity(definition.id, valid), [definition.id, onValidity, valid]);
  const pending = previous === undefined || Math.abs(value - previous) > 1e-9;
  const localOnly = definition.support === "reserved";
  const label = definition.id === "angleBias" ? "机身重心 / 俯仰偏置" : definition.label;
  const update = (next: string): void => {
    setText(next);
    const number = Number(next);
    if (next.trim() !== "" && Number.isFinite(number) && number >= definition.min && number <= definition.max) {
      onChange(definition.id, number);
    }
  };

  return (
    <div className={`workbench-parameter${pending ? " is-pending" : ""}`}>
      <div className="workbench-parameter__label">
        <label htmlFor={`parameter-${definition.id}`} title={definition.description}>{label}</label>
        <span>{definition.symbol}</span>
        <small title={previous === undefined ? "上位机尚未读取设备值，显示的是本地草稿" : `最近请求 ${formatParameterValue(definition, previous)}${definition.unit ?? ""}`}>
          {localOnly ? "仅本地" : previous === undefined ? "未下发" : pending ? "已修改" : requested ? "已请求" : "未确认"}
        </small>
      </div>
      <div className="workbench-parameter__editor">
        <div className="workbench-number">
          <input id={`parameter-${definition.id}`} aria-label={`${label}数值`} type="number" min={definition.min} max={definition.max} step={definition.step} value={text} disabled={sending} aria-invalid={!valid} onChange={(event) => update(event.target.value)} onBlur={() => { if (valid) setText(String(numeric)); }} />
          {definition.unit && <span>{definition.unit}</span>}
        </div>
        <button className="small-action" type="button" disabled={unavailable || sending || localOnly || !valid} onClick={() => onSend(definition.id)}>{localOnly ? "仅本地" : "下发"}</button>
      </div>
      <div className="workbench-parameter__range">
        <input aria-label={`${label}滑块`} type="range" min={definition.min} max={definition.max} step={definition.step} value={value} disabled={sending} onChange={(event) => update(event.target.value)} />
        <span>{definition.min} — {definition.max}{definition.unit ?? ""}</span>
      </div>
      {!valid && <small className="workbench-input-error" role="alert">请输入 {definition.min} 至 {definition.max} 之间的数值</small>}
      {definition.support === "derived" && <div className="workbench-auto"><button className="text-button" type="button" disabled={unavailable || sending} onClick={() => onAuto(definition.id)}>恢复自动</button><span>自动 / 手动切换取决于固件版本</span></div>}
    </div>
  );
}

export function TuningPage({ connected, remote = false, writesUnlocked, draft, applied, requestedIds, profiles, sending, saving, saveUnavailableReason, saveNotice, notice, controlPanel, telemetryPanel, featurePanel, onChange, onSendOne, onSendMany, onSaveToFlash, onRestoreAuto, onLoadProfile, onSaveProfile, onDeleteProfile, onResetDraft }: TuningPageProps) {
  const [editRevision, setEditRevision] = useState(0);
  const [profileName, setProfileName] = useState("");
  const [invalidIds, setInvalidIds] = useState<string[]>([]);
  const onValidity = useCallback((id: string, valid: boolean): void => {
    setInvalidIds((current) => valid ? current.includes(id) ? current.filter((item) => item !== id) : current : current.includes(id) ? current : [...current, id]);
  }, []);
  const pidGroups = parameterGroups.filter((group) => group.id !== "geometry");
  const pendingPid = useMemo(() => parameterDefinitions.filter((item) => item.group !== "geometry" && item.support !== "reserved" && (applied[item.id] === undefined || Math.abs((draft[item.id] ?? item.defaultValue) - (applied[item.id] ?? 0)) > 1e-9)).map((item) => item.id), [applied, draft]);
  const row = (definition: ParameterDefinition): ReactNode => (
    <ParameterRow key={`${definition.id}-${editRevision}`} definition={definition} value={draft[definition.id] ?? definition.defaultValue} previous={applied[definition.id]} requested={requestedIds.includes(definition.id)} sending={sending} unavailable={!writesUnlocked || (remote && (definition.id === "legHeight" || definition.id === "rollBias"))} onChange={onChange} onSend={onSendOne} onAuto={onRestoreAuto} onValidity={onValidity} />
  );

  const saveButton = (label: string): ReactNode => (
    <button className="text-button workbench-save" type="button" aria-label={label + "：保存设备参数到 Flash"} disabled={sending || saving || Boolean(saveUnavailableReason)} title={saveUnavailableReason ?? "保存设备当前全部可持久化参数，不下发本地草稿"} onClick={onSaveToFlash}>
      <Save size={14} />{saving ? "等待保存回执…" : "保存到 Flash"}
    </button>
  );

  return (
    <div className="page-stack motion-workbench">
      <section className="page-heading">
        <div><span className="section-kicker">MOTION WORKBENCH</span><h1>运动工作台</h1><p>重心、腿高、PID 与方向控制，就在这一页。</p></div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" disabled={sending} onClick={() => { setInvalidIds([]); setEditRevision((value) => value + 1); onResetDraft(); }}><RotateCcw size={16} />重置草稿</button>
          <button className="primary-button" type="button" disabled={!writesUnlocked || sending || pendingPid.length === 0 || invalidIds.some((id) => parameterDefinitions.find((item) => item.id === id)?.group !== "geometry")} onClick={() => onSendMany(pendingPid)}><CloudUpload size={17} />{saving ? "正在保存…" : sending ? "处理中…" : "下发待更新 PID"}<b>{pendingPid.length}</b></button>
        </div>
      </section>
      {notice && <div className="inline-notice" role="status"><Info size={17} />{notice}</div>}
      {!connected && <div className="workbench-hint">在顶部选择设备并连接即可下发；离线也可以编辑参数、保存档案。</div>}
      {connected && !writesUnlocked && <div className="readonly-banner">当前连接为只读，可查看遥测、编辑草稿和保存档案。</div>}
      {remote && <div className="workbench-hint">遥控器模式可无线下发 PID、重心偏置与自适应腿高开关；运动和共同腿高使用实体摇杆，当前链路不回传遥测。</div>}
      {featurePanel}
      <div className="workbench-hint workbench-save-hint">
        <strong>保存到设备：</strong>先下发并确认调试效果，再点击任一组的“保存到 Flash”。固件会一起保存当前设备的 PID、机身偏置、自适应腿高角度中心、共同腿高、自动模式和自适应腿高开关；未下发的草稿与本地轮半径不会写入设备。
        {saveUnavailableReason && <span>{saveUnavailableReason}</span>}
      </div>
      {saveNotice && <div className="inline-notice" role="status"><Info size={17} />{saveNotice}</div>}

      <div className="workbench-layout">
        <div className="workbench-settings">
          <section className="workbench-group workbench-body glass-card" aria-label="机身重心与腿高">
            <div className="workbench-group__heading"><div><span className="section-kicker">BODY & BALANCE</span><h2>机身与重心</h2></div><div className="workbench-group__actions">{saveButton("机身与重心")}</div></div>
            <div className="workbench-body__parameters">
              {bodyParameterIds.map((id) => parameterDefinitions.find((item) => item.id === id)).filter((item): item is ParameterDefinition => Boolean(item)).map(row)}
            </div>
            <p className="workbench-footnote">角度中心是横滚零点偏置：原始横滚角 + 角度中心 = 补偿后横滚角。例如期望中点处原始角度为 +2.5°，则设置 −2.5°；下发后可随本组“保存到 Flash”一起保存。</p>
            {remote && <p className="workbench-footnote">共同腿高和角度中心仅可编辑本地草稿；请直连小车后下发。</p>}
          </section>
          <div className="workbench-pid-grid">
            {pidGroups.map((group) => {
              const definitions = parameterDefinitions.filter((item) => item.group === group.id);
              const pending = definitions.filter((item) => pendingPid.includes(item.id)).map((item) => item.id);
              return (
                <section className="workbench-group glass-card" key={group.id} aria-label={`${group.label} PID`}>
                  <div className="workbench-group__heading"><div><h2>{group.label}</h2><p>{group.description}</p></div><div className="workbench-group__actions"><button className="text-button" type="button" disabled={!writesUnlocked || sending || pending.length === 0 || definitions.some((item) => invalidIds.includes(item.id))} onClick={() => onSendMany(pending)}>下发本组</button>{saveButton(group.label)}</div></div>
                  {definitions.map(row)}
                </section>
              );
            })}
          </div>
          <p className="workbench-footnote">修改数值只更新草稿，点击“下发”才写入设备 RAM。“已请求”表示发送记录；只有收到固件保存成功回执，才表示设备已写入 Flash。保存依赖支持 save 的固件，不会自动重试。</p>
        </div>
        <aside className="workbench-live" aria-label="实时控制与反馈">{controlPanel}{telemetryPanel}</aside>
      </div>

      <details className="workbench-details glass-card">
        <summary><FolderOpen size={18} /><strong>参数档案与更多设置</strong><span>保存 / 载入 · 本地几何参数 · 参数说明</span></summary>
        <div className="workbench-details__content">
          <div className="section-title-row"><div><h2>本地参数档案</h2><p>载入只更新草稿，确认数值后再下发。</p></div><div className="profile-save"><input aria-label="新档案名称" value={profileName} maxLength={24} placeholder="新档案名称" disabled={sending} onChange={(event) => setProfileName(event.target.value)} /><button className="secondary-button" type="button" disabled={sending || invalidIds.length > 0 || !profileName.trim()} onClick={() => { onSaveProfile(profileName.trim(), "运动工作台参数草稿"); setProfileName(""); }}><Save size={16} />保存草稿</button></div></div>
          <div className="profile-grid">{profiles.map((profile) => <article className="profile-card" key={profile.id}><div className="profile-icon"><FolderOpen size={19} /></div><div><small>{profile.builtIn ? "内置参考" : new Date(profile.updatedAt).toLocaleDateString("zh-CN")}</small><strong>{profile.name}</strong><p>{profile.description}</p></div><button className="text-button" type="button" disabled={sending} onClick={() => { setInvalidIds([]); setEditRevision((value) => value + 1); onLoadProfile(profile); }}>载入</button>{!profile.builtIn && <button className="icon-button icon-button--danger" type="button" aria-label={`删除${profile.name}`} disabled={sending} onClick={() => onDeleteProfile(profile.id)}><Trash2 size={16} /></button>}</article>)}</div>
          <div className="workbench-local-parameters">{parameterDefinitions.filter((item) => item.group === "geometry" && !bodyParameterIds.includes(item.id)).map(row)}</div>
          <details className="workbench-parameter-help"><summary>查看参数用途与固件说明</summary><dl>{parameterDefinitions.filter((item) => item.support !== "reserved").map((item) => <div key={item.id}><dt>{item.label} · {item.symbol}</dt><dd>{item.description}{item.warning && ` ${item.warning}`}</dd></div>)}</dl></details>
        </div>
      </details>
    </div>
  );
}
