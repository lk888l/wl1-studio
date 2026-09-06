import {
  Activity,
  ArrowLeft,
  ArrowRight,
  Check,
  CircleDot,
  Gauge,
  Info,
  Ruler,
  Save,
  ShieldCheck,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { CalibrationDraft, TelemetrySample } from "../../types";

interface CalibrationPageProps {
  connected: boolean;
  writesUnlocked: boolean;
  samples: readonly TelemetrySample[];
  onSendText: (command: string) => Promise<void>;
}

const STORAGE_KEY = "wl1-studio.calibration.v1";

const defaultDraft: CalibrationDraft = {
  imuRollBias: 0,
  imuPitchBias: 0,
  imuYawBias: 0,
  angleBias: 12.6,
  legHeight: 44.5,
};

const stepItems = [
  { label: "安全准备", icon: ShieldCheck },
  { label: "IMU 采样", icon: Activity },
  { label: "姿态零点", icon: CircleDot },
  { label: "腿高基准", icon: Ruler },
  { label: "生成记录", icon: Save },
];

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function circularAverageDegrees(values: number[]): number {
  if (values.length === 0) return 0;
  const radians = values.map((value) => value * Math.PI / 180);
  const sine = average(radians.map(Math.sin));
  const cosine = average(radians.map(Math.cos));
  return Math.atan2(sine, cosine) * 180 / Math.PI;
}

function finiteInRange(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max
    ? value
    : fallback;
}

function loadCalibrationDraft(): CalibrationDraft {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { ...defaultDraft };
    const value = parsed as Record<string, unknown>;
    return {
      imuRollBias: finiteInRange(value.imuRollBias, defaultDraft.imuRollBias, -180, 180),
      imuPitchBias: finiteInRange(value.imuPitchBias, defaultDraft.imuPitchBias, -180, 180),
      imuYawBias: finiteInRange(value.imuYawBias, defaultDraft.imuYawBias, -360, 360),
      angleBias: finiteInRange(value.angleBias, defaultDraft.angleBias, -20, 20),
      legHeight: finiteInRange(value.legHeight, defaultDraft.legHeight, 44.5, 78.5),
      updatedAt: typeof value.updatedAt === "number" && Number.isFinite(value.updatedAt) && value.updatedAt >= 0
        ? value.updatedAt
        : undefined,
    };
  } catch {
    return { ...defaultDraft };
  }
}

