import type { CSSProperties } from "react";

import type { TelemetrySample } from "../types";

interface RobotVisualProps {
  sample?: TelemetrySample;
  connected: boolean;
  telemetryFresh: boolean;
  name: string;
  ledColor: string;
}

export function RobotVisual({ sample, connected, telemetryFresh, name, ledColor }: RobotVisualProps) {
  const pitch = Math.max(-12, Math.min(12, sample?.pitch ?? 0));
  const roll = Math.max(-10, Math.min(10, sample?.roll ?? 0));
  const reportedHeight = sample?.targetHeight;
  const height = reportedHeight ?? 61.5;
  const legLength = 66 + ((height - 44.5) / 34) * 42;
  const style = {
    "--robot-pitch": `${pitch}deg`,
    "--robot-roll": `${roll}deg`,
    "--leg-length": `${legLength}px`,
    "--robot-led": ledColor,
  } as CSSProperties;
  return (
    <div className="robot-visual" style={style}>
      <div className="robot-visual__topline">
        <div>
          <span className="section-kicker">DIGITAL TWIN</span>
          <h3>{name}</h3>
        </div>
        <span className={`soft-badge${telemetryFresh ? " is-success" : ""}`}>{!connected ? "等待设备" : telemetryFresh ? "姿态同步" : "遥测陈旧"}</span>
      </div>
      <svg viewBox="0 0 430 310" role="img" aria-label="WL1 轮腿机器人姿态示意">
        <defs>
          <linearGradient id="robotBody" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="0.58" stopColor="#dfeaff" />
            <stop offset="1" stopColor="#b9cbec" />
          </linearGradient>
          <linearGradient id="robotDark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#26334d" />
            <stop offset="1" stopColor="#10192b" />
          </linearGradient>
        </defs>
        <ellipse cx="215" cy="279" rx="150" ry="18" fill="#86a5d4" opacity=".14" />
        <g className="robot-rig">
          <g className="robot-wheel robot-wheel--left">
            <circle cx="96" cy="245" r="43" fill="url(#robotDark)" />
            <circle cx="96" cy="245" r="30" fill="#34425e" stroke="#8293ae" strokeWidth="3" />
            <circle cx="96" cy="245" r="12" fill="#c8d9f1" />
            <path d="M96 215v60M66 245h60M75 224l42 42M117 224l-42 42" stroke="#91a4c1" strokeWidth="3" opacity=".55" />
          </g>
          <g className="robot-wheel robot-wheel--right">
            <circle cx="334" cy="245" r="43" fill="url(#robotDark)" />
            <circle cx="334" cy="245" r="30" fill="#34425e" stroke="#8293ae" strokeWidth="3" />
            <circle cx="334" cy="245" r="12" fill="#c8d9f1" />
            <path d="M334 215v60M304 245h60M313 224l42 42M355 224l-42 42" stroke="#91a4c1" strokeWidth="3" opacity=".55" />
          </g>
          <g className="robot-body">
            <path className="robot-leg" d="M155 142 L118 190 L96 232" />
            <path className="robot-leg" d="M275 142 L312 190 L334 232" />
            <circle cx="118" cy="190" r="11" fill="#eef5ff" stroke="#7186a8" strokeWidth="5" />
            <circle cx="312" cy="190" r="11" fill="#eef5ff" stroke="#7186a8" strokeWidth="5" />
            <rect x="124" y="73" width="182" height="84" rx="30" fill="url(#robotBody)" stroke="#fff" strokeWidth="3" />
            <path d="M145 84h140" stroke="#fff" strokeWidth="6" strokeLinecap="round" opacity=".72" />
            <rect x="165" y="98" width="100" height="28" rx="14" fill="#172238" />
            <circle cx="190" cy="112" r="5" fill="var(--robot-led)" className="robot-led" />
            <circle cx="240" cy="112" r="5" fill="var(--robot-led)" className="robot-led" />
            <path d="M204 137h22" stroke="#8293ae" strokeWidth="4" strokeLinecap="round" />
          </g>
        </g>
      </svg>
      <div className="robot-readout">
        <span><small>Pitch</small><strong>{pitch.toFixed(1)}°</strong></span>
        <span><small>Roll</small><strong>{roll.toFixed(1)}°</strong></span>
        <span><small>Height</small><strong>{reportedHeight?.toFixed(1) ?? "--"} mm</strong></span>
      </div>
    </div>
  );
}
