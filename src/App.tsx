import {
  AlertTriangle,
  ArrowLeft,
  Cable,
  ChevronRight,
  Clock3,
  Gauge,
  Gamepad2,
  Music2,
  Nfc,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { CalibrationPage } from "./components/pages/CalibrationPage";
import { ControlPage } from "./components/pages/ControlPage";
import { DiagnosticsPage } from "./components/pages/DiagnosticsPage";
import { KinematicsPage } from "./components/pages/KinematicsPage";
import { OverviewPage } from "./components/pages/OverviewPage";
import { TuningPage } from "./components/pages/TuningPage";
import { PianoStudio } from "./components/piano/PianoStudio";
import { GameBoxStudio } from "./components/gamebox/GameBoxStudio";
import { NfcStudio } from "./components/nfc/NfcStudio";
import { LiveChart } from "./components/LiveChart";
import { ConnectionModal } from "./components/ConnectionModal";
import { ProductHome } from "./components/ProductHome";
import { Sidebar } from "./components/Sidebar";
import {
  buildParameterCommand,
  defaultParameterValues,
  parameterDefinitions,
} from "./data/parameters";
import { deviceGateway, motionCommand } from "./lib/device";
import { gameboxGateway } from "./lib/gamebox";
import { nfcGateway } from "./lib/nfc";
import { isRemoteConnection, REMOTE_COMMAND_INTERVAL_MS } from "./lib/connection";
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

const pageMeta: Record<PageId, { label: string }> = {
  overview: { label: "总览" },
  kinematics: { label: "腿部运动学" },
  tuning: { label: "运动工作台" },
  control: { label: "实时控制" },
  calibration: { label: "标定向导" },
  diagnostics: { label: "诊断终端" },
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

type AppView = "products" | "wl1" | "piano" | "gamebox" | "nfc";
type ProductTransitionState = "idle" | "covering" | "revealing";
type CatalogSafetyState = "checking" | "ready" | "error";

const pianoPreviewEnabled = import.meta.env.DEV
  || import.meta.env.VITE_ENABLE_PIANO_PREVIEW === "true";

interface Wl1StudioProps {
  onBack: () => void;
  personalization: PersonalizationSettings;
}

export default function App() {
  const [personalization, setPersonalization] = useState<PersonalizationSettings>(loadPersonalization);
  const [personalizationPersisted, setPersonalizationPersisted] = useState(true);
  const [view, setView] = useState<AppView>("products");
  const [productTransition, setProductTransition] = useState<ProductTransitionState>("idle");
  const [launchTarget, setLaunchTarget] = useState<Exclude<AppView, "products"> | null>(null);
  const [catalogSafety, setCatalogSafety] = useState<CatalogSafetyState>("checking");
  const [catalogSafetyError, setCatalogSafetyError] = useState<string | null>(null);
  const [catalogSafetyAttempt, setCatalogSafetyAttempt] = useState(0);

  useEffect(() => {
    setPersonalizationPersisted(savePersonalization(personalization));
  }, [personalization]);

  const updatePersonalization = useCallback((next: PersonalizationSettings): void => {
    setPersonalization({ ...defaultPersonalization, ...next });
  }, []);

  useEffect(() => {
    // The generation is intentionally read only to make each explicit retry
    // start a fresh initialization attempt.
    void catalogSafetyAttempt;
    let cancelled = false;
    setCatalogSafety("checking");
    setCatalogSafetyError(null);
    void deviceGateway.initialize()
      .then(() => gameboxGateway.initialize())
      .then(() => nfcGateway.initialize())
      .then(() => {
        if (!cancelled) setCatalogSafety("ready");
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        const message = reason instanceof Error ? reason.message : String(reason);
        setCatalogSafetyError(message);
        setCatalogSafety("error");
      });
    return () => {
      cancelled = true;
    };
  }, [catalogSafetyAttempt]);

  useEffect(() => {
    document.title = view === "products"
      ? "设备控制中心 · 选择产品"
      : view === "wl1"
        ? "WL1 Studio · 轮腿控制中心"
        : view === "gamebox"
          ? "GameBox Studio · 游戏机工作台"
          : view === "nfc"
            ? "NFC Studio · PN532 读卡器"
            : "KeyNest Studio · 口袋电子琴";
  }, [view]);

  useEffect(() => {
    if (productTransition === "idle") return;
    const duration = productTransition === "covering" ? 460 : 560;
    const timer = window.setTimeout(() => {
      if (productTransition === "covering") {
        if (!launchTarget) {
          setProductTransition("idle");
          return;
        }
        setView(launchTarget);
        setProductTransition("revealing");
      } else {
        setProductTransition("idle");
        setLaunchTarget(null);
      }
    }, duration);
    return () => window.clearTimeout(timer);
  }, [launchTarget, productTransition]);

  const openProduct = useCallback((target: Exclude<AppView, "products">): void => {
    if (catalogSafety !== "ready" || productTransition !== "idle") return;
    if (target === "piano" && !pianoPreviewEnabled) return;
    if (personalization.reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setView(target);
      return;
    }
    setLaunchTarget(target);
    setProductTransition("covering");
  }, [catalogSafety, personalization.reducedMotion, productTransition]);

  const launchLabel = launchTarget === "piano" ? "KeyNest Studio"
    : launchTarget === "gamebox" ? "GameBox Studio"
      : launchTarget === "nfc" ? "NFC Studio" : "WL1 Studio";

  return (
    <div
      className="app-stage"
      data-accent={personalization.accent}
      data-glass={personalization.glassStrength}
      data-reduced-motion={personalization.reducedMotion ? "true" : "false"}
    >
      {view === "products" ? (
        <ProductHome
          safetyState={catalogSafety}
          safetyError={catalogSafetyError}
          pianoPreviewEnabled={pianoPreviewEnabled}
          launching={productTransition === "covering" ? launchTarget : null}
          personalization={personalization}
          personalizationPersisted={personalizationPersisted}
          onPersonalizationChange={updatePersonalization}
          onRetrySafety={() => setCatalogSafetyAttempt((value) => value + 1)}
          onOpenWl1={() => openProduct("wl1")}
          onOpenPiano={() => openProduct("piano")}
          onOpenGameBox={() => openProduct("gamebox")}
          onOpenNfc={() => openProduct("nfc")}
        />
      ) : view === "wl1" ? (
        <Wl1Studio personalization={personalization} onBack={() => setView("products")} />
      ) : view === "gamebox" ? (
        <GameBoxStudio onBack={() => setView("products")} />
      ) : view === "nfc" ? (
        <NfcStudio onBack={() => setView("products")} />
      ) : (
        <PianoStudio onBack={() => setView("products")} />
      )}

      {productTransition !== "idle" && (
        <div
          className={`product-transition is-${productTransition}`}
          role="status"
          aria-label={`正在打开 ${launchLabel}`}
        >
          <span className="product-transition__wash" />
          <span className="product-transition__content">
            <span className="product-transition__mark" aria-hidden="true">
              {launchTarget === "piano" ? <Music2 size={29} strokeWidth={2.2} />
                : launchTarget === "gamebox" ? <Gamepad2 size={29} strokeWidth={2.2} />
                  : launchTarget === "nfc" ? <Nfc size={29} strokeWidth={2.2} />
                    : <Gauge size={29} strokeWidth={2.2} />}
              <i />
            </span>
            <span><small>正在打开</small><strong>{launchLabel}</strong></span>
          </span>
        </div>
      )}
    </div>
  );
}

function Wl1Studio({ onBack, personalization }: Wl1StudioProps) {
  const [page, setPage] = useState<PageId>("tuning");
  const [connection, setConnection] = useState<ConnectionSnapshot>(deviceGateway.connection);
  const [startupReady, setStartupReady] = useState(false);
  const [startupError, setStartupError] = useState<string | null>(null);
  const [startupAttempt, setStartupAttempt] = useState(0);
  const [connectionBusy, setConnectionBusy] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [ports, setPorts] = useState<SerialPortOption[]>([]);
  const [samples, setSamples] = useState<TelemetrySample[]>([]);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([initialConsole]);
  const [telemetryEnabled, setTelemetryEnabled] = useState(false);
  const [telemetryBusy, setTelemetryBusy] = useState(false);
  const [telemetryError, setTelemetryError] = useState<string | null>(null);
  const [draftParameters, setDraftParameters] = useState<ParameterValues>({ ...defaultParameterValues });
  const [appliedParameters, setAppliedParameters] = useState<Partial<ParameterValues>>({});
  const [requestedParameterIds, setRequestedParameterIds] = useState<string[]>([]);
  const [profiles, setProfiles] = useState<ParameterProfile[]>(() => [...builtinProfiles, ...loadProfiles()]);
  const [parameterSending, setParameterSending] = useState(false);
  const [parameterNotice, setParameterNotice] = useState<string | null>(null);
  const [lastMotionCommand, setLastMotionCommand] = useState("");
  const [motionHeight, setMotionHeight] = useState<{ value: number; requested: boolean } | null>(null);
  const [freshnessNow, setFreshnessNow] = useState(Date.now());
  const parameterOperation = useRef(0);

  const connected = connection.mode !== "disconnected";
  const remote = isRemoteConnection(connection);
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
      // arrived 20 Hz frame as a future (therefore stale) timestamp.
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
    // Retries deliberately re-run the complete backend cleanup handshake.
    void startupAttempt;
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
      })
      .finally(() => {
        if (!cancelled) setConnectionBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [startupAttempt]);

  useEffect(() => {
    // Nothing can become stale while disconnected. Avoid waking and
    // re-rendering the whole product hub four times per second while idle.
    if (!connected || remote) return;
    const timer = window.setInterval(() => setFreshnessNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [connected, remote]);

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

  useEffect(() => {
    if (startupReady) void refreshPorts();
  }, [refreshPorts, startupReady]);

  const openConnection = useCallback(() => {
    const reducedMotion = personalization.reducedMotion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    document.getElementById("device-connection")?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
    document.querySelector<HTMLElement>("#device-connection select, #device-connection button")?.focus({ preventScroll: true });
  }, [personalization.reducedMotion]);

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
      setAppliedParameters({});
      setRequestedParameterIds([]);
      setMotionHeight(null);
      setParameterNotice(isRemoteConnection(snapshot)
        ? "已打开遥控器串口：可发送 PID 与姿态偏置；需桥接固件，无法确认小车在线或参数生效。"
        : "已连接：保留当前参数草稿，点击下发即可应用。设备当前参数尚未确认。");
      setConnection(snapshot);
      if (snapshot.mode === "mock") {
        await deviceGateway.setTelemetry({ imu: true, rpm: true });
        setTelemetryEnabled(true);
        setConnection(deviceGateway.connection);
      } else {
        // 真实串口默认保持低流量；用户可在工作台或诊断页开启遥测。
        setTelemetryEnabled(false);
      }
      setPage("tuning");
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
    setMotionHeight((current) => current?.value === target.height ? { ...current, requested: true } : current);
  }, [activeSessionId]);

  const changeParameter = useCallback((id: string, next: number): void => {
    const definition = parameterDefinitions.find((item) => item.id === id);
    if (!definition || !Number.isFinite(next)) return;
    const value = Math.min(definition.max, Math.max(definition.min, next));
    setDraftParameters((current) => ({ ...current, [id]: value }));
    if (id === "legHeight") setMotionHeight(null);
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
        await delay(REMOTE_COMMAND_INTERVAL_MS);
      }
      setParameterNotice(`已按至少 ${REMOTE_COMMAND_INTERVAL_MS} ms 间隔发送 ${sent} 项请求；${remote ? "已写入遥控器串口，小车是否执行仍未知。" : "Legacy 固件无 ACK，设备值仍需人工验证。"}`);
    } catch (reason) {
      setParameterNotice(`批量发送在第 ${sent + 1} 项中止：${reason instanceof Error ? reason.message : String(reason)}`);
    } finally {
      setParameterSending(false);
    }
  }, [activeSessionId, draftParameters, recordParameterRequest, remote]);

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

  const setTelemetry = useCallback(async (enabled: boolean): Promise<void> => {
    await deviceGateway.setTelemetry({ imu: enabled, rpm: enabled }, activeSessionId);
    setTelemetryEnabled(enabled);
    setConnection(deviceGateway.connection);
  }, [activeSessionId]);

  const navigate = useCallback((next: PageId): void => {
    if (next !== page) parameterOperation.current += 1;
    setPage(next === "control" ? "tuning" : next);
  }, [page]);

  const returnToProductHome = useCallback((): void => {
    if (connectionBusy) {
      setConnectionError("当前设备操作尚未完成，请等待操作结束后再返回产品首页。");
      return;
    }
    if (connected) {
      setConnectionError("切换产品前请先断开当前设备，避免设备会话在后台继续运行。");
      return;
    }
    if (!startupReady) {
      setConnectionError("启动安全检查完成前不能离开当前工作台，请先完成安全清理。");
      return;
    }
    parameterOperation.current += 1;
    onBack();
  }, [connected, connectionBusy, onBack, startupReady]);

  const currentMeta = pageMeta[page];
  return (
    <div className="app-shell wl1-shell">
      <div className="ambient ambient--one" /><div className="ambient ambient--two" /><div className="ambient ambient--three" />
      <Sidebar page={page} robotName={personalization.robotName} connection={connection} onPageChange={navigate} onConnectionOpen={openConnection} />
      <div className="workspace">
        <header className="topbar glass-panel">
          <div className="topbar-context">
            <button
              className="icon-button topbar-home-button"
              type="button"
              aria-label="返回产品首页"
              title={connected ? "请先断开当前设备" : "返回产品首页"}
              onClick={returnToProductHome}
            >
              <ArrowLeft size={18} />
            </button>
            <div className="breadcrumbs"><span>WL1 控制台</span><ChevronRight size={14} /><strong>{currentMeta.label}</strong></div>
          </div>
          <div className="topbar-actions">
            <span className="topbar-clock"><Clock3 size={15} />{new Date().toLocaleDateString("zh-CN", { month: "short", day: "numeric" })}</span>
            <button className={connected ? "connection-button is-online" : startupError ? "connection-button is-fault" : "connection-button"} type="button" onClick={openConnection}><span className="status-orb" /><div><small>{remote ? "REMOTE SERIAL OPEN" : connected ? "CONNECTED" : startupError ? "SAFETY LOCKED" : "OFFLINE"}</small><strong>{startupError ? "初始化失败" : connected ? connection.label : "连接设备"}</strong></div><Cable size={17} /></button>
          </div>
        </header>

        <ConnectionModal connection={connection} ports={ports} loading={connectionBusy} startupReady={startupReady} error={connectionError} onRefresh={() => { if (startupReady) void refreshPorts(); else setStartupAttempt((value) => value + 1); }} onConnect={(config) => void connect(config)} onDisconnect={() => void disconnect()} />

        {startupError && (
          <section className="startup-danger-banner" role="alert">
            <AlertTriangle size={22} />
            <div><strong>启动安全检查失败：不要把“离线”视为机器人已经停止</strong><span>{startupError}。请先准备物理断电，再重试安全清理；成功前连接与写入功能保持锁定。</span></div>
            <button className="danger-button" type="button" disabled={connectionBusy} onClick={() => setStartupAttempt((value) => value + 1)}>{connectionBusy ? "正在重试…" : "重试安全清理"}</button>
          </section>
        )}

        <main className="page-content">
          {remote && (page === "control" || page === "calibration") && (
            <div className="page-stack">
              <section className="page-heading"><div><h1>{currentMeta.label}</h1><p>当前通过遥控器进行无线调参。</p></div></section>
              <section className="glass-card capability-note">
                <Cable size={24} />
                <div><h2>{page === "control" ? "运动由实体遥控器控制" : "标定需要直连小车"}</h2><p>{page === "control" ? "遥控器持续发送摇杆目标，运动与腿高请在遥控器上操作。使用电脑实时控制时，请断开后切换为直连小车。" : "当前无线桥接没有 IMU / RPM 回传。请直连小车采样标定；PID 与姿态偏置仍可在参数调校页无线下发。"}</p><button className="primary-button" type="button" onClick={() => navigate("tuning")}>前往无线调参</button></div>
              </section>
            </div>
          )}
          {page === "overview" && <OverviewPage connection={connection} samples={samples} imuFresh={imuFresh} rpmFresh={rpmFresh} robotName={personalization.robotName} ledColor={personalization.ledColor} compactTelemetry={personalization.compactTelemetry} onConnect={openConnection} onNavigate={navigate} />}
          {page === "kinematics" && <KinematicsPage />}
          {page === "tuning" && <TuningPage remote={remote} connected={connected} writesUnlocked={writesUnlocked} draft={draftParameters} applied={appliedParameters} requestedIds={requestedParameterIds} profiles={profiles} sending={parameterSending || connectionBusy} notice={parameterNotice} onChange={changeParameter} onSendOne={(id) => void sendParameter(id)} onSendMany={(ids) => void sendParameters(ids)} onRestoreAuto={(id) => void restoreAutomaticParameter(id)} onLoadProfile={(profile) => { setMotionHeight(null); setDraftParameters({ ...defaultParameterValues, ...profile.values }); setParameterNotice(`已载入“${profile.name}”到草稿区；设备值未知项也会列为待请求。`); }} onSaveProfile={saveProfile} onDeleteProfile={deleteProfile} onResetDraft={() => { setMotionHeight(null); setDraftParameters(mergeKnownParameterValues(appliedParameters)); }} controlPanel={!remote ? (<ControlPage compact suggestedHeight={draftParameters.legHeight} key={activeSessionId ?? "disconnected"} connected={connected} writesUnlocked={writesUnlocked} suspended={connectionBusy || parameterSending || telemetryBusy || !startupReady} sample={imuFresh || rpmFresh ? latest : undefined} imuFresh={imuFresh} rpmFresh={rpmFresh} telemetryRequired={telemetryEnabled} telemetryHealthy={!telemetryEnabled || (imuFresh && rpmFresh)} lastCommand={lastMotionCommand} heightTarget={motionHeight?.value ?? null} heightRequested={motionHeight?.requested ?? false} onHeightTargetChange={(value) => setMotionHeight({ value, requested: false })} onSendMotion={sendMotion} />) : undefined} telemetryPanel={!remote ? (
            <section className="workbench-telemetry glass-card" aria-label="实时反馈">
              <div className="workbench-telemetry__heading"><h2>实时反馈</h2><button className="text-button" type="button" disabled={!connected || connectionBusy || telemetryBusy || parameterSending} onClick={() => {
                setTelemetryBusy(true); setTelemetryError(null);
                void setTelemetry(!telemetryEnabled).catch((reason: unknown) => setTelemetryError(reason instanceof Error ? reason.message : String(reason))).finally(() => setTelemetryBusy(false));
              }}>{telemetryBusy ? "切换中…" : telemetryEnabled ? "关闭遥测" : "开启遥测"}</button></div>
              <div className="workbench-telemetry__values"><div><span>俯仰 / 横滚</span><strong>{imuFresh ? latest?.pitch.toFixed(1) : "--"} / {imuFresh ? latest?.roll.toFixed(1) : "--"}<small> °</small></strong></div><div><span>左轮 / 右轮</span><strong>{rpmFresh ? latest?.leftRpm.toFixed(0) : "--"} / {rpmFresh ? latest?.rightRpm.toFixed(0) : "--"}<small> rpm</small></strong></div></div>
              <LiveChart samples={imuFresh ? samples : []} compact />
              {!telemetryEnabled && <p className="workbench-footnote">开启遥测后，可边调参数边观察姿态与轮速。</p>}
              {telemetryEnabled && (!imuFresh || !rpmFresh) && <p className="workbench-footnote">等待新的姿态与轮速数据…</p>}
              {telemetryError && <div className="inline-error" role="alert">{telemetryError}</div>}
            </section>
          ) : undefined} />}
          {page === "calibration" && !remote && <CalibrationPage connected={connected} writesUnlocked={writesUnlocked} samples={imuFresh ? samples : []} onSendText={sendText} />}
          {page === "diagnostics" && <DiagnosticsPage connection={connection} entries={consoleEntries} telemetryEnabled={telemetryEnabled} writesUnlocked={writesUnlocked} onSend={sendText} onTelemetryChange={setTelemetry} onClear={() => setConsoleEntries([])} onConnectionOpen={openConnection} />}
        </main>
      </div>

    </div>
  );
}
