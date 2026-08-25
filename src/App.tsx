import {
  AlertTriangle,
  Bell,
  Cable,
  ChevronRight,
  CircleHelp,
  Clock3,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CalibrationPage } from "./components/pages/CalibrationPage";
import { ControlPage } from "./components/pages/ControlPage";
import { DiagnosticsPage } from "./components/pages/DiagnosticsPage";
import { KinematicsPage } from "./components/pages/KinematicsPage";
import { OverviewPage } from "./components/pages/OverviewPage";
import { PersonalizationPage } from "./components/pages/PersonalizationPage";
import { TuningPage } from "./components/pages/TuningPage";
import { ConnectionModal } from "./components/ConnectionModal";
import { Sidebar } from "./components/Sidebar";
import {
  buildParameterCommand,
  defaultParameterValues,
  parameterDefinitions,
} from "./data/parameters";
import { deviceGateway, motionCommand } from "./lib/device";
import { appendTelemetrySample, telemetryChannelFresh } from "./lib/telemetry";
import {
  defaultPersonalization,
  loadPersonalization,
  loadProfiles,
  savePersonalization,
  saveProfiles,
} from "./lib/storage";
import type {
  ConnectionSnapshot,
  ConsoleEntry,
  MotionTarget,
  PageId,
  ParameterProfile,
  ParameterValues,
  PersonalizationSettings,
  SerialConfig,
  SerialPortOption,
  TelemetrySample,
} from "./types";

const pageMeta: Record<PageId, { label: string; eyebrow: string }> = {
  overview: { label: "总览", eyebrow: "Overview" },
  kinematics: { label: "腿部运动学", eyebrow: "Kinematics" },
  tuning: { label: "参数调校", eyebrow: "Tuning" },
  control: { label: "实时控制", eyebrow: "Control" },
  calibration: { label: "标定向导", eyebrow: "Calibration" },
  personalization: { label: "个性设置", eyebrow: "Personalize" },
  diagnostics: { label: "诊断终端", eyebrow: "Diagnostics" },
};

const builtinProfiles: ParameterProfile[] = [
  {
    id: "builtin-safe",
    name: "保守起点",
    description: "按本地固件默认值整理，仅供架空台架起步，不代表已认证安全参数。",
    updatedAt: 0,
    values: { ...defaultParameterValues },
    builtIn: true,
  },
  {
    id: "builtin-soft",
    name: "柔和响应",
    description: "降低姿态与差速比例，便于架空调试和观察趋势。",
    updatedAt: 0,
    values: { ...defaultParameterValues, angleKd: 48, velocityKp: 0.035, differentialKp: 1.5 },
    builtIn: true,
  },
  {
    id: "builtin-lab",
    name: "实验记录",
    description: "预留轮径与几何参数，作为后续固件接口迁移示例。",
    updatedAt: 0,
    values: { ...defaultParameterValues, legHeight: 55, wheelRadius: 22 },
    builtIn: true,
  },
];

const initialConsole: ConsoleEntry = {
  id: "studio-ready",
  timestamp: Date.now(),
  direction: "system",
  text: "WL1 Studio 已就绪；浏览器可直接使用 Mock 模式。",
};

