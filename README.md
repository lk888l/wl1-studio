# WL1 Studio 设备控制中心

**简体中文** | [English](README.en.md)

本仓库实现一套可扩展的多产品桌面上位机。软件启动后先进入产品首页，再进入独立产品工作台：**WL1 轮腿小车**提供连接、遥测与调参，**GameBox 游戏机**提供真实串口只读诊断、按键可视化、游戏与工具图鉴，以及本地固件检查。GameBox 串口链路仍待实机联调，当前固件不支持下行控制或串口升级。口袋电子琴目前仅保留交互预览，生产构建默认关闭入口。项目采用 Tauri + React 技术路线，不依赖额外仓库或 Git 子模块，并以最小权限、可替换通信层和可审计发布流程为目标。

> [!WARNING]
> 轮腿机器人可能因错误参数、协议误判或通信异常突然运动。首次连接和每次调参前，请先阅读[安全指南](docs/safety.md)，架空驱动轮、准备物理急停，并确保人员远离运动范围。本软件不是安全控制器，不能替代固件侧限幅、看门狗和急停电路。

## 运动工作台

进入 WL1 后默认打开运动工作台：机身重心、共同腿高、全部四组 PID、方向控制和遥测同页展示。顶部常驻连接区支持选择目标与串口、刷新和断开；记住上次串口，单串口时自动选择，不会自动连接。参数支持数字输入、滑块、逐项与按组下发；档案和本地几何参数折叠收纳。编辑只更新草稿，连接前后的有效草稿会保留；实时运动必须明确采用腿高并主动启用。

机身与重心、四组 PID 和腿高自适应均提供“保存到 Flash”。先下发需要修改的值，再保存；每个入口都会保存车上全部运动参数的 SRAM 快照，不自动下发页面草稿。收到小车 `save: ok` 或 `save: unchanged` 后才显示成功；只读和遥控器连接不可用。固件要求、共同腿高等保存范围及错误处理见[参数保存指南](docs/parameter-flash-save.md)。

范围及滑块步长同步 VOFA，TypeScript 与 Rust 使用相同命令边界。参考配置和已核实的固件版本差异见[运动参数范围说明](docs/motion-parameter-ranges.md)。

WL1 现支持 **ZX-D30 单模 BLE 扫描连接与遥控**。选择蓝牙设备、允许本次连接写入后，在独立“实时遥控”页选择腿高并启用，使用 W/A/S/D、方向键或屏幕按钮按住移动；松手归零，空格 / Esc 停止，失焦后需重新启用。蓝牙采用 10 Hz 更新和 20 字节分包；连接与写入成功不等于设备确认执行。接线、固件要求、9600 baud 带宽限制与平台配置见[蓝牙遥控指南](docs/bluetooth-control.md)。

## WL1 固件烧录与 Flash 管理

轮腿工作台的 **固件与 Flash** 页面内置 probe-rs，通过 ST-Link / SWD 操作固定型号 **STM32F411CEU / 512 KiB**，不再提供其他芯片选项。支持本地 BIN、HEX、ELF/AXF 烧录、回读校验与复位；整片主 Flash 擦除和完整读取是两个独立操作。读取结果支持地址跳转、十六进制/ASCII 查看和 BIN 导出，操作前核对实际芯片 ID、容量和固件范围。

无需另装烧录命令行工具。Windows x64 内置 ST 原版驱动，Linux 内置精确 USB 权限规则；首次需要时在页面手动点击“设置 USB 支持”，通过系统管理员授权后生效，不会随启动或安装自动修改系统。接线、使用边界与验证项见 [WL1 固件烧录指南](docs/wl1-firmware.md)。

## GameBox 游戏机工作台

从产品首页进入 GameBox，通过 **115200 / 8N1** 串口接收实体按键事件，查看八键状态、事件类型和日志；六款游戏与六项工具图鉴说明设备端操作，桌面和浏览器均提供明确标注的无硬件演示。串口只读，不发送探测或控制命令。

**固件与 Flash** 页以暂定的 **STM32F103C8T6 / 64 KiB** 为固定目标，通过内置 probe-rs 支持 ST-Link 烧录 BIN/HEX/ELF/AXF、回读校验及完整 Flash 读取/显示/BIN 备份。更新限制在前 **62 KiB 程序区**，保留末尾 **2 KiB 设置区**，读取则包含全片；复用应用内 USB 设置，无需另装烧录工具。

