# 开发指南

本文说明 WL1 Studio（WL1 控制中心）的本地开发、测试和构建约定。默认使用 Windows、npm 与 Rust stable-msvc；所有文档和用户界面优先使用简体中文。

## 前置环境

### Node.js

- Node.js：20.18 或更高；
- npm：10.8 或更高；
- 不要求全局安装 Vite、Vitest 或 Tauri CLI。

验证：

```powershell
node --version
npm --version
```

### Rust 与 Windows 组件

- 通过 rustup 安装 stable-msvc 工具链；
- Visual Studio 2022 的“使用 C++ 的桌面开发”组件；
- Microsoft Edge WebView2 Runtime。

验证：

```powershell
rustup show active-toolchain
rustc --version
cargo --version
```

项目把 `@tauri-apps/cli` 放在 `devDependencies` 中，统一通过 npm 脚本调用，避免不同开发者的全局 CLI 版本漂移。

## 安装依赖

```powershell
npm install
```

首次安装需要访问 npm registry 和 crates.io。`npm install` 会生成 `package-lock.json`；应用项目应提交该文件以便复现依赖，不要手工编辑锁文件。

本项目不要求 clone 额外协议仓库，也不使用 Git submodule。未来如需拆分协议 crate，优先放入当前仓库的 Cargo workspace，并使用仓库内相对路径。

## 常用命令

| 命令 | 用途 |
|---|---|
| `npm run dev` | 仅启动 Vite 前端，适合 Mock 模式和样式开发 |
| `npm run tauri dev` | 启动完整桌面应用与热更新 |
| `npm run typecheck` | 对前端和 Vite 配置执行严格 TypeScript 检查 |
| `npm test` | 运行一次 Vitest 测试；当前允许无测试文件 |
| `npm run test:watch` | 监听模式运行 Vitest |
| `npm run build` | TypeScript 检查后生成前端 `dist/` |
| `npm run tauri build` | 构建桌面安装包/可执行文件 |

