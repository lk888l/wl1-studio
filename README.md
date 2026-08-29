# WL1 Studio 设备控制中心

**简体中文** | [English](README.en.md)

本仓库实现一套可扩展的多产品桌面上位机。软件启动后先进入产品首页，再进入对应产品的连接、遥测、调参和诊断工作台；当前首个且唯一接入的产品是 **WL1 轮腿小车**，其工作台名称为 **WL1 Studio（WL1 控制中心）**。项目参考 [hex-gui](https://github.com/hex-meow/hex-gui) 的 Tauri + React 技术路线，但不依赖额外仓库或 Git 子模块，并以更轻量的依赖、明亮的液态玻璃视觉和可替换通信层为目标。

> [!WARNING]
> 轮腿机器人可能因错误参数、协议误判或通信异常突然运动。首次连接和每次调参前，请先阅读[安全指南](docs/safety.md)，架空驱动轮、准备物理急停，并确保人员远离运动范围。本软件不是安全控制器，不能替代固件侧限幅、看门狗和急停电路。

## 当前定位

当前阶段优先建立“产品首页 + 独立产品工作台”的可扩展骨架。WL1 兼容层同时核对了 `feature/framework@8f8eb82` 的提交基线，以及 2026-08-24 本地固件工作树中尚未提交的控制/通信演进；界面仍可依靠 Mock 数据独立开发。未来新增产品时可接入自己的协议、页面与安全策略，WL1 固件变更则应集中在协议适配器，不需要重写页面。

当前首版已经覆盖的核心场景包括：

- 产品首页启动时先清理遗留设备会话，再选择 WL1 轮腿小车；仅在当前会话安全结束后返回产品库；
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
- 调参值目前只保存在 **RAM**，重启或断电后会丢失。HEAD 会周期重算 Angle `Kp`/`anglebias`；当前工作树的数值命令会启用手动覆盖，并新增 `anglepid auto`/`anglebias auto` 恢复自动计算；
- 当前工作树为有效 `R` 帧加入 250 ms 超时归零，HEAD 基线没有。由于没有能力握手，应用仍按“看门狗未知”处理，软件停止不能替代物理断电；
- `R` 只能走类型化实时控制通道，诊断终端不能发送；每次连接必须明确选择腿高目标，旧会话的延迟任务和事件由 `sessionId` 隔离；
- 固件尚无稳定的版本与能力协商协议，因此真实串口写入还要求独立确认 Legacy WL1 双基线兼容性；缺少确认时只读，未知命令不得自动下发；
- 已请求遥测时，前端会在通道停滞后撤销实时控制武装，Rust 会在更宽松的 2 秒窗口、连续解析失败或帧边界失步时锁定会话；所有关闭命令仍只是 best-effort。

更完整的协议边界见[固件接入指南](docs/firmware-integration.md)。

## 技术栈

- [Tauri 2](https://tauri.app/)：桌面外壳、串口访问和系统能力边界；
- Rust：设备状态、命令校验、通信适配与遥测解析；
- React 19 + TypeScript：前端页面和类型安全的调用封装；
- Vite 6：开发服务器和前端构建；
- Lucide React：轻量图标；
- 原生 CSS：设计令牌、响应式布局和浅色液态玻璃效果。

项目有意不引入大型 UI 组件库。液态玻璃效果在不透明浅色窗口内部通过半透明背景、`backdrop-filter`、描边和柔和阴影实现，以避免原生透明窗口在 Windows 上常见的缩放与 GPU 合成问题。

## 环境要求

Windows 开发环境建议具备：

- Node.js 20.18 或更高版本；
- npm 10.8 或更高版本；
- Rust stable-msvc 工具链（通过 rustup 安装）；
- Visual Studio 2022 C++ 桌面开发组件；
- Microsoft Edge WebView2 Runtime。

本仓库使用项目内的 `@tauri-apps/cli`，无需全局安装 Tauri CLI。首次安装前端和 Rust 依赖需要联网。

## 快速开始

```powershell
# 安装前端依赖，并生成应提交的 package-lock.json
npm install

# 仅启动浏览器中的 Vite 前端；没有硬件时可使用 Mock 模式
npm run dev

# 启动完整 Tauri 桌面应用
npm run tauri dev
```

提交前运行：

```powershell
npm run typecheck
npm test
npm run build
```

如果尚未安装 Rust，前端仍可通过 `npm run dev` 开发；完整桌面构建必须先补齐 Rust stable-msvc。开发环境说明见[开发指南](docs/development.md)。

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
│   ├── development.md           # 开发、测试和构建流程
│   └── safety.md                # 实机操作与开发安全要求
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
- [开发指南](docs/development.md)
- [安全指南](docs/safety.md)

## 上游与参考

- WL1 固件：[lk888l/wheeled-legged_Robot-WL1](https://github.com/lk888l/wheeled-legged_Robot-WL1)
- 上位机技术参考：[hex-meow/hex-gui](https://github.com/hex-meow/hex-gui)

项目中的命令语义以本地 WL1 的 `feature/framework@8f8eb82` 和 2026-08-24 尚未提交的工作树源码为双层基线；该工作树仍在变化，不能用 commit 唯一标识。任何后续改动都应重新核对 `commands.md`、`communication_module.cpp`、`motion_control_module.cpp` 并完成台架验证。
