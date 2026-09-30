# StickS3 多功能工作台

从产品库进入 **StickS3 多功能终端**，默认打开“SWD / JTAG → 调试工作区 · USB / Wi-Fi”。
USB 与无线设备共用原有 Flash 界面，可在设备下拉框选择探针，在旁边选择 SWD 或 JTAG。
首次使用进入“USB 配网与蓝牙”，通过物理 USB 控制台配置 Wi-Fi，取得 IP 后点击
“使用此 IP 查找调试器”。已联网的设备无需连接 USB，直接添加无线设备即可。

## IP 查找与网络调试

1. 让电脑和 StickS3 接入同一局域网，在设备屏幕打开 **W-DAP**，保持 Wi-Fi 启用且未暂停探针。
2. 点击“添加无线设备”，输入设备屏幕的 IPv4 地址，再点击“连接并打开工作区”；手动查找使用 TCP 4441。
   也可点击“搜索局域网”，选择发现的设备，再核对 TCP 返回的序列号。
3. 核验设备身份和 SWD/JTAG 能力后，自动进入共享调试工作区并选中对应的 Wi-Fi 设备。
   若 USB 配网控制台仍连接，会先释放本机串口，保留设备上的 Wi-Fi 连接。
   设备列表可以同时保留 USB 与多台无线探针，刷新 USB 列表不会删除无线设备。
4. 按接线选择 SWD 或 JTAG，点击“连接并识别”。识别支持的目标后，可使用原有读取、备份、
   烧录、校验、擦除和复位功能。默认 100 kHz；选择复位下连接时必须连接 NRST。
   未接目标板也能找到 StickS3，但目标识别会失败，写入和擦除按钮保持不可用。
5. 使用外部工具时，可在查找结果的折叠区下载 `sticks3-wifi.cfg`，交给支持
   `cmsis-dap backend tcp` 的 OpenOCD / IDE 并添加实际 target 配置；上位机内置操作无需这些工具。

身份查询本身仅发送 `DAP_Info`，完成后释放 TCP；进入工作区不代表已经识别目标芯片。
查询结果带有核验时间，不代表持续在线。每次实际操作会重新核验探针身份，并在同一条
TCP 连接上交给内置 probe-rs 引擎；操作结束释放探针。

局域网搜索在 2 秒内每 500 ms 向 `255.255.255.255:4442` 发送 `STICKS3_DAP_V1?`。
仅接收源端口 4442、恰好 29 字节、签名和序列号有效的应答，以源 IP 作为端点，
按序列号去重，最多显示 32 台。它使用系统路由选定的广播接口；多网卡、跨子网或
客户端隔离时可能搜不到，直接输入 IP 即可绕过广播发现（仍需网络可达）。
只记住最近核验成功的 IP，不自动连接。TCP 建连最多等待 2 秒，身份查询总时限为 5 秒；
严格检查头、包长度及响应类型，失败不自动重发。已被其他调试客户端占用时会提示关闭占用者。

无线图形化操作与 USB 复用同一引擎和目标支持范围，不依赖外部 OpenOCD。
支持 JTAG 传输不等于支持所有 JTAG 芯片；当前自动识别范围见下文。

## 快速使用

1. 在 Tauri 桌面应用中打开 StickS3 工作台，进入“USB 配网与蓝牙”，用 USB 数据线连接设备。
2. 关闭占用该串口的 `idf.py monitor` 或终端，保持 S3 不处于 USB DAP 页面。
3. 选择 S3 的 USB Serial/JTAG 串口，点击“连接 S3”。只记住串口选择，不自动连接；
   打开端口后等待 API v1 能力握手，串口打开成功本身不表示固件兼容。
4. 在 **Wi-Fi 网络** 中开启无线、扫描并选择网络，或填写隐藏 SSID；输入密码并连接。
   开放网络使用空密码。可勾选“连接成功后记住”，也可临时连接。
5. 在 **蓝牙 BLE** 中开启无线、扫描并选择可连接的外设。应用原样使用扫描地址类型；
   不猜测 public / random，不向外设写入任意 GATT 特征。连接后可以查询主服务 UUID。
