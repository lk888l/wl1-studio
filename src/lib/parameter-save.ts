import type { DeviceGateway } from "./device";
import { parseFlashSaveReply, validateFirmwareCommand } from "./protocol";

type SaveGateway = Pick<DeviceGateway, "connection" | "subscribe" | "sendTextCommand">;
export type ParameterSaveResult = "saved" | "unchanged";

const activeSaves = new WeakSet<SaveGateway>();
const unconfirmedSessions = new WeakMap<SaveGateway, number>();

export function getParameterSaveBlockReason(gateway: SaveGateway, expectedSessionId: number): string | null {
  return unconfirmedSessions.get(gateway) === expectedSessionId
    ? "上次保存结果未确认，请断开并重新连接小车后再保存。"
    : null;
}
const TIMEOUT_MS = 10_000;

function connectionError(gateway: SaveGateway, expectedSessionId: number): Error | null {
  const connection = gateway.connection;
  if (connection.mode === "disconnected" || connection.sessionId === undefined) {
    return new Error("设备已断开，无法确认参数是否已保存到 Flash。");
  }
  if (connection.sessionId !== expectedSessionId) {
    return new Error("设备会话已变化，已取消旧连接的保存任务；无法确认保存结果。");
  }
  if (!connection.writesUnlocked) return new Error("当前为只读连接，不能保存参数到 Flash。");
  const unsupported = validateFirmwareCommand("save", connection.connectionTarget ?? "robot");
  return unsupported ? new Error(unsupported) : null;
}

/** Save the firmware's current SRAM snapshot; never resend drafts or retry a flash write. */
export async function saveParametersToFlash(
  gateway: SaveGateway,
  expectedSessionId: number,
  signal?: AbortSignal,
): Promise<ParameterSaveResult> {
  const cancelled = () => new Error("已取消等待保存回执，无法确认参数是否已写入 Flash。");
  if (signal?.aborted) throw cancelled();
  const invalidConnection = connectionError(gateway, expectedSessionId);
  if (invalidConnection) throw invalidConnection;
  const blocked = getParameterSaveBlockReason(gateway, expectedSessionId);
  if (blocked) throw new Error(blocked);
  if (activeSaves.has(gateway)) throw new Error("已有保存操作正在等待固件回执，请勿重复保存。");
  activeSaves.add(gateway);

  return new Promise<ParameterSaveResult>((resolve, reject) => {
    let settled = false;
    let sendStarted = false;
    let sent = false;
    let reply: ParameterSaveResult | undefined;
    let unsubscribe = () => {};
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let sessionMonitor: ReturnType<typeof setInterval> | undefined;
    const finish = (error?: Error, result?: ParameterSaveResult, unconfirmed = false) => {
      if (settled) return;
      settled = true;
      // Replies have no request ID: a late ACK must never confirm a later save.
      if (unconfirmed && sendStarted) unconfirmedSessions.set(gateway, expectedSessionId);
      unsubscribe();
      clearTimeout(timeout);
      clearInterval(sessionMonitor);
      signal?.removeEventListener("abort", onAbort);
      activeSaves.delete(gateway);
      if (error) reject(error);
      else if (result) resolve(result);
    };
    const onAbort = () => finish(cancelled(), undefined, true);
    const checkConnection = () => {
      const error = connectionError(gateway, expectedSessionId);
      if (error) finish(error, undefined, true);
      return error === null;
    };

    try {
      // Subscribe before sending: the browser Mock can deliver its reply synchronously.
      unsubscribe = gateway.subscribe((event) => {
        if (settled || !checkConnection()) return;
        if (event.type === "disconnected") {
          finish(new Error("设备已断开，无法确认参数是否已保存到 Flash。"), undefined, true);
          return;
        }
        if (event.type !== "console" || event.entry.direction !== "rx") return;
        const parsed = parseFlashSaveReply(event.entry.text);
        if (!parsed) return;
        if (parsed.status === "error") finish(new Error(parsed.message), undefined, parsed.unconfirmed);
        else {
          reply = parsed.status;
          if (sent) finish(undefined, reply);
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      timeout = setTimeout(() => {
        finish(new Error("等待保存回执超时，无法确认参数是否已写入 Flash；请检查连接或固件版本。"), undefined, true);
      }, TIMEOUT_MS);
      // Explicit disconnect/reconnect updates the snapshot without a DeviceEvent.
      sessionMonitor = setInterval(checkConnection, 100);
      if (!checkConnection()) return;
      sendStarted = true;
      void gateway.sendTextCommand("save", expectedSessionId).then(() => {
        if (settled || !checkConnection()) return;
        sent = true;
        if (reply) finish(undefined, reply);
      }, (error: unknown) => {
        finish(error instanceof Error ? error : new Error(String(error)), undefined, true);
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)), undefined, true);
    }
  });
}
