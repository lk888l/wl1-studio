import { Cpu, RadioTower, RotateCw, Save } from "lucide-react";

import { isRemoteConnection } from "../../lib/connection";
import type { ConnectionSnapshot } from "../../types";

interface AutoLegStatus {
  enabled: boolean;
  active: boolean;
}

interface RobotFeaturesPanelProps {
  connection: ConnectionSnapshot;
  chipUid: string | null;
  autoLeg: AutoLegStatus | null;
  busy: "uid" | "autoleg" | null;
  notice: string | null;
  disabled?: boolean;
  saving: boolean;
  saveUnavailableReason: string | null;
  onSaveToFlash: () => void;
  onReadUid: () => void;
  onReadAutoLeg: () => void;
  onSetAutoLeg: (enabled: boolean) => void;
}

export function RobotFeaturesPanel({
  connection,
  chipUid,
  autoLeg,
  busy,
  notice,
  disabled = false,
  saving,
  saveUnavailableReason,
  onSaveToFlash,
  onReadUid,
  onReadAutoLeg,
  onSetAutoLeg,
}: RobotFeaturesPanelProps) {
  const connected = connection.mode !== "disconnected";
  const remote = isRemoteConnection(connection);
  const canRead = connected && !remote && busy === null && !disabled;
  const canWrite = connected && connection.writesUnlocked && busy === null && !disabled;

  return (
    <section className="workbench-features glass-card" aria-label="小车设备信息与自适应腿高">
      <div className="workbench-features__heading">
        <div><span className="section-kicker">DEVICE FEATURES</span><h2>设备信息与自适应腿高</h2></div>
        <span className="soft-badge">{remote ? "遥控器单向链路" : "小车固件命令"}</span>
      </div>
      <div className="workbench-features__grid">
        <div className="workbench-feature">
          <div className="workbench-feature__title"><Cpu size={19} /><strong>芯片唯一序列号</strong></div>
          <code className="workbench-feature__uid">{chipUid ?? "尚未读取"}</code>
          <p>读取 STM32 的 96 位 UID，用于识别当前小车主控芯片。</p>
          <button className="secondary-button" type="button" disabled={!canRead} onClick={onReadUid}>
            <RotateCw size={15} />{busy === "uid" ? "等待回执…" : "读取序列号"}
          </button>
          {remote && <small>遥控器桥接不回传 UID；请直连小车读取。</small>}
        </div>
        <div className="workbench-feature">
          <div className="workbench-feature__title"><RadioTower size={19} /><strong>横滚自适应腿高</strong></div>
          <div className="workbench-feature__state">
            <span>设置：<strong>{remote || !autoLeg ? "未知" : autoLeg.enabled ? "已开启" : "已关闭"}</strong></span>
            <span>回执时补偿：<strong>{remote || !autoLeg ? "未知" : autoLeg.active ? "运行中" : "未运行"}</strong></span>
          </div>
          <p>关闭后两腿同高；重新开启时会逐步恢复横滚补偿。</p>
          <div className="workbench-feature__actions">
            <button className="secondary-button" type="button" disabled={!canRead} onClick={onReadAutoLeg}>
              {busy === "autoleg" && !remote ? "等待回执…" : "查询状态"}
            </button>
            <button className="small-action" type="button" disabled={!canWrite} onClick={() => onSetAutoLeg(true)}>开启</button>
            <button className="small-action" type="button" disabled={!canWrite} onClick={() => onSetAutoLeg(false)}>关闭</button>
            <button className="text-button workbench-save" type="button" disabled={!canWrite || Boolean(saveUnavailableReason)} title={saveUnavailableReason ?? "保存设备当前全部运动参数，包括自适应腿高开关"} onClick={onSaveToFlash}><Save size={14} />{saving ? "等待保存回执…" : "保存到 Flash"}</button>
          </div>
          <small>{remote ? "无线发送后无法确认小车执行状态。" : "开关立即修改 RAM；点击“保存到 Flash”会连同设备当前全部运动参数一起保存。"}</small>
        </div>
      </div>
      {notice && <div className="inline-notice" role="status">{notice}</div>}
    </section>
  );
}