6. 从四个固定记忆槽选择之前保存的目标，或确认后忘记单条记忆。
7. “首次 Wi-Fi 配网”显示 USB 握手、有效 STA IP、保存三个步骤。保存完成须同时满足
   `remember_pending=0`、`memory_error=0` 和首选记忆与当前 SSID 一致。
   临时连接或保存失败仍可使用已经取得的 IP。点击“使用此 IP 查找调试器”，在设备上
   打开 W-DAP，再点击“连接并打开工作区”。连接命令被受理不会被当作配网成功。

Wi-Fi / BLE 状态每 3 秒刷新一次；执行操作期间暂停常规轮询。扫描、命令确认和
结果分页串行执行，USB 断线或返回产品库会取消尚未发送的请求。断开 USB 控制台
只释放本机串口，保留设备上的无线链接和连接记忆。浏览器界面不提供虚假连接或扫描结果。

## 状态、记忆和蓝牙方向

- `accepted + ticket` 表示进入设备队列，`command.result=applied` 表示驱动/协议栈接受操作。
  Wi-Fi 是否连通由 `wifi.status.state=connected` 和实际 IP 判断，BLE 看 `connected`。
  保存是否完成由 `remember_pending`、`memory_error` 和设备的 `saved` 记录判断。
- Wi-Fi 在取得 DHCP 地址后保存；保存的首选网络在下次启动时重连。BLE 保存稳定身份，
  重启后不会主动连接目标，需要点击已记住的外设。
- 每种无线各 4 个固定槽位，用 `used_mask` 枚举，不能用 `0..count` 推算槽位。
  满槽时先忘记不需要的目标；临时连接仍可使用。保存失败不代表链接一定失败。
- 忘记目标保留当前链接；需要断开时再点击“断开网络 / 外设”。BLE 忘记目标保留
  安全配对密钥，本界面不执行 `ble.unpair` 或批量删除。
- **B-DAP 是电脑连接 S3**。页面中的 BLE 扫描列表用于 **S3 主动连接其他外设**。
  界面同时展示电脑等客户端到 S3 的入站连接状态，两种角色不会混为一谈。
- ESP32-S3 只支持 BLE，不提供经典蓝牙 SPP / A2DP。无法解析稳定身份的私有地址
  可能无法记住，但仍可临时连接。

## 共享 SWD / JTAG 调试工作区

设备屏幕负责选择 / 启停 DAP 模式，固件无线 API 没有对应的远程切换命令。
USB / Wi-Fi 图形化操作使用内置 probe-rs 0.32.0，不需要额外安装 OpenOCD 或烧录 CLI。

1. USB：断开配网控制台，在 StickS3 屏幕保持 **USB DAP** 开启；Wi-Fi：保持 **W-DAP** 开启。
2. 打开 **SWD / JTAG → 调试工作区 · USB / Wi-Fi**。刷新烧录器查找 USB `303a:4004` 设备，
   或按上文添加无线设备；在同一列表选择探针，再选择 SWD/JTAG。JTAG 目标需支持该协议。
3. 目标默认为自动识别，不需要选择封装型号或预设容量。先用 100 kHz，连接稳定后可提高频率。
4. 点击“连接并识别”，读取系列 ID、实际 Flash 容量和 UID，并选择对应算法；一次操作完成后
   释放探针。支持 STM32F1 中容量（64 / 128 KiB）、STM32F411（256 / 512 KiB）、
   STM32G431（32 / 64 / 128 KiB）。器件 ID 无法确定完整封装型号，页面显示识别到的系列。
5. “读取全部 Flash”提供完整主 Flash 的十六进制 / ASCII 视图、分页、地址跳转、
   SHA-256 和 BIN 导出。切换页面会保留快照；更换探针、协议或目标后标记旧快照；切换探针或协议会清除之前的目标确认。