export function CalibrationPage({ connected, writesUnlocked, samples, onSendText }: CalibrationPageProps) {
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<CalibrationDraft>(loadCalibrationDraft);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const latest = samples.at(-1);
  const sampleWindow = useMemo(() => {
    const seen = new Set<number>();
    const unique: TelemetrySample[] = [];
    for (let index = samples.length - 1; index >= 0 && unique.length < 60; index -= 1) {
      const sample = samples[index];
      if (!sample || sample.imuTimestamp === undefined || seen.has(sample.imuTimestamp)) continue;
      seen.add(sample.imuTimestamp);
      unique.push(sample);
    }
    return unique.reverse();
  }, [samples]);

  const collectImu = (): void => {
    if (sampleWindow.length < 10) {
      setNotice("样本不足：请连接设备并至少等待 0.5 秒。");
      return;
    }
    setDraft((current) => ({
      ...current,
      imuRollBias: -average(sampleWindow.map((item) => item.roll)),
      imuPitchBias: -average(sampleWindow.map((item) => item.pitch)),
      imuYawBias: -circularAverageDegrees(sampleWindow.map((item) => item.yaw)),
    }));
    setNotice(`已从最近 ${sampleWindow.length} 帧计算本地偏置；当前固件尚无持久写入入口。`);
  };

  const requestCommand = async (command: string): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      await onSendText(command);
      setNotice("写入请求已发送。Legacy 固件没有 ACK 或读回，请观察姿态与机构变化。");
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  const finish = (): void => {
    const saved = { ...draft, updatedAt: Date.now() };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
      setDraft(saved);
      setNotice("标定记录已保存在本机。固件重启后仍需重新下发可写项。");
    } catch {
      setNotice("无法写入本机存储；当前标定草稿仍保留在页面内存中。");
    }
  };

  return (
    <div className="page-stack calibration-page">
      <section className="page-heading">
        <div><h1>标定向导</h1><p>按步骤完成姿态、腿高与本地记录标定；设备写入会单独标识。</p></div>
        <span className="soft-badge">步骤 {step + 1} / {stepItems.length}</span>
      </section>

      <section className="wizard-shell glass-card liquid-card">
        <aside className="wizard-progress">
          {stepItems.map((item, index) => {
            const Icon = item.icon;
            return (
              <button type="button" key={item.label} className={(index === step ? "is-active" : "") + (index < step ? " is-done" : "")} onClick={() => index <= step && setStep(index)}>
                <span>{index < step ? <Check size={17} /> : <Icon size={17} />}</span>
                <div><small>STEP 0{index + 1}</small><strong>{item.label}</strong></div>
              </button>
            );
          })}
        </aside>

        <main className="wizard-content">
          {step === 0 && (
            <div className="wizard-step">
              <span className="wizard-icon"><ShieldCheck size={30} /></span>
              <div className="wizard-heading"><small>BEFORE YOU START</small><h2>把安全条件准备好</h2><p>标定可能改变姿态零点和腿高。当前工作树虽有 250 ms R 超时归零，但没有可协商的通用 arm/disarm 或急停；HEAD 基线也没有该超时保护。</p></div>
              <div className="checklist">
                <label><input type="checkbox" /><span><strong>车轮已架空</strong><small>确保突发输出不会驱动车体移动。</small></span></label>
                <label><input type="checkbox" /><span><strong>物理断电可触达</strong><small>软件停止无法替代电源急停。</small></span></label>
                <label><input type="checkbox" /><span><strong>机身处于静止状态</strong><small>IMU 采样期间不要触碰机器人。</small></span></label>
              </div>
              <div className="capability-strip"><Info size={18} /><p>本向导不会宣称“标定已写入 Flash”。当前固件在线参数都在 RAM 中，重启后丢失。</p></div>
            </div>
          )}

          {step === 1 && (
            <div className="wizard-step">
              <span className="wizard-icon"><Activity size={30} /></span>
              <div className="wizard-heading"><small>IMU SAMPLE</small><h2>采集静态姿态偏置</h2><p>从最近 60 帧计算 Roll / Pitch / Yaw 均值的相反数，结果先保存在上位机。</p></div>
              <div className="calibration-reading-grid">
                <div><span>实时 Roll</span><strong>{latest?.roll.toFixed(3) ?? "--"}°</strong><em>补偿 {draft.imuRollBias.toFixed(3)}°</em></div>
                <div><span>实时 Pitch</span><strong>{latest?.pitch.toFixed(3) ?? "--"}°</strong><em>补偿 {draft.imuPitchBias.toFixed(3)}°</em></div>
                <div><span>实时 Yaw</span><strong>{latest?.yaw.toFixed(3) ?? "--"}°</strong><em>补偿 {draft.imuYawBias.toFixed(3)}°</em></div>
              </div>
              <button className="primary-button" type="button" disabled={!connected} onClick={collectImu}><Gauge size={17} />采集最近 {sampleWindow.length} 帧</button>
            </div>
          )}

          {step === 2 && (
            <div className="wizard-step">
              <span className="wizard-icon"><CircleDot size={30} /></span>
              <div className="wizard-heading"><small>ATTITUDE ZERO</small><h2>调整俯仰静态偏置</h2><p>调整机身俯仰基准。这里保留上位机参考值 12.6°；日常重心与腿高调节可直接在运动工作台完成。</p></div>
              <label className="calibration-slider"><span><strong>Angle bias</strong><output>{draft.angleBias.toFixed(1)}°</output></span><input type="range" min="-20" max="20" step="0.1" value={draft.angleBias} onChange={(event) => setDraft((current) => ({ ...current, angleBias: Number(event.target.value) }))} /></label>
              <div className="command-preview"><span>请求命令</span><code>anglebias {draft.angleBias.toFixed(1)}</code></div>
              <div className="parameter-warning"><Info size={15} />参考固件将本项用于最低腿高的俯仰基准，并随腿高补偿；手动覆盖与 auto 命令仅适用于对应扩展固件。</div>
              <div className="heading-actions"><button className="secondary-button" type="button" disabled={!writesUnlocked || busy} onClick={() => void requestCommand(`anglebias ${draft.angleBias.toFixed(1)}`)}>请求手动覆盖</button><button className="text-button" type="button" disabled={!writesUnlocked || busy} onClick={() => void requestCommand("anglebias auto")}>恢复自动计算</button></div>
            </div>
          )}

          {step === 3 && (
            <div className="wizard-step">
              <span className="wizard-icon"><Ruler size={30} /></span>
              <div className="wizard-heading"><small>LEG REFERENCE</small><h2>设置共同腿高基准</h2><p>WL1 固件当前将腿高目标钳位到 44.5–78.5 mm。停止帧只会保留当前目标高度，这一范围不代表经过实机认证的机械安全边界。</p></div>
              <label className="calibration-slider"><span><strong>目标轮心高度</strong><output>{draft.legHeight.toFixed(1)} mm</output></span><input type="range" min="44.5" max="78.5" step="0.1" value={draft.legHeight} onChange={(event) => setDraft((current) => ({ ...current, legHeight: Number(event.target.value) }))} /></label>
              <div className="height-scale"><span>LOW · 44.5</span><i style={{ width: `${((draft.legHeight - 44.5) / 34) * 100}%` }} /><span>HIGH · 78.5</span></div>
              <button className="secondary-button" type="button" disabled={!writesUnlocked || busy} onClick={() => void requestCommand(`legheight ${draft.legHeight.toFixed(1)}`)}>请求应用腿高</button>
            </div>
          )}

          {step === 4 && (
            <div className="wizard-step wizard-step--complete">
              <span className="wizard-icon is-complete"><Check size={32} /></span>
              <div className="wizard-heading"><small>LOCAL RECORD</small><h2>生成本地标定记录</h2><p>记录可用于后续固件加入 CALIBRATION_GET / COMMIT 接口时迁移，不代表设备端持久化。</p></div>
              <dl className="calibration-summary">
                <div><dt>IMU Roll / Pitch</dt><dd>{draft.imuRollBias.toFixed(3)}° / {draft.imuPitchBias.toFixed(3)}°</dd></div>
                <div><dt>Angle bias</dt><dd>{draft.angleBias.toFixed(1)}°</dd></div>
                <div><dt>共同腿高</dt><dd>{draft.legHeight.toFixed(1)} mm</dd></div>
                <div><dt>持久化状态</dt><dd className="text-warning">仅上位机本地</dd></div>
              </dl>
              <button className="primary-button" type="button" onClick={finish}><Save size={17} />保存本地标定记录</button>
            </div>
          )}

          {notice && <div className="inline-notice"><Info size={16} />{notice}</div>}
          <footer className="wizard-actions">
            <button className="secondary-button" type="button" disabled={step === 0 || busy} onClick={() => setStep((value) => value - 1)}><ArrowLeft size={16} />上一步</button>
            {step < stepItems.length - 1 && <button className="primary-button" type="button" disabled={busy} onClick={() => setStep((value) => value + 1)}>下一步<ArrowRight size={16} /></button>}
          </footer>
        </main>
      </section>
    </div>
  );
}
