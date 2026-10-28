import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke, runtime } = vi.hoisted(() => ({ invoke: vi.fn(), runtime: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./device", () => ({ isTauriRuntime: runtime }));

const themeKey = "wl1-studio.personalization.v1";
const portKey = "studio.sticks3.port.v1";
const profileKey = "wl1-studio.parameter-profiles.v1";
let storage: typeof import("./user-storage");
let nativeValues: Map<string, unknown>;
let legacyValues: Map<string, string>;
let nativeStatus: { directory: string; warning: string | null; blocked: boolean; legacyImportCompleted: boolean };
let failWrites: boolean;
let browser: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn>; removeItem: ReturnType<typeof vi.fn> };
async function nativeCommand(command: string, args?: Record<string, unknown>): Promise<unknown> {
  if (command === "user_config_status") return { ...nativeStatus };
  if (command === "user_config_get") return nativeValues.get(String(args?.key)) ?? null;
  if (command === "user_config_reset") {
    const invalidKeys = args?.invalidKeys as string[] | undefined;
    if (invalidKeys?.length) for (const key of invalidKeys) nativeValues.delete(key);
    else nativeValues.clear();
    nativeStatus.blocked = false; nativeStatus.warning = null; nativeStatus.legacyImportCompleted = true; return nativeStatus;
  }
  if (command === "user_config_retry") return nativeStatus;
  if (failWrites) throw new Error("directory is read-only");
  if (command === "user_config_set") { nativeValues.set(String(args?.key), args?.value); return; }
  if (command === "user_config_import") {
    for (const [key, value] of Object.entries(args?.entries as Record<string, unknown>)) if (!nativeValues.has(key)) nativeValues.set(key, value);
    nativeStatus.legacyImportCompleted = true;
  }
}

beforeEach(async () => {
  vi.resetModules(); vi.clearAllMocks(); runtime.mockReturnValue(true);
  nativeValues = new Map(); legacyValues = new Map(); failWrites = false;
  nativeStatus = { directory: "D:\\studio\\.local", warning: null, blocked: false, legacyImportCompleted: true };
  browser = {
    getItem: vi.fn((key: string) => legacyValues.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { legacyValues.set(key, value); }),
    removeItem: vi.fn((key: string) => { legacyValues.delete(key); }),
  };
  vi.stubGlobal("localStorage", browser);
  invoke.mockImplementation(nativeCommand);
  storage = await import("./user-storage");
});

describe("便携用户配置的初始化与迁移", () => {
  it("先读取本机文件，只补缺少的已知旧字段，损坏的旧项不影响其余配置", async () => {
    nativeStatus.legacyImportCompleted = false;
    nativeValues.set(themeKey, { accent: "mint" });
    legacyValues.set(themeKey, JSON.stringify({ accent: "violet" }));
    legacyValues.set(portKey, " COM7 ");
    legacyValues.set(profileKey, "{broken");
    legacyValues.set("unrelated-secret", "ignored");
    storage.registerStorageValidator(portKey, (value) => String(value).trim());
    await storage.initializeUserStorage();
    expect(storage.getStoredItem(themeKey)).toBe('{"accent":"mint"}');
    expect(storage.getStoredItem(portKey)).toBe("COM7");
    expect(storage.getStoredItem(profileKey)).toBeNull();
    expect(invoke).toHaveBeenCalledWith("user_config_import", { entries: { [portKey]: "COM7" } });
    expect(browser.setItem).not.toHaveBeenCalled();
    expect(browser.removeItem).not.toHaveBeenCalled();
    expect(browser.getItem).not.toHaveBeenCalledWith("unrelated-secret");
  });

  it("迁移目标不可写时仍恢复会话配置，保留修改供稍后重试", async () => {
    nativeStatus.legacyImportCompleted = false;
    legacyValues.set(portKey, "COM9"); failWrites = true;
    await storage.initializeUserStorage();
    expect(storage.getStoredItem(portKey)).toBe("COM9");
    await expect(storage.flushUserStorage()).rejects.toThrow("read-only");
    expect(legacyValues.get(portKey)).toBe("COM9");
    failWrites = false;
    await storage.retryUserStorage();
    expect(nativeValues.get(portKey)).toBe("COM9");
    expect(invoke).toHaveBeenCalledWith("user_config_flush");
  });

  it("失败的首次迁移在关闭刷新成功后持久化完成标记，携带配置不会混入另一台机器的旧项", async () => {
    nativeStatus.legacyImportCompleted = false;
    legacyValues.set(portKey, "COM9"); failWrites = true;
    await storage.initializeUserStorage();
    expect(nativeStatus.legacyImportCompleted).toBe(false);
    failWrites = false;
    await storage.flushUserStorage();
    expect(nativeStatus.legacyImportCompleted).toBe(true);
    expect(invoke).toHaveBeenCalledWith("user_config_import", { entries: {} });
    expect(nativeValues.get(portKey)).toBe("COM9");
    // The same portable store opened on a machine with unrelated legacy data.
    legacyValues.set(themeKey, '{"accent":"violet"}');
    await storage.initializeUserStorage();
    expect(storage.getStoredItem(themeKey)).toBeNull();
  });

  it("损坏文件阻止默认值覆盖，显式重置后不重新导入旧数据", async () => {
    nativeStatus.blocked = true; nativeStatus.warning = "配置损坏";
    nativeStatus.legacyImportCompleted = false; legacyValues.set(portKey, "COM3");
    await expect(storage.initializeUserStorage()).rejects.toThrow("配置损坏");
    expect(await storage.setStoredItem(themeKey, "{}")).toBe(false);
    expect(invoke.mock.calls.some(([command]) => command === "user_config_set")).toBe(false);
    await storage.resetUserStorage();
    expect(invoke).toHaveBeenCalledWith("user_config_reset", { invalidKeys: null });
    expect(storage.getStoredItem(portKey)).toBeNull();
    expect(invoke.mock.calls.some(([command]) => command === "user_config_import")).toBe(false);
  });

  it("后台不可达时拒绝挂载，恢复连接后可以重试", async () => {
    invoke.mockRejectedValueOnce(new Error("bridge unavailable"));
    await expect(storage.initializeUserStorage()).rejects.toThrow("bridge unavailable");
    await storage.retryUserStorage();
    expect(await storage.setStoredItem(portKey, "COM1")).toBe(true);
  });

  it("文件内单个字段损坏阻止自动覆盖，显式恢复只重置坏项", async () => {
    nativeValues.set(portKey, { invalid: "port" });
    nativeValues.set(themeKey, { accent: "mint" });
    storage.registerStorageValidator(portKey, (value) => {
      if (typeof value !== "string") throw new Error("invalid port");
      return value;
    });
    await expect(storage.initializeUserStorage()).rejects.toThrow("部分配置损坏");
    expect(await storage.setStoredItem(portKey, "default port")).toBe(false);
    expect(nativeValues.get(portKey)).toEqual({ invalid: "port" });
    await storage.resetUserStorage();
    expect(invoke).toHaveBeenCalledWith("user_config_reset", { invalidKeys: [portKey] });
    expect(storage.getStoredItem(themeKey)).toBe('{"accent":"mint"}');
    expect(await storage.setStoredItem(portKey, "COM3")).toBe(true);
  });
});

describe("原生写入确认与关闭前保存", () => {
  it("保存等待原生确认，关闭刷新等待正在写入的请求", async () => {
    await storage.initializeUserStorage();
    let acknowledge: () => void = () => { throw new Error("write was not submitted"); };
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => command === "user_config_set"
      ? new Promise<void>((resolve) => { acknowledge = resolve; })
      : nativeCommand(command, args));
    let finished = false;
    const save = storage.setStoredItem(portKey, "COM8").then((result) => { finished = true; return result; });
    const flush = storage.flushUserStorage();
    await Promise.resolve();
    expect(storage.getStoredItem(portKey)).toBe("COM8");
    expect(finished).toBe(false);
    expect(invoke.mock.calls.some(([command]) => command === "user_config_flush")).toBe(false);
    acknowledge();
    expect(await save).toBe(true);
    await flush;
    expect(invoke.mock.calls.slice(-2).map(([command]) => command)).toEqual(["user_config_flush", "user_config_status"]);
    expect(browser.setItem).not.toHaveBeenCalled();
  });

  it("失败的写入保留最新内存值，刷新重试后真正落盘", async () => {
    nativeValues.set(portKey, "COM2");
    await storage.initializeUserStorage(); failWrites = true;
    expect(await storage.setStoredItem(portKey, "COM4")).toBe(false);
    expect(storage.getStoredItem(portKey)).toBe("COM4");
    expect(nativeValues.get(portKey)).toBe("COM2");
    failWrites = false; await storage.flushUserStorage();
    expect(nativeValues.get(portKey)).toBe("COM4");
  });

  it("无关用户字段保存成功不会清掉后台配置警告，全部刷新成功后再更新警告", async () => {
    nativeStatus.warning = "后台配置保存失败";
    await storage.initializeUserStorage();
    await storage.setStoredItem(portKey, "COM4");
    expect(storage.getUserStorageStatus().warning).toBe("后台配置保存失败");
    nativeStatus.warning = null;
    await storage.flushUserStorage();
    expect(storage.getUserStorageStatus().warning).toBeNull();
  });

  it("重试过程中较晚的改动不会被旧dirty快照覆盖", async () => {
    await storage.initializeUserStorage(); failWrites = true;
    await storage.setStoredItem(portKey, "old port");
    await storage.setStoredItem(themeKey, '{"accent":"old"}');
    failWrites = false;
    let acknowledge: () => void = () => { throw new Error("retry not started"); };
    let firstRetry = true;
    invoke.mockImplementation((command: string, args?: Record<string, unknown>) => {
      if (command === "user_config_set" && firstRetry) {
        firstRetry = false;
        return new Promise<void>((resolve) => { acknowledge = () => { nativeValues.set(String(args?.key), args?.value); resolve(); }; });
      }
      return nativeCommand(command, args);
    });
    const flush = storage.flushUserStorage();
    await Promise.resolve(); await Promise.resolve();
    const newer = storage.setStoredItem(themeKey, '{"accent":"new"}');
    acknowledge();
    await newer; await flush;
    expect(storage.getStoredItem(themeKey)).toBe('{"accent":"new"}');
    expect(nativeValues.get(themeKey)).toEqual({ accent: "new" });
  });

  it("前端防抖数据先提交，再确认用户配置和后台设置全部落盘", async () => {
    await storage.initializeUserStorage();
    const unregister = storage.registerStorageFlusher(async () => { await storage.setStoredItem(portKey, "COM6"); });
    await storage.flushUserStorage();
    const commands = invoke.mock.calls.map(([command]) => command);
    expect(commands.slice(-3)).toEqual(["user_config_set", "user_config_flush", "user_config_status"]);
    unregister(); invoke.mockClear(); await storage.flushUserStorage();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["user_config_flush", "user_config_status"]);
  });

  it("较大的档案保持完整，不受旧监控消息16KiB边界截断", async () => {
    await storage.initializeUserStorage();
    const profiles = [{ name: "x".repeat(20_000) }];
    expect(await storage.setStoredItem(profileKey, JSON.stringify(profiles))).toBe(true);
    expect(nativeValues.get(profileKey)).toEqual(profiles);
  });

  it("浏览器预览继续使用原有存储，无需原生命令", async () => {
    runtime.mockReturnValue(false); legacyValues.set(portKey, "COM5");
    await storage.initializeUserStorage();
    expect(storage.getStoredItem(portKey)).toBe("COM5");
    expect(await storage.setStoredItem(portKey, "COM7")).toBe(true);
    await storage.flushUserStorage();
    expect(legacyValues.get(portKey)).toBe("COM7");
    expect(invoke).not.toHaveBeenCalled();
  });
});