6. 选择 BIN / HEX / ELF / AXF；BIN 可指定起始地址。未连接时可先解析文件；识别或读取后，
   按实测容量检查每个数据段并启用烧录和擦除。文件全部解析并检查边界后，
   可先点击“仅校验文件与 Flash”，或在确认目标、文件 SHA-256 和写入范围后烧录。
7. 烧录只擦除涉及的扇区，保留未覆盖字节，写后回读校验并复位运行。
8. “擦除全部 Flash”需要输入 `ERASE`；仅擦主 Flash，随后逐字节检查全 FF。
   操作不解除读保护，不访问选项字节或 OTP。擦除后需重新烧录才有程序可运行。

通用模式按实际容量使用完整主 Flash，不套用 GameBox 的 62 KiB 应用区限制。
例如 F103 板报告 64 KiB 时，读取和擦除使用 64 KiB，写入文件也必须落在该范围内；
不会因以前选择过 CB / 128 KiB 而拒绝连接，也不会假定芯片具有未报告的额外容量。
写入和擦除时再次核对实际 UID / 系列 / 容量，若确认后换板则停止并要求重新识别。
自动识别实现与本轮验证边界见 [容量识别说明](sticks3-swd-auto-detection.md)。

读取与独立校验会短暂暂停核心，结束后恢复先前运行状态；也可单独“复位运行”。
任务期间禁用产品返回、页签切换和串口连接，并阻止正常关闭窗口。失败不自动重发写入。
接线和 BLE 外部工具说明收在“SWD / JTAG 接线与 BLE 调试”中。BLE DAP 尚未接入图形化操作。

Linux 可点击 USB 支持设置，通过系统授权安装 `70-wl1-sticks3.rules`，仅匹配
`303a:4004` 并用 `uaccess` 授权当前本地桌面用户；已有不同内容的规则不会覆盖。
完成后会对已连接的 StickS3 重新应用规则，点击“刷新烧录器”即可。Windows 使用固件提供的 WinUSB 描述符；
StickS3 不使用内置的 ST-Link 驱动安装包。

| 模式 | 准备和使用 |
| --- | --- |
| USB DAP | 先断开控制台，再在 S3 上进入 USB DAP；使用本工作台图形化操作，或释放后交给 IDE / OpenOCD。退出后刷新并重连恢复的串口。 |
| W-DAP | 电脑与 S3 在同一网络，或电脑连接设备热点；进入 W-DAP 后监听 TCP 4441。通过添加无线设备进入同一图形化工作区；也可选用支持 `cmsis-dap backend tcp` 的 OpenOCD。 |
| B-DAP | 开启 BLE，进入 B-DAP；电脑用固件仓库的 `tools/dap_bridge.py scan` 找到 S3，再用 `ble --address` 模式连接。系统配对后等待 Ready，让 OpenOCD 连接 `127.0.0.1:4441`。 |

S3 HAT2：G6 → SWCLK / TCK、G7 → SWDIO / TMS、G1 → TDI、G2 → TDO、G8 → NRST、GND → GND。SWD 不需要 TDI / TDO。目标板自行供电，
只支持 3.3 V 逻辑，建议先用 100–250 kHz。Wi-Fi DAP TCP 没有应用认证或 TLS，
限可信局域网 / 设备密码热点内使用。

USB Serial/JTAG 与 USB DAP 共用芯片 USB PHY。USB DAP 运行时控制串口消失属于
预期行为，上位机不会自动重连或重放未确认的修改。Wi-Fi DAP / BLE DAP 可与 USB
配置通道同时使用；关闭无线会影响相应调试连接。

## 协议与代码边界

USB 控制台最初对接的是用户提供的 `m5_sticks3` **2026-09-22 本地工作树**，其 HEAD 为
`c21c3fa`；USB 控制台和四槽记忆是该工作树中尚未提交的扩展，不能仅凭 HEAD 判断兼容。
核对来源：`docs/radio-console.md`、`docs/debug-probe.md`、
`components/connectivity/src/connectivity_service.cpp` 和 `local_console_protocol.cpp`。
未修改固件仓库，也不依赖其绝对路径构建上位机。

