import {
  Activity,
  AlertTriangle,
  ArrowRight,
  Boxes,
  Cable,
  Gauge,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from "lucide-react";

interface ProductHomeProps {
  safetyState: "checking" | "ready" | "error";
  safetyError: string | null;
  onRetrySafety: () => void;
  onOpenWl1: () => void;
}

export function ProductHome({
  safetyState,
  safetyError,
  onRetrySafety,
  onOpenWl1,
}: ProductHomeProps) {
  const safetyLabel = safetyState === "checking"
    ? "安全检查中"
    : safetyState === "error"
      ? "安全检查失败"
      : "本机工作区";

  return (
    <div className="product-hub">
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
            <small>PRODUCT CONSOLE</small>
          </span>
        </div>
        <div className="product-hub__status" aria-label="产品库状态">
          <span className="product-count"><strong>1</strong> 个产品可用</span>
          <span className={`local-status is-${safetyState}`}><i />{safetyLabel}</span>
        </div>
      </header>

      <main className="product-home">
        <section className="product-home__hero" aria-labelledby="product-home-title">
          <div className="product-home__intro">
            <span className="section-kicker">PRODUCT LIBRARY · 产品库</span>
            <h1 id="product-home-title">选择要控制的产品</h1>
            <p>从产品工作区进入对应的连接、遥测、调参与诊断界面。当前已接入 WL1 轮腿小车，后续产品可在这里继续扩展。</p>
          </div>
          <div className="product-home__summary glass-card" aria-label="产品库摘要">
            <span><small>AVAILABLE</small><strong>01</strong><em>已接入</em></span>
            <span><small>CONNECTION</small><strong>02</strong><em>串口 / Mock</em></span>
            <span><small>WORKSPACE</small><strong>06</strong><em>功能模块</em></span>
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
              <span className="section-kicker">AVAILABLE PRODUCTS</span>
              <h2 id="available-products-title">已接入产品</h2>
            </div>
            <span>01 / 01</span>
          </div>

          <div className="product-catalog__layout">
            <button
              className={`product-card glass-card liquid-card is-${safetyState}`}
              type="button"
              disabled={safetyState !== "ready"}
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
                <span className="product-card__visual-caption">WHEEL · LEG · BALANCE</span>
              </span>

              <span className="product-card__body">
                <span className="product-card__meta">
                  <span className="product-available"><i />可用</span>
                  <span>串口 · Mock</span>
                </span>
                <span className="product-card__title">
                  <strong>WL1 轮腿小车</strong>
                  <small>Wheel-legged Robot</small>
                </span>
                <span className="product-card__description">用于 WL1 的设备连接、姿态与轮速遥测、PID 参数调校、实时运动控制、标定和诊断。</span>
                <span className="product-card__features">
                  <span><Activity size={15} />实时遥测</span>
                  <span><SlidersHorizontal size={15} />参数调校</span>
                  <span><Gauge size={15} />运动控制</span>
                  <span><Cable size={15} />设备诊断</span>
                </span>
                <span className="product-card__action">
                  <span>
                    <small>{safetyState === "ready" ? "OPEN STUDIO" : "SAFETY CHECK"}</small>
                    <strong>
                      {safetyState === "checking"
                        ? "正在准备设备会话…"
                        : safetyState === "error"
                          ? "等待安全检查通过"
                          : "进入上位机"}
                    </strong>
                  </span>
                  {safetyState === "ready" ? <ArrowRight size={21} /> : <ShieldCheck size={20} />}
                </span>
              </span>
            </button>

            <aside className="product-catalog__note glass-card">
              <span className="product-catalog__note-icon" aria-hidden="true"><Boxes size={21} /></span>
              <span className="section-kicker">SCALABLE WORKSPACE</span>
              <h3>为更多产品预留</h3>
              <p>产品首页与具体控制工作台相互独立。新增设备时，可继续接入自己的协议、页面与安全策略。</p>
              <span className="catalog-divider" />
              <span className="catalog-safety"><ShieldCheck size={16} /><span><strong>安全隔离</strong><small>启动时清理遗留会话，切换产品前结束当前设备会话</small></span></span>
            </aside>
          </div>
        </section>
      </main>

      <footer className="product-hub__footer">
        <span><ShieldCheck size={15} />设备写入由各产品工作台独立校验</span>
        <span>LOCAL PRODUCT CATALOG</span>
      </footer>
    </div>
  );
}
