# ESP32-C3 无线电脑监控

## 使用

1. 电脑和 ESP32-C3 连接同一局域网，在设备 Network 页面查看 STA IP；也可让电脑连接设备热点，目标使用 `192.168.4.1`。设备仍需供电。
2. 启动桌面应用（开发环境执行 `npm run tauri dev`），进入 **ESP32-C3 像素桌宠 → 电脑监控**。
3. 填写设备 IPv4 地址，按需开启 **采集 NVIDIA GPU** 并选择显卡，选择 500 / 1000 / 2000 ms 更新周期，点击 **开始监控**。看到“设备已响应”表示 MCU 已确认接收。
4. MCU 打开 **Tools → PC Monitor**，Up / Down 或 Enter 翻页，Back 返回。总览显示 CPU / RAM / GPU；详情显示内存、显存和 GPU 温度。

电脑端不需要先连接 USB。返回产品库、切换产品和最小化不会停止监控；右下角全局状态条提供停止与轻量后台入口。
点击 **轻量后台运行** 或关闭窗口，会释放整个工作台进程，只保留原生托盘和采集/发送驱动。
托盘菜单提供 **打开控制中心 / 轻量后台运行 / 恢复 Wi-Fi 传输 / 停止 Wi-Fi 传输 / 退出 WL1 Studio**。
Linux 使用右键托盘菜单；Windows 也可左键托盘恢复界面。

首次启动显示配置界面。成功开始一次监控后，默认在下次启动时直接进入后台，并恢复上次仍在运行的发送任务。
在电脑监控页可分别关闭 **启动时直接进入后台**、**下次启动恢复上次传输**。
主动点击停止会记住停止状态；从托盘退出会立即结束当前发送，但保留下次启动的恢复意图。
仅启动软件时应用这些选项，系统开机启动项可按需要指向应用并添加 `--background`。

命令行 `wl1-studio --show` 强制打开工作台，`wl1-studio --background` 优先进入后台。
首次使用、配置损坏、恢复失败或系统托盘不可用时，始终打开窗口以便配置和诊断。
重复启动会复用已有托盘/驱动；普通启动或 `--show` 恢复窗口，`--background` 保持后台。
开发环境可用 `npm run tauri -- dev -- -- --show` 强制显示工作台。

后台设置、最后成功的 IP / GPU 采集开关 / 显卡 / 周期及运行意图，保存在 Tauri 应用配置目录的 `background-v1.json`，通过临时文件替换保存。
Windows 为用户的 Roaming AppData 下的应用目录，Linux 为 `$XDG_CONFIG_HOME/io.github.wl1.studio`（通常是 `~/.config/io.github.wl1.studio`）。
配置读取/保存失败会在界面提示；损坏配置不会自动发送。浏览器只提供配置预览，不模拟采集或发送。采样仅保存在内存。

进入轻量后台前，工作台会释放其他产品的 USB、蓝牙和演示会话；正在刷写固件或进行探针网络操作时，会保留窗口直至操作完成。
后台期间不接受新的产品连接或固件任务，恢复工作台后可正常使用。
Linux 需要可用的 StatusNotifier / AppIndicator 托盘宿主；缺失时保持窗口，仍可最小化继续传输，关闭窗口则完整退出。

## 实时资源占用

正常使用时，电脑监控页的 **本程序资源占用** 每秒显示：

- **程序 CPU / 程序内存**：托盘、驱动及工作台进程树的 CPU 和常驻内存合计；内存使用 MiB。
- **后台进程 CPU / 内存**：单独列出托盘/驱动进程，便于区分工作台开销。
- **Wi-Fi 发送速率 / 包速率**：实际成功发送的 UDP JSON 字节和报文计数的时间差分，不包含 UDP/IP/链路层头部。

CPU 按逻辑处理器数归一化，整机总算力为 100%。首次采样建立基线，暂时显示 N/A；重新开始发送不继承旧会话的速率。
内存是进程 RSS 的合计，共享页可能在多个进程中重复计入，不等同于系统任务管理器的私有工作集。
右下角全局状态条也显示程序 CPU、内存和发送速率，切换产品后仍然可见。
发送给 ESP32-C3 的 CPU / RAM / GPU 仍是整机指标，协议没有加入软件自身占用字段。

## 采集与协议