const delay = (milliseconds: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

type ParameterRequest =
  | { id: string; value: number; automatic?: false }
  | { id: string; automatic: true };

function parseParameterRequest(command: string): ParameterRequest | null {
  const trimmed = command.trim();
  if (trimmed === "anglepid auto") return { id: "angleKp", automatic: true };
  if (trimmed === "anglebias auto") return { id: "angleBias", automatic: true };

  for (const definition of parameterDefinitions) {
    if (!definition.command || definition.support === "reserved") continue;
    const prefix = definition.flag
      ? `${definition.command} -${definition.flag} `
      : `${definition.command} `;
    if (!trimmed.startsWith(prefix)) continue;
    const value = Number(trimmed.slice(prefix.length));
    if (Number.isFinite(value)) return { id: definition.id, value };
  }
  return null;
}

function mergeKnownParameterValues(applied: Partial<ParameterValues>): ParameterValues {
  const next = { ...defaultParameterValues };
  for (const [id, value] of Object.entries(applied)) {
    if (value !== undefined) next[id] = value;
  }
  return next;
}

export default function App() {
  const [page, setPage] = useState<PageId>("overview");
  const [connection, setConnection] = useState<ConnectionSnapshot>(deviceGateway.connection);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [startupReady, setStartupReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([initialConsole]);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [draftParameters, setDraftParameters] = useState<ParameterValues>({ ...defaultParameterValues });
  const [appliedParameters, setAppliedParameters] = useState<Partial<ParameterValues>>({});
  const [requestedParameterIds, setRequestedParameterIds] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ParameterProfile[]>(() => [...builtinProfiles, ...loadProfiles()]);
  const [parameterSending, setParameterSending] = useState(false);
  const [parameterNotice, setParameterNotice] = useState<string | null>(null);
  const [personalization, setPersonalization] = useState<PersonalizationSettings>(loadPersonalization);
  const [personalizationPersisted, setPersonalizationPersisted] = useState(true);
  const [lastMotionCommand, setLastMotionCommand] = useState("");
  const [motionHeight, setMotionHeight] = useState<{ value: number; requested: boolean } | null>(null);
  const [freshnessNow, setFreshnessNow] = useState(Date.now());
  const parameterOperation = useRef(0);

  const connected = connection.mode !== "disconnected";
  const writesUnlocked = connected && connection.writesUnlocked;
  const activeSessionId = connection.sessionId;
  const latest = samples.at(-1);
  const imuFresh = Boolean(connected && telemetryChannelFresh(latest?.imuTimestamp, freshnessNow));
  const rpmFresh = Boolean(connected && telemetryChannelFresh(latest?.rpmTimestamp, freshnessNow));

  useEffect(() => deviceGateway.subscribe((event) => {
    if (event.type === "telemetry") {
      setSamples((items) => appendTelemetrySample(items, event.sample, 240));
      // Keep the freshness reference at least as new as the sample being
      // rendered. A slower 250 ms wall-clock tick must not classify a newly
      // arrived 20/30 Hz frame as a future (therefore stale) timestamp.
      setFreshnessNow(Math.max(Date.now(), event.sample.timestamp));
    } else if (event.type === "console") {
      setConsoleEntries((items) => [...items.slice(-599), event.entry]);
    } else {
      parameterOperation.current += 1;
      setConnection(deviceGateway.connection);
      setTelemetryEnabled(false);
      setSamples([]);
      setLastMotionCommand("");
      setAppliedParameters({});
      setRequestedParameterIds([]);
      setMotionHeight(null);
      setConsoleEntries((items) => [...items.slice(-599), {
        id: `disconnect-${Date.now()}`,
        timestamp: Date.now(),
        direction: "system",
        text: `设备掉线：${event.reason ?? "未知原因"}`,
      }]);
    }
  }), []);

  useEffect(() => {
    let cancelled = false;
    setConnectionBusy(true);
    setConnectionError(null);
    void deviceGateway.initialize()
      .then((snapshot) => {
        if (cancelled) return;
        setConnection(snapshot);
        setTelemetryEnabled(false);
        setSamples([]);
        setLastMotionCommand("");
        setAppliedParameters({});
        setRequestedParameterIds([]);
        setMotionHeight(null);
        setStartupError(null);
        setStartupReady(true);
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setStartupReady(false);
        const message = reason instanceof Error ? reason.message : String(reason);
        const safetyMessage = `无法确认并清理 Rust 后端遗留设备会话：${message}`;
        setStartupError(safetyMessage);
        setConnectionError(`启动安全检查失败，连接功能保持锁定：${message}。可点击“刷新”重试。`);
        setConnectionOpen(true);
      })
      .finally(() => {
        if (!cancelled) setConnectionBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [startupAttempt]);

  useEffect(() => {
    setPersonalizationPersisted(savePersonalization(personalization));
  }, [personalization]);

  useEffect(() => {
    const timer = window.setInterval(() => setFreshnessNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);

  const refreshPorts = useCallback(async (): Promise<void> => {
    setConnectionBusy(true);
    setConnectionError(null);
    try {
      setPorts(await deviceGateway.listSerialPorts());
    } catch (reason) {
      setConnectionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConnectionBusy(false);
    }
  }, []);

  const openConnection = useCallback(() => {
    parameterOperation.current += 1;
    setConnectionOpen(true);
    setConnectionError(null);
    if (!startupReady) {
      setConnectionError("正在执行启动安全检查并清理旧设备会话，请稍候。");
      setStartupAttempt((value) => value + 1);
      return;
    }
    void refreshPorts();
  }, [refreshPorts, startupReady]);

  const connect = useCallback(async (config: SerialConfig): Promise<void> => {
    if (!startupReady) {
      setConnectionError("启动安全检查尚未成功，连接功能仍被锁定。");
      return;
    }
    setConnectionBusy(true);
    parameterOperation.current += 1;
    setConnectionError(null);
    try {
      const snapshot = await deviceGateway.connect(config);
      setSamples([]);
      setLastMotionCommand("");
      setDraftParameters({ ...defaultParameterValues });
      setAppliedParameters({});
      setRequestedParameterIds([]);
      setMotionHeight(snapshot.mode === "mock" ? { value: 61.5, requested: true } : null);
      setParameterNotice("已进入新设备会话：草稿已回到上位机默认参考，所有设备参数仍视为未知。");
      setConnection(snapshot);
      if (snapshot.mode === "mock") {
        await deviceGateway.setTelemetry({ imu: true, rpm: true });
        setTelemetryEnabled(true);
        setConnection(deviceGateway.connection);
      } else {
        // 真实串口默认保持低流量；用户可在诊断页主动开启遥测。
        setTelemetryEnabled(false);
      }
      setConnectionOpen(false);
    } catch (reason) {
      setConnection(deviceGateway.connection);
      if (deviceGateway.connection.mode === "disconnected") {
        setAppliedParameters({});
        setRequestedParameterIds([]);
        setMotionHeight(null);
      }
      setConnectionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConnectionBusy(false);
    }
  }, [startupReady]);

  const disconnect = useCallback(async (): Promise<void> => {
    setConnectionBusy(true);
    parameterOperation.current += 1;
    setConnectionError(null);
    try {
      await deviceGateway.disconnect();
      setConnection(deviceGateway.connection);
      setTelemetryEnabled(false);
      setSamples([]);
      setLastMotionCommand("");
      setAppliedParameters({});
      setRequestedParameterIds([]);
      setMotionHeight(null);
      setConnectionOpen(false);
    } catch (reason) {
      setConnectionError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setConnectionBusy(false);
    }
  }, []);

  const recordParameterRequest = useCallback((command: string): void => {
    const request = parseParameterRequest(command);
    if (!request) return;
    if (request.automatic) {
      setAppliedParameters((current) => {
        const next = { ...current };
        delete next[request.id];
        return next;
      });
      return;
    }
    setAppliedParameters((current) => ({ ...current, [request.id]: request.value }));
    setRequestedParameterIds((current) => current.includes(request.id) ? current : [...current, request.id]);
    if (request.id === "legHeight") {
      setMotionHeight({ value: request.value, requested: true });
    }
  }, []);

  const sendText = useCallback(async (command: string): Promise<void> => {
    await deviceGateway.sendTextCommand(command, activeSessionId);
    recordParameterRequest(command);
  }, [activeSessionId, recordParameterRequest]);

  const sendMotion = useCallback(async (target: MotionTarget): Promise<void> => {
    const command = motionCommand(target);
    await deviceGateway.sendMotionTarget(target, activeSessionId);
    setLastMotionCommand(command);
    setMotionHeight({ value: target.height, requested: true });
  }, [activeSessionId]);

  const changeParameter = useCallback((id: string, next: number): void => {
    const definition = parameterDefinitions.find((item) => item.id === id);
    if (!definition || !Number.isFinite(next)) return;
    const value = Math.min(definition.max, Math.max(definition.min, next));
    setDraftParameters((current) => ({ ...current, [id]: value }));
  }, []);

  const sendParameter = useCallback(async (id: string): Promise<void> => {
    const definition = parameterDefinitions.find((item) => item.id === id);
    const value = draftParameters[id];
    if (!definition || value === undefined) return;
    const command = buildParameterCommand(definition, value);
    if (!command) {
      setParameterNotice(`${definition.label} 是预留参数，仅保存在本地档案。`);
      return;
    }
    setParameterSending(true);
    setParameterNotice(null);
    try {
      await deviceGateway.sendTextCommand(command, activeSessionId);
      recordParameterRequest(command);
      setParameterNotice(`${definition.label}写入请求已发送（Legacy 固件无 ACK）。`);
    } catch (reason) {
      setParameterNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setParameterSending(false);
    }
  }, [activeSessionId, draftParameters, recordParameterRequest]);

  const sendParameters = useCallback(async (ids: string[]): Promise<void> => {
    const operationId = ++parameterOperation.current;
    setParameterSending(true);
    setParameterNotice(null);
    let sent = 0;
    const expectedSessionId = activeSessionId;
    try {
      for (const id of ids) {
        if (parameterOperation.current !== operationId) throw new Error("页面或设备状态已变化，旧批量任务已取消");
        const definition = parameterDefinitions.find((item) => item.id === id);
        const value = draftParameters[id];
        if (!definition || value === undefined) continue;
        const command = buildParameterCommand(definition, value);
        if (!command) continue;
        await deviceGateway.sendTextCommand(command, expectedSessionId);
        if (parameterOperation.current !== operationId) throw new Error("页面或设备状态已变化，旧批量任务已取消");
        recordParameterRequest(command);
        sent += 1;
        await delay(120);
      }
      setParameterNotice(`已按 120 ms 间隔发送 ${sent} 项请求，避免挤满固件 4 深度命令队列。`);
    } catch (reason) {
      setParameterNotice(`批量发送在第 ${sent + 1} 项中止：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setParameterSending(false);
    }
  }, [activeSessionId, draftParameters, recordParameterRequest]);

  const restoreAutomaticParameter = useCallback(async (id: string): Promise<void> => {
    const command = id === "angleKp" ? "anglepid auto" : id === "angleBias" ? "anglebias auto" : null;
    if (!command) return;
    setParameterSending(true);
    setParameterNotice(null);
    try {
      await deviceGateway.sendTextCommand(command, activeSessionId);
      recordParameterRequest(command);
      setParameterNotice(`已请求 ${command}；HEAD 基线可能忽略该命令，Legacy 固件无 ACK。`);
    } catch (reason) {
      setParameterNotice(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setParameterSending(false);
    }
  }, [activeSessionId, recordParameterRequest]);

  const saveProfile = useCallback((name: string, description: string): void => {
    const profile: ParameterProfile = {
      id: `profile-${Date.now().toString(36)}`,
      name,
      description,
      updatedAt: Date.now(),
      values: { ...draftParameters },
    };
    const next = [...profiles, profile];
    setProfiles(next);
    const persisted = saveProfiles(next.filter((item) => !item.builtIn));
    setParameterNotice(persisted
      ? `档案“${name}”已保存在本机。`
      : `档案“${name}”仅保留在当前会话：本机存储写入失败。`);
  }, [draftParameters, profiles]);

  const deleteProfile = useCallback((id: string): void => {
    const next = profiles.filter((item) => item.id !== id);
    setProfiles(next);
    if (!saveProfiles(next.filter((item) => !item.builtIn))) {
      setParameterNotice("档案已从当前列表移除，但本机存储更新失败；刷新后可能重新出现。");
    }
  }, [profiles]);

  const updatePersonalization = useCallback((next: PersonalizationSettings): void => {
    setPersonalization({ ...defaultPersonalization, ...next });
  }, []);

  const setTelemetry = useCallback(async (enabled: boolean): Promise<void> => {
    await deviceGateway.setTelemetry({ imu: enabled, rpm: enabled }, activeSessionId);
    setTelemetryEnabled(enabled);
    setConnection(deviceGateway.connection);
  }, [activeSessionId]);

  const shellAttributes = useMemo(() => ({
    "data-accent": personalization.accent,
    "data-glass": personalization.glassStrength,
    "data-reduced-motion": personalization.reducedMotion ? "true" : "false",
  }), [personalization]);

  const navigate = useCallback((next: PageId): void => {
    if (next !== page) parameterOperation.current += 1;
    setPage(next);
  }, [page]);

  const currentMeta = pageMeta[page];
  return (
    <div className="app-shell" {...shellAttributes}>
      <div className="ambient ambient--one" /><div className="ambient ambient--two" /><div className="ambient ambient--three" />
      <Sidebar page={page} robotName={personalization.robotName} connection={connection} onPageChange={navigate} onConnectionOpen={openConnection} />
      <div className="workspace">
        <header className="topbar glass-panel">
          <div className="breadcrumbs"><span>WL1 Studio</span><ChevronRight size={14} /><strong>{currentMeta.label}</strong><small>{currentMeta.eyebrow}</small></div>
          <div className="topbar-actions">
            <span className="topbar-clock"><Clock3 size={15} />{new Date().toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span>
            <button className="icon-button" type="button" aria-label="帮助"><CircleHelp size={18} /></button>
            <button className="icon-button notification-button" type="button" aria-label="通知"><Bell size={18} /><i /></button>
            <button className={connected ? "connection-button is-online" : startupError ? "connection-button is-fault" : "connection-button"} type="button" onClick={openConnection}><span className="status-orb" /><div><small>{connected ? "CONNECTED" : startupError ? "SAFETY LOCKED" : "OFFLINE"}</small><strong>{startupError ? "需要人工确认" : connection.label}</strong></div><Cable size={17} /></button>
          </div>
        </header>

        {startupError && (
          <section className="startup-danger-banner" role="alert">
            <AlertTriangle size={22} />
            <div><strong>启动安全检查失败：不要把“离线”视为机器人已经停止</strong><span>{startupError}。请先准备物理断电，再重试安全清理；成功前连接与写入功能保持锁定。</span></div>
            <button className="danger-button" type="button" disabled={connectionBusy} onClick={() => setStartupAttempt((value) => value + 1)}>{connectionBusy ? "正在重试…" : "重试安全清理"}</button>
          </section>
        )}

        <main className="page-content">
          {page === "overview" && <OverviewPage connection={connection} samples={samples} imuFresh={imuFresh} rpmFresh={rpmFresh} robotName={personalization.robotName} ledColor={personalization.ledColor} compactTelemetry={personalization.compactTelemetry} onConnect={openConnection} onNavigate={navigate} />}
          {page === "kinematics" && <KinematicsPage />}
          {page === "tuning" && <TuningPage connected={connected} writesUnlocked={writesUnlocked} draft={draftParameters} applied={appliedParameters} requestedIds={requestedParameterIds} profiles={profiles} sending={parameterSending} notice={parameterNotice} onChange={changeParameter} onSendOne={(id) => void sendParameter(id)} onSendMany={(ids) => void sendParameters(ids)} onRestoreAuto={(id) => void restoreAutomaticParameter(id)} onLoadProfile={(profile) => { setDraftParameters({ ...defaultParameterValues, ...profile.values }); setParameterNotice(`已载入“${profile.name}”到草稿区；设备值未知项也会列为待请求。`); }} onSaveProfile={saveProfile} onDeleteProfile={deleteProfile} onResetDraft={() => setDraftParameters(mergeKnownParameterValues(appliedParameters))} />}
          {page === "control" && <ControlPage key={`${activeSessionId ?? "disconnected"}-${connectionOpen || parameterSending ? "suspended" : "ready"}`} connected={connected} writesUnlocked={writesUnlocked} suspended={connectionOpen || connectionBusy || parameterSending || !startupReady} sample={imuFresh || rpmFresh ? latest : undefined} imuFresh={imuFresh} rpmFresh={rpmFresh} telemetryRequired={telemetryEnabled} telemetryHealthy={!telemetryEnabled || (imuFresh && rpmFresh)} lastCommand={lastMotionCommand} heightTarget={motionHeight?.value ?? null} heightRequested={motionHeight?.requested ?? false} onHeightTargetChange={(value) => setMotionHeight({ value, requested: false })} onSendMotion={sendMotion} />}
          {page === "calibration" && <CalibrationPage connected={connected} writesUnlocked={writesUnlocked} samples={imuFresh ? samples : []} onSendText={sendText} />}
          {page === "personalization" && <PersonalizationPage settings={personalization} persisted={personalizationPersisted} onChange={updatePersonalization} />}
          {page === "diagnostics" && <DiagnosticsPage connection={connection} entries={consoleEntries} telemetryEnabled={telemetryEnabled} writesUnlocked={writesUnlocked} onSend={sendText} onTelemetryChange={setTelemetry} onClear={() => setConsoleEntries([])} onConnectionOpen={openConnection} />}
        </main>
      </div>

      <ConnectionModal open={connectionOpen} connection={connection} ports={ports} loading={connectionBusy} startupReady={startupReady} error={connectionError} onClose={() => setConnectionOpen(false)} onRefresh={() => { if (startupReady) void refreshPorts(); else setStartupAttempt((value) => value + 1); }} onConnect={(config) => void connect(config)} onDisconnect={() => void disconnect()} />
    </div>
  );
}
