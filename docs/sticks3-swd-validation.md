# StickS3 USB DAP / STM32G431 实机验收

日期：2026-09-23。使用真实 Tauri 桌面应用、用户连接的 StickS3 与 STM32G431CBU6。
USB DAP 使用现有 StickS3 固件，本次未修改或重新烧录 ESP32-S3。

## 设备与连接

| 项目 | 实测值 |
| --- | --- |
| CMSIS-DAP USB | `303a:4004`，序列号 `14C19FD536F4` |
| 目标 | STM32G431CBU6，Cortex-M4 |
| 器件系列 ID / 修订 | `0x468` / `0x2003` |
| 主 Flash | 128 KiB，`0x08000000–0x0801FFFF` |
| UID（按寄存器字节顺序） | `40004B000850303448383720` |
| 连接模式 | 普通 SWD 连接，未使用“复位下连接” |
| SWD 频率设置 | 后端专项测试 100 kHz；桌面擦写及最终独立回读 1000 kHz |

独立参考工具为 Docker `esp-dev` 中的 OpenOCD
`v0.12.0-esp32-20251215`，使用 StickS3 固件仓库的 `tools/openocd/sticks3-usb.cfg`
与 OpenOCD `target/stm32g4x.cfg`，测试时覆盖 `reset_config none`。
频率是软件配置值，本次未以示波器测量实际 SWCLK。

## 测试结果

1. OpenOCD 连接、暂停、读取芯片信息、单步、恢复运行成功。首先保存完整 128 KiB 原始备份。
2. 应用的实际 Rust 工作线程完成识别、完整读取、文件校验及复位。全部 131072 字节与
   OpenOCD 备份一致。仅修改校验文件的最后一个字节后，正确报出 `0x0801FFFF` 不一致；
   此项只修改电脑内存中的测试文件，不写入目标。
3. 通过原生桌面 WebView 操作真实界面，完成探针枚举、芯片识别、文件解析、完整 Flash
   读取及十六进制显示。Tauri IPC 和 USB 均为真实后端，未使用模拟设备。
4. 用户明确允许“擦除测试后恢复原程序”后，通过界面输入 `ERASE` 并执行主 Flash 擦除。
   后端检查完整 Flash 全为 `FF`；再用界面独立读取确认全空。
5. 在界面选择原始备份，确认文件 SHA-256 与地址范围后烧录。烧录、回读校验及复位成功；
   随后点击“仅校验文件与 Flash”，再次通过逐字节校验。
6. 最后用 OpenOCD 再次独立读取完整主 Flash，131072 字节与原始备份完全一致，并恢复运行。
   原程序已经恢复。没有将此前提供的 F103 游戏机 HEX 写入 G431。
7. 界面地址跳转至 `0x0801FFFF`，正确显示第 512 / 512 页；切换无线 / SWD 页面后快照和
   页码仍保留。切换目标芯片后导出旧快照，文件名仍标记原 G431；实际下载的 131072 字节
   BIN 与原始备份一致。131073 字节的越界 BIN 被拒绝，烧录按钮禁用。

原始备份、应用读取和最终 OpenOCD 回读的 SHA-256 均为：

```text
30b894fede6f148988c38ed9962084b06a38ff5f0240fe60dc7d6cfa04fece19
```

擦除后完整 128 KiB 全 `FF` 的 SHA-256 为：

```text
b5a41c3758763bbec72769fab4a2533bf2db0b6312d93d25a695f9e4b9e02260
```

本机验收文件保存在 `captures/sticks3-g431-20260923/`（已被 Git 忽略）：

- `original-flash.bin`：擦除前 OpenOCD 原始备份。
- `probe-rs-flash.bin`：应用后端的完整读取结果。
- `restored-flash.bin`：恢复后 OpenOCD 独立回读结果。
- `identity.json`、`openocd-backup.log`、`openocd-after.log`：设备信息及参考工具日志。
- `desktop-read.txt`、`desktop-erased.txt`、`desktop-restored.txt`：桌面操作结果。
- `desktop-final.txt`、`desktop-viewer-checks.txt`：最终读取和地址跳转、导出、容量边界检查。

## 自动化检查与复现

前端 lint、TypeScript 检查、120 项测试及生产构建通过；Rust Clippy（全部 target / feature，
警告视为错误）与 126 项常规测试通过，6 项需要特定硬件的测试默认忽略。
新增 G431 硬件测试已单独在本设备上执行通过。

只读校验测试需显式指定探针及独立备份，默认不会随常规测试访问 USB。该测试会短暂暂停
核心，结束时复位运行，不擦除或写入 Flash：

```bash
WL1_SWD_PROBE=303a:4004:14C19FD536F4 \
WL1_SWD_BASELINE="$PWD/captures/sticks3-g431-20260923/original-flash.bin" \
WL1_SWD_OUTPUT=/tmp/sticks3-g431-check \
WL1_SWD_SPEED=100 \
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  firmware::hardware_tests::sticks3_g431_read_and_verify -- --ignored --nocapture
```

## 验证范围

本次实机覆盖 Linux、USB CMSIS-DAP 和 G431。F103CB / F411 的目标描述及容量边界已通过
自动化检查，但未在本轮连接对应实物。Windows USB 驱动、Wi-Fi / BLE DAP 和 NRST 复位下
连接未在本轮验证。读保护不会自动解锁；主 Flash 操作不涉及系统 ROM、OTP 或选项字节。

当前电脑测试时仅为这一个 USB 设备临时授予访问权限。重新插拔后如提示权限不足，可在
页面展开“USB 驱动与权限设置”安装仅匹配 `303a:4004` 的规则；需要系统管理员授权。
