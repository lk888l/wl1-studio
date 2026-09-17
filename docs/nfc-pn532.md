# PN532 串口门卡备份与写入

连接参数为 HSU、115200 8N1、无流控。USB-TTL 与 PN532 的 TX/RX 交叉连接，并共地。当前实现主要支持 MIFARE Classic 1K / 4K 的标准认证、读块、写块；DESFire / Plus SL3 等需要独立的应用和密钥协议，不能按 Classic 内存复制。

## 原卡备份

在 NFC 工作台连接串口，保持原卡位于天线有效区域，点击“读取全部数据”。

- 每个扇区分别尝试 Key A 和 Key B；补充密钥会用于两种认证。可以在待补齐扇区中输入 `a:密钥,b:密钥`。密钥必须是 6 字节十六进制。
- 7 字节 UID 使用最后 4 字节进行 Classic 认证。
- 认证或读写被拒后，重新选卡并恢复认证；重新选卡必须仍是相同 UID、SAK、ATQA。
- Key A 永远不可回读。Key B 是否可读取决于尾块权限：可读时它是数据，不能用于 Key B 认证；隐藏时通过认证确定真实值。
- 原始尾块中的零不等于真实密钥。JSON 同时保存原始读块结果、已知密钥、缺失块和诊断信息；写入时使用这些信息重建尾块。
- “所有块已读取”和“所有密钥已取得”分开判断。未知密钥不会被自动恢复；需要提供正确密钥。

在数据页选择“保存备份文件”。导入时检查卡型、块长度、完整地址表、重复地址及扇区结构；未读块保留在表中，数据为空。后端还会在写入前再次验证备份及权限位的三组冗余编码。

## 回读对比

“回读对比”使用独立的待对比区保存卡片快照，可用于原卡与回读结果、同一张卡两次读取，以及历史 JSON 备份之间的比较。

1. 读取第一张卡后，在数据页点击“前往回读对比”，再点击“加入待对比区”。第一份记录自动作为 A 基准。
2. 换上第二张卡，在对比页点击“读取下一张卡”。读取成功后仍停留在对比页，点击“加入待对比区”，第二份记录自动作为 B 对照并显示结果。读取沿用“读取卡片”页中填写的补充密钥；需要时使用“读取设置 / 补充密钥”调整。
3. 使用已保存的备份时，点击“导入 JSON 文件（可多选）”或“粘贴 JSON”。无需连接读卡器，可以混合比较读卡记录和 JSON，也可以直接比较两份 JSON。支持本工具的完整 JSON 结构，包括保留地址但未读出内容的块；单份 JSON 最大 2 MB。批量文件全部校验成功后才加入，失败不会替换现有记录。
4. 可以继续加入更多记录，再点击“设为 A”“设为 B”选择任意两份，或“交换 A / B”。相同 UID 的两次读取会作为不同记录保留，不会自动合并。
5. 每份记录都可保存 JSON 或移除。切换 NFC 页面不会清空待对比区；返回产品库或关闭程序会清空本次对比记录，需要长期留存的记录请先保存 JSON。

卡片信息单独比较 UID、ATQA、SAK、卡型、块 / 页大小与记录地址数。数据按实际地址匹配，即使 JSON 中数组顺序不同也能正确比较；不同卡型或块大小不会强行逐地址比较。

- 默认只显示有差异或未知内容的块 / 页，可切换全部内容、未知内容，并按数据区域或扇区筛选。
- 红色标出已确认不同的字节。黄色表示至少一侧未知，`??` 表示该侧未取得数据。双方都未读出的内容也不会被判为一致。
- Classic 尾块使用 JSON 中已确认的 Key A / Key B 替换原始回读掩码，中间 4 字节比较权限位和通用字节。缺失密钥保持未知，密钥表同时单独显示差异。
- 块 / 页差异与未知内容可以同时存在，计数不是互斥分类。“已记录内容一致”仅指备份覆盖的范围，尤其 Type 2 的有限读取范围不能据此推断整卡完整或门禁可用。
- 对比过程不写卡，导入对比用 JSON 不会替换当前写入备份。重新读卡仍会更新工作台的当前备份，因此应先把需要保留的基准加入待对比区或保存 JSON。

## 写入另一张卡

先移开原卡，再放入目标卡。目标必须属于相同 Classic 容量类型，且需要知道目标当前的认证密钥。

1. 数据块逐块认证和写入，启用验证时先回读比对。
2. 数据不完整、写入失败或校验失败时，保留该扇区尾块，便于修正后重试。
3. 只有能够重建全部隐藏密钥且权限位有效时，才写尾块。尾块验证用认证检查隐藏密钥，用读取检查权限位和可读 Key B。
4. 厂商块最后处理，默认跳过。只支持能通过标准认证后写块命令改写厂商块的 4 字节 UID 兼容卡；没有实现特殊 UID 卡解锁协议。
5. 默认拒绝对与备份相同 UID 的卡进行写入，避免误写原卡。已确认换上相同 UID 的目标卡时，可开启相应选项。

结果显示成功、失败、跳过、通过验证的块数、验证失败明细和 UID 是否一致。“已写块校验通过”只说明实际写入的区域；“整卡写入并校验一致”还要求全部块完成、无跳过且 UID 一致。门禁后台是否接受目标卡仍须实测。

## 小米钱包空白门卡

