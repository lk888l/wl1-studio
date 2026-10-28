import { invoke } from "@tauri-apps/api/core";
import { pcMonitorGateway } from "./pc-monitor";
import { flushUserStorage } from "./user-storage";

export interface DesktopCloseRequest {
  id: number;
  action: "close" | "background" | "quit";
}

/** Native teardown must wait for both queued preferences and automatic saves. */
export async function completeDesktopClose(request: DesktopCloseRequest, discard = false): Promise<void> {
  await pcMonitorGateway.waitForChanges();
  if (!discard) await flushUserStorage();
  await invoke<void>("desktop_complete_close", { id: request.id });
}

export function cancelDesktopClose(request: DesktopCloseRequest): Promise<void> {
  return invoke<void>("desktop_cancel_close", { id: request.id });
}
