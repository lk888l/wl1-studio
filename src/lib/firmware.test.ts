import { afterEach, describe, expect, it, vi } from "vitest";
import { firmwareApi, firmwareFormat, firmwareImageRangeError, FIRMWARE_TARGETS, FLASH_START, flashRows, hexAddress, parseFlashAddress, resolveFirmwareTarget, sameFlashTarget, networkProbeOption, mergeStickS3Probes, type ChipInfo } from "./firmware";
import type { NetworkProbe } from "./sticks3-network";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("固件文件与 Flash 地址", () => {
  it("shows the last byte of a G431 backup and bounds SWD target addresses", () => {
    const size = 128 * 1024;
    const data = new Array<number>(size).fill(0xff);
    data[data.length - 1] = 0x47;
    expect(flashRows(data, 511).at(-1)?.address).toBe("0x0801FFF0");
    expect(flashRows(data, 511).at(-1)?.ascii).toBe("...............G");
    expect(flashRows(data, 512)).toEqual([]);
    expect(parseFlashAddress("0801ffff", size)).toBe(FLASH_START + 128 * 1024 - 1);
    expect(() => parseFlashAddress("08020000", size)).toThrow();
  });
  it("supports downloaded firmware formats without guessing unknown extensions", () => {
    expect(firmwareFormat("WL1-v2.BIN")).toBe("bin");
    expect(firmwareFormat("motor.axf")).toBe("elf");
    expect(firmwareFormat("car.hex")).toBe("hex");
    expect(() => firmwareFormat("firmware.zip")).toThrow();
    expect(() => firmwareFormat("firmware.bin.exe")).toThrow();
  });

  it("accepts both hexadecimal forms and rejects partial parses or out-of-chip addresses", () => {
    expect(parseFlashAddress("0x08000000", 512 * 1024)).toBe(FLASH_START);
    expect(parseFlashAddress("0807ffff", 512 * 1024)).toBe(FLASH_START + 512 * 1024 - 1);
    for (const value of ["08080000", "07ffffff", "0x08000000oops", "-08000000", "", "100000000", "0x20000000"]) {
      expect(() => parseFlashAddress(value, 512 * 1024)).toThrow();
    }
    expect(parseFlashAddress("08040000", 512 * 1024)).toBe(FLASH_START + 256 * 1024);
  });

  it("shows the complete GameBox settings area but rejects it as a firmware start address", () => {
    const target = FIRMWARE_TARGETS.gamebox;
    const data = new Array<number>(target.flashSize).fill(0xff);
    data[data.length - 1] = 0x41;
    const rows = flashRows(data, 255);
    expect(rows).toHaveLength(16);
    expect(rows.at(-1)?.address).toBe("0x0800FFF0");
    expect(rows.at(-1)?.ascii).toBe("...............A");
    expect(flashRows(data, 256)).toEqual([]);
    expect(parseFlashAddress("0800ffff", target.flashSize)).toBe(FLASH_START + 64 * 1024 - 1);
    expect(parseFlashAddress("0800f7ff", target.programSize)).toBe(FLASH_START + 62 * 1024 - 1);
    expect(() => parseFlashAddress("0800f800", target.programSize)).toThrow();
  });

  it("renders the final byte of a full 512 KiB dump and limits each page to 256 bytes", () => {
    const data = new Array<number>(512 * 1024).fill(0xff);
    data[data.length - 1] = 0x41;
    const rows = flashRows(data, 2047);
    expect(rows).toHaveLength(16);
    expect(rows.at(-1)?.address).toBe("0x0807FFF0");
    expect(rows.at(-1)?.hex).toMatch(/FF 41$/);
    expect(rows.at(-1)?.ascii).toBe("...............A");
    expect(flashRows(data, 2048)).toEqual([]);
    expect(hexAddress(FLASH_START)).toBe("0x08000000");
  });

  it("keeps binary zeroes, printable bytes and partial final lines distinguishable", () => {
    const row = flashRows([0, 31, 32, 65, 126, 127, 255], 0)[0];
    expect(row?.hex).toBe("00 1F 20 41 7E 7F FF");
    expect(row?.ascii).toBe(".. A~..");
  });
});

