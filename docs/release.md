# 发布工程规范

## 发布原则

桌面包必须在目标操作系统原生构建和验证。不要把“能交叉编译”当作“可以发布”：Windows WebView2、macOS 签名/公证以及 Linux WebKitGTK/glibc 都有不同的运行时和信任链。

当前自动化只生成未签名的 CI 验证产物，不会自动创建公开 Release。配置正式发布前，需要先准备受保护环境、签名身份和人工审批。

## 版本与变更

发布标签使用 `vMAJOR.MINOR.PATCH`。以下版本必须保持一致：

- `package.json`;
- `src-tauri/Cargo.toml`;
- `src-tauri/tauri.conf.json`。

每个 Release Notes 至少写明支持的操作系统/架构、固件基线、协议限制、硬件验证记录、迁移步骤和已知风险。未实现的能力必须写成未实现，不能用 UI 流程代替后端能力。

## 发布门禁

正式版本只能引用可获取的固件 commit/tag 和对应协议证据；当前 2026-08-24 未提交工作树快照只能用于开发兼容，不能作为可复现发布基线。

1. 工作树只包含已评审变更；
2. `npm ci` 和 `npm run check` 在全新环境通过；
3. `npm audit` 与 `cargo audit` 已复核；
4. Ubuntu 和 Windows CI 均通过；
5. 目标平台安装、首次启动、升级和卸载均完成冒烟测试；
6. Mock、串口枚举、权限拒绝、拔线和安全停机完成验证；
7. 真实设备测试遵守安全清单，并记录固件 commit、硬件版本和操作者；
8. 生成 SHA-256 校验和与软件物料清单（SBOM）；
9. 签名后再次校验产物，最后由受保护发布环境批准公开。

## 平台签名

- Windows：使用组织代码签名证书签署 exe/MSI/NSIS，并在干净机器验证 SmartScreen 与 WebView2 安装策略。
- macOS：使用 Developer ID 签名、Hardened Runtime、公证与 stapling；串口驱动和 USB 权限必须单独验证。
- Linux：deb 仓库应签署 Release 元数据；独立下载同时发布 SHA-256。AppImage 的签名和更新元数据需要在选定发布渠道后统一设计。

密钥只保存在 CI 的受保护 secrets/HSM 中，不写入仓库、日志或 `.env`。前端构建仅允许 `VITE_*` 环境变量；任何 `VITE_*` 都会成为公开客户端数据，绝不能承载秘密。Tauri 更新私钥必须仅供签名步骤读取，并限制分支、审批人与日志输出。

## 依赖和供应链

- npm 与 Cargo lock 文件必须提交；
- Node、npm、Rust 和 cargo-audit 版本固定；
- GitHub Actions 使用完整 commit SHA，Dependabot 负责提出更新；
- npm 依赖安装脚本默认关闭；
- 每周运行 npm/RustSec 审计；
- 对无法立即移除的上游风险，在安全审计中登记受影响路径、缓解措施、责任人与复查条件。
- Linux 发布候选只允许通过 `npm run bundle:linux` 构建；该入口将 Tauri AppImage 工具预置到项目缓存，并对固定提交/资产执行 SHA-256 校验，内容变化时失败关闭；
- 禁止把绕过 `scripts/prepare-appimage-tools.sh` 的裸 Tauri AppImage 构建当作发布候选。更新工具哈希时必须核对官方来源、变更内容和许可证，并走代码评审。

## 跨平台扩展成本

业务 UI、协议校验和 Transport 边界已经跨平台，新增桌面平台通常不需要重写主体。主要工作集中在：

- 原生 WebView/系统库和最低系统版本；
- 串口命名、权限、驱动与稳定设备身份；
- 安装包格式、图标、升级和卸载；
- 平台代码签名、公证与发布渠道；
- 每个平台的 CI、安装冒烟和真实硬件矩阵。

因此不是“大量重写”，但每个平台都需要独立的发布工程和验证证据。macOS 尚未建立 CI/签名验证前，不应列为受支持平台。
