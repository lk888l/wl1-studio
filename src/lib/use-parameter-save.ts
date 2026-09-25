import { useCallback, useEffect, useRef, useState } from "react";

import type { ConnectionSnapshot } from "../types";
import { isRemoteConnection } from "./connection";
import { deviceGateway } from "./device";
import { getParameterSaveBlockReason, saveParametersToFlash } from "./parameter-save";

export function useParameterSave(connection: ConnectionSnapshot) {
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<AbortController | null>(null);
  const currentSessionId = useRef(connection.sessionId);
  const unavailableReason = connection.mode === "disconnected"
    ? "请先连接小车，再保存设备参数。"
    : isRemoteConnection(connection)
      ? "当前遥控器桥接不支持 Flash 保存，请通过串口或蓝牙直连小车。"
      : !connection.writesUnlocked ? "当前为只读连接，保存到 Flash 需要本次连接的写入权限。"
        : connection.sessionId === undefined ? "请先连接小车。" : getParameterSaveBlockReason(deviceGateway, connection.sessionId);

  useEffect(() => {
    currentSessionId.current = connection.sessionId;
    setSaving(false);
    setNotice(null);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [connection.sessionId]);

  const save = useCallback(async (): Promise<void> => {
    if (pending.current) throw new Error("正在等待保存回执，请勿重复保存。");
    if (unavailableReason || connection.sessionId === undefined) {
      const message = unavailableReason ?? "请先连接小车。";
      setNotice(message);
      throw new Error(message);
    }
    const controller = new AbortController();
    pending.current = controller;
    setSaving(true);
    setNotice("正在等待小车保存回执…");
    try {
      const result = await saveParametersToFlash(deviceGateway, connection.sessionId, controller.signal);
      if (controller.signal.aborted || currentSessionId.current !== connection.sessionId || deviceGateway.connection.sessionId !== connection.sessionId) throw new Error("设备会话已变化，无法确认本次保存结果。");
      const prefix = connection.mode === "mock" ? "Mock 仿真回执：" : "小车固件已确认：";
      setNotice(prefix + (result === "unchanged"
        ? "设备参数与已保存记录一致，本次未写入 Flash。"
        : "保存时的全部运动参数已写入 Flash，重启后可恢复。"));
    } catch (reason) {
      if (!controller.signal.aborted && currentSessionId.current === connection.sessionId && deviceGateway.connection.sessionId === connection.sessionId) {
        setNotice(reason instanceof Error ? reason.message : String(reason));
      }
      throw reason;
    } finally {
      if (pending.current === controller) {
        pending.current = null;
        setSaving(false);
      }
    }
  }, [connection.mode, connection.sessionId, unavailableReason]);

  return { saving, notice, unavailableReason, save };
}
