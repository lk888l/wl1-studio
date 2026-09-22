# Ubuntu 24.04 开发、运行与打包

Ubuntu 24.04 x86_64 是当前声明并实际构建验证的 Linux 基线。Linux 桌面使用系统 WebKitGTK，不内置浏览器运行时；真实串口通常由 `dialout` 组控制。

## 一次性准备

推荐以普通桌面用户执行：

```bash
./scripts/bootstrap-ubuntu.sh --with-dialout
```

脚本只通过 `sudo` 安装系统构建依赖，并可选择把当前用户加入 `dialout`。组成员变更后必须注销桌面会话并重新登录。应用运行时与打包入口会拒绝 UID 0；不要用 `sudo` 启动或构建应用。

手工安装的等价命令是：

```bash
sudo apt update
sudo apt install --no-install-recommends \
  build-essential curl file wget patchelf \
  libayatana-appindicator3-dev librsvg2-dev libssl-dev \
  libwebkit2gtk-4.1-dev libxdo-dev libdbus-1-dev bluez
sudo usermod -aG dialout "$(id -un)"
```

另外安装 Node.js 24 LTS、npm 11 和 rustup。仓库中的 `.node-version`、`packageManager` 与 `rust-toolchain.toml` 固定了已验证版本。项目使用 `serialport` 的无 libudev 后端，因此当前不要求 `libudev-dev`。

重新登录后运行只读诊断：

```bash
./scripts/check-linux.sh
```

没有连接 USB 串口或没有安装仅打包需要的 `patchelf` 会显示警告；缺少编译依赖会返回非零状态。

## 安装依赖与开发

```bash
npm ci
npm run check
npm run tauri dev
```

`npm ci` 严格使用已提交的 lock 文件。`.npmrc` 默认禁止依赖生命周期脚本；引入确实依赖安装脚本的新包时，必须先审查该脚本，再在单次命令中显式启用，而不是永久关闭此保护。

只开发界面时可以运行 `npm run dev` 并使用 WL1 Mock。电子琴硬件协议尚未实现：开发构建可访问其交互预览，生产构建默认禁用。只有在明确需要评审预览时才可设置 `VITE_ENABLE_PIANO_PREVIEW=true`。

## 串口权限与稳定设备身份

ZX-D30 BLE 使用系统 BlueZ / D-Bus，通过桌面会话授予蓝牙权限，不使用 USB 串口权限。编译需要 `libdbus-1-dev`，运行需启用系统蓝牙。详细流程见[蓝牙遥控指南](bluetooth-control.md)。

先确认设备节点和权限：

```bash
ls -l /dev/ttyACM* /dev/ttyUSB* 2>/dev/null
id -nG
```

应用会展示 USB `VID:PID`，并在打开前重新从系统串口列表核对端口。拔插后设备名可能从 `/dev/ttyUSB0` 变为其他编号，因此不要缓存旧名称。

优先使用发行版默认的 `dialout` 权限，不要：

- 以 root 运行 WL1 Studio；
- 对串口执行 `chmod 666`；
- 编写 `MODE="0666"` 的宽泛 udev 规则。

受管设备部署若必须使用 udev，应按已经核实的 VID/PID 精确匹配，并使用 `TAG+="uaccess"` 或专用组。不要从文档示例猜测设备标识。

## ST-Link USB 权限

WL1 的 ST-Link/SWD 烧录不走串口，`dialout` 权限并不代替 ST-Link USB 权限。可在 **WL1 → 固件与 Flash → USB 驱动与权限设置** 中手动设置内置规则，系统通过 pkexec 请求管理员授权；操作后重新插拔 ST-Link。该规则只匹配 ST-Link 并通过 `uaccess` 授权活动桌面用户，应用无需 root。无桌面授权代理或受管系统需管理员预配置，详见 [WL1 固件指南](wl1-firmware.md)。

## Wayland 与 X11

Ubuntu 24.04 默认 Wayland，WebKitGTK/Tauri 可直接运行。若特定显卡驱动下出现空白窗口，先更新系统 WebKitGTK 与显卡驱动并收集日志；临时诊断可尝试：

```bash
GDK_BACKEND=x11 npm run tauri dev
```

这只是兼容性诊断，不应作为长期隐藏渲染问题的发布配置。

### 显卡与卡顿诊断

WL1 Studio 使用系统 WebKitGTK，具体渲染路径由 GTK、WebKitGTK、Wayland/X11 和显卡驱动共同决定。不要默认设置 `WEBKIT_DISABLE_DMABUF_RENDERER=1`、`LIBGL_ALWAYS_SOFTWARE=1` 等变量：它们适合定位特定驱动问题，却可能关闭硬件加速并让正式运行更慢。

判断是否使用独立 NVIDIA 显卡时，可在应用运行期间执行 `nvidia-smi`；进程出现在图形客户端列表中表示窗口已使用该 GPU，但不能证明页面没有过度重绘。排查持续卡顿时还应分别观察主进程和 `WebKitWebProcess` 的 CPU 占用：

```bash
pidstat -C 'wl1-studio|WebKitWebProces' 1
```

界面实现应避免在大面积 `backdrop-filter` 内容之下持续移动模糊图层，并为屏幕刷新率驱动的动画设置合理上限。当前运动学动画限制为 60 Hz，遥测推送限制为 20 Hz；这不会降低串口接收与安全处理频率。

## Linux 打包

```bash
npm run bundle:linux
```

该入口会先下载 Tauri AppImage 所需的五个工具到项目 `target/.tauri/`，其中脚本 URL 固定到提交，全部文件固定 SHA-256；任一上游内容变化都会在编译前失败。校验值升级必须作为依赖变更接受评审。不要用裸 `npm run tauri build -- --bundles appimage` 制作发布候选，因为它会绕过这道完整性门禁。

固定工具清单目前只验证了 x86_64，脚本会拒绝在其他架构上生成未经验证的 AppImage。增加 ARM64 支持时，必须分别固定并验证该架构的工具、依赖和安装环境。

产物位于：

- `src-tauri/target/release/bundle/deb/`
- `src-tauri/target/release/bundle/appimage/`
- `src-tauri/target/release/bundle/SHA256SUMS`

安装本地 deb 时使用 `sudo apt install ./实际文件名.deb`，让 apt 同时检查依赖。AppImage 需要可执行权限，可用 `chmod +x ./实际文件名.AppImage` 后以普通用户运行。发布或安装前在 `bundle/` 目录执行 `sha256sum --check SHA256SUMS`。

当前 CI 在 Ubuntu 24.04 原生构建 deb 和 AppImage。Linux 二进制受 glibc 与系统 WebKitGTK ABI 约束：在 Ubuntu 24.04 构建只代表支持该基线及经测试的兼容系统，不应直接宣称支持更老发行版。若未来支持 Ubuntu 22.04、Debian 或 ARM64，应分别建立原生构建和真实安装测试矩阵。

## 运行验证清单

发布候选至少完成：

1. `npm run check` 全部通过；
2. 全新用户环境安装 deb；
3. 普通用户可启动，Mock 遥测和关闭流程正常；
4. 已授权用户能枚举测试串口，未授权用户得到明确权限提示；
5. 拔线、重复连接、退出应用不会遗留后台会话；
6. 在架空且具备物理断电条件的台架上验证真实设备；
7. 检查动态库无缺失：`ldd src-tauri/target/release/wl1-studio` 不含 `not found`。

自动 CI 不连接真实串口，也不发送运动命令。
