import { useState } from "react";
import { BookOpen, Check, RefreshCw } from "lucide-react";
import {
  calibrationStates,
  canConfigure,
  hex,
  mapEntries,
  numeric,
  objects,
  type Pdo,
  type Service,
  type Snapshot,
  wireBytes,
} from "../../lib/foc";
import type { Ask, Run } from "./useMotor";

export type ConfigProps = {
  view: Snapshot | null;
  busy: boolean;
  run: Run;
  ask: Ask;
};
type Field = (typeof objects)[number];
const choices = ["常用设置", "通信", "MIT", "诊断", "完整字典"];
const nodeRates: Record<string, number[]> = {
  "2001:02": [125000, 250000, 500000, 1000000],
  "2001:03": [1000000, 2000000, 4000000, 5000000, 8000000],
};
export function Parameters({ view, busy, run, ask }: ConfigProps) {
  const [group, setGroup] = useState("常用设置"),
    [search, setSearch] = useState(""),
    [page, setPage] = useState(0);
  const [values, setValues] = useState<Record<string, number>>({}),
    [draft, setDraft] = useState<Record<string, string>>({});
  const query = search.trim().toLowerCase().replace(/^0x/, "");
  const fields = objects.filter((item) =>
    query
      ? `${item.address} ${item.title} ${item.name}`.toLowerCase().includes(query)
      : group === "完整字典" ||
        (group === "常用设置"
          ? item.editable && (item.group === "驱动" || item.index === 0x2001)
          : group === "诊断"
            ? item.group === "诊断" || (!item.writable && item.index >= 0x2100)
            : item.group === group),
  );
  const visible = fields.slice(page * 12, (page + 1) * 12),
    canRead = !!view && !view.reset && view.phase === "idle" && !busy;
  const read = async (list: Field[]) => {
    const result = await run({
      kind: "read",
      addresses: list.map((item) => [item.index, item.sub]),
    });
    if (result && result.length === list.length)
      setValues((prev) => ({
        ...prev,
        ...Object.fromEntries(result.map((value, index) => [list[index]!.address, value])),
      }));
  };
  const write = (field: Field) => {
    const value = numeric(draft[field.address] ?? "");
    if (value === null) return;
    ask(
      `写入 ${field.address}？`,
      `${field.title}：${values[field.address] ?? "未读取"} → ${value}。仅写当前 RAM；通信参数、电流基准和 Kt 需显式保存并重启才生效。`,
      () => {
        void (async () => {
          const actual = await run(
            { kind: "write", index: field.index, sub: field.sub, value },
            `已写入并读回 ${field.address}。`,
          );
          if (actual !== undefined) {
            setValues((old) => ({ ...old, [field.address]: actual }));
            setDraft((old) => ({ ...old, [field.address]: "" }));
          }
        })();
      },
    );
  };
  return (
    <section className="motor-card">
      <small>OBJECT DICTIONARY / SDO</small>
      <h2>参数字典</h2>
      <p>设备值须实读。只读项不提供输入；控制字、映射和 Flash 命令走专用流程。</p>
      <div className="motor-filters">
        <div className="motor-buttons">
          {choices.map((choice) => (
            <button
              type="button"
              key={choice}
              aria-pressed={!query && group === choice}
              onClick={() => {
                setGroup(choice);
                setSearch("");
                setPage(0);
              }}
            >
              {choice}
            </button>
          ))}
        </div>
        <input
          aria-label="搜索对象字典"
          placeholder="搜索索引、中文或对象名"
          value={search}
          onChange={(event) => {
            setSearch(event.target.value);
            setPage(0);
          }}
        />
      </div>
      <div className="motor-table-wrap">
        <table className="motor-table">
          <thead>
            <tr>
              <th>地址 / 类型</th>
              <th>对象</th>
              <th>设备值</th>
              <th>新值</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((field) => {
              const rates = nodeRates[field.address],
                text = draft[field.address] ?? "",
                input = (value: string) => setDraft({ ...draft, [field.address]: value });
              return (
                <tr key={field.address}>
                  <td>
                    <code>{field.address}</code>
                    <small>{field.scalar}</small>
                  </td>
                  <td>
                    {field.title}
                    {field.name !== field.title && <small>{field.name}</small>}
                  </td>
                  <td>
                    <code>{values[field.address] ?? "—"}</code>
                  </td>
                  <td>
                    {field.editable ? (
                      rates ? (
                        <select
                          value={text}
                          aria-label={`${field.address} 新值`}
                          onChange={(event) => input(event.target.value)}
                        >
                          <option value="">选择速率</option>
                          {rates.map((rate) => (
                            <option key={rate} value={rate}>
                              {rate}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          aria-label={`${field.address} 新值`}
                          value={text}
                          placeholder={`默认 ${field.initial}`}
                          onChange={(event) => input(event.target.value)}
                        />
                      )
                    ) : (
                      <small>{field.writable ? "专用流程" : "只读"}</small>
                    )}
                  </td>
                  <td>
                    <div className="motor-buttons">
                      <button
                        type="button"
                        disabled={!canRead}
                        aria-label={`读取 ${field.address}`}
                        onClick={() => void read([field])}
                      >
                        读
                      </button>
                      {field.editable && (
                        <button
                          type="button"
                          disabled={
                            busy ||
                            !canConfigure(view) ||
                            values[field.address] === undefined ||
                            numeric(text) === null
                          }
                          aria-label={`写入 ${field.address}`}
                          onClick={() => write(field)}
                        >
                          写
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {!visible.length && <p>没有匹配的对象。</p>}
      </div>
      <div className="motor-table-footer">
        <button type="button" disabled={!canRead || !visible.length} onClick={() => void read(visible)}>
          <RefreshCw size={14} />
          读取本页
        </button>
        <span>
          {fields.length} 项 · 第 {page + 1} / {Math.max(1, Math.ceil(fields.length / 12))} 页
        </span>
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)}>
          上一页
        </button>
        <button type="button" disabled={(page + 1) * 12 >= fields.length} onClick={() => setPage(page + 1)}>
          下一页
        </button>
      </div>
    </section>
  );
}

const slotLabel = (slot: number) => `${slot <= 4 ? "R" : "T"}PDO${((slot - 1) % 4) + 1}`;
export function PdoEditor({ view, busy, run, ask }: ConfigProps) {
  const [slot, setSlot] = useState(1),
    [loaded, setLoaded] = useState<Pdo | null>(null),
    [cob, setCob] = useState(""),
    [enabled, setEnabled] = useState(false);
  const [type, setType] = useState("255"),
    [timer, setTimer] = useState("0"),
    [inhibit, setInhibit] = useState("0"),
    [words, setWords] = useState("");
  const [picked, setPicked] = useState("");
  const show = (config: Pdo) => {
    setLoaded(config);
    setCob(`0x${hex(config.cob & 2047, 3)}`);
    setEnabled(!(config.cob >>> 31));
    setType(String(config.transmission));
    setTimer(String(config.timer_ms));
    setInhibit(String(config.inhibit));
    setWords(config.entries.map((word) => hex(word, 8)).join("\n"));
  };
  const read = async () => {
    const config = await run({ kind: "read_pdo", slot });
    if (config) show(config);
  };
  const entries = mapEntries(words, slot);
  const size = entries?.reduce((sum, word) => sum + (word & 255) / 8, 0) ?? 0;
  const id = numeric(cob),
    trans = numeric(type),
    ms = numeric(timer),
    quiet = numeric(inhibit);
  const valid =
    id !== null &&
    Number.isInteger(id) &&
    id >= 0 &&
    id <= 2047 &&
    trans !== null &&
    Number.isInteger(trans) &&
    trans >= 0 &&
    trans <= 255 &&
    (trans <= 240 || trans >= 254) &&
    [ms, quiet].every((val) => val !== null && Number.isInteger(val) && val >= 0 && val <= 65535) &&
    !!entries &&
    (!enabled || entries.length > 0);
  const save = () => {
    if (!valid || !loaded || !entries || id === null || trans === null || ms === null || quiet === null)
      return;
    const config: Pdo = {
      slot,
      cob: ((loaded.cob & 0x40000000) | id | (enabled ? 0 : 0x80000000)) >>> 0,
      transmission: trans,
      timer_ms: ms,
      inhibit: quiet,
      entries,
    };
    ask(
      `应用 ${slotLabel(slot)} 映射？`,
      "仅在关桥状态改写 RAM：先禁用、清计数、写映射与定时，最后恢复所选启用位并读回。请核对总线上其他节点的 COB-ID。",
      () => {
        void (async () => {
          const ok = await run({ kind: "write_pdo", config }, "映射与通信参数已写入并读回。");
          if (ok !== undefined) show(config);
          else setLoaded(null);
        })();
      },
    );
  };
  return (
    <section className="motor-card">
      <small>PROCESS DATA / MAPPING</small>
      <h2>PDO 路由</h2>
      <p>手动配置全部 4 收 / 4 发槽位。周期驱动临时配置所需槽，关桥后恢复，不自动写 Flash。</p>
      <div className="motor-slots">
        {Array.from({ length: 8 }, (_, index) => index + 1).map((number) => (
          <button
            type="button"
            key={number}
            disabled={busy}
            aria-pressed={slot === number}
            onClick={() => {
              if (slot === number) return;
              setSlot(number);
              setLoaded(null);
              setPicked("");
              setWords("");
              setCob("");
            }}
          >
            {slotLabel(number)}
          </button>
        ))}
      </div>
      <div className="motor-buttons">
        <button
          type="button"
          disabled={busy || !view || view.reset || view.phase !== "idle"}
          onClick={() => void read()}
        >
          <RefreshCw size={15} />
          读取 {slotLabel(slot)}
        </button>
        <span>{loaded ? "已读取设备配置" : "读取后才可编辑"}</span>
      </div>
      <fieldset className="motor-pdo-form" disabled={!loaded || busy || !canConfigure(view)}>
        <legend>
          {slotLabel(slot)} · {slot <= 4 ? "主站 → 驱动" : "驱动 → 主站"}
        </legend>
        <div className="motor-fields">
          <label>
            COB-ID
            <input value={cob} onChange={(event) => setCob(event.target.value)} />
          </label>
          <label>
            类型 · 0–240 / 254–255
            <input value={type} onChange={(event) => setType(event.target.value)} />
          </label>
          <label>
            {slot <= 4 ? "接收超时" : "事件定时"} · ms
            <input value={timer} onChange={(event) => setTimer(event.target.value)} />
          </label>
          {slot > 4 && (
            <label>
              抑制 · 100 µs
              <input value={inhibit} onChange={(event) => setInhibit(event.target.value)} />
            </label>
          )}
        </div>
        <label className="motor-check">
          <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
          启用此 PDO（清除 bit31）
        </label>
        <div className="motor-fields">
          <label>
            映射顺序 · 每行一个 32 位十六进制值
            <textarea
              rows={6}
              spellCheck={false}
              placeholder="60FF0020"
              value={words}
              onChange={(event) => setWords(event.target.value)}
            />
          </label>
          <div>
            <label>
              可映射对象
              <select value={picked} onChange={(event) => setPicked(event.target.value)}>
                <option value="">选择字段</option>
                {objects
                  .filter((item) => item.mappable && (slot > 4 || item.writable))
                  .map((item) => (
                    <option
                      key={item.address}
                      value={`${hex(item.index)}${hex(item.sub, 2)}${hex(Number(item.scalar.slice(1)), 2)}`}
                    >
                      {item.address} · {item.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              disabled={!picked}
              onClick={() => setWords([words.trim(), picked].filter(Boolean).join("\n"))}
            >
              追加字段
            </button>
            <p>
              {entries
                ? `${entries.length}/16 项 · ${size} B 有效 · ${wireBytes(size)} B 线上 · ${size > 8 ? "FD+BRS" : "经典 CAN"}`
                : "映射方向、长度或对象错误"}
            </p>
          </div>
        </div>
        <button type="button" className="motor-primary" disabled={!valid} onClick={save}>
          <Check size={15} />
          应用到 RAM
        </button>
      </fieldset>
      <div className="motor-readout">
        <BookOpen size={16} />
        <span>启用压缩格式前须有唯一的两字映射。改 RPDO 前先关闭压缩格式。</span>
      </div>
      <div className="motor-buttons">
        {[false, true].map((on) => (
          <button
            type="button"
            key={String(on)}
            disabled={busy || !canConfigure(view)}
            onClick={() =>
              ask(
                `${on ? "启用" : "关闭"}压缩 MIT 格式？`,
                "写入 2004:01，不使能电机；范围和附加限值不跨重启保留。",
                () => void run({ kind: "packed", on }, "格式设置已确认。"),
              )
            }
          >
            {on ? "启用" : "关闭"}压缩格式
          </button>
        ))}
      </div>
    </section>
  );
}

const services: [Service, string, string][] = [
  [
    "calibrate",
    "电角校准",
    "电机会通电并正反转。请固定电机、清空转动范围，并备好物理急停。成功后需单独保存。",
  ],
  ["slow_scan", "正反慢扫描", "需已有有效校准；电机会正反扫描约 202 秒。不会自动拟合或写 Flash。"],
  ["compensation_on", "开启周期补偿", "启用 RAM 中的角度周期电流补偿；只适用于匹配的电机与编码器安装。"],
  ["compensation_off", "关闭周期补偿", "仅关闭本次上电的周期补偿。"],
  [
    "reset_fault",
    "故障复位",
    "先排除故障或非法 PDO 的原因。发送 bit7 上升沿，再清零，核对状态和故障码；不会重新使能。",
  ],
  ["save", "保存到 Flash", "将当前通信、PDO、运动限值及校准保存到非易失存储器。不保存运动目标或 MIT 量程。"],
  [
    "restore",
    "恢复出厂配置",
    "将默认值写入下次启动配置，已保存的电角校准会丢失；重启后回到 Node 1 和 1M / 5M。",
  ],
  [
    "reset_communication",
    "NMT 复位通信",
    "此固件收到 Reset Communication 也会整机重启，未保存参数和累计圈数会丢失。请按已保存的节点号和速率重新连接。",
  ],
  ["reboot", "重启节点", "未保存设置会丢失。节点号或速率可能改变，请释放旧会话并用新参数连接。"],
];
export function Maintenance({ view, busy, run, ask }: ConfigProps) {
  const [result, setResult] = useState<number[] | null>(null);
  const sample = view?.feedback;
  return (
    <>
      <section className="motor-card">
        <small>COMMISSIONING / ELECTRICAL</small>
        <h2>校准与故障</h2>
        <div className="motor-route">
          <span>校准 · {sample ? (calibrationStates[sample.calibration] ?? "未知") : "—"}</span>
          <span>故障码 · {sample ? `0x${hex(sample.fault)}` : "—"}</span>
        </div>
        <p>校准中可以立即关桥。Halt 不是关桥；拔掉 CAN 线也不是急停。</p>
        <button
          type="button"
          disabled={!view || view.reset || busy || view.phase !== "idle"}
          onClick={() =>
            void run({
              kind: "read",
              addresses: [
                [0x2100, 3],
                [0x2100, 4],
                [0x2100, 5],
                [0x2100, 6],
                [0x2100, 7],
                [0x2100, 10],
              ],
            }).then((values) => {
              if (values) setResult(values);
            })
          }
        >
          读取校准结果
        </button>
        {result && (
          <div className="motor-readout">
            极对数 {result[0]} · 方向 {result[1]} · 偏置 {result[2]?.toFixed(5)} rad · 电流配置{" "}
            {result[3]?.toFixed(3)} A · Kt {result[4]?.toFixed(4)} Nm/A · ISR 峰值 {result[5]} cycles
          </div>
        )}
      </section>
      <div className="motor-two">
        {[services.slice(0, 5), services.slice(5)].map((group, index) => (
          <section className="motor-card" key={group[0]?.[0]}>
            <small>{index ? "NONVOLATILE / NMT" : "SERVICE / RAM"}</small>
            <h2>{index ? "存储与复位" : "维护动作"}</h2>
            {group.map(([command, name, description]) => {
              const fault =
                command === "reset_fault" &&
                !!view &&
                !view.reset &&
                view.phase === "idle" &&
                view.age_ms < 1000 &&
                !view.io_error &&
                [8, 0x40].includes(view.feedback.status & 0x6f) &&
                ![1, 2, 3].includes(view.feedback.calibration);
              return (
                <div className="motor-service" key={command}>
                  <div>
                    <strong>{name}</strong>
                    <p>{description}</p>
                  </div>
                  <button
                    type="button"
                    disabled={
                      busy ||
                      !(command === "reset_fault" ? fault : canConfigure(view)) ||
                      (command === "slow_scan" && sample?.calibration !== 4)
                    }
                    onClick={() =>
                      ask(
                        `${name}？`,
                        description,
                        () =>
                          void run(
                            { kind: "service", command },
                            command === "reboot" || command === "reset_communication"
                              ? "已发送定向复位，请重新连接。"
                              : `已发送：${name}。`,
                          ),
                      )
                    }
                  >
                    执行
                  </button>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </>
  );
}
