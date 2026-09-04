# WL1 固件接入指南

本文面向上位机与 WL1 feature/framework 固件的联调。当前实现同时记录两个事实层：

- 固件仓库：[lk888l/wheeled-legged_Robot-WL1](https://github.com/lk888l/wheeled-legged_Robot-WL1)；联调使用独立本地 checkout，个人绝对路径不写入产品文档
- 已提交基线：<code>feature/framework@8f8eb82</code>
- 本地工作树快照：2026-08-24，仍有多项未提交修改；包含持续演进中的控制安全与协议扩展，不能仅用 commit 标识
- 命令文档：<code>car_firmware/docs/commands.md</code>
- 解析实现：<code>car_firmware/Component/AppModules/src/communication_module.cpp</code>

本文会分别标出 HEAD 与工作树的差异。上位机默认使用两者共有的保守子集，并兼容两种 IMU 行；其他 commit、工作树继续变化或固件分支接入时必须重新比对源码与实机行为。

> [!CAUTION]
> PID、组合运动目标和腿高会立即影响控制器行为。未完成台架验证前，只能在机器人可靠架空、物理急停可用、人员远离运动范围的条件下发送写命令。

## 已确认的传输约定

### USART1

| 项目 | 已确认值 |
|---|---|
| 引脚 | TX PA15 / RX PA10 |
| 波特率 | 115200 baud |
| 数据格式 | 8N1：8 数据位、无校验、1 停止位 |
| 流控 | 无 |
| 接收方式 | DMA receive-to-idle |
| 单次接收缓冲 | 128 字节 |
| 实际命令正文 | 最多取前 32 字节 |
| 命令分帧 | 源码实际使用 DMA receive-to-idle；当前解析器未去除 LF/CRLF |
| 命令大小写 | 区分大小写 |
| 参数分隔 | 一个或多个空格 |
| 命令队列 | 深度 4 |

固件文档写有“LF 或 CRLF 均可”，但当前 `LkUart` 会把 receive-to-idle 得到的全部字节原样交给 `TaskReactor`，最终数值 token 又要求完整解析。由此可推断，带 LF/CRLF 的 PID、`R`、`legheight` 等命令可能因尾随字符失败；两条快速写入也可能被合并成一个 DMA 帧。WL1 Studio 因此只接受并生成单个 ASCII 空格分隔的规范正文，每次发送一条**不带行结束符**的命令，`flush` 后保留 2 ms 空闲，并对批量参数使用 120 ms 间隔。这是依据源码采取的兼容措施，仍必须在 USB-UART 实机上验证；长期修复应在固件侧实现明确的 LF/CRLF 分帧与 trim。

### 32 字节正文限制

固件会把 USART1 收到的消息放入 <code>etl::string&lt;32&gt;</code>，超过 32 字节时只取前 32 字节。因此上位机必须在发送前拒绝超长正文，绝不能依赖固件截断：

~~~text
body_bytes = ASCII(command_body)
assert body_bytes.length <= 32
frame = body_bytes            # 当前主机利用 UART idle 分帧，不追加 LF/CRLF
~~~

这里的上限是**命令正文 32 字节**。如果未来固件正确实现 LF/CRLF 分帧，结束符也不应计入正文；当前主机则完全不发送结束符。仍应按字节而非 JavaScript 字符数判断。

其他约束：

- 只允许具体命令格式所需的 ASCII 字符；
- 禁止参数携带回车、换行、控制字符或额外命令分隔符；
- 数字使用小数点，不使用科学计数法，除非另一个固件基线明确验证；
- 拒绝 NaN、正负无穷和无法安全表示的数值；
- 超长命令只能报错，不能截断后继续发送；
- 当前固件没有通用成功应答，串口写入成功不能显示为“设备已确认”。

### nRF24L01+ 共享解析器

nRF payload 固定为 32 字节，有效 ASCII 文本后补 0x00，并与 USART1 共用同一命令解析器。它说明命令领域层可以复用，但不意味着 SerialTransport 应模拟无线帧。当前上位机先实现串口；未来无线适配器仍应遵循 Transport/Protocol 分层。

## 精确命令语义

### 组合运动命令 R

R **不是轮径参数**。它一次更新转向、速度、横滚和腿高四个目标，格式和字段顺序严格固定：

~~~text
R <turn> <velocity> <roll> <height>
~~~

| 字段 | 写入固件状态 | 单位/语义 |
|---|---|---|
| <code>turn</code> | <code>Differ_Target</code> | 左右轮目标 RPM 差 |
| <code>velocity</code> | <code>Velocity_Target</code> | 平均目标 RPM |
| <code>roll</code> | <code>Roll_Target</code> | 度 |
| <code>height</code> | <code>Target_height</code> | 毫米 |

当前工作树还允许在四个主字段后追加 `profile`（0/1/2）和跳跃 `flags`，并在固件内钳位四个主字段；HEAD 只定义四字段格式。首版上位机为了双版本兼容，始终只发送四字段 `R`，不开放 profile、flags、`pidlevel` 或跳跃命令。

固件文档给出的推荐遥控帧示例：

~~~text
R 0.0 -0.0 0.0 61.5
~~~

tele_firmware 会把摇杆速度取反后编码进第二个字段。上位机必须建立独立、经过实机验证的前进方向约定，不能盲目再复制一次取反，否则会改变前后方向。

R 是高风险、实时运动目标，不属于“保存参数方案”。界面采用按住发送、松开回中、连接丢失立即停止发送。当前工作树会在最后一帧有效 `R` 超过 250 ms 后把速度、转向和横滚归零；HEAD 没有这项保护，且应用无法通过握手识别二者，所以仍按“看门狗未知”处理，软件停止不能替代物理急停。

其他已实现的运动目标命令：

| 命令 | 语义 |
|---|---|
| <code>VandD &lt;difference&gt; &lt;velocity&gt;</code> | 更新左右轮速差和平均速度目标 |
| <code>target_roll &lt;degrees&gt;</code> | 更新横滚目标 |
| <code>legheight &lt;millimetres&gt;</code> | 更新共同腿高目标并打印运动学诊断 |
| <code>anglebias &lt;degrees&gt;</code> | 临时写入俯仰静态偏置 |

### 腿高 legheight

格式：

~~~text
legheight <millimetres>
~~~

舵机任务最终把目标限幅到 **44.5..78.5 mm**。上位机必须在发送前使用同样的闭区间，不应依靠固件事后限幅。

固件会打印：

~~~text
Servo angel: <angle> <x> <bias>
~~~

HEAD 基线在限幅前计算这组诊断；当前工作树先把输入钳位到 44.5..78.5 mm 再计算。两者都保留固件现有拼写 `angel`，且诊断输出都不是腿高写入回读或 ACK。

### PID

三组常规 PID 的命令格式完全一致：

~~~text
anglepid -p <value>
anglepid -i <value>
anglepid -d <value>

velocitypid -p <value>
velocitypid -i <value>
velocitypid -d <value>

differpid -p <value>
differpid -i <value>
differpid -d <value>
~~~

当前默认值：

| 命令 | 控制环 | 默认 Kp / Ki / Kd |
|---|---|---|
| <code>anglepid</code> | 俯仰姿态到共同 PWM | <code>70 / 0 / 60</code> |
| <code>velocitypid</code> | 平均轮速到俯仰目标 | <code>0.05 / 0.008 / 0</code> |
| <code>differpid</code> | 左右轮速差到差速 PWM | <code>2 / 0.001 / 0</code> |

横滚环只实现 P 和 I：

~~~text
rollpid -p <value>
rollpid -i <value>
~~~

rollpid -d 不受支持，不能由通用 PID 表单生成。

HEAD 基线没有声明这些 PID 的安全上下限；当前本地工作树会在写入时钳位。为了避免 Legacy 无 ACK 时“主机请求值”和“固件实际值”静默分叉，Studio 采用工作树硬限幅以内的更小交集：

| 参数 | 工作树硬限幅 | Studio 允许范围 |
|---|---:|---:|
| Angle P / I / D | 40..120 / 0..1 / 30..100 | 45..95 / 0..1 / 30..100 |
| Velocity P / I / D | 0..0.15 / 0..0.03 / 0..0.10 | 0..0.15 / 0..0.03 / 0..0.05 |
| Differ P / I / D | 0..5 / 0..0.01 / 0..1 | 0..5 / 0..0.01 / 0..0.2 |
| Roll P / I | -1..1 / -1..0 | -1..1 / -1..0 |
| anglebias | 5..20° | 5..20° |

这些只是当前源码的硬限制与上位机兼容范围，**不是经过实机认证的安全范围**。首次实机写入仍必须由硬件配置、机构状态和台架记录给出更窄的已验证区间。

当前工作树在跳跃已武装或处于动作阶段时会拒绝 PID、腿高和 anglebias 调整，并只输出诊断文本。Studio 首版不开放跳跃入口，也无法通过 ACK 确认这类拒绝；看到 `tuning: rejected while jump is armed/active` 时应停止写入并检查固件状态。

### Angle Kp / anglebias 的双版本语义

HEAD `8f8eb82` 会在 MotionControl 中按腿高周期重算 Angle Kp 与 anglebias，因此数值写入只短暂生效。当前本地工作树新增手动覆盖状态：

~~~text
anglepid -p <value>   # 启用手动 Kp 覆盖
anglepid auto         # 恢复按腿高自动计算
anglebias <degrees>   # 启用手动偏置覆盖
anglebias auto        # 恢复按腿高自动计算
~~~

HEAD 会忽略两条 `auto` 形式；当前工作树会把数值覆盖保持到重启或 `auto` 请求。由于没有版本握手或读回，上位机把这两项标记为“版本相关”，只显示“请求已发送”，并同时提供恢复自动计算的入口。

Angle Ki、Angle Kd、速度 PID、差速 PID，以及 Roll Kp/Ki 会持续到 MCU 下次复位，但仍然只存在 RAM。

## 遥测与诊断

### IMU

~~~text
showimu -y
showimu -n
~~~

- <code>-y</code> 开启连续输出，约 **100 Hz**；
- <code>-n</code> 停止输出；
- HEAD 每行是三个定宽浮点数构成的 CSV：Roll,Pitch,Yaw，格式为 <code>{:07.3f},{:07.3f},{:07.3f}\n</code>；
- 当前工作树格式为 <code>Roll,Pitch,Yaw,a=&lt;|a|g&gt;,ok=&lt;0|1&gt;</code>，其中 `a` 是合加速度（g），`ok` 表示加速度是否被姿态融合信任；
- 上位机严格兼容三字段和上述五字段两种格式，其他后缀仍作为诊断文本；
- 字段顺序固定为 Roll、Pitch、Yaw。

该输出在 10 ms 控制环内格式化并提交 UART 日志。长时间开启会增加中断延迟与 UART 丢帧风险，只适合短时诊断。WL1 Studio 的遥测开关是会话级状态，切换页面后仍保持开启，必须在诊断页手动关闭；串口会话关闭时应用无条件尽力发送 <code>showimu -n</code> 与 <code>showrpm -n</code>，以覆盖部分写入和连接前遗留状态，但不能把停流成功当作已确认。

### 轮速

~~~text
showrpm -y
showrpm -n
~~~

- <code>-y</code> 开启连续输出，约 **20 Hz**；
- <code>-n</code> 停止输出；
- 每行格式为 <code>A: {:07.3f}\tB: {:07.3f}\n</code>；
- 当前实现中 A 对应 left_rpm，B 对应 right_rpm。

解析器应严格识别 A、空白与 B 字段，并保留原始值和本机单调时间戳。

### 输出交错

IMU 和 RPM 可以同时开启，启动日志、Servo angel 诊断和其他文本也可能混入。串口是字节流，解析器必须处理：

- 一行被拆成多次读取；
- 多行一次到达；
- IMU CSV 与 A/B RPM 行交错；
- MPU success/fail、Servo angel 等诊断行；
- 空行、部分行、乱码和超长行；
- 采样速度高于 UI 消费速度。

高频样本进入有界环形缓冲，UI 使用限频快照绘图。慢页面不得反压串口读取任务；溢出时丢弃旧样本并增加可见计数。

## 应答与错误语义

当前命令解析器不提供统一 ACK/NACK：

- PID、R、VandD、target_roll、anglebias 和 show 开关通常不回成功应答；
- legheight 会输出运动学诊断，但不是写入后回读；
- 未知命令不会返回 Unknown command，而是回显 <code>receive: &lt;original text&gt;</code>；
- 参数格式错误时，多数 handler 直接返回，未必有错误文本；
- 命令队列满时消息可能直接丢失。

所以 UI 必须区分：

1. **已提交到操作系统串口**；
2. **观察到固件相关输出**；
3. **设备明确确认**；
4. **回读一致**。

当前基线大多数写命令最多只能达到第 1 级，不能显示“设置成功”。未来固件应增加请求序号、稳定错误码、明确 ACK 和参数回读。

## RAM 参数

当前参数只存在 RAM。确认后的持久修改需要改动固件 <code>Component/AppModules/src/runtime.hpp</code> 默认初始化值，重新构建并烧录。

上位机必须遵守：

- MCU 重启、看门狗复位或断电后将设备参数状态重置为未知；
- “应用到本次运行”与“保存为上位机方案”使用不同按钮和文案；
- 默认禁止重连后自动套用本地方案；
- 本地方案匹配设备身份并由用户确认后才能逐项发送；
- 不把本地保存描述成“写入机器人”；
- 如果未来支持 Flash/EEPROM，新增独立 capability 和显式操作，不能改变现有按钮语义。

R、VandD 和 target_roll 是实时目标，不是可持久化参数。

## Legacy 连接状态机

当前固件没有稳定的版本/能力查询命令。推荐流程：

~~~text
列出端口
  → 用户选择 Legacy WL1（HEAD/本地工作树兼容）配置
  → 用户明确确认目标设备确实属于已复核的双基线协议
  → 以 115200 8N1、无流控打开
  → 默认只读，不自动发未知探测命令
  → 用户按需成组开启 IMU + RPM 遥测
  → 协议确认与三项安全台架条件全部满足后解锁写操作
~~~

未知命令会被回显，但不能因此把随意探测视为安全。当前应用无法自动验证设备身份；兼容性确认默认未选，未明确确认时只能只读连接。连接、重连和切换设备时不得自动发送 R 或调参命令。

任何拔线、读取错误、解析连续失败、超时或固件重启迹象都应：

1. 立即停止新的写请求和周期 R 发送；
2. 取消等待中的操作并把结果标为未知；
3. 清除参数“已确认”状态；
4. 关闭端口和后台读取任务；
5. 重新选择兼容配置后才能再次写入。

每个连接还必须分配不可复用的 `sessionId`。写请求、遥测、日志和掉线事件都要核对该令牌；旧串口线程排队中的迟到事件不得污染或关闭后来建立的新连接。

当前实现对已请求开启的遥测采用两级健康保护：React 端任一 IMU/RPM 通道超过 600 ms 未更新就撤销实时控制武装并请求中立目标；Rust 端任一通道超过 2 s 未更新、连续 64 行无法解析，或超过 4096 字节仍无换行时，都会锁定会话并触发断开清理。未请求遥测时不会用“无遥测”判断连接故障。Rust 读/写故障路径共享受互斥保护的 writer 和最后一次尝试腿高，会先阻止排队写入，再直接尽力发送中立 `R` 与两条停流命令，并由带 `sessionId` 的独立清理线程关闭会话；这条安全路径不依赖 WebView 收到事件。所有结果仍无设备 ACK，物理断电仍是最终保障。

## 版本与能力协议预留

为了让未来固件不再依赖用户手选 Legacy 配置，建议新增无副作用的身份/能力查询，至少返回：

~~~text
protocol major / minor
product id
hardware revision
firmware version or build id
capabilities
parameter units and verified limits
settings persistence: ram / nonvolatile
maximum command body size
~~~

建议能力名称：

- <code>telemetry.imu</code>
- <code>telemetry.rpm</code>
- <code>tuning.angle-pid</code>
- <code>tuning.velocity-pid</code>
- <code>tuning.differential-pid</code>
- <code>tuning.roll-pi</code>
- <code>geometry.leg-height</code>
- <code>motion.composite-target</code>
- <code>settings.readback</code>
- <code>settings.nonvolatile</code>

版本规则：

- major 不同默认只读；
- minor 只能增加兼容字段或能力；
- 未知字段忽略，未知能力不自动启用；
- 能力同时声明单位、上下限、是否可回读和持久化方式；
- 每个写请求返回序号、成功/失败和稳定错误码；
- 身份查询永不驱动电机或修改控制状态。

这些是未来协议提案，不能把提案命令发送给 8f8eb82 基线或未识别的本地工作树固件。

## Mock、Serial 与未来传输

### MockTransport

Mock 场景应精确模拟基线协议：

- HEAD 三字段与工作树五字段 IMU、RPM 20 Hz A/B 格式；
- 两种流独立启停并可交错；
- R 的四字段顺序；
- legheight 44.5..78.5 mm 前端限幅；
- PID 命令族以及 roll 无 D；
- Angle Kp/anglebias 的 HEAD 周期覆写与工作树手动 override/auto 双语义；
- 参数复位丢失、无 ACK、队列丢命令、半包和拔线。

### SerialTransport

SerialTransport 只负责端口生命周期和字节收发；当前通过无结束符的独立 write/flush 与 2 ms idle 间隔适配固件源码，LegacyProtocol 负责正文和命令解析。待固件正确实现 LF/CRLF 分帧后，应增加显式 framing capability，而不是静默改变。页面不得绕过统一设备网关。

### CAN / UDP

CAN 与 UDP 当前只有架构预留，没有已确认帧协议：

- CAN 适配器未来负责节点身份、仲裁 ID、分帧和总线状态；
- UDP 适配器未来负责端点身份、乱序、丢包、重复和超时；
- 两者复用领域 DTO 和 capability，不必模拟串口行协议；
- 协议和安全策略未确定前不得实现猜测性发送。

## 实机验收清单

- [ ] 固件确认为 HEAD `8f8eb82`、2026-08-24 本地工作树，或已完成等价源码复核；
- [ ] 115200 8N1、无流控；验证无结束符 receive-to-idle 分帧，并单独记录 LF/CRLF 的真实行为；
- [ ] 32 字节正文正常，33 字节及以上在上位机侧被拒绝且没有发送；
- [ ] showimu -y/-n 能以约 100 Hz 开启/停止，三字段与 `a/ok` 五字段都能正确解析；
- [ ] showrpm -y/-n 能以约 20 Hz 开启/停止 A/B RPM；
- [ ] 四组 PID 的支持项与默认值符合基线，roll 不生成 -d；
- [ ] HEAD 的周期覆写与工作树的 override/auto 都在 UI 中明确展示并实测；
- [ ] legheight 只允许 44.5..78.5 mm，诊断输出不冒充回读；
- [ ] R 按 turn、velocity、roll、height 顺序发送，并已验证速度符号；
- [ ] 无 ACK、未知命令回显和队列丢弃不会被误判为成功；
- [ ] 复位后 RAM 参数状态回到未知，不会自动重发；
- [ ] 拔线、超时和解析故障会停止周期目标发送；
- [ ] 工作树 250 ms R 超时归零已实测；HEAD/未知固件仍按无看门狗处理；
- [ ] 机器人架空、物理急停和已确认的固件保护条件下完成安全测试。

实机动作前还必须阅读[安全指南](safety.md)。
