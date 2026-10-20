import { LoaderCircle, Moon } from "lucide-react";
import { useState } from "react";
import { isTauriRuntime } from "../lib/device";
import { pcMonitorGateway, usePcMonitor } from "../lib/pc-monitor";

export function BackgroundButton({ compact = false }: { compact?: boolean }) {
  const snapshot = usePcMonitor();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!isTauriRuntime()) return null;
  const available = snapshot.desktop?.trayAvailable === true;
  async function enter(): Promise<void> {
    if (busy) return;
    setBusy(true); setError("");
    try { await pcMonitorGateway.enterBackground(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }
  return <span className="background-control">
    <button type="button" className={compact ? "pc-monitor-background-button" : "secondary-button"} disabled={busy || !available}
      title={available ? "释放工作台窗口并保留 Wi-Fi 传输；从系统托盘恢复界面" : snapshot.desktop ? "系统托盘不可用，可以最小化窗口继续传输" : "正在检查系统托盘"}
      onClick={() => { void enter(); }}>
      {busy ? <LoaderCircle size={compact ? 14 : 17} className="pet-spin" /> : <Moon size={compact ? 14 : 17} />}
      {busy ? "正在切换…" : compact ? "轻量后台" : "轻量后台运行"}
    </button>
    {error && <small className="background-control-error" role="alert">{error}</small>}
  </span>;
}
