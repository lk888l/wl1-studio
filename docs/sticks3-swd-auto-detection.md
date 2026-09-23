# StickS3 SWD 实测容量识别

2026-09-23：修正手选 STM32F103CBT6 / 128 KiB 时，目标报告 64 KiB 导致读取也被拒绝的问题。
StickS3 作为通用调试器，使用 `auto` 模式；WL1、GameBox 的专用产品配置继续各自约束分区。

## 当前行为

- 页面不再要求选择 C8 / CB 或封装型号。点击“连接并识别”或“读取全部 Flash”时读取器件
  ID、容量寄存器和 UID；显示已知系列及实测容量，避免把 Flash 算法名称当成完整芯片型号。
- 64 KiB 的 F1 使用完整 `0x08000000–0x0800FFFF`；128 KiB 则使用到 `0x0801FFFF`。
  不因预设的封装名称阻断正常操作，也不默认允许访问未报告的额外容量。
- 文件可在连接前解析。识别后界面立即按实际容量检查所有段；烧录 / 校验后端在当前连接上
  再检查一次，覆盖 BIN、稀疏 HEX、ELF 物理加载地址。超容量文件被拒绝，不静默截断。
- 烧录或擦除之前需识别目标，确认框显示实际容量和 UID。后端重新识别后核对这些信息，
  避免确认后换板仍对新目标执行写入。读取可以直接点击，不需要先手选型号。
- 固定 GameBox 配置仍保留末尾 2 KiB 设置区；通用 SWD 不继承该产品限制。

| 器件 ID | 当前支持系列 | 容量（KiB） | 内置算法目标 |
| --- | --- | --- | --- |
| `0x410` | STM32F1 中容量（F103 兼容布局） | 64、128 | STM32F103C8 / CB |
| `0x431` | STM32F411 | 256、512 | STM32F411CC / CE |
| `0x468` | STM32G431 | 32、64、128 | STM32G431C6 / C8 / CB |

器件 ID 不包含封装信息。未知系列或无匹配算法的容量会明确报出 ID / 容量并停止，
不会猜测算法。新增系列时扩展 `firmware_target.rs` 的寄存器及容量映射，并补充对应实机验证。

## 本轮验证

- Rust 常规测试 132 项通过，7 项硬件测试默认忽略；前端 123 项测试、类型检查和构建通过。
- 回归测试覆盖 F1 的 64 / 128 KiB 算法选择、7 种容量的内置 Flash 映射、完整 64 KiB 更新、
  越界最后一个字节、稀疏 HEX、未知容量、系统内存地址拒绝以及 GameBox 设置区保留。
- 确认后 UID、容量或系列变化会被拒绝；前端快照身份、不同容量的文件范围重新检查也有覆盖。
- 原生桌面界面另以隔离的测试网关完成 64 / 128 KiB 场景回归，文件解析调用真实 Rust 后端：
  未识别时不预设容量、完整 64 KiB 文件可用、96 KiB 文件按当前容量拒绝或接受、确认框携带
  实际 UID / 容量、失败后要求重新识别，以及读取分页与旧快照标记均通过。记录保存在
  `captures/sticks3-auto-20260923/ui-fixtures-result.txt`；这些场景不是硬件实测。
- F103C8 板重新接好后，StickS3 的 USB DAP 已通过 OpenOCD 读到 SWD ID `0x1ba01477`、
  器件 ID `0x410` 和容量寄存器 `0x0040`。上位机自动识别的只读硬件测试通过：匹配
  STM32F103C8 配置、64 KiB Flash 和 UID `52FF6C067271515708440387`。
- Linux 权限规则安装时间晚于当时的 USB 枚举，因此当前节点仍为 `root:root`，没有当前用户
  的读写 ACL；探针显示无权限，连接按钮变灰。临时只给核对序列号的这个节点授予 UID 1000
  读写访问后，真实桌面上位机按钮可用，并成功识别同一 F103。修正后的安装脚本会在安装
  或重复设置规则时，只触发 `303a:4004` 的现有设备重新应用 uaccess 规则并等待处理。
- 这次只做连接和识别，未擦除或烧录 F103；完整 Flash 读取和写入仍待独立验证。
- 之前的 G431 擦除恢复结果记录在 [实机验收](sticks3-swd-validation.md)，不能替代本次
  新自动识别流程的硬件验证。

连接恢复后，可先使用 OpenOCD 保存独立的完整 Flash 备份，再运行新增的只读硬件测试。
必须指定准确探针序列号和该目标的备份：

```bash
WL1_SWD_PROBE=303a:4004:实际序列号 \
WL1_SWD_BASELINE=/absolute/path/to/independent-backup.bin \
WL1_SWD_OUTPUT=/tmp/sticks3-auto-check \
WL1_SWD_SPEED=100 \
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  firmware::hardware_tests::sticks3_automatic_capacity_read_and_verify -- --ignored --nocapture
```

此测试自动识别容量、完整读取并与独立备份比较，然后校验文件及越界拒绝；不会擦除、烧录
或复位目标。读取和校验时短暂暂停核心，完成后恢复之前的运行状态。

仅复现本次已通过的 F103 识别，无需备份文件：

```bash
WL1_SWD_PROBE=303a:4004:14C19FD536F4 \
cargo test --manifest-path src-tauri/Cargo.toml --locked \
  firmware::hardware_tests::sticks3_f103_auto_identify -- --ignored --nocapture
```
