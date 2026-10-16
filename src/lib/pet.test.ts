import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PetSnapshot } from "./pet";

const { invoke, runtime } = vi.hoisted(() => ({ invoke: vi.fn(), runtime: vi.fn(() => true) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
vi.mock("./device", () => ({ isTauriRuntime: runtime, deviceGateway: { listSerialPorts: vi.fn(async () => []) } }));
import { PetCancelled, PetGateway } from "./pet";
import { encodePetPackage, makePetPreset, newPetProject, petCrc32 } from "./pet-model";

const session: PetSnapshot = { connected: true, sessionId: 7, portName: "/dev/ttyACM0" };
interface Arguments { command?: string; expectedSessionId?: number | null }
function backend(name: string, args?: Arguments) {
  if (name === "pet_connect" || name === "pet_snapshot") return { ...session };
  if (name === "pet_command") {
    const fields = args?.command?.split(" ") ?? [];
    if (fields[1] === "begin") return `pet_ok begin bytes=${fields[2]}`;
    if (fields[1] === "chunk") return `pet_ok chunk next=${Number(fields[2]) + (fields[3]?.length ?? 0) / 2}`;
    if (fields[1] === "commit") return `pet_ok commit bytes=320 crc=${petCrc32(encodePetPackage(newPetProject()))}`;
    return `pet_ok ${fields[1]}`;
  }
  return { connected: false };
}
const sentCommands = (): string[] => invoke.mock.calls.filter(([name]) => name === "pet_command").map(([, args]) => (args as Arguments).command ?? "");
beforeEach(() => { vi.clearAllMocks(); runtime.mockReturnValue(true); invoke.mockImplementation(async (name: string, args?: Arguments) => backend(name, args)); });

describe("桌宠 USB 会话和可靠上传", () => {
  it("浏览器离线创作可生成所有样式与像素包，不伪造 USB 设备", async () => {
    runtime.mockReturnValue(false);
    const gateway = new PetGateway(); await gateway.initialize();
    for (const style of [0, 1, 2, 3] as const) expect(encodePetPackage(makePetPreset(style)).length).toBe(4160);
    await expect(gateway.connect("/dev/ttyACM0")).rejects.toThrow("桌面应用");
    expect(gateway.snapshot.connected).toBe(false); expect(invoke).not.toHaveBeenCalled();
  });
  it("上传逐块等待ACK，偏移连续且最多64字节，提交成功后才显示custom", async () => {
    const gateway = new PetGateway(); await gateway.connect("/dev/ttyACM0");
    const project = newPetProject(); const bytes = encodePetPackage(project);
    const progress = vi.fn(); await gateway.upload(project, progress, () => false);
    const commands = sentCommands();
    expect(commands[0]).toBe(`pet begin ${bytes.length} ${petCrc32(bytes)}`);
    const chunks = commands.filter((command) => command.startsWith("pet chunk "));
    expect(chunks.length).toBe(5);
    chunks.forEach((command, index) => { const fields = command.split(" "); expect(Number(fields[2])).toBe(index * 64); expect(fields[3]).toHaveLength(128); });
    expect(commands.slice(-2)).toEqual(["pet commit", "pet open 4"]);
    expect(progress).toHaveBeenLastCalledWith(320, 320);
    expect(invoke.mock.calls.filter(([name]) => name === "pet_command").every(([, args]) => (args as Arguments).expectedSessionId === 7)).toBe(true);
  });
  it("设备拒绝分块时 abort，保留连接且不提交不重试", async () => {
    const gateway = new PetGateway(); await gateway.connect("/dev/ttyACM0");
    invoke.mockImplementation(async (name: string, args?: Arguments) => {
      if (args?.command?.startsWith("pet chunk")) throw new Error("pet_error chunk offset");
      return backend(name, args);
    });
    await expect(gateway.upload(newPetProject(), vi.fn(), () => false)).rejects.toThrow("offset");
    expect(sentCommands().filter((command) => command.startsWith("pet chunk"))).toHaveLength(1);
    expect(sentCommands().at(-1)).toBe("pet abort"); expect(sentCommands()).not.toContain("pet commit");
    expect(gateway.snapshot.connected).toBe(true);
  });
  it("拒绝偏移错误的 ACK 并 abort，不提交不继续发送", async () => {
    const gateway = new PetGateway(); await gateway.connect("/dev/ttyACM0");
    invoke.mockImplementation(async (name: string, args?: Arguments) => args?.command?.startsWith("pet chunk") ? "pet_ok chunk next=999" : backend(name, args));
    await expect(gateway.upload(newPetProject(), vi.fn(), () => false)).rejects.toThrow("偏移");
    expect(sentCommands().at(-1)).toBe("pet abort"); expect(sentCommands()).not.toContain("pet commit");
  });
  it("拒绝不匹配的 commit 大小或 CRC，不显示 custom", async () => {
    const gateway = new PetGateway(); await gateway.connect("/dev/ttyACM0");
    invoke.mockImplementation(async (name: string, args?: Arguments) => args?.command === "pet commit" ? "pet_ok commit bytes=320 crc=ffffffff" : backend(name, args));
    await expect(gateway.upload(newPetProject(), vi.fn(), () => false)).rejects.toThrow("校验和");
    expect(sentCommands()).not.toContain("pet open 4");
  });
  it("用户取消上传时 abort 暂存包并保留原宠物", async () => {
    const gateway = new PetGateway(); await gateway.connect("/dev/ttyACM0");
    let cancel = false;
    await expect(gateway.upload(newPetProject(), (sent) => { if (sent > 0) cancel = true; }, () => cancel)).rejects.toBeInstanceOf(PetCancelled);
    expect(sentCommands().at(-1)).toBe("pet abort"); expect(sentCommands()).not.toContain("pet commit");
    expect(gateway.snapshot.connected).toBe(true);
  });
  it("断开立即取消排队动作，不把旧命令写入新会话", async () => {
    const gateway = new PetGateway(); await gateway.connect("/dev/ttyACM0");
    const pending = gateway.command("pet action happy"); const rejected = expect(pending).rejects.toBeInstanceOf(PetCancelled);
    await gateway.disconnect(); await rejected;
    expect(sentCommands()).toEqual([]); expect(invoke).toHaveBeenLastCalledWith("pet_disconnect", { expectedSessionId: 7 });
  });
  it("超时刷新失效状态，不重发动作", async () => {
    const gateway = new PetGateway(); await gateway.connect("/dev/ttyACM0");
    invoke.mockImplementation(async (name: string) => { if (name === "pet_command") throw new Error("timeout"); return { connected: false }; });
    await expect(gateway.command("pet action dance")).rejects.toThrow("timeout");
    expect(sentCommands()).toEqual(["pet action dance"]); expect(gateway.snapshot.connected).toBe(false);
  });
  it("握手期间断开会释放迟到的会话", async () => {
    let complete: (snapshot: PetSnapshot) => void = () => { throw new Error("not started"); };
    invoke.mockImplementation((name: string) => name === "pet_connect" ? new Promise<PetSnapshot>((resolve) => { complete = resolve; }) : Promise.resolve({ connected: false }));
    const gateway = new PetGateway(); const opening = gateway.connect("/dev/ttyACM0");
    const rejected = expect(opening).rejects.toBeInstanceOf(PetCancelled);
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("pet_connect", { portName: "/dev/ttyACM0" }));
    const closing = gateway.disconnect(); complete(session); await rejected; await closing;
    expect(invoke).toHaveBeenCalledWith("pet_disconnect", { expectedSessionId: 7 }); expect(gateway.snapshot.connected).toBe(false);
  });
});
