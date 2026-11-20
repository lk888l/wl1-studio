import { useEffect, useRef, useState } from "react";
import { Activity, ArrowLeft, Cable, ChevronDown, CircleStop, ListTree, Radio, Route, Wrench } from "lucide-react";
import { isTauriRuntime } from "../../lib/device";
import { defaultLink, driveState, foc, hex, phases, type Discovery, type Link } from "../../lib/foc";
import { Maintenance, Parameters, PdoEditor } from "./Configuration";
import { MotorScope } from "./MotorScope";
import { Operations } from "./Operations";
import { useMotor, type Ask } from "./useMotor";
import "./MotorStudio.css";

const tabs = [
  ["运动台", Activity],
  ["参数字典", ListTree],
  ["PDO 路由", Route],
  ["校准与存储", Wrench],
] as const;
const rateLabel = (rate: number) => (rate >= 1000000 ? `${rate / 1000000} Mbit/s` : `${rate / 1000} kbit/s`);
type Decision = {
  title: string;
  message: string;
  execute: () => void;
  session?: number;
};

export function MotorStudio({ onBack }: { onBack: () => void }) {
  const motor = useMotor();
  const { view, busy } = motor;
  const [tab, setTab] = useState(0),
    [link, setLink] = useState<Link>(defaultLink);
  const [scopeExpanded, setScopeExpanded] = useState(false);
  const [showConnection, setShowConnection] = useState(false);
  const [discovery, setDiscovery] = useState<Discovery | null>(null),
    [decision, setDecision] = useState<Decision | null>(null);
  const dialog = useRef<HTMLDialogElement>(null),
    desktop = isTauriRuntime();
  const change = (update: Partial<Link>) => {
    setLink((old) => ({ ...old, ...update }));
    setDiscovery(null);
  };
  const valid = Number.isInteger(link.node) && link.node >= 1 && link.node <= 127;
  const ask: Ask = (title, message, execute) =>
    setDecision({ title, message, execute, session: view?.session });
  useEffect(() => {
    if (decision) dialog.current?.showModal();
    else dialog.current?.close();
  }, [decision]);
  const leave = () => {
    if (!view) onBack();
    else
      void motor.release().then((ok) => {
        if (ok) onBack();
      });
  };
  const blocked = busy || !!motor.pollError;
  const stopOutput = () => {
    setDecision(null);
    void motor.stop();
  };
  const config = { view, busy: blocked, run: motor.run, ask };
  const feedback = view?.feedback;
  const stale = !!view && (view.age_ms >= 1000 || !!motor.pollError || !!view.io_error || view.reset);
  const metrics = [
    ["机械位置", feedback?.position, "rev", 3],
    ["实际转速", feedback?.velocity, "rev/s", 2],
    ["交轴电流", feedback && feedback.iq_ma / 1000, "A", 3],
    ["母线电压", feedback && feedback.bus_mv / 1000, "V", 2],
  ] as const;
  const listen = async () => {
    setDiscovery(null);
    const result = await motor.perform(() => foc.listen(link));
    if (result) setDiscovery(result);
  };
  const logControls = (
    <div className="motor-log">
      <span>
        {motor.recording ? "● 录制中" : "遥测记录"} · {motor.logged} 个样本
      </span>
      <button
        type="button"
        disabled={!motor.recording && (!view || view.reset)}
        onClick={() => {
          if (!motor.recording && motor.logged)
            ask("开始新录制？", "之前的录制会被替换。如需保留，请先导出 CSV。", motor.toggleLog);
          else motor.toggleLog();
        }}
      >
        {motor.recording ? "停止录制" : "开始录制"}
      </button>
      <button type="button" disabled={!motor.logged} onClick={motor.exportLog}>
        导出 CSV
      </button>
    </div>
  );
  return (
    <main className="motor-studio" data-scope-expanded={scopeExpanded}>
      <div className="motor-shell">
        <header className="motor-head">
          <button
            type="button"
            className="motor-back"
            aria-label="返回产品目录"
            disabled={busy}
            onClick={leave}
          >
            <ArrowLeft size={17} />
          </button>
          <div className="motor-heading">
            <small>CF LAB &nbsp; / &nbsp; MOTION CONTROL</small>
            <h1>
              电机驱动台 <span>G431</span>
            </h1>
          </div>
          {scopeExpanded && logControls}
          <div className="motor-head-actions">
            <span className="motor-badge" data-live={!!view && !stale}>
              {view ? (stale && view.phase !== "unconfirmed" ? "反馈未刷新" : phases[view.phase]) : "离线"}
            </span>
            <button
              type="button"
              className="motor-stop"
              disabled={!view || motor.stopping || view.reset}
              onClick={stopOutput}
            >
              <CircleStop size={17} />
              {motor.stopping ? "正在关桥…" : "立即关桥"}
            </button>
          </div>
        </header>
        <div className="motor-layout">
          <aside className="motor-side" data-open={showConnection}>
            <div className="motor-side-heading">
              <small>INTERFACE / GS_USB</small>
              <h2>
                <Cable size={21} />
                总线接入
              </h2>
              <button
                type="button"
                className="motor-connection-toggle"
                aria-expanded={showConnection}
                aria-label={showConnection ? "收起总线接入" : "展开总线接入"}
                onClick={() => setShowConnection(!showConnection)}
              >
                <ChevronDown size={17} />
              </button>
            </div>
            <p>连接只读身份和反馈，不使能功率桥。</p>
            <fieldset disabled={!!view || busy}>
              <label>
                适配器通道
                <select
                  value={link.channel}
                  onChange={(event) => change({ channel: Number(event.target.value) })}
                >
                  {[0, 1, 2, 3].map((channel) => (
                    <option key={channel} value={channel}>
                      gs_usb · can{channel}
                    </option>
                  ))}
                </select>
              </label>
              {(
                [
                  ["nominal", "仲裁段", [125000, 250000, 500000, 1000000]],
                  ["data", "数据段", [1000000, 2000000, 4000000, 5000000, 8000000]],
                ] as const
              ).map(([key, name, rates]) => (
                <label key={key}>
                  {name}
                  <select
                    value={link[key]}
                    onChange={(event) => change({ [key]: Number(event.target.value) })}
                  >
                    {rates.map((rate) => (
                      <option key={rate} value={rate}>
                        {rateLabel(rate)}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label>
                目标节点 ID
                <input
                  type="number"
                  min={1}
                  max={127}
                  value={link.node || ""}
                  onChange={(event) => setLink({ ...link, node: Number(event.target.value) })}
                />
              </label>
            </fieldset>
            {view ? (
              <>
                <button type="button" disabled={busy} onClick={() => void motor.release()}>
                  断开并释放通道
                </button>
                {view.phase === "unconfirmed" && (
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      ask(
                        "已物理切断电机电源？",
                        "仅在现场已确认功率电源断开的情况下释放通道。这不会恢复未完成的 RAM 映射。",
                        () => void motor.release(true),
                      )
                    }
                  >
                    已物理断电，强制释放
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  className="motor-primary"
                  disabled={busy || !desktop || !valid}
                  onClick={() => void motor.connect(link)}
                >
                  <Cable size={15} />
                  读取并连接
                </button>
                <button type="button" disabled={busy || !desktop || !valid} onClick={() => void listen()}>
                  <Radio size={15} />
                  被动监听 2 s
                </button>
              </>
            )}
            {discovery && !view && (
              <div className="motor-discovery">
                <strong>监听结果</strong>
                {discovery.nodes.map(([node, state]) => (
                  <button type="button" key={node} onClick={() => setLink({ ...link, node })}>
                    节点 {node} · 心跳 0x{hex(state, 2)}
                  </button>
                ))}
                <p>
                  {discovery.ids.length
                    ? `观测 ID：${discovery.ids.map((id) => hex(id, 3)).join(" / ")}`
                    : "未观测到帧；不能据此判定通道被占用。"}
                </p>
                {discovery.health && <p>{discovery.health}</p>}
              </div>
            )}
            <div className="motor-side-foot">
              <span>控制通道</span>
              <b>RPDO → 电机</b>
              <span>周期反馈</span>
              <b>TPDO4 → 主站</b>
            </div>
          </aside>
          <div className="motor-main">
            <div className="motor-instruments">
              <div className="motor-instrument-head">
                <span>AXIS / {String(view?.link.node ?? link.node).padStart(2, "0")}</span>
                <span>
                  {view
                    ? `${stale ? "上次反馈" : driveState(view.feedback.status)} · ${view.source}`
                    : "未连接 · 无遥测"}
                </span>
              </div>
              <div className="motor-metrics">
                {metrics.map(([label, value, unit, digits]) => (
                  <div key={label}>
                    <small>{label}</small>
                    <strong>{value === undefined ? "—" : value.toFixed(digits)}</strong>
                    <span>{unit}</span>
                  </div>
                ))}
              </div>
            </div>
            {!desktop && (
              <p className="motor-banner">浏览器仅供离线查看。连接 gs_usb 及下发命令请使用桌面版。</p>
            )}
            {(motor.error || view?.error || view?.io_error || motor.pollError) && (
              <p role="alert" className="motor-banner motor-fault">
                {[
                  ...new Set([motor.error, view?.error, view?.io_error, motor.pollError].filter(Boolean)),
                ].join("；")}
              </p>
            )}
            {view?.reset && (
              <p className="motor-banner">已复位。请释放连接，并按保存后的节点 ID 和速率重新连接。</p>
            )}
            {motor.notice && (
              <p role="status" className="motor-banner">
                {motor.notice}
              </p>
            )}
            {!scopeExpanded && (
              <div className="motor-workspace-bar">
                <nav className="motor-tabs" aria-label="驱动台功能">
                  {tabs.map(([title, Icon], index) => (
                    <button type="button" key={title} aria-pressed={tab === index} onClick={() => setTab(index)}>
                      <Icon size={16} />
                      {title}
                    </button>
                  ))}
                </nav>
                {logControls}
              </div>
            )}
            <div className="motor-page" key={view?.session ?? "offline"}>
              {tab === 0 ? (
                <>
                  <MotorScope
                    points={motor.points}
                    stale={stale}
                    expanded={scopeExpanded}
                    onExpandedChange={setScopeExpanded}
                  />
                  <Operations {...config} />
                </>
              ) : tab === 1 ? (
                <Parameters {...config} />
              ) : tab === 2 ? (
                <PdoEditor {...config} />
              ) : (
                <Maintenance {...config} />
              )}
            </div>
          </div>
        </div>
        <dialog
          className="motor-dialog"
          ref={dialog}
          onCancel={() => setDecision(null)}
          aria-labelledby="motor-confirm-title"
        >
          <small>OPERATOR CONFIRMATION</small>
          <h2 id="motor-confirm-title">{decision?.title}</h2>
          <p>{decision?.message}</p>
          <div className="motor-buttons">
            <button type="button" onClick={() => setDecision(null)}>
              取消
            </button>
            {view && !view.reset && view.phase !== "idle" && (
              <button type="button" className="motor-stop" disabled={motor.stopping} onClick={stopOutput}>
                立即关桥
              </button>
            )}
            <button
              type="button"
              className="motor-primary"
              disabled={busy || decision?.session !== view?.session}
              onClick={() => {
                if (decision?.session === view?.session && !busy) decision?.execute();
                setDecision(null);
              }}
            >
              确认执行
            </button>
          </div>
        </dialog>
      </div>
    </main>
  );
}
