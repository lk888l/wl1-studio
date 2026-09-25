# 运动参数范围与参考版本

核对日期：2026-09-06（Asia/Shanghai）。上位机的滑块范围、步长和 TypeScript / Rust 命令边界校验按用户提供的 VOFA 配置同步。

## 来源

参考仓库：`D:\kk\Robot_Project\wheeled-legged_Robot\WL1\SoftWare\wheeled-legged_Robot-WL1`。

- `vofa_host_tools_cfg/vofa_tab.json`：控件 `from`、`to`、`step_size`；通过 `cmd_menu.ctx` 下标关联命令。
- `vofa_host_tools_cfg/vofa.cmds.json`：命令名称与十六进制编码的命令模板。
- 两个配置文件的文件修改时间：2026-07-26 22:45:53（Asia/Shanghai）；最后相关提交为 `00266569c6ac870ecc2569679b12c582600edfb1`（2026-07-26 16:03:32 +08:00）。
- 核对时仓库 HEAD 为 `43d35a30ce69484af1e455d2df69d15929f3adbc`，小车与遥控固件均有未提交修改；小车 `Component/UserApp/main.cpp` 修改时间为 2026-09-06 18:02:00 +08:00。下文固件语义描述以这份工作树源码为准。

## 同步的范围

| VOFA 控件 | 上位机参数 | 最小值 | 最大值 | 滑块步长 |
| --- | --- | ---: | ---: | ---: |
| Angle_KP | 姿态 P | 0 | 150 | 0.1 |
| Angle_KI | 姿态 I | 0 | 1 | 0.1 |
| Angle_KD | 姿态 D | -107 | 100 | 0.1 |
| Velocity_KP | 速度 P | 0 | 10 | 0.01 |
| Velocity_KI | 速度 I | 0 | 100 | 0.001 |
| Velocity_KD | 速度 D | 0 | 100 | 0.01 |
| Differ_KP | 差速 P | -50 | 50 | 0.1 |
| Differ_KI | 差速 I | 0 | 1 | 0.001 |
| Differ_KD | 差速 D | 0 | 100 | 0.1 |
| Roll_KP | 横滚 P | -100 | 100 | 0.1 |
| Roll_KI | 横滚 I | -10 | 10 | 0.1 |
| Angle_bias | 机身重心 / 俯仰基准（°） | -20 | 20 | 0.1 |
| Legheight | 共同腿高（mm） | 44.5 | 78.5 | 0.1 |
| target_Roll | 横滚目标（°） | -18 | 18 | 0.1 |
| VandD | 速度 / 转向目标 | -100 | 100 | 0.5 |

`Angle_KD` 的下限确实是配置中的 `-107`。另有一个范围 ±1000 的未绑定摇杆（`cmd_menu.ctx: []`），不作为运动命令的取值依据。轮半径没有 VOFA 在线控制项，保留现有本地档案范围。

VOFA 的 `target_value` 是保存配置时的控件位置，不能推定为固件默认值；因此本次不据此重置上位机已有默认值和用户档案。上述 PID 范围是调参入口的可输入边界，并非经过实机验证的稳定运行区间。

## 命令与版本差异

1. VOFA 的 `Roll_KI` 模板误写为 `rollpid -p`。上位机保持积分项的 `rollpid -i`。当前参考小车源码还存在 `rollpid -p` / `-i` 都赋值给 `Adapt_y_ki` 的情况；修改上位机范围不能修复该固件行为，不能把发送成功解释为比例项已生效。横滚没有 D 项。
2. 当前小车 `anglebias <value>` 设置 `Angle_bias_min`，表示最低腿高 44.5 mm 的俯仰基准。每个控制周期通过 `BalanceCompensation::pitchBias` 叠加腿高补偿；它不等同于冻结整个高度范围的实时偏置。当前源码的基准默认值为 9.5°，参考固件部分文档仍写 12.6°，两者不能混用。
3. 当前源码会按腿高重新计算 Angle Kp，没有实现 `anglepid auto` / `anglebias auto`。本工程早期文档所述“当前工作树手动覆盖 / auto 恢复”属于另一份固件快照，不能用于断言本次参考固件具备该能力。协议校验保留已有 `auto` 命令形式供对应旧版本使用；界面应说明版本依赖，仅表示请求已发送。
4. 当前遥控工作树的 `SerialCommandQueue.cpp` 接收 `nrfsend <payload>` 进行参数转发；裸 PID / `anglebias` 文本不进入转发分支。VOFA 命令也带有 `nrfsend` 前缀。上位机遥控模式现按此格式添加 `nrfsend ` 前缀与 LF 行尾；31 字节限制只计算无线正文，最外层 UART 帧最多 40 字节，处于参考固件 96 字节行缓冲内。直连小车继续发送不带前缀、无行尾的原始命令。串口写入成功仍不等于小车执行成功。

本次仅只读核对参考仓库。未连接实机、未发送设备指令、未修改或烧录参考固件。

## 2026-09-25 新增：自适应腿高角度中心

依据当前固件 `Component/UserApp/Tasks/CommandServiceTask.cpp`、`MotionParameters.hpp` 和 `MotionPersistence.cpp`，新增 `rollBias` / `rollbias <degrees>`。它不来自上表旧 VOFA 配置：默认 0°，上位机范围 −20° 至 +20°，步长 0.1°；固件解析仅约束为完整有限浮点数，未规定这个上下限。

计算关系为 `corrected_roll = raw_roll + roll_bias`；该参数独立于实时 `R.roll` / `target_roll`，不会被摇杆回中覆盖。裸 `rollbias` 为只读查询，数值形式需要写入权限。当前遥控桥接不转发本命令；串口和蓝牙直连可下发，随后通过现有 `save` 持久化，详见[参数保存指南](parameter-flash-save.md)。

## 回归验证

- `src/data/parameters.test.ts`：VOFA 范围与步长、生成命令的边界通过和越界拒绝、扩展范围的档案恢复、横滚积分命令。
- `src/lib/protocol.test.ts` 与 `src-tauri/src/protocol.rs`：前后端同样接受以上边界，继续检查参数格式、无线载荷长度、命令白名单及遥控腿高限制。