手机钱包空白门卡应先在钱包中选中，再将手机 NFC 区贴近读卡器。不要将它视为可任意修改 UID 的实体 CUID 卡，默认关闭厂商块写入。手机卡的当前密钥、数据写权限和尾块写权限必须实测。

若目标 UID 与原卡不同，而门禁使用 UID 识别，则仅复制数据块不能使两者等同；此时需要门禁管理方为手机卡登记授权。即使 UID 相同，也仍需检查扇区内容与密钥是否可完整写入。

## 命令行硬件测试

普通 `cargo test` 不触碰真实读卡器。以下命令在仓库根目录运行；一次仅启动一个使用真实串口的程序。

只读诊断（固件、射频寄存器及十次寻卡）：

```sh
NFC_TEST_PORT=/dev/ttyACM0 cargo test --manifest-path src-tauri/Cargo.toml --lib \
  nfc::tests::diagnoses_a_real_reader -- --ignored --nocapture
```

只读备份，文件必须尚不存在；Unix 下创建权限为 `0600`，`captures/` 不进入 Git：

```sh
mkdir -p captures
NFC_TEST_PORT=/dev/ttyACM0 NFC_TEST_DUMP_PATH=captures/source.json \
  cargo test --manifest-path src-tauri/Cargo.toml --lib \
  nfc::tests::reads_a_real_card -- --ignored --nocapture
```

可通过 `NFC_TEST_READ_OPTIONS` 提供读取选项 JSON，例如 `{"extraKeys":["FFFFFFFFFFFF"],"sectorKeys":[]}`。`NFC_TEST_REQUIRE_COMPLETE=1` 要求所有数据块和扇区密钥均已取得，否则测试失败。部分备份仍会保存，不能把测试进程结束当成完整读取。

实际写入测试需要已保存的原卡备份和明确的目标 UID。此命令会修改目标卡，不要把原卡留在天线上：

```sh
NFC_TEST_PORT=/dev/ttyACM0 NFC_TEST_SOURCE_PATH=captures/source.json \
  NFC_TEST_WRITE_UID=目标卡UID \
  NFC_TEST_WRITE_OPTIONS='{"writeManufacturerBlock":false,"writeTrailers":true,"verify":true}' \
  cargo test --manifest-path src-tauri/Cargo.toml --lib \
  nfc::tests::writes_a_real_card -- --ignored --nocapture
```

后端在开始写入时再次核对指定目标 UID。默认不会将当前卡读出后原样写回来做试验。

## 空白目标卡的可恢复实机测试

`round_trips_a_blank_replacement_card` 用来检查实际写入能力，不需要原卡内容。必须先保存并确认目标空白卡备份，且目标仍为 Classic 1K、全部用户数据块为零、Key A / Key B 为出厂值、访问条件为传输配置。程序会在写入前重新读取并逐项核对基线。

测试会写入 47 个数据块和 16 个尾块，其中扇区 15 的 Key A 暂时改为 `A1B2C3D4E5F6`，可读 Key B 数据改为 `102030405060`，全部访问条件不变。第 0 块不写入。程序在校验后恢复基线，即使写入步骤返回错误也先尝试恢复，最后重新读取整卡比对。通信中断仍可能导致恢复失败，测试数据文件会保留恢复所需的临时密钥。

仅在已经明确同意上述具体改动的空白目标上运行，不要对正在使用的原卡执行：

```sh
NFC_TEST_PORT=/dev/ttyACM0 \
  NFC_TEST_WRITE_UID=目标卡UID \
  NFC_TEST_TARGET_BACKUP=captures/target-before.json \
  NFC_TEST_PATTERN_PATH=captures/target-test-pattern.json \
  cargo test --manifest-path src-tauri/Cargo.toml --lib \
  nfc::tests::round_trips_a_blank_replacement_card -- --ignored --nocapture
```

测试数据文件必须不存在；恢复成功会打印 `RESTORED: 64/64`，并要求写入与恢复的 63 个块均通过校验。这个结果验证读写实现，不代表已复制原卡或已经取得门禁授权。

## 资料

- [NXP PN532 User Manual UM0701-02](https://www.nxp.com/docs/en/user-guide/141520.pdf)：HSU 帧格式、SAMConfiguration、RFConfiguration、InDataExchange。
- [NXP MIFARE Classic EV1 1K 数据手册](https://www.nxp.com/docs/en/data-sheet/MF1S50YYX_V1.pdf)：§8.7 访问条件、可读 Key B、§10.1.3 UID 认证。
- [NXP MIFARE Classic EV1 4K 数据手册](https://www.nxp.com/docs/en/data-sheet/MF1S70YYX_V1.pdf)：大扇区内存布局。
- [NXP MIFARE UID 应用说明 AN10927](https://www.nxp.com/docs/en/application-note/AN10927.pdf)：UID 与认证。

## Type 2 标签

Ultralight / NTAG 使用独立的页读写流程。NTAG213/215/216 通过 `GET_VERSION` 确认容量，读取末尾时避免地址回卷，失败页仍保留原地址。未确认具体型号时仅记录前 16 页并明确提示范围。写入仅允许已识别型号的用户区；未确认型号仅允许公共用户页 4–15。UID、OTP、锁定位、配置和密码页均跳过，避免永久锁定或写入回读掩码。这个流程不会声称完成整卡复制。

依据：[NXP NTAG213/215/216 数据手册](https://www.nxp.com/docs/en/data-sheet/NTAG213_215_216.pdf)。
