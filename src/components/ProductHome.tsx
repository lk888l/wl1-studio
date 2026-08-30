import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Cpu,
  Gauge,
  Keyboard,
  Music2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Upload,
} from "lucide-react";

interface ProductHomeProps {
  safetyState: "checking" | "ready" | "error";
  safetyError: string | null;
  launching: "wl1" | "piano" | null;
  onRetrySafety: () => void;
  onOpenWl1: () => void;
  onOpenPiano: () => void;
}

export function ProductHome({
  safetyState,
  safetyError,
  launching,
  onRetrySafety,
  onOpenWl1,
  onOpenPiano,
}: ProductHomeProps) {
  const safetyLabel = safetyState === "checking"
    ? "安全检查中"
    : safetyState === "error"
      ? "安全检查失败"
      : "本机工作区";

  return (
    <div className={`product-hub${launching ? " is-launching" : ""}`}>
      <div className="ambient ambient--one" />
      <div className="ambient ambient--two" />
      <div className="ambient ambient--three" />

      <header className="product-hub__topbar glass-panel">
        <div className="product-hub__brand">
          <span className="product-hub__brand-mark" aria-hidden="true">
            <Boxes size={24} strokeWidth={2.1} />
          </span>
          <span>
            <strong>设备控制中心</strong>
          </span>
        </div>
        <div className="product-hub__status" aria-label="产品库状态">
          <span className={`local-status is-${safetyState}`}><i />{safetyLabel}</span>
        </div>
      </header>

      <main className="product-home">
        <section className="product-home__hero" aria-labelledby="product-home-title">
          <div className="product-home__intro">
            <span className="section-kicker">产品库</span>
            <h1 id="product-home-title">选择产品，开始控制</h1>
            <p>从机器人运动控制到低成本嵌入式小摆件，在同一个控制中心进入对应工作台。</p>
          </div>
        </section>

        {safetyState === "error" && (
          <section className="product-safety-error" id="product-safety-error" role="alert">
            <AlertTriangle size={21} />
            <div>
              <strong>启动安全检查失败，产品入口已锁定</strong>
              <span>无法确认并清理后端遗留设备会话：{safetyError ?? "未知错误"}。请先准备物理断电，再重试安全清理。</span>
            </div>
            <button type="button" onClick={onRetrySafety}><RefreshCw size={15} />重试安全清理</button>
          </section>
        )}

        <section className="product-catalog" aria-labelledby="available-products-title">
          <div className="product-section-heading">
            <div>
              <h2 id="available-products-title">已接入产品</h2>
            </div>
            <span>2 个可用</span>
          </div>

          <div className="product-catalog__layout">
            <button
              className={`product-card glass-card liquid-card is-${safetyState}${launching === "wl1" ? " is-launching" : ""}`}
              type="button"
              disabled={safetyState !== "ready" || Boolean(launching)}
              aria-describedby={safetyState === "error" ? "product-safety-error" : undefined}
              title={safetyState === "ready" ? "进入 WL1 轮腿小车上位机" : "等待启动安全检查通过"}
              onClick={onOpenWl1}
            >
              <span className="product-card__visual" aria-hidden="true">
                <span className="product-card__model">WL1</span>
                <svg viewBox="0 0 520 300">
                  <defs>
                    <linearGradient id="hubRobotBody" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#ffffff" />
                      <stop offset="0.55" stopColor="#dfe8ff" />
                      <stop offset="1" stopColor="#aebfe8" />
                    </linearGradient>
                    <linearGradient id="hubRobotWheel" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#34445f" />
                      <stop offset="1" stopColor="#101827" />
                    </linearGradient>
                    <filter id="hubRobotShadow" x="-40%" y="-40%" width="180%" height="190%">
                      <feDropShadow dx="0" dy="17" stdDeviation="14" floodColor="#294369" floodOpacity=".22" />
                    </filter>
                  </defs>
                  <ellipse cx="260" cy="264" rx="176" ry="20" fill="#7798c7" opacity=".15" />
                  <g filter="url(#hubRobotShadow)">
                    <circle cx="120" cy="229" r="52" fill="url(#hubRobotWheel)" />
                    <circle cx="120" cy="229" r="35" fill="#35455f" stroke="#8294b4" strokeWidth="4" />
                    <circle cx="120" cy="229" r="13" fill="#d2dff2" />
                    <path d="M120 194v70M85 229h70M95 204l50 50M145 204l-50 50" stroke="#91a5c3" strokeWidth="3" opacity=".54" />
                    <circle cx="400" cy="229" r="52" fill="url(#hubRobotWheel)" />
                    <circle cx="400" cy="229" r="35" fill="#35455f" stroke="#8294b4" strokeWidth="4" />
                    <circle cx="400" cy="229" r="13" fill="#d2dff2" />
                    <path d="M400 194v70M365 229h70M375 204l50 50M425 204l-50 50" stroke="#91a5c3" strokeWidth="3" opacity=".54" />
                    <path d="M191 123l-43 55-28 39M329 123l43 55 28 39" fill="none" stroke="#63789b" strokeWidth="14" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="148" cy="178" r="12" fill="#eef4ff" stroke="#7187aa" strokeWidth="5" />
                    <circle cx="372" cy="178" r="12" fill="#eef4ff" stroke="#7187aa" strokeWidth="5" />
                    <rect x="155" y="55" width="210" height="91" rx="34" fill="url(#hubRobotBody)" stroke="#fff" strokeWidth="4" />
                    <path d="M180 69h160" stroke="#fff" strokeWidth="7" strokeLinecap="round" opacity=".7" />
                    <rect x="205" y="84" width="110" height="30" rx="15" fill="#172238" />
                    <circle cx="232" cy="99" r="6" fill="#6d82ff" />
                    <circle cx="288" cy="99" r="6" fill="#6d82ff" />
                    <path d="M247 126h26" stroke="#8294b0" strokeWidth="4" strokeLinecap="round" />
                  </g>
                </svg>
              </span>

              <span className="product-card__body">
                <span className="product-card__meta">
                  <span className="product-available"><i />可用</span>
                </span>
                <span className="product-card__title">
                  <strong>WL1 轮腿小车</strong>
                </span>
                <span className="product-card__description">连接、遥测、调校与运动控制集中在一个工作台。</span>
                <span className="product-card__features">
                  <span><Activity size={15} />实时遥测</span>
                  <span><SlidersHorizontal size={15} />参数调校</span>
                  <span><Gauge size={15} />运动控制</span>
                </span>
                <span className="product-card__action">
                  <span>
                    <strong>
                      {launching === "wl1"
                        ? "正在打开工作台…"
                        : safetyState === "checking"
                        ? "正在准备设备会话…"
                        : safetyState === "error"
                          ? "等待安全检查通过"
                          : "进入 WL1 工作台"}
                    </strong>
                  </span>
                  {safetyState === "ready" ? <ArrowRight size={21} /> : <ShieldCheck size={20} />}
                </span>
              </span>
            </button>

            <button
              className={`product-card product-card--piano glass-card liquid-card is-${safetyState}${launching === "piano" ? " is-launching" : ""}`}
              type="button"
              disabled={safetyState !== "ready" || Boolean(launching)}
              aria-describedby={safetyState === "error" ? "product-safety-error" : undefined}
              title={safetyState === "ready" ? "进入口袋电子琴上位机" : "等待启动安全检查通过"}
              onClick={onOpenPiano}
            >
              <span className="product-card__visual" aria-hidden="true">
                <span className="product-card__model">PK-51</span>
                <svg viewBox="0 0 520 300">
                  <defs>
                    <linearGradient id="hubPianoBody" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#fff8f2" />
                      <stop offset="0.52" stopColor="#ffd9cc" />
                      <stop offset="1" stopColor="#eaa08f" />
                    </linearGradient>
                    <linearGradient id="hubPianoScreen" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#27344b" />
                      <stop offset="1" stopColor="#111827" />
                    </linearGradient>
                    <filter id="hubPianoShadow" x="-30%" y="-40%" width="160%" height="190%">
                      <feDropShadow dx="0" dy="18" stdDeviation="15" floodColor="#8d5362" floodOpacity=".2" />
                    </filter>
                  </defs>
                  <ellipse cx="260" cy="262" rx="190" ry="18" fill="#9b6b7c" opacity=".13" />
                  <g filter="url(#hubPianoShadow)">
                    <rect x="52" y="47" width="416" height="205" rx="47" fill="url(#hubPianoBody)" stroke="#fff" strokeWidth="5" />
                    <path d="M78 69h364" stroke="#fff" strokeWidth="7" strokeLinecap="round" opacity=".58" />
                    <g fill="#bc756b" opacity=".72">
                      {Array.from({ length: 18 }, (_, index) => (
                        <circle key={index} cx={96 + (index % 6) * 13} cy={90 + Math.floor(index / 6) * 13} r="3.4" />
                      ))}
                    </g>
                    <rect x="237" y="75" width="95" height="43" rx="12" fill="url(#hubPianoScreen)" />
                    <path d="M254 96h16l7-9 10 18 8-9h20" fill="none" stroke="#66e0c6" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    <circle cx="390" cy="94" r="12" fill="#ff755f" stroke="#fff" strokeWidth="3" />
                    <circle cx="424" cy="94" r="12" fill="#7388ff" stroke="#fff" strokeWidth="3" />
                    <g>
                      {Array.from({ length: 8 }, (_, index) => (
                        <g key={index}>
                          <rect x={77 + index * 46} y="143" width="42" height="82" rx="8" fill="#fff" stroke="#d7cbd1" strokeWidth="2" />
                          <rect x={88 + index * 46} y="153" width="20" height="9" rx="4.5" fill={index < 4 ? "#ff917b" : "#758aff"} opacity=".82" />
                        </g>
                      ))}
                    </g>
                  </g>
                </svg>
              </span>

              <span className="product-card__body">
                <span className="product-card__meta"><span className="product-available"><i />新接入</span></span>
                <span className="product-card__title"><strong>口袋电子琴</strong></span>
                <span className="product-card__description">面向 51 单片机与无源蜂鸣器的编曲、配键、曲库和固件工作台。</span>
                <span className="product-card__features">
                  <span><Music2 size={15} />曲谱编辑</span>
                  <span><Keyboard size={15} />琴键配调</span>
                  <span><Upload size={15} />串口写曲</span>
                </span>
                <span className="product-card__action">
                  <span>
                    <strong>
                      {launching === "piano"
                        ? "正在打开工作台…"
                        : safetyState === "checking"
                          ? "正在准备设备会话…"
                          : safetyState === "error"
                            ? "等待安全检查通过"
                            : "进入电子琴工作台"}
                    </strong>
                  </span>
                  {safetyState === "ready" ? <ArrowRight size={21} /> : <Cpu size={20} />}
                </span>
              </span>
            </button>
          </div>
        </section>
      </main>

      <footer className="product-hub__footer">
        <span><ShieldCheck size={15} />安全检查通过后可进入设备工作台</span>
      </footer>
    </div>
  );
}