“存储与检查”保留本地 `.bin` 大小、CRC-32、初始栈指针和复位向量检查，该检查不直接烧录。后续外置 SPI Flash 将用于保存多个固件包，串口传输与 bootloader 均属规划；普通 SPI NOR 不能让 F103 直接执行更大的单个固件，bootloader 还会占用内部 Flash。协议、源码基线、容量边界和实机验证项见 [GameBox 接入指南](docs/gamebox-integration.md)。

## StickS3 多功能工作台

从产品库进入 **StickS3 多功能终端**，默认打开“SWD / JTAG → 调试工作区 · USB / Wi-Fi”。
USB 和无线探针共用设备选择框、SWD/JTAG 协议选择及原有 Flash 界面。
点击“添加无线设备”，输入 IPv4 或搜索局域网；核验身份后自动进入工作区并选中该设备。
无线调试时设备需保持 W-DAP 开启，无需额外安装 OpenOCD。

首次使用可在“USB 配网与蓝牙”页通过 USB 控制台扫描、选择和连接 Wi-Fi / BLE 外设。
支持手动填写 SSID、临时连接、连接成功后记住、每种无线 4 个记忆槽的切换与忘记，
以及 BLE 主服务查看。配网页显示取得 IP 与保存结果，并可将 IP 带入探针查找。
连接与记忆状态以固件实际回报为准；密码不保存到电脑设置中。

共享工作区提供芯片识别、完整 Flash 读取、十六进制 / ASCII 浏览、地址跳转、BIN 备份、
BIN / HEX / ELF / AXF 烧录、独立校验、整片主 Flash 擦除和复位。
按实际器件 ID 与容量自动匹配 STM32F1 中容量、STM32F411、STM32G431；
JTAG 还要求目标芯片支持该协议。读取、文件范围检查和擦除均使用实测容量。
USB / SWD 已用 G431 完成实机读取、擦除、空白检查和原程序恢复，并以 OpenOCD 独立回读确认一致。
Wi-Fi 已用 `172.18.7.163` 验证 SWD/JTAG 初始化和未接目标板时的识别失败与会话释放；
无线目标读写仍待连接目标板验证。

DAP 模式在 S3 屏幕选择；USB DAP 与配网控制串口互斥。每次无线操作重新核对探针序列号，
操作完成释放连接，断线不自动重发写入。BLE DAP 仍使用独立的桥接器和 OpenOCD。
使用方式见 [StickS3 接入指南](docs/sticks3-integration.md)，
USB 测试范围与备份见 [SWD 验收记录](docs/sticks3-swd-validation.md)。
自动识别支持范围见 [容量识别说明](docs/sticks3-swd-auto-detection.md)。

## 当前定位

WL1 工作台可选择 **蓝牙 BLE、USB 串口** 或 **通过遥控器无线调参**。遥控器模式支持 PID 与姿态偏置下发，需要先更新遥控器串口桥接固件；原版固件没有启动串口 RX。接线、使用步骤与回传限制见[遥控器无线调参指南](docs/remote-tuning.md)。下文 Legacy 遥测与 idle 分帧说明仅适用于旧版有线固件；蓝牙入口使用 SoftEngine 显式分帧，所提供 2026-09 固件为 500 ms 运动超时，详见蓝牙指南。

当前代码已经形成“产品首页 + 独立产品工作台 + Rust 设备网关”的跨平台骨架。WL1 兼容层同时核对了 `feature/framework@8f8eb82` 的提交基线，以及 2026-08-24 本地固件工作树中尚未提交的控制/通信演进；GameBox 独立接收 `FW2` 按键文本协议。界面仍可依靠 Mock 或演示数据独立开发。新增产品应实现自己的协议、Transport、页面与安全策略，并明确区分真实接口、无硬件演示和待实机验证的范围。

当前首版已经覆盖的核心场景包括：

