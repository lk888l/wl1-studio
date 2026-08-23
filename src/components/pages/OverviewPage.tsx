import {
  ArrowRight,
  Activity,
  Bolt,
  ChevronRight,
  RadioTower,
  RotateCw,
  ShieldCheck,
} from "lucide-react";

import type { ConnectionSnapshot, PageId, TelemetrySample } from "../../types";
import { LiveChart } from "../LiveChart";
import { RobotVisual } from "../RobotVisual";

interface OverviewPageProps {
  connection: ConnectionSnapshot;
  samples: readonly TelemetrySample[];
  imuFresh: boolean;
  rpmFresh: boolean;
  robotName: string;
  ledColor: string;
  compactTelemetry: boolean;
  onConnect: () => void;
  onNavigate: (page: PageId) => void;
}

export function OverviewPage({
  connection,
  samples,
  imuFresh,
  rpmFresh,
  robotName,
  ledColor,
  compactTelemetry,
  onConnect,
  onNavigate,
}: OverviewPageProps) {
  const latest = samples.at(-1);
  const latestImu = imuFresh ? latest : undefined;
  const latestRpm = rpmFresh ? latest : undefined;
  const connected = connection.mode !== "disconnected";
  const meanRpm = latestRpm ? (Math.abs(latestRpm.leftRpm) + Math.abs(latestRpm.rightRpm)) / 2 : undefined;
  return (
    <div className="page-stack overview-page">
      <section className="hero-card glass-card liquid-card">
        <div className="hero-copy">
          <span className="section-kicker">WL1 / READY FOR DISCOVERY</span>
          <h1>让每一次调校，<br /><em>都有迹可循。</em></h1>
          <p>面向 WL1 轮腿机器人的参数、控制、标定与诊断工作台。当前固件仍在演进，Studio 会明确区分已支持能力与预留接口。</p>
          <div className="hero-actions">
            <button className="primary-button" type="button" onClick={connected ? () => onNavigate("tuning") : onConnect}>{connected ? "开始调校" : "连接机器人"}<ArrowRight size={17} /></button>
            <button className="secondary-button" type="button" onClick={() => onNavigate("diagnostics")}>打开诊断终端</button>
          </div>
        </div>
        <div className="hero-status-stack">
          <div className={`connection-pill${connected ? " is-online" : ""}`}>
            <span className="status-orb" /><div><small>{connected ? "DEVICE ONLINE" : "DEVICE OFFLINE"}</small><strong>{connection.label}</strong></div>
          </div>
          <div className="firmware-chip"><ShieldCheck size={18} /><span><small>协议兼容层</small><strong>Legacy ASCII · v0</strong></span></div>
        </div>
      </section>

      <section className="metric-grid" aria-label="设备关键指标">
        <article className="metric-card glass-card">
          <div className="metric-icon is-blue"><Activity size={20} /></div>
          <div><span>IMU 合加速度</span><strong>{latestImu?.accelerationNormG?.toFixed(3) ?? "--"}<small> g</small></strong></div>
          <em>{latestImu?.accelerationTrusted === true ? "加速度可信" : latestImu?.accelerationTrusted === false ? "动态或异常，融合已降权" : imuFresh && connection.mode === "serial" ? "HEAD 基线未上报" : connected ? "IMU 超过 600 ms 未更新" : "等待连接"}</em>
        </article>
        <article className="metric-card glass-card">
          <div className="metric-icon is-mint"><Bolt size={20} /></div>
          <div><span>平均轮速</span><strong>{meanRpm?.toFixed(1) ?? "--"}<small> rpm</small></strong></div>
          <em>{rpmFresh ? "左右轮绝对均值" : connected ? "RPM 超过 600 ms 未更新" : "等待连接"}</em>
        </article>
        <article className="metric-card glass-card">
          <div className="metric-icon is-violet"><RotateCw size={20} /></div>
          <div><span>俯仰姿态</span><strong>{latestImu?.pitch.toFixed(2) ?? "--"}<small> °</small></strong></div>
          <em>{latestImu ? Math.abs(latestImu.pitch) < 3 ? "平衡区间" : "偏离中立" : connected ? "IMU 陈旧或尚未开启" : "等待连接"}</em>
        </article>
        <article className="metric-card glass-card">
          <div className="metric-icon is-coral"><RadioTower size={20} /></div>
          <div><span>链路质量</span><strong>{latest?.linkQuality?.toFixed(0) ?? "--"}<small> %</small></strong></div>
          <em>{connection.mode === "mock" ? "Mock 链路" : connection.mode === "serial" ? "当前固件未提供质量指标" : "等待连接"}</em>
        </article>
      </section>

      <section className="overview-grid">
        <article className="glass-card chart-card"><LiveChart samples={imuFresh ? samples : []} compact={compactTelemetry} /></article>
        <article className="glass-card robot-card"><RobotVisual sample={latestImu} connected={connected} telemetryFresh={imuFresh} name={robotName} ledColor={ledColor} /></article>
      </section>

      <section className="quick-grid">
        <button className="quick-card glass-card" type="button" onClick={() => onNavigate("tuning")}>
          <span className="quick-number">01</span><div><small>PRECISION</small><strong>参数调校</strong><p>按控制环分组管理脏值，并节流下发到固件。</p></div><ChevronRight size={20} />
        </button>
        <button className="quick-card glass-card" type="button" onClick={() => onNavigate("calibration")}>
          <span className="quick-number">02</span><div><small>GUIDED</small><strong>四步标定</strong><p>采样、校零、腿高与本地记录形成完整闭环。</p></div><ChevronRight size={20} />
        </button>
        <button className="quick-card glass-card" type="button" onClick={() => onNavigate("control")}>
          <span className="quick-number">03</span><div><small>HOLD TO MOVE</small><strong>安全控制</strong><p>按住才发送 R 帧，释放立即回到中立目标。</p></div><ChevronRight size={20} />
        </button>
      </section>
    </div>
  );
}