describe("通用 SWD 按实测容量操作", () => {
  const detected: ChipInfo = {
    name: "STM32F1", target: "STM32F103C8Tx", deviceId: 0x410, revisionId: 0x2000,
    flashStart: FLASH_START, flashSize: 64 * 1024, uid: "00112233445566778899AABB",
    speedKhz: 100, probeId: "303a:4004:fixture",
  };

  it("starts without a guessed capacity and uses all 64 KiB after F1 discovery", () => {
    const pending = resolveFirmwareTarget("sticks3", null);
    expect(pending.chip).toBe("auto");
    expect(pending.flashSize).toBeNull();
    expect(pending.programSize).toBeNull();
    const actual = resolveFirmwareTarget("sticks3", detected);
    expect(actual.flashSize).toBe(64 * 1024);
    expect(actual.programSize).toBe(64 * 1024);
    expect(actual.canErase).toBe(true);
    expect(resolveFirmwareTarget("gamebox", detected).programSize).toBe(62 * 1024);
    expect(resolveFirmwareTarget("gamebox", detected).canErase).toBe(false);
    expect(resolveFirmwareTarget("wl1", detected).flashSize).toBe(512 * 1024);
  });

  it("rechecks every file region when discovered capacity changes", () => {
    const file = { fileSize: 4, programmedSize: 4, sha256: "fixture", regions: [{ address: FLASH_START + 65535, length: 1 }] };
    expect(firmwareImageRangeError(file, 65536)).toBeNull();
    const beyond = { ...file, regions: [...file.regions, { address: FLASH_START + 65536, length: 1 }] };
    expect(firmwareImageRangeError(beyond, null)).toBeNull();
    expect(firmwareImageRangeError(beyond, 65536)).toContain("实测 64 KiB");
    expect(firmwareImageRangeError(beyond, 131072)).toBeNull();
    expect(firmwareImageRangeError({ ...file, regions: [{ address: 0x20000000, length: 1 }] }, 65536)).not.toBeNull();
  });

  it("distinguishes replacement chips behind the same probe and preserves snapshot identity", () => {
    expect(sameFlashTarget(detected, { ...detected, speedKhz: 1000 })).toBe(true);
    expect(sameFlashTarget(detected, { ...detected, uid: "new-board" })).toBe(false);
    expect(sameFlashTarget(detected, { ...detected, flashSize: 131072 })).toBe(false);
    expect(sameFlashTarget(detected, { ...detected, deviceId: 0x468 })).toBe(false);
  });
});

describe("浏览器没有真实烧录能力", () => {
  it("refuses all hardware operations instead of displaying simulated success", async () => {
    vi.stubGlobal("window", {});
    const config = { probeId: "0483:3748:test", chip: "stm32f411ceu" as const, speedKhz: 1000, connectUnderReset: false };
    await expect(firmwareApi.read(config)).rejects.toThrow("桌面应用");
    await expect(firmwareApi.erase(config, "ERASE")).rejects.toThrow("桌面应用");
    await expect(firmwareApi.flash(config, { format: "bin", data: [1], baseAddress: FLASH_START, chip: config.chip }, "hash")).rejects.toThrow("桌面应用");
    await expect(firmwareApi.installUsbSupport()).rejects.toThrow("桌面应用");
    await expect(firmwareApi.read({ ...config, chip: "stm32f103c8t6" })).rejects.toThrow("桌面应用");
  });
});

describe("游戏机 SWD 请求", () => {
  it("carries the F103 target through inspection, flashing and reading", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue(undefined);
    const chip = FIRMWARE_TARGETS.gamebox.chip;
    const config = { probeId: "0483:3748:gamebox", chip, speedKhz: 1000, connectUnderReset: false };
    const image = { format: "bin" as const, chip, data: [1, 2, 3, 4], baseAddress: FLASH_START };
    await firmwareApi.inspect(image);
    await firmwareApi.flash(config, image, "confirmed-hash");
    await firmwareApi.read(config);
    expect(invoke.mock.calls).toEqual([
      ["firmware_inspect", { image }],
      ["firmware_flash", { config, image, confirmedSha256: "confirmed-hash" }],
      ["firmware_read", { config }],
    ]);
  });
});

