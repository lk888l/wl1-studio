import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isTauriRuntime } from "./device";

export const USER_STORAGE_KEYS = [
  "wl1-studio.personalization.v1", "wl1-studio.parameter-profiles.v1",
  "wl1-studio.connection.v1", "wl1-studio.pc-monitor.v1", "wl1-studio.calibration.v1",
  "studio.esp-c3.pet.v1", "cf-gui.pocket-piano.studio.v1",
  "studio.sticks3.port.v1", "studio.sticks3.network-host.v1",
] as const;
type StorageKey = typeof USER_STORAGE_KEYS[number];
interface NativeStatus { directory: string | null; warning: string | null; blocked: boolean; legacyImportCompleted: boolean }
export interface UserStorageStatus {
  directory: string | null;
  warning: string | null;
  blocked: boolean;
  initialized: boolean;
  saving: boolean;
}
const stringKeys = new Set<string>(["studio.sticks3.port.v1", "studio.sticks3.network-host.v1"]);
const validators = new Map<string, (value: unknown) => unknown>();
const cache = new Map<string, string>();
const dirty = new Map<string, { value: string; revision: number }>();
const listeners = new Set<() => void>();
const flushers = new Set<() => void | Promise<unknown>>();
const invalidNativeKeys = new Set<string>();
let status: UserStorageStatus = { directory: null, warning: null, blocked: false, initialized: false, saving: false };
let queue: Promise<unknown> = Promise.resolve();
let initializing: Promise<void> | undefined;
let flushing: Promise<void> | undefined;
let revision = 0;
let pending = 0;
let nativeWarning: string | null = null;
let migrationPending = false;
const errorText = (reason: unknown): string => reason instanceof Error ? reason.message : String(reason);
function publish(patch: Partial<UserStorageStatus>): void {
  status = { ...status, ...patch };
  for (const listener of listeners) listener();
}
function knownKey(key: string): key is StorageKey { return USER_STORAGE_KEYS.some((candidate) => candidate === key); }
function nativeValue(key: string, value: string): unknown { return stringKeys.has(key) ? value : JSON.parse(value); }
function storedValue(key: string, value: unknown): string {
  if (stringKeys.has(key)) {
    if (typeof value !== "string") throw new Error("配置字段必须为文本");
    return value;
  }
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("配置字段不是有效 JSON");
  return text;
}
export function registerStorageValidator(key: string, validate: (value: unknown) => unknown): void {
  if (!knownKey(key)) throw new Error(`未知配置字段：${key}`);
  validators.set(key, validate);
}
function readLegacy(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

/** Synchronous reads are backed by the snapshot hydrated before React mounts. */
export function getStoredItem(key: string): string | null {
  if (!knownKey(key)) return null;
  if (!isTauriRuntime() && !status.initialized) return readLegacy(key);
  return cache.get(key) ?? null;
}

async function hydrate(): Promise<void> {
  invalidNativeKeys.clear();
  if (!isTauriRuntime()) {
    cache.clear();
    for (const key of USER_STORAGE_KEYS) { const value = readLegacy(key); if (value !== null) cache.set(key, value); }
    publish({ initialized: true, blocked: false, directory: null, warning: null });
    return;
  }
  const native = await invoke<NativeStatus>("user_config_status");
  nativeWarning = native.warning;
  publish({ directory: native.directory, warning: native.warning, blocked: native.blocked });
  if (native.blocked) throw new Error(native.warning ?? "用户配置损坏，请重试或恢复默认设置。");
  const restored = await Promise.all(USER_STORAGE_KEYS.map(async (key) => [key, await invoke<unknown>("user_config_get", { key })] as const));
  cache.clear();
  for (const [key, value] of restored) {
    if (value === null) continue;
    try {
      const validate = validators.get(key);
      const validated = validate ? validate(value) : value;
      if (validated === null || validated === undefined) throw new Error("配置字段无效");
      cache.set(key, storedValue(key, validated));
    } catch { invalidNativeKeys.add(key); }
  }
  if (invalidNativeKeys.size) {
    throw new Error([nativeWarning, `部分配置损坏，已保留原数据，请重试或恢复损坏项：${[...invalidNativeKeys].join("、")}`].filter(Boolean).join("；"));
  }
  for (const [key, entry] of dirty) cache.set(key, entry.value);
  if (!native.legacyImportCompleted || migrationPending) {
    const entries: Record<string, unknown> = {};
    for (const key of USER_STORAGE_KEYS) {
      if (cache.has(key)) continue;
      const raw = readLegacy(key);
      if (raw === null) continue;
      try {
        const value = nativeValue(key, raw);
        const validate = validators.get(key);
        const validated = validate ? validate(value) : value;
        // Non-text preferences are objects or arrays, never JSON primitives.
        if (!stringKeys.has(key) && (!validated || typeof validated !== "object")) continue;
        entries[key] = validated;
        cache.set(key, storedValue(key, validated));
      } catch { /* One damaged legacy preference must not block the others. */ }
    }
    try {
      await invoke<void>("user_config_import", { entries });
      migrationPending = false;
    }
    catch (reason) {
      migrationPending = true;
      for (const [key, value] of Object.entries(entries)) dirty.set(key, { value: storedValue(key, value), revision: ++revision });
      const latest = await invoke<NativeStatus>("user_config_status");
      nativeWarning = latest.warning;
      publish({ directory: latest.directory, warning: latest.warning ?? errorText(reason), blocked: latest.blocked });
      if (latest.blocked) throw reason;
    }
  }
  publish({ initialized: true, blocked: false });
}

export function initializeUserStorage(): Promise<void> {
  if (initializing) return initializing;
  initializing = hydrate().catch((reason: unknown) => {
    publish({ initialized: true, blocked: true, warning: errorText(reason) });
    throw reason;
  }).finally(() => { initializing = undefined; });
  return initializing;
}

export function setStoredItem(key: string, value: string): Promise<boolean> {
  if (!knownKey(key)) return Promise.resolve(false);
  if (status.blocked || (isTauriRuntime() && !status.initialized)) return Promise.resolve(false);
  let parsed: unknown;
  try { parsed = nativeValue(key, value); }
  catch (reason) { publish({ warning: errorText(reason) }); return Promise.resolve(false); }
  cache.set(key, value);
  const entry = { value, revision: ++revision };
  dirty.set(key, entry);
  ++pending;
  publish({ saving: true });
  const result = queue.then(async () => {
    try {
      if (isTauriRuntime()) await invoke<void>("user_config_set", { key, value: parsed });
      else localStorage.setItem(key, value);
      if (dirty.get(key)?.revision === entry.revision) dirty.delete(key);
      if (!dirty.size) publish({ warning: nativeWarning });
      return true;
    } catch (reason) {
      publish({ warning: `配置保存失败，当前修改仍保留在内存中：${errorText(reason)}` });
      return false;
    } finally { --pending; publish({ saving: pending > 0 }); }
  });
  queue = result;
  return result;
}

export function registerStorageFlusher(callback: () => void | Promise<unknown>): () => void {
  flushers.add(callback);
  return () => { flushers.delete(callback); };
}

export function flushUserStorage(): Promise<void> {
  if (flushing) return flushing;
  flushing = (async () => {
    if (status.blocked) throw new Error(status.warning ?? "用户配置不可用。");
    for (const callback of flushers) await callback();
    await queue;
    // Retry retained edits once; a failed flush keeps the window and edits alive.
    for (const [key, entry] of [...dirty]) {
      if (dirty.get(key)?.revision !== entry.revision) continue;
      await setStoredItem(key, entry.value);
    }
    await queue;
    if (dirty.size) throw new Error(status.warning ?? "配置尚未保存，请重试。");
    if (isTauriRuntime()) {
      try {
        if (migrationPending) {
          await invoke<void>("user_config_import", { entries: {} });
          migrationPending = false;
        }
        await invoke<void>("user_config_flush");
        const native = await invoke<NativeStatus>("user_config_status");
        nativeWarning = native.warning;
        publish({ directory: native.directory, warning: native.warning, blocked: native.blocked });
        if (native.blocked) throw new Error(native.warning ?? "用户配置不可用。");
      }
      catch (reason) { publish({ warning: errorText(reason) }); throw reason; }
    }
  })().finally(() => { flushing = undefined; });
  return flushing;
}

export async function retryUserStorage(): Promise<void> {
  await queue;
  if (isTauriRuntime()) await invoke<NativeStatus>("user_config_retry");
  await initializeUserStorage();
  await flushUserStorage();
}

export async function resetUserStorage(): Promise<void> {
  await queue;
  if (isTauriRuntime()) await invoke<NativeStatus>("user_config_reset", { invalidKeys: invalidNativeKeys.size ? [...invalidNativeKeys] : null });
  else for (const key of USER_STORAGE_KEYS) localStorage.removeItem(key);
  cache.clear(); dirty.clear(); invalidNativeKeys.clear(); nativeWarning = null; migrationPending = false;
  publish({ initialized: false, blocked: false, warning: null });
  await initializeUserStorage();
}

export function getUserStorageStatus(): UserStorageStatus { return status; }
function subscribe(listener: () => void): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
export function useUserStorageStatus(): UserStorageStatus {
  return useSyncExternalStore(subscribe, getUserStorageStatus, getUserStorageStatus);
}
