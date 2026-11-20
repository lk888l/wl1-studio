# G431 电机驱动台

对应 `stm32g431-foc-canfd` 固件的 CANopen 风格对象字典与厂商 FD-PDO 扩展，并非通用 CiA 402 主站。无需旁边的固件仓库或 `hex-gui` 即可编译、测试、运行。286 个标量对象来自固件 `docs/object-dictionary.md`；主站和界面共用 [objects.csv](../src-tauri/crates/foc-drive/src/objects.csv)。

## 首次连接

1. 台架先断开功率输出，固定电机、清空运动范围、准备独立的物理断电手段。总线上只留一个控制该节点的主站。Windows 使用 WinUSB；该后端直接打开 HexMeow USB-CANFD Hub（`1209:2323`，80 MHz），不是串口或 SLCAN。若有多个相同 Hub，先只保留目标 Hub；通道号不是 USB 设备序号。
2. 首页 → **G431 无刷电机**。选择 Hub 通道、主机侧仲裁/数据速率和当前 Node-ID。主站默认 `can0`；固件出厂为节点 1、1 Mbit/s 仲裁、5 Mbit/s 数据。不会自动探测波特率、关闭其他程序或启用电机。若占用，先在另一个程序中释放适配器。
3. 可选「被动监听 2 s」：使用适配器 listen-only 模式，不发送探测帧；列出观测到的 ID 和 heartbeat 节点。无帧不代表没有电机，也不证明通道被占用。只有两个节点且监听端不 ACK 时，不要用监听结果替代身份读取。
4. 「读取并连接」仅发本节点 SDO 上传，检查设备类型 `0x00020192`、厂商 `0`、产品 `0x431` 并读取反馈。不会切换 NMT、自动清故障、校准或写 Flash。空闲断开不发送控制命令。若连接失败，核实板卡供电、终端电阻、节点 ID、速率和占用；不要用广播或使能来试探接线。

## 在界面中能做什么

| 功能 | 行为 |
| --- | --- |
| 运动台 | 速度、力矩、单圈/多圈位置、浮点 MIT、压缩 MIT。使能先握手，目标数值单独下发；改草稿不改变电机。速度单位为 rev/s（不是 rpm），位置为 rev，力矩模式单位为基准电流的千分比，MIT 前馈为 Nm。 |
| 反馈与记录 | 空闲用 SDO，周期运行用 TPDO4。示波可选位置、速度、Id/Iq、电压、力矩或 MCU 温度，窗口 5–60 s。「开始录制」记录主站采样序号、相对时间、来源、阶段与全套反馈；CSV 可检查缺号。上限 60,000 个样本，不是原始 CAN 抓包；断开后仍可导出，离开工作台前请先导出。 |
| 参数字典 | 按名称或十六进制地址搜索，读取一项或一页。可改通信、Heartbeat、SYNC、EMCY、跟随误差、速度和加减速、快停斜率、电流基准/Kt、全局及 MIT 附加限流、压缩物理量程等；逐项写 RAM，并比较读回值。控制字、目标、映射和维护命令只走专用入口。 |
| PDO 路由 | 编辑 4 RPDO、4 TPDO 的启用位、11 位 COB-ID、传输类型、映射顺序、接收超时或事件周期及 TPDO inhibit。校验映射方向、类型位宽、16 项和 64 B 上限。配置写入按禁用→清计数→写入→恢复计数和启用位→读回。手工配置同步类型不会开启 SYNC 生产器；默认驱动使用异步 PDO。 |
| 校准与存储 | 电角校准、正反慢扫描、RAM 周期补偿开关、读校准结果、故障复位、保存、恢复默认和复位分别确认。该固件的 NMT Reset Node 和 Reset Communication **都会整机重启**；恢复默认还会使已保存的校准失效。慢扫描需要已有有效校准，不自动拟合或写入补偿表。 |

观察小幅波动时，使用示波区的「自动量程」。选择「Iq / Id 双电流」可在同一安培刻度下对比两轴电流。指向曲线可读取该采样点的会话时间和数值，键盘聚焦波形后也可用左右方向键逐点查看。「冻结画面」期间采集和录制继续，时间窗短于已缓存历史时，可拖动「冻结回看」检查更早的波形。「展开波形」保留顶部关桥按钮，按 Esc 可还原布局。