- 产品首页启动时先清理遗留设备会话，再选择 WL1 轮腿小车或 GameBox 游戏机；仅在当前会话结束后返回产品库；
- GameBox 串口按键诊断、六游戏与六工具图鉴、本地 `.bin` 容量/向量/CRC-32 检查；
- 连接串口设备并显示连接状态、静态 Legacy 兼容描述，以及 IMU/RPM 分通道遥测新鲜度；
- 观察 IMU 与左右轮 RPM：`showimu -y/-n`、`showrpm -y/-n`；
- 调整四组 PID 和 `legheight`，并通过 `R <turn> <velocity> <roll> <height>` 发送组合运动目标；
- 保存上位机自身的主题、显示名称、遥测密度和常用参数档案；
- 通过 Mock 模式开发界面；回放接口已预留但尚未实现；
- 原生腿部运动学实验室：无需 Python 即可调节五连杆几何，并同步固件的腿高、逆解角域、舵机偏置与物理角度限幅后播放或导出轮心轨迹；
- 为后续 CAN、UDP 及新版固件协议保留统一接口。

当前兼容范围分为“已提交 HEAD 基线”和“本地工作树扩展”两层。应用只自动使用两者共有且经过白名单限制的子集：

- 默认串口参数为 **115200 baud、8N1、无流控**。固件文档声称可用 LF/CRLF，但当前源码未去除行尾；本应用按 DMA receive-to-idle 发送**不带行结束符**的独立命令，并留出空闲间隔，仍需实机确认；
- 命令正文最多 **32 字节**，长度必须按编码后的正文计算，超长内容会被固件截到前 32 字节；
- 命令区分大小写；固件解析器可跳过多个空白，但上位机白名单只接受并生成单个 ASCII 空格的规范格式，以减少分帧与人工输入歧义；
- `showimu -y` 约以 100 Hz 输出：HEAD 是 `Roll,Pitch,Yaw`，当前工作树追加 `a=<|a|g>,ok=<0|1>`；解析器兼容两种。`showrpm -y` 仍约以 20 Hz 输出 `A: ... B: ...`；
- `anglepid`、`velocitypid`、`differpid` 使用 `-p/-i/-d <value>`，`rollpid` 只支持 `-p/-i <value>`；
- `R` **不是轮径**，而是格式严格为 `R <turn> <velocity> <roll> <height>` 的组合运动命令；`legheight` 的舵机任务限幅为 **44.5..78.5 mm**；
- 调参先修改 **SRAM**；支持 `save` 的现行固件可通过“保存到 Flash”保存全部运动参数，未保存的修改在重启后丢失。旧 `8f8eb82` 基线及 2026-08-24 工作树的 RAM / 自动补偿语义保留在接入文档中，不能用于推断现行保存固件；
- 当前工作树为有效 `R` 帧加入 250 ms 超时归零，HEAD 基线没有。由于没有能力握手，应用仍按“看门狗未知”处理，软件停止不能替代物理断电；
- `R` 只能走类型化实时控制通道，诊断终端不能发送；每次连接必须明确选择腿高目标，旧会话的延迟任务和事件由 `sessionId` 隔离；
- 固件尚无稳定的版本与能力协商协议，因此仍保留会话级写入权限与命令白名单校验；未解锁的会话只读，未知命令不得自动下发；
- 已请求遥测时，前端会在通道停滞后撤销实时控制武装，Rust 会在更宽松的 2 秒窗口、连续解析失败或帧边界失步时锁定会话；所有关闭命令仍只是 best-effort。

更完整的协议边界见[固件接入指南](docs/firmware-integration.md)。

## 技术栈

