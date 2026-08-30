import {
  AlertTriangle,
  Download,
  Eye,
  EyeOff,
  Pause,
  Play,
  RotateCcw,
  Ruler,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  DEFAULT_LEG_GEOMETRY,
  FIRMWARE_LEG_LIMITS,
  firmwareLegTravel,
  firmwareServoAngle,
  sampleLegTrajectory,
  solveLegKinematics,
  splitTrajectory,
  trajectoryPolyline,
} from "../../lib/leg-kinematics";
import type { LegGeometry, Point2D } from "../../lib/leg-kinematics";

const geometryFields: Array<{
  key: keyof LegGeometry;
  label: string;
  symbol: string;
  min: number;
  max: number;
}> = [
  { key: "driveLength", label: "驱动杆", symbol: "CD", min: 10, max: 100 },
  { key: "upperLength", label: "上连杆", symbol: "AB", min: 10, max: 100 },
  { key: "couplerLength", label: "耦合杆", symbol: "BD", min: 5, max: 80 },
  { key: "wheelLinkLength", label: "轮心延长", symbol: "DW", min: 10, max: 120 },
  { key: "anchorX", label: "固定点横坐标", symbol: "Aₓ", min: -80, max: 80 },
  { key: "anchorY", label: "固定点纵坐标", symbol: "Aᵧ", min: -80, max: 80 },
  { key: "wheelRadius", label: "轮半径", symbol: "R", min: 3, max: 40 },
];

function range(start: number, end: number, step: number): number[] {
  const values: number[] = [];
  const first = Math.ceil(start / step) * step;
  for (let value = first; value <= end; value += step) values.push(value);
  return values;
}

function pointLabel(point: Point2D): string {
  return `${point.x.toFixed(1)}, ${point.y.toFixed(1)}`;
}

