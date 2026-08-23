import { AlertTriangle, Check, CloudUpload, FolderOpen, RotateCcw, Save, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";

import {
  formatParameterValue,
  parameterDefinitions,
  parameterGroups,
} from "../../data/parameters";
import type {
  ParameterDefinition,
  ParameterGroupId,
  ParameterProfile,
  ParameterValues,
} from "../../types";

const differs = (left: number | undefined, right: number | undefined): boolean =>
  left === undefined || right === undefined || Math.abs(left - right) > 1e-9;

interface TuningPageProps {
  connected: boolean;
  writesUnlocked: boolean;
  draft: ParameterValues;
  applied: Partial<ParameterValues>;
  requestedIds: readonly string[];
  profiles: readonly ParameterProfile[];
  sending: boolean;
  notice: string | null;
  onChange: (id: string, value: number) => void;
  onSendOne: (id: string) => void;
  onSendMany: (ids: string[]) => void;
  onRestoreAuto: (id: string) => void;
  onLoadProfile: (profile: ParameterProfile) => void;
  onSaveProfile: (name: string, description: string) => void;
  onDeleteProfile: (id: string) => void;
  onResetDraft: () => void;
}

function supportLabel(definition: ParameterDefinition): string {
  if (definition.support === "supported") return "固件支持";
  if (definition.support === "derived") return "版本相关";
  return "接口预留";
}

const bulkEligible = (definition: ParameterDefinition | undefined): boolean =>
  definition?.support === "supported" && definition.id !== "legHeight";

export function TuningPage({
  connected,
  writesUnlocked,
  draft,
  applied,
  requestedIds,
  profiles,
  sending,
  notice,
  onChange,
  onSendOne,
  onSendMany,
  onRestoreAuto,
  onLoadProfile,
  onSaveProfile,
  onDeleteProfile,
  onResetDraft,
}: TuningPageProps) {
  const [group, setGroup] = useState<ParameterGroupId>("attitude");
  const [profileName, setProfileName] = useState("");
  const pendingIds = useMemo(
    () => parameterDefinitions.filter((item) => differs(draft[item.id], applied[item.id])).map((item) => item.id),
    [applied, draft],
  );
  const visible = parameterDefinitions.filter((item) => item.group === group);
  const sendablePending = pendingIds.filter((id) => bulkEligible(parameterDefinitions.find((item) => item.id === id)));
  const groupPending = visible.filter((item) => pendingIds.includes(item.id) && bulkEligible(item)).map((item) => item.id);

  return (
    <div className="page-stack">
      <section className="page-heading">
        <div><span className="section-kicker">CONTROL LOOPS</span><h1>参数调校</h1><p>草稿先与本机会话基线比较，再逐项或按组请求下发。Legacy 固件没有读回与 ACK；“本次已请求”不是设备当前值。</p></div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" disabled={sending} onClick={onResetDraft}><RotateCcw size={16} />重置草稿</button>
          <button className="primary-button" type="button" disabled={!writesUnlocked || sending || sendablePending.length === 0} onClick={() => onSendMany(sendablePending)}><CloudUpload size={17} />下发待请求项 <b>{sendablePending.length}</b></button>
        </div>
      </section>

      {connected && !writesUnlocked && <div className="readonly-banner"><AlertTriangle size={18} /><div><strong>当前为只读连接</strong><span>重新连接并完成协议兼容性与三项现场安全确认（共四项）后，才可下发参数；本地编辑与档案仍可使用。</span></div></div>}

      <div className="tuning-layout">
        <aside className="tuning-sidebar glass-card">
          <div className="tuning-sidebar__head"><span>控制分组</span><b>{sendablePending.length} 项待请求</b></div>
          <div className="group-tabs">
            {parameterGroups.map((item) => {
              const count = parameterDefinitions.filter((definition) => definition.group === item.id && pendingIds.includes(definition.id) && bulkEligible(definition)).length;
              return <button key={item.id} type="button" className={group === item.id ? "is-active" : ""} onClick={() => setGroup(item.id)}><span><strong>{item.label}</strong><small>{item.description}</small></span>{count > 0 && <em>{count}</em>}</button>;
            })}
          </div>
          <div className="capability-note"><AlertTriangle size={18} /><p><strong>兼容与范围提示</strong>滑块范围是上位机保守边界，不是固件认证安全范围；重连后设备值一律未知。Angle Kp / bias 具有版本相关的自动计算语义，腿高会直接驱动机构，三者都不进入普通批量，只能逐项明确请求。</p></div>
        </aside>

        <main className="tuning-main">
          <div className="section-title-row"><div><span className="section-kicker">{group.toUpperCase()}</span><h2>{parameterGroups.find((item) => item.id === group)?.label}</h2></div><button className="text-button" type="button" disabled={!writesUnlocked || sending || groupPending.length === 0} onClick={() => onSendMany(groupPending)}>下发本组 {groupPending.length || ""}</button></div>
          {notice && <div className="inline-notice"><Check size={17} />{notice}</div>}
          <div className="parameter-list">
            {visible.map((definition) => {
              const value = draft[definition.id] ?? definition.defaultValue;
              const pending = pendingIds.includes(definition.id);
              const unknown = applied[definition.id] === undefined;
              const dirty = !unknown && pending;
              return (
                <article className={`parameter-card glass-card${pending ? " is-dirty" : ""}${definition.support === "derived" ? " is-warning" : ""}`} key={definition.id}>
                  <div className="parameter-meta">
                    <div className="parameter-title"><span className={`support-badge is-${definition.support}`}>{supportLabel(definition)}</span><span className="dirty-badge">{unknown ? "设备值未知" : dirty ? "草稿变更" : requestedIds.includes(definition.id) ? "本次已请求" : "请求状态未知"}</span></div>
                    <h3>{definition.label}<small>{definition.symbol}</small></h3>
                    <p>{definition.description}</p>
                    {definition.warning && <div className="parameter-warning"><AlertTriangle size={14} />{definition.warning}</div>}
                    {definition.support === "derived" && <button className="text-button" type="button" disabled={!writesUnlocked || sending} onClick={() => onRestoreAuto(definition.id)}>请求恢复固件自动计算</button>}
                  </div>
                  <div className="parameter-control">
                    <div className="parameter-value-row">
                      <label><input aria-label={`${definition.label}数值`} type="number" min={definition.min} max={definition.max} step={definition.step} value={value} onChange={(event) => onChange(definition.id, Number(event.target.value))} /><span>{definition.unit ?? ""}</span></label>
                      <button className="small-action" type="button" disabled={!writesUnlocked || sending || !pending || definition.support === "reserved"} onClick={() => onSendOne(definition.id)}>{definition.support === "reserved" ? "仅存档" : unknown ? "明确下发" : "下发"}</button>
                    </div>
                    <input className="parameter-range" aria-label={`${definition.label}滑块`} type="range" min={definition.min} max={definition.max} step={definition.step} value={value} onChange={(event) => onChange(definition.id, Number(event.target.value))} />
                    <div className="range-labels"><span>{formatParameterValue(definition, definition.min)}</span><em>当前 {formatParameterValue(definition, value)}{definition.unit ?? ""}</em><span>{formatParameterValue(definition, definition.max)}</span></div>
                  </div>
                </article>
              );
            })}
          </div>
        </main>
      </div>

      <section className="profiles-section glass-card">
        <div className="section-title-row"><div><span className="section-kicker">LOCAL PROFILES</span><h2>本地参数档案</h2><p>档案包含已支持与预留参数，但不会自动写入机器人 Flash。</p></div><div className="profile-save"><input value={profileName} maxLength={24} placeholder="新档案名称" onChange={(event) => setProfileName(event.target.value)} /><button className="secondary-button" type="button" disabled={!profileName.trim()} onClick={() => { onSaveProfile(profileName.trim(), `基于 ${parameterGroups.find((item) => item.id === group)?.label} 草稿`); setProfileName(""); }}><Save size={16} />保存草稿</button></div></div>
        <div className="profile-grid">
          {profiles.map((profile) => (
            <article className="profile-card" key={profile.id}>
              <div className="profile-icon"><FolderOpen size={19} /></div><div><small>{profile.builtIn ? "内置基线" : new Date(profile.updatedAt).toLocaleDateString("zh-CN")}</small><strong>{profile.name}</strong><p>{profile.description}</p></div>
              <button className="text-button" type="button" onClick={() => onLoadProfile(profile)}>载入</button>
              {!profile.builtIn && <button className="icon-button icon-button--danger" type="button" aria-label={`删除${profile.name}`} onClick={() => onDeleteProfile(profile.id)}><Trash2 size={16} /></button>}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