不是每个固件内部变量都是 CAN 参数：内部 PI 增益、固件编译时常量、只读的 BRS 等不提供假写入口。电流基准、Kt、节点 ID 和波特率是**待应用值**：写入后在旧链路显式保存，重启，按新速率/ID 重新连接。MIT 开关、量程、附加限值和运动目标不会跨重启保留。校准成功不自动保存。

## 典型驱动流程与复用

桌面端与[示例](../src-tauri/crates/foc-drive/examples/pdo_velocity.rs)均调用独立 [`foc-drive`](../src-tauri/crates/foc-drive/src/lib.rs)，不依赖 React/Tauri。其他项目可将其作为 Cargo 路径依赖；用 `Link::open()` 打开 Hub，或用 `Node::attach(Arc<dyn CanBus>, node_id)` 注入自己的传输。

1. 独占 `Motor` 会话，读取身份与反馈。`Motor::start(mode, period_ms)` 检查无故障、已关桥、校准状态为 4；目标节点进入 Pre-operational、控制字 0，确认状态后才配置。
2. 读取需要的槽位及**实际** COB-ID，暂存既有映射、模式和压缩格式。速度用 RPDO1、位置 RPDO2、力矩 RPDO3、MIT RPDO4；压缩 MIT 额外借用 RPDO1 单独传控制字。TPDO4 周期 20 ms、30 B 有效，填充至 32 B FD+BRS。再定向 NMT Start，不广播。
3. 单一 Tokio 任务按 `next_tick()` 的绝对时刻调用 `tick()`（默认 10 ms，可选 5–20 ms）。发送中性目标，逐级确认 `状态字 & 0x006F`：控制字 `0 → 6 → 7 → 15`，应答 `0x40 → 0x21 → 0x23 → 0x27`，并核对实际模式。握手和续期都用 PDO，不回退到周期 SDO。≤8 B 使用经典 CAN；浮点 MIT 的 19 B 填充到 20 B FD+BRS。压缩包按实读量程编码，先发完整 8 B 再发独立控制字。
4. 仅在 `Phase::Running` 下调用 `set_target()`。位置目标必须先复位 bit4 并等 bit12 清，再置 bit4 等 bit12 置位；相对目标只触发一次。bit12 是接受，bit10 才表示到位。Halt 暂停时仍已使能且持续续期，恢复会执行当前目标。Quick stop 按固件斜率减速，随后关桥，不自动重新使能。
5. 正常退出、取消和错误路径均显式 `release().await`。驱动移除临时映射、恢复进入前的模式与格式，不自动写 Flash；若无法确认关桥或恢复，保留未确认状态，重试「立即关桥」。只有已物理断开功率电源才强制释放。不要以丢弃 Rust 对象替代异步清理。

```powershell
# 仓库根目录。仅运行内存总线测试，不打开 USB。
cargo test --locked --manifest-path src-tauri/Cargo.toml -p foc-drive
# 查看供其他主站参考的例程用法；不带参数不会访问设备。
cargo run --locked --manifest-path src-tauri/Cargo.toml -p foc-drive --example pdo_velocity
```

**仅在实机联调时运行**（先释放桌面端占用）：

```powershell
cargo run --locked --manifest-path src-tauri/Cargo.toml -p foc-drive --example inspect -- --listen
cargo run --locked --manifest-path src-tauri/Cargo.toml -p foc-drive --example inspect -- 1
# 以下会使能并转动：节点 1，0.1 rev/s 约 1 秒，然后快停并确认关桥。
cargo run --locked --manifest-path src-tauri/Cargo.toml -p foc-drive --example pdo_velocity -- --enable 1 0.1
```

**安全边界：** 主站周期延迟达 100 ms、TPDO 中断达 200 ms、握手超时或反馈故障时会尝试关桥。桌面界面连续 3 s 不续租也会触发清理。CAN 线断开、进程被强杀或控制器 bus-off 时，主站无法保证关桥命令送达；固件可能保持最后目标。软件按钮和通讯看门狗都不是物理急停。
