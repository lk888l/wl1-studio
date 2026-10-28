import { AlertTriangle, Folder, LoaderCircle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { initializeUserStorage, resetUserStorage, retryUserStorage, useUserStorageStatus } from "../lib/user-storage";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

export function StorageBootstrap({ children }: { children: ReactNode }) {
  const status = useUserStorageStatus();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void initializeUserStorage().then(() => { if (!cancelled) setReady(true); })
      .catch((reason: unknown) => { if (!cancelled) setError(errorText(reason)); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  async function recover(reset: boolean): Promise<void> {
    if (busy) return;
    setBusy(true); setError("");
    try {
      if (reset) await resetUserStorage();
      else await retryUserStorage();
      setReady(true);
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  if (ready) return <>{children}{status.warning && <aside className="storage-warning" role="status"><strong>配置尚未完整保存</strong><span>{status.warning}</span>{status.directory && <code>{status.directory}</code>}</aside>}</>;
  return <main className="storage-startup"><section className="storage-dialog" aria-labelledby="storage-startup-title">
    {busy ? <LoaderCircle size={28} className="pet-spin" /> : <AlertTriangle size={28} />}
    <h1 id="storage-startup-title">{busy ? "正在读取本地配置" : "无法安全读取配置"}</h1>
    <p>{error || "读取已保存内容并迁移旧配置，完成后打开控制中心。"}</p>
    {status.directory && <p className="storage-directory"><Folder size={16} /><code>{status.directory}</code></p>}
    {!busy && <><p>原有数据会保留。请修复配置后重试，或备份损坏文件后使用默认设置。</p><div className="storage-dialog-actions">
      {status.blocked && <button type="button" className="secondary-button" onClick={() => { void recover(true); }}>备份损坏配置并重置</button>}
      <button type="button" className="primary-button" onClick={() => { void recover(false); }}>重试读取</button>
    </div></>}
  </section></main>;
}
