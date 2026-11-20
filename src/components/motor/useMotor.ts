import { useCallback, useEffect, useRef, useState } from "react";
import {
  type Action,
  foc,
  type Link,
  type ResultOf,
  type Snapshot,
  type TracePoint,
  traceCsv,
} from "../../lib/foc";

export type Point = TracePoint;
export type Run = <A extends Action>(action: A, success?: string) => Promise<ResultOf<A> | undefined>;
export type Ask = (title: string, message: string, execute: () => void) => void;

export function useMotor() {
  const [view, setView] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false),
    [stopping, setStopping] = useState(false);
  const [notice, setNotice] = useState(""),
    [error, setError] = useState(""),
    [pollError, setPollError] = useState("");
  const [points, setPoints] = useState<Point[]>([]);
  const session = useRef<number | null>(null),
    mounted = useRef(true),
    pending = useRef(false),
    generation = useRef(0),
    lastSample = useRef(0);
  const log = useRef<{
    session: number | null;
    link: Link | null;
    active: boolean;
    samples: Point[];
  }>({ session: null, link: null, active: false, samples: [] });
  const [recording, setRecording] = useState(false),
    [logged, setLogged] = useState(0);
  const accept = useCallback((next: Snapshot) => {
    if (next.session !== session.current || !mounted.current || next.sample < lastSample.current) return;
    setView(next);
    setPollError("");
    const updates = next.recent.filter((point) => point.seq > lastSample.current);
    if (updates.length) {
      lastSample.current = next.sample;
      const time = updates[updates.length - 1]!.time;
      setPoints((previous) =>
        [...previous.filter((point) => time - point.time <= 60000), ...updates].slice(-12500),
      );
      if (log.current.active && log.current.session === next.session) {
        log.current.samples.push(...updates.slice(0, 60000 - log.current.samples.length));
        setLogged(log.current.samples.length);
        if (log.current.samples.length >= 60000) {
          log.current.active = false;
          setRecording(false);
          setNotice("已到 60,000 样本上限，录制已停止，可以导出 CSV。");
        }
      }
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current++;
      const id = session.current;
      session.current = null;
      if (id !== null) void foc.release(id).catch(() => undefined);
    };
  }, []);
  const id = view?.session;
  useEffect(() => {
    if (id === undefined) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const snapshot = await foc.snapshot(id, lastSample.current);
        if (alive) accept(snapshot);
      } catch (reason) {
        if (alive) setPollError(String(reason));
      } finally {
        if (alive) timer = setTimeout(poll, 100);
      }
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id, accept]);
  const perform = async <T>(work: () => Promise<T>, success?: string): Promise<T | undefined> => {
    if (pending.current) return;
    const token = ++generation.current;
    pending.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const value = await work();
      if (mounted.current && token === generation.current) {
        if (success) setNotice(success);
        return value;
      }
    } catch (reason) {
      if (mounted.current && token === generation.current) setError(String(reason));
    } finally {
      if (mounted.current && token === generation.current) {
        pending.current = false;
        setBusy(false);
      }
    }
  };
  const connect = async (link: Link) => {
    await perform(async () => {
      const next = await foc.connect(link);
      if (!mounted.current) {
        await foc.release(next.session);
        return;
      }
      session.current = next.session;
      lastSample.current = 0;
      setPoints([]);
      accept(next);
    }, "节点身份已核对；连接未使能电机。");
  };
  const release = async (physicalOff = false) => {
    const current = session.current;
    if (current === null) return true;
    return (
      (await perform(async () => {
        await foc.release(current, physicalOff);
        session.current = null;
        log.current.active = false;
        setRecording(false);
        setView(null);
        setPoints([]);
        lastSample.current = 0;
        setPollError("");
        return true;
      }, "已释放 CAN 通道。")) === true
    );
  };
  const stop = async () => {
    const current = session.current;
    if (current === null || stopping) return;
    ++generation.current;
    pending.current = true;
    setStopping(true);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await foc.stop(current);
      accept(await foc.snapshot(current, lastSample.current));
      setNotice("已确认关桥；不会自动恢复输出。");
    } catch (reason) {
      setError(String(reason));
    } finally {
      if (mounted.current) {
        pending.current = false;
        setBusy(false);
        setStopping(false);
      }
    }
  };
  const run: Run = async (action, success) => {
    const current = session.current;
    if (current === null) return;
    return perform(async () => {
      const result = await foc.action(current, action);
      accept(await foc.snapshot(current, lastSample.current));
      return result;
    }, success);
  };
  const toggleLog = () => {
    if (log.current.active) {
      log.current.active = false;
      setRecording(false);
    } else if (view && !view.reset) {
      log.current = {
        session: view.session,
        link: view.link,
        active: true,
        samples: [],
      };
      setLogged(0);
      setRecording(true);
    }
  };
  const exportLog = () => {
    const { samples, link } = log.current;
    if (!samples.length || !link) return;
    const url = URL.createObjectURL(new Blob([traceCsv(samples)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `g431-can${link.channel}-node${link.node}-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return {
    view,
    points,
    busy,
    stopping,
    notice,
    error,
    pollError,
    perform,
    connect,
    release,
    stop,
    run,
    recording,
    logged,
    toggleLog,
    exportLog,
  };
}