CPU / RAM 使用 sysinfo，RAM 已用取 total - available，首个 CPU 样本用于建立基线。
CPU 业务代码直接调用 `refresh_cpu_usage()` / `global_cpu_usage()`。Linux 的 `/proc/stat` 提供累计 CPU 时间，sysinfo 通过相邻采样差分得到占用率；Windows 的 sysinfo 已使用 PDH 读取格式化占用比例，系统计数器内部同样需要两次采样。
占用率描述一个时间段，不能用单次累计时间读取替代。保留现有采样方式，不额外启动外部命令或引入内核模块。依据：[Linux 内核文档](https://www.kernel.org/doc/html/latest/filesystems/proc.html#miscellaneous-kernel-statistics-in-proc-stat)、[Microsoft PDH 文档](https://learn.microsoft.com/en-us/windows/win32/perfctrs/collecting-performance-data)。
NVIDIA 指标通过运行时加载的 NVML 获取，利用已有显卡驱动。采集和 UDP 发送不启动外部采样命令。
**采集 NVIDIA GPU** 默认开启，兼容旧配置。关闭后保留上次显卡选择，仅采集和发送 CPU / RAM；GPU 占用、显存和温度在协议中保持原字段并发送 null，界面显示“GPU 采集已关闭”。
运行中切换开关会重建传输会话并保存，设备连接短暂刷新；后台自动恢复沿用该设置。关闭状态冷启动及打开监控页均不会枚举显卡或初始化 NVML，也不会提示缺少 GPU。
已加载的 NVML 缓存随后台进程退出释放；关闭开关立即停止 GPU 查询。比较两种模式的常驻内存时，应分别冷启动测量。
无 NVIDIA 驱动、显卡缺失或某项不支持时，CPU / RAM 继续，缺失项显示 N/A。
GPU 占用率取 GPU 利用率，显存取 memory_info.used / total；容量以 GiB 显示。

轻量核心在 `src-tauri/crates/pc-monitor-core`，不依赖 Tauri、React、窗口或配置存储。
原生托盘/驱动进程独立持有核心，工作台按需启动为同一程序的子进程；关闭工作台会回收其 WebView、WebKit 网络进程及缓存，避免仅隐藏窗口或销毁 WebView 后仍残留浏览器内存。
两者使用仅绑定 `127.0.0.1` 的私有连接，以每次启动随机生成的 256 位凭据验证，消息有 16 KiB 长度限制，仅开放监控、后台偏好及界面退出确认。
工作台仍使用 `pc_monitor_start / pc_monitor_stop / pc_monitor_snapshot / pc_monitor_devices`；适配层将请求转交同一后台核心。
硬件产品会话和固件任务由工作台进程独占；托盘退出会先等待工作台接受退出，继续保持固件忙时的退出保护。

发送线程通过网络就绪事件、采样截止时间和停止唤醒运行，取消原先每 20 ms 的固定唤醒。
资源统计仅由工作台快照请求触发，每秒最多采样一次；仅枚举进程关系、刷新本程序进程树的 CPU/RSS，不采集进程命令行或环境变量。
进入轻量后台后，工作台进程及资源轮询全部结束，传输会话、UDP 端口和采样频率保持不变。
UDP 4443 发送完整 JSON v1；会话、序号、限长和 MCU ACK 防止旧回执误报连接。3 秒无回执或设备无更新标记过期。当前面向单台电脑向一个 MCU 发送，手动指定 IP。

## 验证

```bash
npm run check:frontend
npm run check:rust
cargo run --manifest-path src-tauri/Cargo.toml -p pc-monitor-core --example send -- 设备IP 10
cargo run --manifest-path src-tauri/Cargo.toml -p pc-monitor-core --example send -- 设备IP 10 --no-gpu
```

示例复用同一核心，每秒输出真实状态，指定秒数后停止。核心测试覆盖协议编码、UDP ACK、旧会话回执、过期、停止及无驱动容错；工作区检查会包含核心 crate。
已在 Linux + NVIDIA RTX 5070 Ti Laptop + ESP32-C3 实板验证数据链路、断流恢复及资源余量；质量检查配置覆盖 Ubuntu/Windows，本轮没有 Windows 实机运行验证。
固件工程中的 `tools/pc_monitor_smoke.py` 提供串口与 Wi-Fi 专项验收，详见固件 `docs/pc-monitor.md`。

### 轻量后台实板验收（2026-10-20）

使用 `/dev/ttyACM2` 查询现有固件状态，通过真实 Wi-Fi 发送本机 CPU / RAM / NVIDIA 指标，保持 UDP v1 不变，无需重刷固件。
本次使用 Linux 调试构建、500 ms 采样周期及 NVIDIA RTX 5070 Ti Laptop；下表为一次测量的 RSS 合计，不能当作所有机器或发布构建的固定预算。

| 模式 | 进程数 | RSS | 整机 CPU |
| --- | --- | --- | --- |
| 冷启动轻量后台 | 1 | 约 88 MiB | 4 秒窗口低于采样分辨率 |
| 打开产品库 | 4 | 约 603 MiB | 约 0.26% |
| 正常电脑监控工作台 | 4 | 约 661 MiB | 约 0.24% |
| 释放工作台后轻量后台 | 1 | 约 88 MiB | 8 秒窗口约 0.008% |

已验证默认后台启动、托盘恢复、标题栏关闭、重复启动复用、带工作台退出、重启自动恢复、主动停止后保持停止、托盘手动恢复，以及界面关闭自动恢复开关后的下次启动行为。
另以全新配置验证首次启动显示工作台，并在隔离 D-Bus、没有托盘宿主的环境中验证窗口降级及关闭后的完整退出。
打开与释放工作台时设备会话保持不变、序号继续增长，设备 `pc_stale=0 / pc_error=0`；纯后台没有 WebKit Web/Network 子进程。
前端检查通过 213 个测试；Rust 工作区通过 175 个测试，13 个需要其他实机条件的测试按原约定跳过。

### GPU 采集开关验收（2026-10-20）

通过独立 D-Bus、隔离配置与本地 UDP 回执端验证真实桌面界面，未中断原有程序和实板传输：

- GPU 关闭状态冷启动，以及打开电脑监控页后，后台进程均未加载 NVML。
- 运行中开启后取得本机 NVIDIA RTX 5070 Ti Laptop 的真实指标；再次关闭后 CPU / RAM 和回执正常，GPU 字段为空/null。
- 开关写入后台配置；停止后重开及进程退出后恢复均保持关闭，冷启动仍未加载 NVML。
- 核心测试额外验证关闭时 NVML 缓存未初始化，保留的失效显卡 UUID 不影响 CPU / RAM / ACK；前端测试覆盖切换期间点击停止的会话竞态。

本轮 `npm run check:frontend` 通过 216 个测试，`npm run check:rust` 通过 177 个测试，13 个依赖其他实机条件的测试保持跳过。