describe("USB 设置须单独确认", () => {
  it("only reads support information until the explicit install action", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValueOnce({ platform: "linux", canInstall: true });
    await firmwareApi.usbSupport();
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["firmware_usb_support"]);
    invoke.mockResolvedValueOnce("设置完成");
    await expect(firmwareApi.installUsbSupport()).resolves.toBe("设置完成");
    expect(invoke).toHaveBeenLastCalledWith("firmware_install_usb_support", { confirmed: true });
  });

  it("keeps system authorization cancellation as an error", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockRejectedValueOnce(new Error("已取消系统授权"));
    await expect(firmwareApi.installUsbSupport()).rejects.toThrow("已取消系统授权");
  });
});

describe("USB 与无线共用 Flash 工作区", () => {
  const probe: NetworkProbe = { host: "172.18.7.163", port: 4441, serial: "14C19FD536F4", vendor: "M5StickS3", product: "StickS3 CMSIS-DAP", firmwareVersion: "2.1.2", swd: true, jtag: true, packetSize: 64 };
  it("USB 刷新保留无线设备，地址与序列号一起确定选择身份", () => {
    const usb = { id: "303a:4004:usb", name: "StickS3", serialNumber: "usb", accessible: true };
    const options = mergeStickS3Probes([usb, { ...usb, id: "0483:3748:other" }], [probe]);
    expect(options).toHaveLength(2);
    expect(options[0]).toEqual(usb);
    expect(options[1]).toMatchObject({ id: "tcp:172.18.7.163:4441:14C19FD536F4", protocols: ["swd", "jtag"], network: { host: probe.host, port: probe.port, serial: probe.serial } });
    expect(mergeStickS3Probes([], [probe])[0]).toEqual(options[1]);
    expect(networkProbeOption({ ...probe, swd: false }).protocols).toEqual(["jtag"]);
    expect(networkProbeOption({ ...probe, host: "192.168.4.1" }).id).not.toBe(options[1]?.id);
  });
  it("识别、读写、校验和擦除均携带同一无线端点及所选 JTAG 协议", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
    invoke.mockResolvedValue(undefined);
    const option = networkProbeOption(probe);
    const config = { probeId: option.id, network: option.network, protocol: "jtag" as const, chip: "auto" as const, speedKhz: 100, connectUnderReset: false, expectedTarget: { deviceId: 0x410, flashSize: 65536, uid: "same-board" } };
    const image = { chip: "auto" as const, format: "bin" as const, data: [1], baseAddress: FLASH_START };
    await firmwareApi.identify(config); await firmwareApi.read(config); await firmwareApi.verify(config, image);
    await firmwareApi.flash(config, image, "sha"); await firmwareApi.erase(config, "ERASE"); await firmwareApi.reset(config);
    expect(invoke.mock.calls.map(([, args]) => args.config)).toEqual(Array(6).fill(config));
    expect(invoke.mock.calls.map(([command]) => command)).toEqual(["firmware_identify", "firmware_read", "firmware_verify", "firmware_flash", "firmware_erase", "firmware_reset"]);
  });
  it("切换调试协议使之前的芯片确认与 Flash 快照失效", () => {
    const target: ChipInfo = { name: "STM32F1", target: "STM32F103C8Tx", deviceId: 0x410, revisionId: 0, flashStart: FLASH_START, flashSize: 65536, uid: "board", speedKhz: 100, probeId: networkProbeOption(probe).id, protocol: "swd" };
    expect(sameFlashTarget(target, { ...target, protocol: "jtag" })).toBe(false);
    expect(sameFlashTarget(target, { ...target, speedKhz: 250 })).toBe(true);
  });
});
