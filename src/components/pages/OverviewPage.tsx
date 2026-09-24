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
import { isRemoteConnection } from "../../lib/connection";
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
  const remote = isRemoteConnection(connection);
  const latest = samples.at(-1);
  const latestImu = imuFresh ? latest : undefined;
  const latestRpm = rpmFresh ? latest : undefined;
  const connected = connection.mode !== "disconnected";
  const meanRpm = latestRpm ? (Math.abs(latestRpm.leftRpm) + Math.abs(latestRpm.rightRpm)) / 2 : undefined;
  return (
    <div className="page-stack overview-page">
      <section className="hero-card glass-card liquid-card">
        <div className="hero-copy">
          <h1>WL1 状态总览</h1>
          <p>{remote ? "通过遥控器无线下发 PID、俯仰偏置和自适应腿高开关，运动控制继续使用遥控器摇杆。" : "直连小车进行遥测与控制，也可连接遥控器进行无线调参。"}</p>
          <div className="hero-actions">
            <button className="primary-button" type="button" onClick={connected ? () => onNavigate("tuning") : onConnect}>{connected ? "开始调校" : "连接设备"}<ArrowRight size={17} /></button>
            <button className="secondary-button" type="button" onClick={() => onNavigate("diagnostics")}>打开诊断终端</button>
          </div>
        </div>
        <div className="hero-status-stack">
          <div className={`connection-pill${connected ? " is-online" : ""}`}>
            <span className="status-orb" /><div><small>{remote ? "遥控器串口已打开" : connected ? "设备已连接" : "设备未连接"}</small><strong>{connection.label}</strong></div>
          </div>
          <div className="firmware-chip"><ShieldCheck size={18} /><span><small>{remote ? "连接目标" : "协议兼容层"}</small><strong>{remote ? "遥控器桥接 · 单向调参" : "Legacy ASCII · v0"}</strong></span></div>
        </div>
      </section>

      {remote ? (
        <section className="remote-capabilities glass-card" aria-label="遥控器连接能力">
          <div className="remote-capabilities-heading"><RadioTower size={24} /><div><span className="section-kicker">WIRELESS TUNING</span><h2>串口就绪，小车状态需现场确认</h2><p>TX 只记录电脑发送，无线链路不返回小车执行 ACK 或参数回读。</p></div></div>
          <div className="remote-capability-grid">
            <article><strong>无线下发参数</strong><p>支持姿态、速度、转向、横滚 PID、俯仰偏置与自适应腿高开关。发送后通过实际表现确认效果。</p></article>
            <article><strong>遥控器掌握运动控制</strong><p>上位机不发送运动或腿高命令；断开串口不会使小车停车。</p></article>
            <article><strong>遥测需直连小车</strong><p>当前无线桥接不回传姿态、轮速或链路质量。需要曲线与实时控制时，切换为直连小车。</p></article>
          </div>
        </section>
      ) : (
        <>
      <section className="metric-grid" aria-label="设备关键指标">
        <article className="metric-card glass-card">
          <div className="metric-icon is-blue"><Activity size={20} /></div>
          <div><span>IMU 合加速度</span><strong>{latestImu?.accelerationNormG?.toFixed(3) ?? "--"}<small> g</small></strong></div>
          <em>{latestImu?.accelerationTrusted === true ? "加速度可信" : latestImu?.accelerationTrusted === false ? "动态或异常，融合已降权" : imuFresh && connection.mode !== "mock" ? "固件未上报" : connected ? "IMU 超过 600 ms 未更新" : "等待连接"}</em>
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
          <em>{connection.mode === "mock" ? "Mock 链路" : connected ? "当前固件未提供质量指标" : "等待连接"}</em>
        </article>
      </section>

      <section className="overview-grid">
        <article className="glass-card chart-card"><LiveChart samples={imuFresh ? samples : []} compact={compactTelemetry} /></article>
        <article className="glass-card robot-card"><RobotVisual sample={latestImu} connected={connected} telemetryFresh={imuFresh} name={robotName} ledColor={ledColor} /></article>
      </section>
        </>
      )}

      <section className="quick-grid">
        <button className="quick-card glass-card" type="button" onClick={() => onNavigate("tuning")}>
          <span className="quick-number">01</span><div><strong>参数调校</strong><p>{remote ? "无线下发 PID、俯仰偏置与自适应腿高开关" : "查看并下发控制参数"}</p></div><ChevronRight size={20} />
        </button>
        <button className="quick-card glass-card" type="button" onClick={() => onNavigate("calibration")}>
          <span className="quick-number">02</span><div><strong>四步标定</strong><p>{remote ? "查看标定记录，完整标定需直连" : "完成校零、腿高与记录"}</p></div><ChevronRight size={20} />
        </button>
        <button className="quick-card glass-card" type="button" onClick={() => onNavigate("control")}>
          <span className="quick-number">03</span><div><strong>安全控制</strong><p>{remote ? "当前由遥控器摇杆控制" : "按住移动，释放即停止"}</p></div><ChevronRight size={20} />
        </button>
      </section>
    </div>
  );
}
