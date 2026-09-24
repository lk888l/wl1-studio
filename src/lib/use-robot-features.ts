import { useCallback, useEffect, useRef, useState } from "react";

import type { ConnectionSnapshot } from "../types";
import { isRemoteConnection } from "./connection";
import { deviceGateway } from "./device";
import { parseRobotFeatureReply } from "./protocol";

type FeatureKind = "uid" | "autoleg";
interface AutoLegStatus { enabled: boolean; active: boolean }
interface PendingReply {
  kind: FeatureKind;
  expectedEnabled?: boolean;
  sessionId: number;
  timeoutId: number;
}

const REPLY_TIMEOUT_MS = 4000;

export function useRobotFeatures(connection: ConnectionSnapshot) {
  const [chipUid, setChipUid] = useState<string | null>(null);
  const [autoLeg, setAutoLeg] = useState<AutoLegStatus | null>(null);
  const [busy, setBusy] = useState<FeatureKind | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<PendingReply | null>(null);
  const currentSessionId = useRef(connection.sessionId);
  const remote = isRemoteConnection(connection);

  useEffect(() => {
    currentSessionId.current = connection.sessionId;
    if (pending.current) window.clearTimeout(pending.current.timeoutId);
    pending.current = null;
    setChipUid(null);
    setAutoLeg(null);
    setBusy(null);
    setNotice(null);
    return () => {
      if (pending.current) window.clearTimeout(pending.current.timeoutId);
      pending.current = null;
    };
  }, [connection.sessionId]);

  useEffect(() => deviceGateway.subscribe((event) => {
    if (event.type !== "console" || event.entry.direction !== "rx") return;
    if (isRemoteConnection(deviceGateway.connection)) return;
    const reply = parseRobotFeatureReply(event.entry.text);
    if (!reply) return;
    if (reply.type === "uid") setChipUid(reply.uid);
    else setAutoLeg({ enabled: reply.enabled, active: reply.active });

    const request = pending.current;
    if (!request || request.kind !== reply.type || request.sessionId !== currentSessionId.current) return;
    window.clearTimeout(request.timeoutId);
    pending.current = null;
    setBusy(null);
    if (reply.type === "uid") {
      setNotice("已收到小车固件返回的芯片序列号。");
    } else if (request.expectedEnabled === undefined) {
      setNotice("已收到小车固件返回的自适应腿高状态。");
    } else {
      setNotice(reply.enabled === request.expectedEnabled
        ? "小车固件已确认自适应腿高开关状态。"
        : "小车返回的开关状态与请求不一致，请检查设备日志。");
    }
  }), []);

  const send = useCallback(async (command: string, kind: FeatureKind, expectedEnabled?: boolean): Promise<void> => {
    if (busy || pending.current) return;
    const sessionId = connection.sessionId;
    if (sessionId === undefined) return;
    setBusy(kind);
    setNotice(null);
    if (kind === "autoleg") setAutoLeg(null);
    let request: PendingReply | null = null;
    if (!remote) {
      request = {
        kind,
        expectedEnabled,
        sessionId,
        timeoutId: window.setTimeout(() => {
          if (pending.current !== request) return;
          pending.current = null;
          setBusy(null);
          setNotice("命令已发送，但 4 秒内未收到固件回执；请检查连接和固件版本。");
        }, REPLY_TIMEOUT_MS),
      };
      pending.current = request;
    }
    try {
      await deviceGateway.sendTextCommand(command, sessionId);
      if (remote && deviceGateway.connection.sessionId === sessionId) {
        setBusy(null);
        setNotice("已写入遥控器串口；当前链路无法确认小车是否执行。");
      }
    } catch (reason) {
      if (request && pending.current === request) {
        window.clearTimeout(request.timeoutId);
        pending.current = null;
      }
      if (deviceGateway.connection.sessionId !== sessionId) return;
      setBusy(null);
      setNotice(reason instanceof Error ? reason.message : String(reason));
    }
  }, [busy, connection.sessionId, remote]);

  return {
    chipUid,
    autoLeg,
    busy,
    notice,
    readUid: () => void send("uid", "uid"),
    readAutoLeg: () => void send("autoleg status", "autoleg"),
    setAutoLeg: (enabled: boolean) => void send(enabled ? "autoleg on" : "autoleg off", "autoleg", enabled),
  };
}
