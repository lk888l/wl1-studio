import { invoke } from "@tauri-apps/api/core";
import { deviceGateway, isTauriRuntime } from "./device";
import { encodePetPackage, petCrc32, petFrameHex, type PetProject } from "./pet-model";

export interface PetSnapshot {
  connected: boolean;
  sessionId?: number | null;
  portName?: string | null;
  status?: string | null;
}
export class PetCancelled extends Error {
  constructor() { super("桌宠操作已取消。"); }
}
const closed = (): PetSnapshot => ({ connected: false });

export class PetGateway {
  private state = closed();
  private queue: Promise<unknown> = Promise.resolve();
  private epoch = 0;
  private readonly listeners = new Set<(snapshot: PetSnapshot) => void>();
  get snapshot(): PetSnapshot { return { ...this.state }; }
  subscribe(listener: (snapshot: PetSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(snapshot: PetSnapshot): PetSnapshot {
    this.state = snapshot;
    for (const listener of this.listeners) listener(this.snapshot);
    return this.snapshot;
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }
  private async close(all: boolean): Promise<PetSnapshot> {
    if (isTauriRuntime() && (all || this.state.sessionId != null)) {
      await invoke("pet_disconnect", { expectedSessionId: all ? null : this.state.sessionId });
    }
    return this.publish(closed());
  }
  initialize(): Promise<PetSnapshot> {
    ++this.epoch;
    return this.serialize(() => this.close(true));
  }
  listSerialPorts() { return deviceGateway.listSerialPorts(); }
  connect(portName: string): Promise<PetSnapshot> {
    const epoch = ++this.epoch;
    return this.serialize(async () => {
      if (!isTauriRuntime()) throw new Error("真实 USB 串口需要在桌面应用中连接。");
      if (!portName.trim()) throw new Error("请选择 ESP32-C3 的 USB 串口。");
      if (epoch !== this.epoch) throw new PetCancelled();
      await this.close(false);
      const snapshot = await invoke<PetSnapshot>("pet_connect", { portName });
      if (epoch !== this.epoch) {
        await invoke("pet_disconnect", { expectedSessionId: snapshot.sessionId });
        throw new PetCancelled();
      }
      return this.publish(snapshot);
    });
  }
  disconnect(): Promise<PetSnapshot> {
    ++this.epoch;
    return this.serialize(() => this.close(false));
  }
  private session<T>(work: (command: (text: string) => Promise<string>) => Promise<T>): Promise<T> {
    const epoch = this.epoch;
    const sessionId = this.state.sessionId;
    const assertCurrent = () => {
      if (epoch !== this.epoch || sessionId == null || sessionId !== this.state.sessionId || !this.state.connected) throw new PetCancelled();
    };
    return this.serialize(async () => {
      assertCurrent();
      return work(async (command) => {
        assertCurrent();
        try {
          const reply = await invoke<string>("pet_command", { expectedSessionId: sessionId, command });
          assertCurrent();
          if (!reply.startsWith("pet_ok ")) throw new Error(reply || "设备没有确认桌宠命令。");
          return reply;
        } catch (reason) {
          if (epoch === this.epoch) {
            try { const snapshot = await invoke<PetSnapshot>("pet_snapshot"); if (epoch === this.epoch) this.publish(snapshot); }
            catch { /* Explicit disconnect can still release the owned session. */ }
          }
          throw reason;
        }
      });
    });
  }
  command(command: string): Promise<string> {
    return this.session((query) => query(command));
  }
  upload(project: PetProject, progress: (sent: number, total: number) => void, cancelled: () => boolean, onCommitting: () => void = () => undefined): Promise<void> {
    const bytes = encodePetPackage(project);
    return this.session(async (query) => {
      let begun = false;
      try {
        if (cancelled()) throw new PetCancelled();
        const crc = petCrc32(bytes);
        const begin = await query(`pet begin ${bytes.length} ${crc}`);
        begun = true;
        if (begin !== `pet_ok begin bytes=${bytes.length}`) throw new Error("设备确认的宠物包大小不一致，已取消上传。");
        progress(0, bytes.length);
        for (let offset = 0; offset < bytes.length; offset += 64) {
          if (cancelled()) throw new PetCancelled();
          const chunk = bytes.subarray(offset, offset + 64);
          const reply = await query(`pet chunk ${offset} ${petFrameHex(chunk)}`);
          if (reply !== `pet_ok chunk next=${offset + chunk.length}`) throw new Error("设备确认的像素偏移不一致，已取消上传。");
          progress(offset + chunk.length, bytes.length);
        }
        if (cancelled()) throw new PetCancelled();
        onCommitting();
        const committed = await query("pet commit");
        if (committed.toLowerCase() !== `pet_ok commit bytes=${bytes.length} crc=${crc}`) throw new Error("设备保存回执的大小或校验和不一致，请重新连接并核对设备。");
        begun = false;
        await query("pet open 4");
      } catch (reason) {
        if (begun) { try { await query("pet abort"); } catch { /* Preserve the original upload error. */ } }
        throw reason;
      }
    });
  }
}
export const petGateway = new PetGateway();