- [Tauri 2](https://tauri.app/)：桌面外壳、串口访问和系统能力边界；
- Rust：设备状态、命令校验、通信适配与遥测解析；
- React 19 + TypeScript：前端页面和类型安全的调用封装；
- Vite 8 + Biome：开发构建、静态检查和前端质量门禁；
- Lucide React：轻量图标；
- 原生 CSS：设计令牌、响应式布局和浅色液态玻璃效果。

项目有意不引入大型 UI 组件库。液态玻璃效果在不透明浅色窗口内部通过半透明背景、`backdrop-filter`、描边和柔和阴影实现，以避免原生透明窗口在 Windows 上常见的缩放与 GPU 合成问题。

## 环境要求

仓库固定并验证 Node.js 24.18、npm 11.16 与 Rust 1.95；无需全局安装 Tauri CLI。lock 文件用于可重复安装，首次下载 npm/crates 依赖需要联网。

| 平台 | 当前状态 | 原生依赖 |
|---|---|---|
| Ubuntu 24.04 x86_64 | 已完成编译、测试、deb 与 AppImage 打包验证 | WebKitGTK 4.1、GTK 3、构建工具；详见 [Linux 指南](docs/linux.md) |
| Windows x64 | 上一轮已编译验证，CI 持续检查 | Visual Studio 2022 C++、WebView2、stable-msvc |
| macOS | 尚未建立签名和运行验证，不声明支持 | 后续需要 Xcode、Developer ID 与公证 |

Linux 系统依赖可用 `./scripts/bootstrap-ubuntu.sh --with-dialout` 安装；该脚本不会安装 Node 或 Rust，也不会以 root 启动应用。

## 快速开始

Ubuntu 24.04 首次准备见 [Linux 指南](docs/linux.md)，随后在各平台使用相同的项目命令：

```bash
npm ci
npm run check
npm run tauri dev
```

只开发界面时运行 `npm run dev` 并使用 WL1 Mock 或 GameBox 体验演示；真实串口需要 Tauri 桌面运行时。Linux 打包运行：

```bash
npm run bundle:linux
```

deb 与 AppImage 输出到 `src-tauri/target/release/bundle/`。电子琴交互预览只在开发构建或显式设置 `VITE_ENABLE_PIANO_PREVIEW=true` 时开放；它不会访问真实硬件。完整开发流程见[开发指南](docs/development.md)，发布门禁见[发布规范](docs/release.md)。

## 项目结构

```text
.
├── src/                         # React 前端
│   ├── components/ProductHome.tsx # 产品选择首页
│   └── components/pages/        # WL1 产品工作台页面
├── src-tauri/                   # Tauri / Rust 后端与桌面配置
├── docs/
│   ├── architecture.md          # 分层、状态与版本策略
│   ├── firmware-integration.md  # WL1 固件与传输接入约定
│   ├── gamebox-integration.md   # GameBox 只读串口、固件检查与外存规划
│   ├── linux.md                 # Ubuntu 24.04 开发、运行与打包
│   ├── release.md               # 跨平台发布、签名与门禁
│   ├── security-audit.md        # 安全审计和残余风险
│   ├── development.md           # 开发、测试和构建流程
│   └── safety.md                # 实机操作与开发安全要求
├── .github/workflows/           # 跨平台 CI 与定期依赖审计
├── package.json
└── vite.config.ts
```

## 设计原则

1. **安全默认值**：未识别设备、协议主版本不兼容或能力未知时，默认只读。
2. **传输与业务分离**：页面不接触串口句柄；Legacy 文本命令统一进入设备网关，并由 Rust 安全白名单重复校验类型、范围和长度。
3. **固件事实与推测分离**：文档明确标注已确认事实、兼容假设和待实机验证项。
4. **可离线开发**：Mock 与回放传输应覆盖连接、遥测、超时和错误状态。
5. **单仓库可构建**：不要求同步 clone 额外协议仓库；如需拆包，优先使用同仓库 Cargo workspace。
6. **中文优先**：默认界面与文档使用简体中文，协议字段和代码标识保留英文。
7. **产品工作区隔离**：产品首页只负责选择入口；每个产品独立管理协议、设备会话、页面与安全约束。

## 文档

- [系统架构](docs/architecture.md)
- [固件接入](docs/firmware-integration.md)
- [WL1 参数保存到 Flash](docs/parameter-flash-save.md)
- [GameBox 游戏机接入](docs/gamebox-integration.md)
- [PN532 NFC 门卡备份与写入](docs/nfc-pn532.md)
- [Ubuntu 24.04 指南](docs/linux.md)
- [开发指南](docs/development.md)
- [发布规范](docs/release.md)
- [安全审计](docs/security-audit.md)
- [安全指南](docs/safety.md)
- [漏洞披露政策](SECURITY.md)

## 上游与参考

- WL1 固件：[lk888l/wheeled-legged_Robot-WL1](https://github.com/lk888l/wheeled-legged_Robot-WL1)
- 上位机技术参考：[hex-meow/hex-gui](https://github.com/hex-meow/hex-gui)

Legacy 兼容记录以本地 WL1 的 `feature/framework@8f8eb82` 和 2026-08-24 尚未提交的工作树源码为双层基线；Flash 参数保存另按 `428f199` 与 2026-09-25 工作树核验，见参数保存指南；该工作树仍在变化，不能用 commit 唯一标识。任何后续改动都应重新核对 `commands.md`、`communication_module.cpp`、`motion_control_module.cpp` 并完成台架验证。
