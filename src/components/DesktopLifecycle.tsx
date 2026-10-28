import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cancelDesktopClose, completeDesktopClose, type DesktopCloseRequest } from "../lib/desktop-lifecycle";
import { isTauriRuntime } from "../lib/device";

const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

/** Also mounted on the recovery screen, so a damaged config cannot trap Quit. */
export function DesktopLifecycle() {
  const [request, setRequest] = useState<DesktopCloseRequest | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef<DesktopCloseRequest | null>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  const dialog = useRef<HTMLDialogElement>(null);

  const finish = useCallback(async (pending: DesktopCloseRequest, discard = false): Promise<void> => {
    if (working.current) return;
    working.current = true;
    setBusy(true); setError("");
    try {
      await completeDesktopClose(pending, discard);
      if (mounted.current) { current.current = null; setRequest(null); }
    } catch (reason) {
      if (mounted.current) setError(errorText(reason));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (request && dialog.current && !dialog.current.open) dialog.current.showModal();
  }, [request]);

  useEffect(() => {
    mounted.current = true;
    if (!isTauriRuntime()) return () => { mounted.current = false; };
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<DesktopCloseRequest>("desktop-prepare-close", (event) => {
      if (cancelled || current.current) return;
      current.current = event.payload;
      setRequest(event.payload);
      void finish(event.payload);
    }).then(async (stop) => {
      if (cancelled) { stop(); return; }
      unlisten = stop;
      await invoke<void>("desktop_ui_ready");
    }).catch((reason: unknown) => { if (!cancelled) setError(errorText(reason)); });
    return () => { cancelled = true; mounted.current = false; unlisten?.(); };
  }, [finish]);

  async function cancel(): Promise<void> {
    if (!request || working.current) return;
    setBusy(true);
    try {
      await cancelDesktopClose(request);
      current.current = null; setRequest(null); setError("");
    } catch (reason) { setError(errorText(reason)); }
    finally { setBusy(false); }
  }

  if (!request) return error ? <aside className="storage-warning" role="alert">窗口关闭服务暂不可用：{error}</aside> : null;
  const action = request.action === "background" ? "进入后台" : request.action === "quit" ? "退出程序" : "关闭窗口";
  return <dialog ref={dialog} className="storage-dialog storage-close-dialog" aria-labelledby="storage-close-title" aria-describedby="storage-close-description" onCancel={(event) => { event.preventDefault(); if (!busy) void cancel(); }}>
      {busy ? <LoaderCircle size={25} className="pet-spin" /> : <AlertTriangle size={25} />}
      <h2 id="storage-close-title">{busy ? `正在保存，准备${action}` : "有修改尚未保存"}</h2>
      <p id="storage-close-description">{busy ? "等待本次配置写入完成。" : error}</p>
      {!busy && <><p>重试保存，或放弃未保存的修改后继续。旧配置文件会保留。</p><div className="storage-dialog-actions">
        <button type="button" className="secondary-button" onClick={() => { void cancel(); }}>继续编辑</button>
        <button type="button" className="secondary-button" onClick={() => { void finish(request, true); }}>放弃保存并继续</button>
        <button type="button" className="primary-button" onClick={() => { void finish(request); }}>重试保存</button>
      </div></>}
  </dialog>;
}