2026-09-29 的网络查找对照该固件最新本地工作树的 `docs/debug-probe.md`、
`components/debug_probe/include/dap_protocol.hpp` 和 `debug_probe.cpp` 实现，包含 JTAG 能力和 UDP 4442 发现协议。

- `src-tauri/src/sticks3.rs`：单独持有串口；类型化操作白名单和参数校验；
  115200 / 8N1、80 ms 底层读取超时、3 秒请求时限、12 秒启动握手窗口。
- 开始握手前发送 `NUL + LF`，使固件拒绝并丢弃整个残留输入行，防止单独换行
  意外执行其他终端留下的半条命令。握手期间仅重试只读 `capabilities`。
- 请求为 UTF-8 API v1 JSON + LF，按转义后的字节限制为 256 字节。SSID 1–32 字节，
  密码为空、8–63 字节或 64 位十六进制 PSK；前后端均校验，不裁切输入。
- 只解析 `RS (0x1e) + JSON + LF/CRLF`，忽略普通 USB 日志；内存有界，
  坏帧、超长帧及旧请求 ID 不作为当前响应。普通启动日志可能含设置密钥，不转发前端。
- 请求 ID 在 `0x40000000..0x7fffffff` 内跨会话递增，与固件 CLI / 损坏行错误的
  `1..0x3fffffff` 分离，初始化清理的错误响应不会冒充能力握手。每次 IPC 都带会话 ID。
  断开时关闭句柄，不发送无线关闭命令。
  传输错误 / 超时关闭当前会话，明确提示结果未知，修改操作始终不自动重发。
- `src/lib/sticks3.ts`：类型化设备网关，串行队列、可取消 ticket 查询、限时扫描、
  generation 一致分页和固定记忆槽。扫描至多等待 25 秒，不拼接不同代结果。
- `src/components/sticks3/RadioConnections.tsx`：共用的无线连接界面；
  `StickS3Studio.tsx`：独立产品导航、USB 连接与 SWD 页面。后续功能可以复用网关
  和无线状态，无需把配网代码重复嵌入每个功能页。
- `src-tauri/src/sticks3_network.rs` / `src/lib/sticks3-network.ts` / `NetworkProbe.tsx`：
  有界 UDP 发现、TCP DAP_Info 核验、工作区设备登记和 USB 配网后的地址衔接。
  端点包含 IPv4、端口和序列号，后端要求其与探针 ID 完全一致；每次操作在同一 socket
  验证身份并执行命令，限制 64 字节 DAP 包，单次交换总时限 3 秒。坏帧、断线或超时使连接
  永久失效并关闭，不自动重连或重发写入。
- `src-tauri/vendor/probe-rs`：固定 0.32.0 的源码及许可，只在两个 CMSIS-DAP 文件中添加
  自定义包传输接口，保留原 USB 路径及算法，不升级依赖版本；来源和维护说明见
  [README.WL1.md](../src-tauri/vendor/probe-rs/README.WL1.md)。
- `FirmwarePage` / `firmware.rs` / `firmware_target.rs`：复用现有烧录页面与任务锁，枚举 ST-Link 和 CMSIS-DAP，
  G431 对照 `0x468` / `0x1FFF75E0` / `0x1FFF7590` 核对 ID、容量和 UID。
- 产品切换、应用退出、网络查找和 Flash 任务互斥均纳入现有产品生命周期。无新增依赖版本或通用 shell
  权限。Wi-Fi 密码不写入 localStorage 或操作日志。

## 验证

2026-09-29 使用用户指定的 `172.18.7.163` 实测新增上位机后端：

