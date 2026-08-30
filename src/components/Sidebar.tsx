import type { LucideIcon } from "lucide-react";
import {
  Activity,
  GitFork,
  Gauge,
  Radio,
  SlidersHorizontal,
  Sparkles,
  Stethoscope,
  WandSparkles,
} from "lucide-react";

import type { ConnectionSnapshot, PageId } from "../types";

const navigation: Array<{ id: PageId; label: string; icon: LucideIcon }> = [
  { id: "overview", label: "总览", icon: Activity },
  { id: "kinematics", label: "腿部运动学", icon: GitFork },
  { id: "tuning", label: "参数调校", icon: SlidersHorizontal },
  { id: "control", label: "实时控制", icon: Radio },
  { id: "calibration", label: "标定向导", icon: WandSparkles },
  { id: "personalization", label: "个性设置", icon: Sparkles },
  { id: "diagnostics", label: "诊断终端", icon: Stethoscope },
];

interface SidebarProps {
  page: PageId;
  robotName: string;
  connection: ConnectionSnapshot;
  onPageChange: (page: PageId) => void;
  onConnectionOpen: () => void;
}
export function Sidebar({ page, robotName, connection, onPageChange, onConnectionOpen }: SidebarProps) {
  const connected = connection.mode !== "disconnected";
  return (
    <aside className="sidebar glass-panel" aria-label="主导航">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true">
          <Gauge size={24} strokeWidth={2.2} />
        </div>
        <div>
          <strong>WL1 Studio</strong>
          <span>轮腿控制中心</span>
        </div>
      </div>

      <nav className="primary-nav">
        {navigation.map((item) => {
          const Icon = item.icon;
          const active = page === item.id;
          return (
            <button
              className={`nav-item${active ? " is-active" : ""}`}
              key={item.id}
              type="button"
              aria-current={active ? "page" : undefined}
              onClick={() => onPageChange(item.id)}
            >
              <span className="nav-icon"><Icon size={19} /></span>
              <span className="nav-copy"><strong>{item.label}</strong></span>
            </button>
          );
        })}
      </nav>

      <button className="sidebar-device" type="button" onClick={onConnectionOpen}>
        <span className={`status-orb${connected ? " is-online" : ""}`} />
        <span className="sidebar-device__copy">
          <small>{connected ? "当前设备" : "设备连接"}</small>
          <strong>{connected ? robotName : "点击建立连接"}</strong>
          <span>{connection.label}</span>
        </span>
        <Radio size={17} />
      </button>
    </aside>
  );
}
