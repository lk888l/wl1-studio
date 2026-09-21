import {
  Activity,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Boxes,
  Copy,
  CreditCard,
  Cpu,
  Gauge,
  Gamepad2,
  Cable,
  KeyRound,
  FileCode2,
  Keyboard,
  Music2,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
  Sparkles,
  Upload,
} from "lucide-react";
import { useState } from "react";

import type { PersonalizationSettings } from "../types";
import { PersonalizationPage } from "./pages/PersonalizationPage";

interface ProductHomeProps {
  safetyState: "checking" | "ready" | "error";
  pianoPreviewEnabled: boolean;
  safetyError: string | null;
  launching: "wl1" | "piano" | "gamebox" | "nfc" | null;
  personalization: PersonalizationSettings;
  personalizationPersisted: boolean;
  onPersonalizationChange: (settings: PersonalizationSettings) => void;
  onRetrySafety: () => void;
  onOpenWl1: () => void;
  onOpenPiano: () => void;
  onOpenGameBox: () => void;
  onOpenNfc: () => void;
}

export function ProductHome({
  safetyState,
  safetyError,
  pianoPreviewEnabled,
  launching,
  personalization,
  personalizationPersisted,
  onPersonalizationChange,
  onRetrySafety,
  onOpenWl1,
  onOpenPiano,
  onOpenGameBox,
  onOpenNfc,
}: ProductHomeProps) {
  const [showPersonalization, setShowPersonalization] = useState(false);
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
        <div className="product-hub__actions">
          <div className="product-hub__status" role="status" aria-label="产品库状态">
            <span className={`local-status is-${safetyState}`}><i />{safetyLabel}</span>
          </div>
          <button
            className="secondary-button"
            type="button"
            disabled={Boolean(launching)}
            aria-controls="product-home-content"
            onClick={() => setShowPersonalization((value) => !value)}
          >
            {showPersonalization ? <ArrowLeft size={17} /> : <Sparkles size={17} />}
            {showPersonalization ? "返回产品库" : "个性设置"}
          </button>
        </div>
      </header>

      <main className="product-home" id="product-home-content">
        {showPersonalization ? (
          <PersonalizationPage
            settings={personalization}
            persisted={personalizationPersisted}
            onChange={onPersonalizationChange}
          />
        ) : <>

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
            <span>3 个设备工作台 · 1 个交互预览</span>
          </div>

          <div className="product-catalog__layout">
            <button
              className={`product-card product-card--gamebox glass-card liquid-card is-${safetyState}${launching === "gamebox" ? " is-launching" : ""}`}
              type="button"
              disabled={safetyState !== "ready" || Boolean(launching)}
              aria-describedby={safetyState === "error" ? "product-safety-error" : undefined}
              onClick={onOpenGameBox}
            >
              <span className="product-card__visual" aria-hidden="true">
                <span className="product-card__model">STM32 GAMEBOX</span>
                <svg viewBox="0 0 520 300" aria-hidden="true">
                  <defs>
                    <linearGradient id="hubGameBoxBody" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#fbfef6" />
                      <stop offset="1" stopColor="#cadbca" />
                    </linearGradient>
                  </defs>
                  <ellipse cx="260" cy="267" rx="160" ry="16" fill="#255c48" opacity=".12" />
                  <rect x="91" y="38" width="338" height="222" rx="44" fill="url(#hubGameBoxBody)" stroke="#fff" strokeWidth="4" />
                  <rect x="157" y="61" width="206" height="121" rx="17" fill="#294d40" />
                  <rect x="171" y="73" width="178" height="97" rx="6" fill="#c2d5a0" />
                  <g fill="#405b35">
                    <path d="M191 149v-18h14v-14h14v14h14v-14h14v14h14v18h-14v-5h-42v5z" />
                    <path d="M204 103h7v7h-7zm14 0h7v7h-7zm63 24h7v22h-7zm-7 7h21v7h-21zm40-44h7v7h-7zm11 11h7v7h-7z" />
                    <path d="M185 156h150v3H185z" />
                  </g>
                  <path d="M132 199h15v-15h16v15h15v16h-15v15h-16v-15h-15z" fill="#3a5149" />
                  <circle cx="344" cy="218" r="13" fill="#428c71" stroke="#fff" strokeWidth="2" />
                  <circle cx="378" cy="196" r="13" fill="#da8f59" stroke="#fff" strokeWidth="2" />
                  <rect x="219" y="224" width="28" height="8" rx="4" fill="#829b8b" />
                  <rect x="263" y="224" width="28" height="8" rx="4" fill="#829b8b" />
                </svg>
              </span>
              <span className="product-card__body">
                <span className="product-card__meta"><span className="product-available"><i />串口只读接入</span></span>
                <span className="product-card__title"><strong>GameBox 游戏机</strong></span>
                <span className="product-card__description">查看按键与串口日志，浏览游戏图鉴，通过 ST-Link 更新固件和备份 Flash。</span>
                <span className="product-card__features">
                  <span><Gamepad2 size={15} />按键监视</span>
                  <span><Cable size={15} />串口日志</span>
                  <span><FileCode2 size={15} />烧录与备份</span>
                </span>
                <span className="product-card__action">
                  <strong>{launching === "gamebox" ? "正在打开工作台…"
                    : safetyState === "checking" ? "正在准备设备会话…"
                      : safetyState === "error" ? "等待安全检查通过" : "进入 GameBox 工作台"}</strong>
                  <ArrowRight size={21} />
                </span>
              </span>
            </button>
            <button
              className={`product-card product-card--nfc glass-card liquid-card is-${safetyState}${launching === "nfc" ? " is-launching" : ""}`}
              type="button"
              disabled={safetyState !== "ready" || Boolean(launching)}
              aria-describedby={safetyState === "error" ? "product-safety-error" : undefined}
              title={safetyState === "ready" ? "进入 PN532 读卡工作台" : "等待启动安全检查通过"}
              onClick={onOpenNfc}
            >
              <span className="product-card__visual" aria-hidden="true">
                <span className="product-card__model">PN532</span>
                <svg viewBox="0 0 520 300" aria-hidden="true">
                  <defs>
                    <linearGradient id="hubNfcCard" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#fdfdff" />
                      <stop offset="0.55" stopColor="#dde5fb" />
                      <stop offset="1" stopColor="#b3c2ee" />
                    </linearGradient>
                    <linearGradient id="hubNfcBoard" x1="0" y1="0" x2="1" y2="1">
                      <stop offset="0" stopColor="#2f51c4" />
                      <stop offset="1" stopColor="#1d3487" />
                    </linearGradient>
                    <filter id="hubNfcShadow" x="-40%" y="-40%" width="180%" height="190%">
                      <feDropShadow dx="0" dy="16" stdDeviation="14" floodColor="#2b3f88" floodOpacity=".24" />
                    </filter>
                  </defs>
                  <ellipse cx="260" cy="264" rx="172" ry="19" fill="#5f7ac2" opacity=".16" />
                  <g filter="url(#hubNfcShadow)">
                    <rect x="163" y="43" width="196" height="219" rx="24" fill="url(#hubNfcBoard)" stroke="#fff" strokeWidth="4" />
                    <rect x="188" y="70" width="146" height="76" rx="11" fill="#eef2ff" opacity=".92" />
                    <g fill="none" stroke="#2f51c4" strokeWidth="4" strokeLinecap="round">
                      <path d="M243 108a22 22 0 0 1 0-24" />
                      <path d="M252 118a36 36 0 0 1 0-44" />
                      <path d="M233 98a9 9 0 0 1 0-8" />
                    </g>
                    <circle cx="267" cy="94" r="5" fill="#2f51c4" />
                    <rect x="203" y="206" width="34" height="22" rx="5" fill="#16235c" />
                    <g fill="#8ea2e8">
                      <rect x="209" y="212" width="4" height="10" />
                      <rect x="217" y="212" width="4" height="10" />
                      <rect x="225" y="212" width="4" height="10" />
                    </g>
                    <g fill="#f4c96b">
                      {Array.from({ length: 6 }, (_, index) => (
                        <rect key={index} x={256 + (index % 2) * 15} y={206 + Math.floor(index / 2) * 9} width="10" height="6" rx="1.5" />
                      ))}
                    </g>
                    <g fill="#a9b8ee">
                      {Array.from({ length: 8 }, (_, index) => (
                        <rect key={index} x="172" y={82 + index * 17} width="11" height="6" rx="2" />
                      ))}
                    </g>
                    <g fill="#a9b8ee">
                      {Array.from({ length: 4 }, (_, index) => (
                        <rect key={index} x="188" y="243" width="11" height="6" rx="2" />
                      ))}
                    </g>
                    <path d="M300 178h44v13h-44z" fill="#16235c" />
                    <path d="M300 199h44v13h-44z" fill="#16235c" />
                  </g>
                  <g transform="translate(358 92) rotate(14)" filter="url(#hubNfcShadow)">
                    <rect x="0" y="0" width="126" height="80" rx="12" fill="url(#hubNfcCard)" stroke="#fff" strokeWidth="3.5" />
                    <rect x="14" y="17" width="30" height="23" rx="4" fill="#e3b75c" />
                    <path d="M14 28h30M29 17v23" stroke="#b98f35" strokeWidth="1.6" />
                    <rect x="58" y="52" width="52" height="6" rx="3" fill="#93a6dc" />
                    <rect x="58" y="63" width="34" height="5" rx="2.5" fill="#b2c0e8" />
                  </g>
                </svg>
              </span>

              <span className="product-card__body">
                <span className="product-card__meta">
                  <span className="product-available"><i />串口接入</span>
                </span>
                <span className="product-card__title">
                  <strong>PN532 读卡器</strong>
                </span>
                <span className="product-card__description">读取 MIFARE 门卡全部扇区，备份后可复制写入新卡。</span>
                <span className="product-card__features">
                  <span><CreditCard size={15} />整卡读取</span>
                  <span><KeyRound size={15} />密钥字典</span>
                  <span><Copy size={15} />复制写入</span>
                </span>
                <span className="product-card__action">
                  <span>
                    <strong>
                      {launching === "nfc"
                        ? "正在打开工作台…"
                        : safetyState === "checking"
                          ? "正在准备设备会话…"
                          : safetyState === "error"
                            ? "等待安全检查通过"
                            : "进入 NFC 工作台"}
                    </strong>
                  </span>
                  {safetyState === "ready" ? <ArrowRight size={21} /> : <ShieldCheck size={20} />}
                </span>
              </span>
            </button>
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
                <svg viewBox="0 0 520 300" aria-hidden="true">
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
              disabled={!pianoPreviewEnabled || safetyState !== "ready" || Boolean(launching)}
              aria-describedby={safetyState === "error" ? "product-safety-error" : undefined}
              title={!pianoPreviewEnabled
                ? "生产构建默认关闭未接入硬件协议的预览"
                : safetyState === "ready" ? "进入口袋电子琴交互预览" : "等待启动安全检查通过"}
              onClick={onOpenPiano}
            >
              <span className="product-card__visual" aria-hidden="true">
                <span className="product-card__model">PK-51</span>
                <svg viewBox="0 0 520 300" aria-hidden="true">
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
                <span className="product-card__meta"><span className="product-available"><i />交互预览</span></span>
                <span className="product-card__title"><strong>口袋电子琴</strong></span>
                <span className="product-card__description">编曲与协议交互预览；硬件协议尚未接入，生产构建默认关闭入口。</span>
                <span className="product-card__features">
                  <span><Music2 size={15} />曲谱编辑</span>
                  <span><Keyboard size={15} />琴键配调</span>
                  <span><Upload size={15} />写曲流程预览</span>
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
                            : pianoPreviewEnabled
                              ? "进入电子琴交互预览"
                              : "协议未接入 · 生产入口关闭"}
                    </strong>
                  </span>
                  {pianoPreviewEnabled && safetyState === "ready" ? <ArrowRight size={21} /> : <Cpu size={20} />}
                </span>
              </span>
            </button>
          </div>
        </section>
        </>}
      </main>

      <footer className="product-hub__footer">
        <span><ShieldCheck size={15} />安全检查通过后可进入设备工作台</span>
      </footer>
    </div>
  );
}