| 检查 | 结果 |
| --- | --- |
| TCP IP 查找与身份 | 通过；StickS3 CMSIS-DAP，序列号 `14C19FD536F4`，CMSIS-DAP 2.1.2，64 字节包，SWD / JTAG 均支持 |
| 查询释放与再次查找 | 通过；首个连接释放后立即重新核对同一序列号 |
| UDP 4442 单播与广播 | 通过；两种方式均发现同一 IP 和序列号，TCP 身份一致 |
| USB `/dev/ttyACM0` | 通过；使用上位机 Rust 实现完成能力握手、读取 Wi-Fi 状态和四槽记忆，STA IP 与网络查找一致 |
| 无线引擎 SWD / JTAG | 通过；真实 probe-rs 经 TCP 初始化两种协议、关闭并释放连接；无外部目标板 |
| 无线工作区识别任务 | 通过；完整 `execute_job` 路径在 SWD / JTAG 下均正确报告无目标响应并释放任务锁 |
| 界面流程 | 浏览器模拟 Tauri/目标响应通过：查找后自动打开工作区、USB/Wi-Fi 共用选择、刷新保留无线选择、协议切换清除目标确认、无线读取和失败清理、390px 布局 |
| 首次配网界面 | 模拟响应通过：等待 DHCP、保存状态、IP 跳转、密码清除；不代表新网络实机配网已验收 |

本轮设备没有连接外部目标板；实机验证了探针身份、SWD/JTAG 初始化和无目标时的失败处理，
未验证无线目标板读取、写入、校验、擦除或复位，也没有更改 Wi-Fi 凭据。
“新 SSID / 密码 → DHCP → 保存”的真实配网流程仍需具备测试网络凭据时验收；
界面测试中的配网成功响应是模拟数据，不算新的配网实测。

可复现身份和已有网络状态检查（设备打开 W-DAP，USB 检查前关闭占用控制串口的程序）：

```bash
STICKS3_TEST_IP=172.18.7.163 cargo test --manifest-path src-tauri/Cargo.toml --locked \
  hardware_network_identity -- --ignored --nocapture
STICKS3_TEST_PORT=/dev/ttyACM0 STICKS3_TEST_IP=172.18.7.163 \
  cargo test --manifest-path src-tauri/Cargo.toml --locked hardware_usb_wifi_status -- --ignored --nocapture
```

以下两项会发送 DAP 初始化及连接命令，只应在**未连接目标板**时运行，需显式声明测试条件：

```bash
STICKS3_TEST_IP=172.18.7.163 STICKS3_NO_TARGET=1 \
  cargo test --manifest-path src-tauri/Cargo.toml --locked hardware_network_engine_modes -- --ignored --nocapture
STICKS3_TEST_IP=172.18.7.163 STICKS3_TEST_SERIAL=14C19FD536F4 STICKS3_NO_TARGET=1 \
  cargo test --manifest-path src-tauri/Cargo.toml --locked sticks3_network_no_target_identification -- --ignored --nocapture
```

```bash
npm run check:frontend
npm run check:rust
```

自动化检查通过：前端 183 项测试，Rust 152 项通过、12 项实机测试默认忽略；lint、类型检查、构建、fmt 和 Clippy 均通过。
TCP 模拟端还覆盖坏帧、身份不匹配、断线后不重发、分包及真实 CMSIS-DAP 驱动初始化。
新增测试覆盖 UTF-8 / JSON 字节边界、RS 分帧与噪声隔离、能力握手、操作白名单、
请求 ID、旧会话取消、异步命令状态、稀疏记忆槽、扫描 generation 换代和超时不重发。
Linux 伪终端测试还覆盖实际 serialport 打开、握手、清理错误响应、分包与旧会话隔离。
浏览器交互验收使用模拟的 Tauri 响应，覆盖 Wi-Fi 扫描/连接/忘记、BLE 连接/服务查询、
返回产品库及 390px 窄屏布局，不能代替实机链路验收。

USB 打开串口、真实握手和已有 Wi-Fi 状态已在本轮核对。实机联调仍需核对：
Wi-Fi / BLE 多轮扫描与新连接、取得 IP 后记忆、
错误密码、记忆槽满、拔插、USB DAP 进入 / 退出后的重新枚举，以及无线 DAP 目标板调试。
USB DAP 的 G431 实机结果见 [SWD 验收记录](sticks3-swd-validation.md)。