function downloadTrajectory(points: ReturnType<typeof sampleLegTrajectory>): void {
  const rows = ["kinematics_theta_deg,servo_command_deg,wheel_x_mm,wheel_y_mm"];
  for (const point of points) rows.push(`${point.theta.toFixed(4)},${firmwareServoAngle(point.theta).toFixed(4)},${point.x.toFixed(4)},${point.y.toFixed(4)}`);
  const blob = new Blob([`${rows.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "wl1-leg-trajectory.csv";
  anchor.click();
  URL.revokeObjectURL(url);
}

export function KinematicsPage() {
  const [theta, setTheta] = useState(45);
  const [geometry, setGeometry] = useState<LegGeometry>({ ...DEFAULT_LEG_GEOMETRY });
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(36);
  const [showTrace, setShowTrace] = useState(true);

  const firmwareTravel = useMemo(() => firmwareLegTravel(geometry), [geometry]);
  // Round inward to the slider's 0.1° step so the DOM value and readout agree.
  const thetaMin = firmwareTravel
    ? Math.ceil(firmwareTravel.minimumTheta * 10) / 10
    : FIRMWARE_LEG_LIMITS.solverThetaMin;
  const thetaMax = firmwareTravel
    ? Math.floor(firmwareTravel.maximumTheta * 10) / 10
    : FIRMWARE_LEG_LIMITS.solverThetaMax;
  const pose = useMemo(() => solveLegKinematics(geometry, theta), [geometry, theta]);
  const solverTrajectory = useMemo(() => sampleLegTrajectory(
    geometry,
    FIRMWARE_LEG_LIMITS.solverThetaMin,
    FIRMWARE_LEG_LIMITS.solverThetaMax,
    1,
  ), [geometry]);
  const trajectory = useMemo(() => sampleLegTrajectory(geometry, thetaMin, thetaMax, 0.5), [geometry, thetaMax, thetaMin]);
  const solverTraceSegments = useMemo(() => splitTrajectory(solverTrajectory), [solverTrajectory]);
  const traceSegments = useMemo(() => splitTrajectory(trajectory), [trajectory]);

  const bounds = useMemo(() => {
    const points: Point2D[] = [
      ...solverTrajectory,
      ...trajectory,
      { x: geometry.anchorX, y: geometry.anchorY },
      { x: 0, y: 0 },
    ];
    if (pose) points.push(pose.knee, pose.crank, pose.wheel);
    const xs = points.map((point) => point.x);
    const ys = points.map((point) => point.y);
    const padding = Math.max(24, geometry.wheelRadius + 14);
    const minX = Math.min(-55, ...xs) - padding;
    const maxX = Math.max(95, ...xs) + padding;
    const minY = Math.min(-45, ...ys) - padding;
    const maxY = Math.max(120, ...ys) + padding;
    return { minX, maxX, minY, maxY };
  }, [geometry, pose, solverTrajectory, trajectory]);

  const viewBox = `${bounds.minX} ${bounds.minY} ${bounds.maxX - bounds.minX} ${bounds.maxY - bounds.minY}`;
  const xGrid = range(bounds.minX, bounds.maxX, 20);
  const yGrid = range(bounds.minY, bounds.maxY, 20);
  const trajectoryHeight = trajectory.length
    ? Math.max(...trajectory.map((point) => point.y)) - Math.min(...trajectory.map((point) => point.y))
    : 0;
  const trajectoryWidth = trajectory.length
    ? Math.max(...trajectory.map((point) => point.x)) - Math.min(...trajectory.map((point) => point.x))
    : 0;

  useEffect(() => {
    setTheta((current) => Math.min(thetaMax, Math.max(thetaMin, current)));
    if (!firmwareTravel) setPlaying(false);
  }, [firmwareTravel, thetaMax, thetaMin]);

  useEffect(() => {
    if (!playing) return;
    let animationFrame = 0;
    let direction = theta >= thetaMax ? -1 : 1;
    let previousTime = performance.now();
    const tick = (time: number) => {
      const elapsedSeconds = Math.min(0.05, (time - previousTime) / 1000);
      previousTime = time;
      setTheta((current) => {
        let next = current + direction * speed * elapsedSeconds;
        if (next >= thetaMax) {
          next = thetaMax;
          direction = -1;
        } else if (next <= thetaMin) {
          next = thetaMin;
          direction = 1;
        }
        return next;
      });
      animationFrame = requestAnimationFrame(tick);
    };
    animationFrame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationFrame);
  }, [playing, speed, thetaMax, thetaMin]);

  const updateGeometry = (key: keyof LegGeometry, value: number) => {
    if (!Number.isFinite(value)) return;
    setGeometry((current) => ({ ...current, [key]: value }));
  };

  const reset = () => {
    setPlaying(false);
    setTheta(45);
    setGeometry({ ...DEFAULT_LEG_GEOMETRY });
  };

  const arcEnd = {
    x: 23 * Math.cos(theta * Math.PI / 180),
    y: 23 * Math.sin(theta * Math.PI / 180),
  };

  return (
    <div className="page-stack kinematics-page">
      <header className="page-heading">
        <div>
          <h1>腿部运动学</h1>
          <p>查看固件可执行行程内的腿高、逆解角度与舵机约束。</p>
        </div>
        <div className="heading-actions">
          <button className="secondary-button" type="button" onClick={reset}><RotateCcw size={16} />恢复原始参数</button>
          <button className="primary-button" type="button" disabled={!trajectory.length} onClick={() => downloadTrajectory(trajectory)}><Download size={16} />导出轨迹</button>
        </div>
      </header>

      <section className="kinematics-metrics" aria-label="运动学摘要">
        <article className="glass-card kinematics-metric">
          <span>驱动角 θ</span><strong>{theta.toFixed(1)}°</strong><small>{playing ? `${speed}°/s 往复扫描` : "手动定位"}</small>
        </article>
        <article className="glass-card kinematics-metric">
          <span>轮心 W</span><strong>{pose ? `${pose.wheel.x.toFixed(1)} / ${pose.wheel.y.toFixed(1)}` : "无解"}</strong><small>X / Y · mm</small>
        </article>
        <article className="glass-card kinematics-metric">
          <span>腿高 / 舵机</span><strong>{pose ? `${pose.wheel.y.toFixed(1)} mm` : "无解"}</strong><small>{pose ? `物理舵机 ${firmwareServoAngle(theta).toFixed(1)}°` : "等待有效机构解"}</small>
        </article>
        <article className={`glass-card kinematics-metric${firmwareTravel ? "" : " is-warning"}`}>
          <span>固件有效角域</span><strong>{firmwareTravel ? `${thetaMin.toFixed(1)}–${thetaMax.toFixed(1)}°` : "无交集"}</strong><small>目标腿高 44.5–78.5 mm</small>
        </article>
      </section>

      <section className="firmware-limit-strip" aria-label="固件腿部限幅">
        <span className="firmware-limit-icon"><ShieldCheck size={20} /></span>
        <div><strong>已启用固件一致限幅</strong><small>逆解 0–80° → 腿高请求 44.5–78.5 mm → 舵机命令 θ−10° → 舵机物理范围 0–50°</small></div>
        <span>理论 θ {firmwareTravel ? `${firmwareTravel.minimumTheta.toFixed(2)}–${firmwareTravel.maximumTheta.toFixed(2)}°` : "无有效范围"}</span>
        <span>模型 Y {firmwareTravel ? `${firmwareTravel.minimumHeight.toFixed(2)}–${firmwareTravel.maximumHeight.toFixed(2)} mm` : "无有效范围"}</span>
        <span>轨迹包络 {trajectoryWidth.toFixed(1)} × {trajectoryHeight.toFixed(1)} mm</span>
      </section>

      <div className="kinematics-layout">
        <section className="glass-card liquid-card kinematics-stage-card">
          <div className="kinematics-card-head">
            <div><span className="section-kicker">MECHANISM VIEW</span><h2>单腿机构</h2></div>
            <div className="kinematics-legend" aria-label="图例">
              <span><i className="is-drive" />驱动 CD</span>
              <span><i className="is-upper" />上连杆 AB</span>
              <span><i className="is-leg" />腿杆 BDW</span>
              <span><i className="is-solver" />逆解全域</span>
              <span><i className="is-trace" />固件有效轨迹</span>
            </div>
          </div>

          <div className="kinematics-stage">
            <svg viewBox={viewBox} role="img" aria-label={`WL1 单腿运动学，驱动角 ${theta.toFixed(1)} 度`}>
              <defs>
                <linearGradient id="kinematicsTrace" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0" stopColor="#9368f7" />
                  <stop offset="1" stopColor="#e15fa8" />
                </linearGradient>
                <radialGradient id="kinematicsWheel">
                  <stop offset="0" stopColor="#465774" />
                  <stop offset=".72" stopColor="#222e43" />
                  <stop offset="1" stopColor="#111a2b" />
                </radialGradient>
                <filter id="kinematicsShadow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="4" stdDeviation="4" floodColor="#385071" floodOpacity=".2" />
                </filter>
              </defs>

              <g className="kinematics-grid">
                {xGrid.map((x) => <line key={`x-${x}`} x1={x} y1={bounds.minY} x2={x} y2={bounds.maxY} className={x === 0 ? "is-axis" : undefined} />)}
                {yGrid.map((y) => <line key={`y-${y}`} x1={bounds.minX} y1={y} x2={bounds.maxX} y2={y} className={y === 0 ? "is-axis" : undefined} />)}
              </g>

              {showTrace && solverTraceSegments.map((segment) => (
                <polyline key={`solver-${segment[0]?.theta}`} className="kinematics-trace kinematics-trace--solver" points={trajectoryPolyline(segment)} />
              ))}
              {showTrace && traceSegments.map((segment) => (
                <polyline key={`safe-${segment[0]?.theta}`} className="kinematics-trace" points={trajectoryPolyline(segment)} />
              ))}

              {pose ? (
                <g className="kinematics-mechanism" filter="url(#kinematicsShadow)">
                  <line className="kinematics-ground" x1={bounds.minX} y1={pose.wheel.y + geometry.wheelRadius} x2={bounds.maxX} y2={pose.wheel.y + geometry.wheelRadius} />
                  <path className="kinematics-angle" d={`M 23 0 A 23 23 0 0 1 ${arcEnd.x} ${arcEnd.y}`} />
                  <text className="kinematics-angle-label" x={arcEnd.x + 5} y={arcEnd.y - 5}>θ</text>
                  <line className="kinematics-link is-drive" x1={pose.pivot.x} y1={pose.pivot.y} x2={pose.crank.x} y2={pose.crank.y} />
                  <line className="kinematics-link is-upper" x1={pose.anchor.x} y1={pose.anchor.y} x2={pose.knee.x} y2={pose.knee.y} />
                  <polyline className="kinematics-link is-leg" points={`${pose.knee.x},${pose.knee.y} ${pose.crank.x},${pose.crank.y} ${pose.wheel.x},${pose.wheel.y}`} />
                  <circle className="kinematics-wheel" cx={pose.wheel.x} cy={pose.wheel.y} r={geometry.wheelRadius} />
                  <circle className="kinematics-wheel-hub" cx={pose.wheel.x} cy={pose.wheel.y} r={Math.max(2.2, geometry.wheelRadius * .28)} />
                  {[
                    ["A", pose.anchor],
                    ["B", pose.knee],
                    ["C", pose.pivot],
                    ["D", pose.crank],
                    ["W", pose.wheel],
                  ].map(([label, point]) => {
                    const typedPoint = point as Point2D;
                    return (
                      <g className="kinematics-joint" key={label as string}>
                        <circle cx={typedPoint.x} cy={typedPoint.y} r="3.6" />
                        <text x={typedPoint.x + 5} y={typedPoint.y - 5}>{label as string}</text>
                      </g>
                    );
                  })}
                </g>
              ) : (
                <g className="kinematics-empty">
                  <circle cx="18" cy="36" r="34" />
                  <text x="18" y="33">当前角度无装配解</text>
                  <text x="18" y="45">请调整角度或机构尺寸</text>
                </g>
              )}
            </svg>
            <span className="kinematics-axis-note">单位 mm · +Y 向下</span>
          </div>

          <div className="kinematics-transport">
            <button className={playing ? "transport-button is-playing" : "transport-button"} type="button" aria-label={playing ? "暂停仿真" : "播放仿真"} onClick={() => setPlaying((value) => !value)}>
              {playing ? <Pause size={18} /> : <Play size={18} />}
            </button>
            <label className="kinematics-theta-control">
              <span><strong>固件有效 θ</strong><small>{thetaMin.toFixed(1)}°</small></span>
              <input type="range" min={thetaMin} max={thetaMax} step="0.1" value={theta} disabled={!firmwareTravel} onChange={(event) => { setPlaying(false); setTheta(Number(event.target.value)); }} />
              <span><output>{theta.toFixed(1)}°</output><small>{thetaMax.toFixed(1)}°</small></span>
            </label>
            <label className="kinematics-speed">
              <span>速度</span>
              <select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}>
                <option value="18">0.5×</option>
                <option value="36">1×</option>
                <option value="72">2×</option>
              </select>
            </label>
            <button className="small-action kinematics-trace-toggle" type="button" onClick={() => setShowTrace((value) => !value)}>
              {showTrace ? <EyeOff size={15} /> : <Eye size={15} />}{showTrace ? "隐藏轨迹" : "显示轨迹"}
            </button>
          </div>
        </section>

        <aside className="kinematics-sidebar">
          <section className="glass-card kinematics-geometry-card">
            <div className="kinematics-card-head">
              <div><span className="section-kicker">GEOMETRY</span><h2>机构参数</h2></div>
              <span className="kinematics-head-icon"><Settings2 size={18} /></span>
            </div>
            <p className="geometry-firmware-note">这里用于设计推演；修改尺寸后需要同步修改并重新编译小车固件。</p>
            <div className="geometry-fields">
              {geometryFields.map((field) => (
                <label className="geometry-field" key={field.key}>
                  <span><strong>{field.label}</strong><small>{field.symbol}</small></span>
                  <span className="geometry-input"><input type="number" min={field.min} max={field.max} step="0.5" value={geometry[field.key]} onChange={(event) => updateGeometry(field.key, Number(event.target.value))} /><i>mm</i></span>
                </label>
              ))}
            </div>
          </section>

          <section className="glass-card kinematics-inspector">
            <div className="kinematics-card-head">
              <div><span className="section-kicker">INSPECTOR</span><h2>实时解算</h2></div>
              <span className="kinematics-head-icon"><Ruler size={18} /></span>
            </div>
            {pose ? (
              <dl className="kinematics-readout">
                <div><dt>固定点 A</dt><dd>{pointLabel(pose.anchor)}</dd></div>
                <div><dt>关节点 B</dt><dd>{pointLabel(pose.knee)}</dd></div>
                <div><dt>驱动点 D</dt><dd>{pointLabel(pose.crank)}</dd></div>
                <div className="is-accent"><dt>轮心 W</dt><dd>{pointLabel(pose.wheel)}</dd></div>
                <div><dt>逻辑驱动角</dt><dd>{theta.toFixed(2)}°</dd></div>
                <div><dt>舵机物理命令</dt><dd>{firmwareServoAngle(theta).toFixed(2)}°</dd></div>
                <div><dt>装配裕度</dt><dd>{pose.assemblyMargin.toFixed(2)} mm</dd></div>
              </dl>
            ) : (
              <div className="kinematics-warning"><AlertTriangle size={19} /><div><strong>机构在当前角度不可达</strong><span>两圆无交点，B 点不存在。播放仍会继续扫描可行区间。</span></div></div>
            )}
          </section>

          <div className="kinematics-source-note">
            <span>固件同步</span>
            <p>约束来自 <code>LegKinematics.hpp</code> 与 <code>main.cpp</code>；最大目标 78.5 mm 经舵机限幅后的模型高度约为 78.29 mm。</p>
          </div>
        </aside>
      </div>
    </div>
  );
}
