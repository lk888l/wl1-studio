import { Check, Folder, LayoutDashboard, Monitor, Palette, RotateCcw, Sparkles, WandSparkles } from "lucide-react";
import { useRef, useState } from "react";

import { isTauriRuntime } from "../../lib/device";
import { pcMonitorGateway, usePcMonitor, type DesktopPreferences } from "../../lib/pc-monitor";
import { defaultPersonalization } from "../../lib/storage";
import { useUserStorageStatus } from "../../lib/user-storage";
import type { PersonalizationSettings } from "../../types";
import { LiquidGlass } from "../LiquidGlass";

interface PersonalizationPageProps {
  settings: PersonalizationSettings;
  persisted: boolean;
  onChange: (settings: PersonalizationSettings) => void;
}

const accents: Array<{ id: PersonalizationSettings["accent"]; label: string; colors: string[] }> = [
  { id: "azure", label: "极光蓝", colors: ["#5f7cff", "#48b7ff"] },
  { id: "violet", label: "星云紫", colors: ["#8a6cff", "#c46cff"] },
  { id: "coral", label: "珊瑚橙", colors: ["#ff7163", "#ffad59"] },
  { id: "mint", label: "薄荷青", colors: ["#19ae9b", "#71d6ba"] },
];

export function PersonalizationPage({ settings, persisted, onChange }: PersonalizationPageProps) {
  const snapshot = usePcMonitor();
  const storage = useUserStorageStatus();
  const [savingClose, setSavingClose] = useState(false);
  const [closeError, setCloseError] = useState("");
  const saving = useRef(false);
  const desktop = snapshot.desktop;
  const tauri = isTauriRuntime();
  const update = <Key extends keyof PersonalizationSettings>(key: Key, value: PersonalizationSettings[Key]): void => {
    onChange({ ...settings, [key]: value });
  };
  async function updateCloseBehavior(closeBehavior: DesktopPreferences["closeBehavior"]): Promise<void> {
    if (!desktop || saving.current) return;
    saving.current = true; setSavingClose(true); setCloseError("");
    try { await pcMonitorGateway.savePreferences({ ...desktop.preferences, closeBehavior }); }
    catch (reason) {
      setCloseError(reason instanceof Error ? reason.message : String(reason));
      await pcMonitorGateway.refresh().catch(() => undefined);
    } finally { saving.current = false; setSavingClose(false); }
  }
  const fullySaved = persisted && !storage.saving && !storage.warning && !savingClose && !closeError;

  return (
    <div className="page-stack personalization-page">
      <section className="page-heading">
        <div><h1>个性设置</h1><p>统一设置首页与各产品工作台的界面偏好，配置自动保存在本机。</p></div>
        <button className="secondary-button" type="button" disabled={savingClose || (tauri && !desktop)} onClick={() => {
          onChange(defaultPersonalization);
          if (desktop && desktop.preferences.closeBehavior !== "tray") void updateCloseBehavior("tray");
        }}><RotateCcw size={16} />恢复默认</button>
      </section>

      <div className="personalization-grid">
        <LiquidGlass as="section" variant="panel" className="settings-card glass-card desktop-settings-card">
          <div className="settings-card__head"><span className="settings-icon"><Monitor size={21} /></span><div><small>APPLICATION</small><h2>窗口与本地配置</h2></div></div>
          <fieldset className="radio-stack" disabled={!tauri || !desktop || savingClose}><legend>关闭窗口时</legend>
            <label><input type="radio" name="close-behavior" checked={(desktop?.preferences.closeBehavior ?? "tray") === "tray"} disabled={desktop?.trayAvailable === false} onChange={() => { void updateCloseBehavior("tray"); }} /><span><strong>最小化到托盘</strong><small>释放界面和其他产品连接，保留电脑监控；从托盘恢复。</small></span></label>
            <label><input type="radio" name="close-behavior" checked={desktop?.preferences.closeBehavior === "exit"} onChange={() => { void updateCloseBehavior("exit"); }} /><span><strong>全部退出</strong><small>结束界面、托盘和后台采集与传输。</small></span></label>
          </fieldset>
          <p className="desktop-settings-note">{!tauri ? "窗口关闭设置需要桌面应用；浏览器预览使用浏览器存储。" : !desktop ? "正在读取窗口设置…" : !desktop.trayAvailable ? "系统托盘不可用，关闭窗口会完整退出。" : savingClose ? "正在保存关闭选择…" : "选择自动记忆，重启后仍然生效。轻量后台按钮和托盘退出入口始终可用。"}</p>
          <div className="storage-directory"><Folder size={16} /><div><strong>{tauri ? "配置目录" : "浏览器本地存储"}</strong>{storage.directory && <code>{storage.directory}</code>}<small>{tauri ? "复制程序时同时复制 .local 文件夹，即可携带全部已保存配置与工程。" : "浏览器预览不读写程序旁的文件。"}</small></div></div>
          {(closeError || snapshot.lastError || desktop?.warning || storage.warning) && <p className="desktop-settings-error" role="alert">{closeError || snapshot.lastError || desktop?.warning || storage.warning}</p>}
        </LiquidGlass>

        <LiquidGlass as="section" variant="panel" className="settings-card glass-card">
          <div className="settings-card__head"><span className="settings-icon"><WandSparkles size={21} /></span><div><small>IDENTITY</small><h2>WL1 机器人身份</h2></div><span className="local-only">仅本机</span></div>
          <label className="form-field"><span>显示名称</span><input value={settings.robotName} maxLength={28} onChange={(event) => update("robotName", event.target.value)} /></label>
          <div className="identity-preview"><span className="identity-avatar">W1</span><div><small>CONNECTED ROBOT</small><strong>{settings.robotName || "未命名 WL1"}</strong><p>Legacy ASCII · Device ID reserved</p></div></div>
        </LiquidGlass>

        <LiquidGlass as="section" variant="panel" className="settings-card glass-card">
          <div className="settings-card__head"><span className="settings-icon"><Palette size={21} /></span><div><small>APPEARANCE</small><h2>主题强调色</h2></div></div>
          <div className="accent-options">
            {accents.map((accent) => (
              <button key={accent.id} className={settings.accent === accent.id ? "is-active" : ""} type="button" onClick={() => update("accent", accent.id)}>
                <span style={{ background: `linear-gradient(135deg, ${accent.colors[0]}, ${accent.colors[1]})` }}>{settings.accent === accent.id && <Check size={16} />}</span><strong>{accent.label}</strong>
              </button>
            ))}
          </div>
          <label className="form-field color-field"><span>机身灯光预览</span><input type="color" value={settings.ledColor} onChange={(event) => update("ledColor", event.target.value)} /><code>{settings.ledColor.toUpperCase()}</code><em>固件接口预留</em></label>
        </LiquidGlass>

        <section className="settings-card glass-card">
          <div className="settings-card__head"><span className="settings-icon"><Sparkles size={21} /></span><div><small>GLASS SURFACE</small><h2>液态玻璃</h2></div></div>
          <div className="choice-row">
            {(["soft", "balanced", "clear"] as const).map((strength) => (
              <button key={strength} type="button" aria-pressed={settings.glassStrength === strength} className={settings.glassStrength === strength ? "is-active" : ""} onClick={() => update("glassStrength", strength)}><i /><strong>{{ soft: "柔和", balanced: "平衡", clear: "通透" }[strength]}</strong></button>
            ))}
          </div>
          <div className="glass-material-preview" role="img" aria-label="玻璃材质预览">
            <LiquidGlass className="glass-material-preview__surface glass-panel">
              <strong>Liquid Glass</strong>
              <span>透过玻璃，看到界面的色彩与层次</span>
            </LiquidGlass>
          </div>
          <label className="switch-row"><span><strong>减少动态效果</strong><small>同时尊重系统 prefers-reduced-motion。</small></span><input type="checkbox" checked={settings.reducedMotion} onChange={(event) => update("reducedMotion", event.target.checked)} /><i /></label>
        </section>

        <LiquidGlass as="section" variant="panel" className="settings-card glass-card">
          <div className="settings-card__head"><span className="settings-icon"><LayoutDashboard size={21} /></span><div><small>WORKSPACE</small><h2>WL1 工作台偏好</h2></div></div>
          <label className="switch-row"><span><strong>紧凑遥测窗口</strong><small>总览只绘制最近 90 帧，降低低端设备负载。</small></span><input type="checkbox" checked={settings.compactTelemetry} onChange={(event) => update("compactTelemetry", event.target.checked)} /><i /></label>
          <fieldset className="radio-stack"><legend>开机姿态偏好 <em>接口预留</em></legend>
            {(["balanced", "low", "last"] as const).map((pose) => <label key={pose}><input type="radio" name="boot-pose" checked={settings.bootPose === pose} onChange={() => update("bootPose", pose)} /><span><strong>{{ balanced: "平衡姿态", low: "低位姿态", last: "恢复上次" }[pose]}</strong><small>{{ balanced: "上位机默认参考，不代表机械安全值", low: "预留搬运与检修姿态", last: "需要未来固件持久化" }[pose]}</small></span></label>)}
          </fieldset>
        </LiquidGlass>
      </div>

      <LiquidGlass as="section" variant="panel" className="settings-footer glass-card"><Sparkles size={19} /><div><strong>{storage.saving || savingClose ? "正在保存设置…" : fullySaved ? "设置会即时生效并自动保存" : "设置已生效，部分修改尚未保存"}</strong><p>主题与动态效果应用于整个软件；机器人名称、灯光预览和工作台偏好用于 WL1。</p></div><span className={`soft-badge${fullySaved ? " is-success" : ""}`}>{storage.saving || savingClose ? "保存中" : fullySaved ? "已保存到本机" : "仅当前会话"}</span></LiquidGlass>
    </div>
  );
}