Rust 侧提交前还应运行：

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --all-features
```

## 推荐开发流程

1. 阅读相关协议与安全文档，明确本次修改是否会触达实机写操作；
2. 默认选择 MockTransport，先覆盖正常、超时和错误状态；
3. 为纯转换和状态机补充单元测试；
4. 运行 `typecheck`、前端测试、Rust 格式化、Clippy 和 Rust 测试；
5. 只在具备安全台架条件时切换 SerialTransport；
6. 记录固件 commit、硬件版本、串口配置和观察结果；
7. 修改协议或安全行为时同步更新中文文档。

不要把“连得上串口”当作协议验证完成。写操作至少需要参数格式、单位、范围、应答和断电行为都得到确认。

## 前端约定

### TypeScript

- 保持 `strict`、未检查索引访问、未使用变量和 switch 穿透检查开启；
- 用结构化类型表达状态，不用多个相互矛盾的布尔变量；
- 领域数值命名包含单位，例如 `legHeightMm` 或 `rollDegrees`，避免裸 `value`；
- 普通业务组件不拼接固件命令；Legacy 标定与诊断的受限文本入口必须经过统一设备网关，并由 Rust 白名单复核；
- 不直接从页面调用任意 Tauri command 名，统一经过类型化 API 封装；
- 对协议枚举使用穷尽检查，未知值进入安全降级分支。

### React

- 组件保持单一职责，设备会话状态与临时表单状态分开；
- 高频遥测不要令整个页面树重渲染；
- 图表消费限频快照，原始采样留在后端环形缓冲或记录任务；
- 功能可见性由 capabilities 驱动；被禁用时说明原因，而不是只显示灰色按钮；
- 危险写操作显示目标设备、单位、旧值和新值，并要求明确确认。

### 样式

- 使用 CSS Variables 维护颜色、间距、圆角、阴影和动画时长；
- 液态玻璃用于信息分组和层次，不牺牲文字对比度；
- 在内容层使用 `backdrop-filter`，不依赖 Tauri 原生透明窗口；
- 为不支持 blur 的环境提供纯色半透明降级；
- 尊重 `prefers-reduced-motion`，避免持续大面积模糊和位移动画；
- 键盘焦点必须清晰，状态不能只依赖颜色表达。

## Rust 与 Tauri 约定

- Tauri command 只接受结构化、可反序列化的 DTO；
- 页面不能绕过设备网关传入任意串口内容；当前诊断终端仅允许 Rust 白名单中的单条 Legacy ASCII 命令；
- 所有写操作在 Rust 侧重复校验能力、单位、范围、有限值和 32 字节上限；
- 端口句柄只归设备服务所有，不放进前端状态；
- 后台任务必须可取消，断开后不得残留读取或重连任务；
- 断开与线程回收必须在会话锁之外完成；当前同步写入为保持顺序会短暂持有会话锁，并由 40 ms 串口超时限界，后续异步传输应拆分独立写队列；
- 错误保留稳定分类与诊断上下文，面向用户的描述由 UI 本地化；
- `unsafe` 默认禁止；确有必要时需说明不变量并增加针对性测试；
- Tauri 权限采用最小集合，不开启通用 shell。

## 协议开发

协议改动遵循[固件接入指南](firmware-integration.md)。建议采用黄金样本驱动：

1. 从已知固件和安全台架记录原始字节；
2. 脱敏端口、路径和唯一设备标识；
3. 固定固件 commit、传输配置和预期结构化结果；
4. 用样本测试半包、粘包、插入日志、乱码和超长行；
5. 对每条可写命令测试最小值、最大值、越界、非有限值和 32 字节边界；
6. 只有在固件行为确认后更新 Legacy 适配器。

协议提案与现有固件实现必须清楚分开。未来设计的能力查询命令不可拿去试探旧固件。

## Mock 优先的开发方式

没有真实机器人时应能完成绝大部分 UI 工作。一个合格的 Mock 场景应定义：

- 设备身份、协议版本和能力集合；
- IMU/RPM 的确定性数据与时间推进；
- 参数当前值、允许范围和 RAM 持久化行为；
- 命令延迟、成功、拒绝和无应答；
- 拔线、固件重启和协议错误；
- 不兼容主版本时的只读界面。

Mock 数据应可复现，测试中避免依赖真实时间和随机数。模拟连接也必须通过 Transport/Protocol/DeviceService 路径，不能在组件里直接塞假数据。

## 测试层次

### 前端单元测试

- 参数格式化和单位转换；
- capabilities 到 UI 状态的映射；
- 连接状态机和错误提示；
- RAM/本地方案/未来持久化三类状态标签；
- 危险操作的确认条件。

默认 Vitest 环境是 Node，保持依赖最少。确实需要渲染 React DOM 时再引入 jsdom 和测试库，不要为尚不存在的测试预装整套工具。

### Rust 单元与集成测试

- 命令编码后的字节长度，而非字符长度；
- 行结束符和数字格式；
- 流解析的半包、粘包、坏行和恢复；
- 超时、取消和关闭期间的竞态；
- 设备能力不足、版本不兼容和安全锁；
- MockTransport 与 SerialTransport 的共同契约。

### 实机测试

实机测试只在[安全指南](safety.md)的条件满足时进行，并形成可追溯记录。自动化测试不得默认搜索或连接串口，更不能在普通 CI 中下发运动相关命令。

## 构建与发布

前端产物由 Vite 生成到 `dist/`，Tauri 构建结果位于 `src-tauri/target/`。这些目录均不提交版本库。

发布前至少检查：

- 前端与 Rust 全部检查通过；
- 应用版本、Tauri 配置与发布标签一致；
- 全新环境能依据 lock 文件构建；
- 安装包不包含测试串口、个人路径或原始硬件记录；
- Windows WebView2 策略和最低系统版本已验证；
- 未签名构建清楚标注，正式发布再配置代码签名；
- Release Notes 明确支持的固件 commit/版本和已知限制。

## 常见问题

### `cargo` 或 `rustc` 找不到

安装 rustup 的 stable-msvc 工具链后重新打开终端，确认 `%USERPROFILE%\.cargo\bin` 已加入 PATH。

### Tauri 可以编译但窗口空白

先运行 `npm run build` 检查前端错误，再核对 Tauri 的 `frontendDist`、`devUrl` 和 Vite 端口是否分别指向 `../dist`、`http://localhost:1420`。

### 端口无法打开

检查端口是否被串口助手或另一份应用占用、USB 驱动是否正常、设备是否重新枚举为其他 COM 号。不要通过管理员权限掩盖端口身份或驱动问题。

### 串口能收到文本但没有遥测

保留脱敏原始字节，检查适配器是否按当前约定发送无结束符的独立 receive-to-idle 帧，确认 USB-UART 没有合并相邻命令；同时核对 `showimu` 是 HEAD 三字段还是工作树 `a/ok` 五字段、`showrpm` 是否仍为 A/B 文本。不要用宽松正则吞掉无法解释的数据，也不要只根据 HEAD commit 忽略未提交工作树差异。

### 参数显示“已发送，未确认”

这表示固件没有提供可关联的明确成功应答或回读。它不等于写入成功，更不等于已经持久化。

## 文档维护

以下变化必须同步更新文档：

- 串口配置、行结束符或 32 字节计数规则；
- 命令语法、单位、范围、应答或持久化方式；
- 新 capability、协议版本或传输实现；
- 任何安全锁、默认值、自动重连或自动套用行为；
- 构建工具版本、依赖安装和发布流程。

协议事实更新时，应注明对应固件 commit 与验证方式；不要把讨论中的设计直接写成已实现功能。
