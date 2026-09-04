# 安全审计与风险登记

审计日期：2026-09-04。范围：React/Vite 前端、Tauri 命令面、Rust 串口/协议/会话实现、依赖锁文件、Linux 构建及打包配置。

## 本轮结论

未发现可直接从网络远程执行任意代码、绕过 Rust 命令白名单发送任意串口文本，或把凭据提交到仓库的证据。已修复和加固的重点包括：

- 生产 CSP 与开发 CSP 分离，生产包不再允许 localhost/WebSocket；禁止对象、表单、基址和 frame 嵌入，并冻结 JavaScript 原型；
- Tauri capability 从 `core:default` 缩减为实际使用的事件监听/取消监听；
- Vite 不再暴露宽泛的 `TAURI_*` 构建环境变量，防止未来签名私钥进入前端产物；
- AppImage 打包不再信任 Tauri 默认的可变 `master`/`continuous` 输入：发布脚本预置固定提交/内容，并逐项校验 SHA-256，校验失败即阻断；
- 连接串口前重新枚举并精确匹配当前设备，UI 展示 USB VID/PID；
- 串行化 connect/disconnect 生命周期，使用 Acquire/Release 发布读取线程故障状态，避免旧会话或排队运动命令跨越故障安全写入；
- 正常关闭与异常 Drop 都执行 best-effort 中立运动/关闭遥测，且不会重复执行常规关闭路径；
- Linux PermissionDenied 给出最小权限的 `dialout` 处理方式；运行时与打包脚本均拒绝 UID 0，不能用 root 绕过串口权限；
- Rust crate 禁止 `unsafe`，前端启用 Biome、严格 TypeScript 和完整检查脚本；
- 未接入硬件协议的电子琴交互预览在生产构建中默认禁用，不再伪装为可用串口产品。

安全相关行为仍必须以代码评审、测试和实机台架共同验证，本文不是认证报告。

## 依赖审计

执行结果：

- `npm audit`：0 个已知漏洞；
- `cargo audit --file src-tauri/Cargo.lock`：0 个 vulnerability 类命中；
- RustSec 同时报告 17 条 warning，主要是 Tauri Linux 栈间接依赖的 GTK3/unmaintained crates，以及 `glib 0.18.5` 的 `RUSTSEC-2024-0429` soundness 告警。

`RUSTSEC-2024-0429` 影响 `glib::VariantStrIter` 的特定迭代 API；本项目没有直接调用该 API。相关版本来自当前 Tauri/WebKitGTK 稳定依赖链，不能在应用层安全地单独替换。当前处置是：

1. 不忽略或删除审计告警，保留每周扫描；
2. 保持 Ubuntu 的 WebKitGTK/GTK 安全更新；
3. 持续跟进 Tauri/wry 上游依赖迁移；
4. Tauri 升级后重新运行完整构建、RustSec 和 GUI/串口回归；
5. 若调用路径变化或 RustSec 提升严重度，阻断发布。

这是一项已接受的上游残余风险，不等于“完全无漏洞”。

## 固有风险与发布阻断项

| 风险 | 当前控制 | 发布要求 |
|---|---|---|
| Legacy WL1 无设备身份/能力握手 | 写入默认锁定、人工四项确认、命令白名单 | 未核实固件基线时只能只读 |
| 命令无 ACK，无法证明设备已应用 | UI 明确显示“请求已发送/未确认” | 不得把发送成功表述为设备状态 |
| 主机或 dialout 用户可绕过应用 | OS 最小权限、无 root 运行 | 受管环境使用专用账号/精确 udev |
| SIGKILL、掉电、内核/USB 故障无法保证安全写入 | 固件看门狗、物理急停、best-effort 停机 | 实机前必须具备物理断电；桌面端不是安全控制器 |
| Linux WebView 依赖系统补丁状态 | 严格 CSP、无远程内容、系统更新 | 仅支持仍接收安全更新的发行版 |
| 安装包尚未签名 | CI 只标记为未签名验证产物 | 对外正式发布前完成平台签名 |
| 裸 Tauri AppImage 构建会使用可变上游别名 | `bundle:linux` 预置五项固定、受 SHA-256 校验的工具 | 发布候选禁止绕过包装脚本；哈希变更必须评审 |
| 电子琴后端协议未实现 | 生产入口默认禁用 | 协议、Transport、测试与实机验证完成前不得启用 |
| Ubuntu 真实 WL1 尚未在本轮接入 | Mock/单元测试/包构建已验证 | 首个 Linux 正式版前完成架空台架测试 |

## 复查命令

```bash
npm ci
npm run check
npm audit --audit-level=moderate
cargo audit --file src-tauri/Cargo.lock
npm run bundle:linux
./scripts/check-linux.sh
```

还应检查生产 bundle 中不存在签名材料、个人路径、测试捕获和 `TAURI_SIGNING_PRIVATE_KEY` 等敏感字符串。任何协议、权限、导航、更新器或外部 URL 变更都要求重新威胁建模。
