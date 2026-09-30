//! ST-Link and CMSIS-DAP SWD/JTAG service. Jobs own USB/TCP on a blocking worker and
//! reserve the product lifecycle before attaching. No probe-rs CLI is spawned.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use probe_rs::architecture::arm::{sequences::DefaultArmSequence, FullyQualifiedApAddress};
use probe_rs::flashing::{self, DownloadOptions, FlashProgress, ProgressEvent, ProgressOperation};
use probe_rs::probe::{
    cmsisdap::CmsisDapFactory,
    list::{Accessibility, ProbeListItem},
    stlink::StLinkFactory,
    DebugProbeInfo, Probe, ProbeFactory, WireProtocol,
};
use probe_rs::{MemoryInterface, Permissions, Session};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::ProductSessionLifecycle;
use crate::firmware_image::{
    prepare_image, sha256, validate_detected_capacity, Chip, ImageRequest, ImageSummary,
    PreparedImage, TargetSelection, FLASH_START,
};
use crate::firmware_target::{self, ResolvedTarget};
use crate::sticks3_network::NetworkDevice;

#[derive(Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareStatus {
    pub busy: bool,
    pub stage: String,
    pub message: String,
    pub completed: u64,
    pub total: Option<u64>,
}

#[derive(Clone, Default)]
pub struct FirmwareState(Arc<Mutex<FirmwareStatus>>);

impl FirmwareState {
    pub fn snapshot(&self) -> FirmwareStatus {
        self.0
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    }

    pub fn ensure_idle(&self) -> Result<(), String> {
        if self.snapshot().busy {
            Err("固件操作正在进行，请等待完成后连接设备或切换产品".into())
        } else {
            Ok(())
        }
    }

    pub fn begin(&self) -> Result<JobGuard, String> {
        let mut status = self.0.lock().map_err(|_| "固件任务状态已损坏")?;
        if status.busy {
            return Err("已有固件操作正在进行".into());
        }
        *status = FirmwareStatus {
            busy: true,
            stage: "connecting".into(),
            message: "正在连接烧录器 / 调试端口…".into(),
            completed: 0,
            total: None,
        };
        Ok(JobGuard(self.clone()))
    }

    pub fn progress(&self, stage: &str, message: &str, completed: u64, total: Option<u64>) {
        let mut status = self.0.lock().unwrap_or_else(|error| error.into_inner());
        status.stage = stage.into();
        status.message = message.into();
        status.completed = completed;
        status.total = total;
    }
}

pub struct JobGuard(FirmwareState);

impl Drop for JobGuard {
    fn drop(&mut self) {
        let mut status = self.0 .0.lock().unwrap_or_else(|error| error.into_inner());
        status.busy = false;
        if status.stage != "complete" && status.stage != "error" {
            status.stage = "error".into();
            status.message = "任务意外中断；请检查设备并重新读取确认状态".into();
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeOption {
    id: String,
    name: String,
    serial_number: Option<String>,
    accessible: bool,
}

fn probe_id(info: &DebugProbeInfo) -> String {
    format!(
        "{:04x}:{:04x}:{}",
        info.vendor_id,
        info.product_id,
        info.serial_number.as_deref().unwrap_or("")
    )
}

fn list_probes() -> Vec<ProbeListItem> {
    StLinkFactory
        .list_probes()
        .into_iter()
        .chain(CmsisDapFactory.list_probes())
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeConfig {
    pub probe_id: String,
    pub chip: TargetSelection,
    pub speed_khz: u32,
    pub connect_under_reset: bool,
    #[serde(default)]
    pub expected_target: Option<TargetIdentity>,
    #[serde(default)]
    pub network: Option<NetworkDevice>,
    #[serde(default)]
    pub protocol: DebugProtocol,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum DebugProtocol {
    #[default]
    Swd,
    Jtag,
}

impl DebugProtocol {
    fn wire(self) -> WireProtocol {
        match self {
            Self::Swd => WireProtocol::Swd,
            Self::Jtag => WireProtocol::Jtag,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TargetIdentity {
    pub device_id: u32,
    pub flash_size: usize,
    pub uid: String,
}

impl ProbeConfig {
    fn validate(&self) -> Result<(), String> {
        if self.probe_id.is_empty() || self.probe_id.len() > 256 {
            return Err("请刷新并选择 ST-Link 或 CMSIS-DAP 烧录器".into());
        }
        if ![100, 250, 400, 1000, 1800, 4000].contains(&self.speed_khz) {
            return Err("调试频率不在支持的范围内".into());
        }
        if let Some(network) = &self.network {
            network.validate()?;
            if self.probe_id != network.probe_id() || self.chip != TargetSelection::AUTO {
                return Err("无线探针与所选设备不匹配，请重新选择 StickS3".into());
            }
        } else if self.probe_id.starts_with("tcp:") {
            return Err("无线探针缺少已核验的设备地址和序列号".into());
        }
        if self.protocol == DebugProtocol::Jtag
            && self.network.is_none()
            && !self.probe_id.starts_with("303a:4004:")
        {
            return Err("此工作台的 JTAG 操作仅支持 StickS3".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChipInfo {
    pub name: String,
    pub target: String,
    pub device_id: u32,
    pub revision_id: u32,
    pub flash_start: u64,
    pub flash_size: usize,
    pub uid: String,
    pub speed_khz: u32,
    pub probe_id: String,
    pub protocol: DebugProtocol,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FirmwareReport {
    pub chip: ChipInfo,
    pub message: String,
    pub bytes: usize,
    pub sha256: Option<String>,
    pub data: Option<Vec<u8>>,
}

fn detailed_error(context: &str, error: impl std::error::Error) -> String {
    let mut message = format!("{context}: {error}");
    let mut source = error.source();
    while let Some(cause) = source {
        message.push_str(&format!("；{cause}"));
        source = cause.source();
    }
    message
}

fn check_identity(device_id: u32, size_kib: u16, chip: Chip) -> Result<(), String> {
    if device_id & 0xfff != chip.device_id() {
        return Err(format!(
            "实测芯片 ID 为 {:#05X}，与 {} 的器件系列 ID（{:#05X}）不符，操作已拒绝",
            device_id & 0xfff,
            chip.name(),
            chip.device_id()
        ));
    }
    if usize::from(size_kib) * 1024 != chip.size() {
        return Err(format!(
            "芯片实测 Flash 为 {size_kib} KiB，与所选目标 {} 的 {} KiB 不一致；请检查所连接的设备",
            chip.name(),
            chip.size() / 1024
        ));
    }
    Ok(())
}

fn discover_target(mut probe: Probe, under_reset: bool) -> Result<(Probe, ResolvedTarget), String> {
    // Read the identification registers before selecting a package or capacity.
    // No Flash loader, erase or unlock operation runs during this phase.
    let attached = if under_reset {
        probe.attach_to_unspecified_under_reset()
    } else {
        probe.attach_to_unspecified()
    };
    if let Err(error) = attached {
        if under_reset {
            let _ = probe.target_reset_deassert();
        }
        return Err(detailed_error("无法初始化目标自动识别", error));
    }
    let mut interface = probe
        .try_into_arm_debug_interface(DefaultArmSequence::create())
        .map_err(|(mut probe, error)| {
            if under_reset {
                let _ = probe.target_reset_deassert();
            }
            detailed_error(
                "无法连接 ARM 调试接口，请检查目标供电和所选 SWD/JTAG 接线",
                error,
            )
        })?;
    let detected = (|| {
        let mut memory = interface
            .memory_interface(&FullyQualifiedApAddress::v1_with_default_dp(0))
            .map_err(|error| detailed_error("无法访问芯片识别寄存器", error))?;
        let id = memory
            .read_word_32(0xe004_2000)
            .map_err(|error| detailed_error("无法读取芯片器件 ID", error))?;
        let address = firmware_target::size_register(id)?;
        let mut size = [0; 2];
        memory
            .read_8(address, &mut size)
            .map_err(|error| detailed_error("无法读取芯片实际 Flash 容量", error))?;
        firmware_target::resolve(id, u16::from_le_bytes(size))
    })();
    let mut probe = interface.close();
    // Always release reset, including failed identification. The normal session
    // attach below performs its own target-specific under-reset sequence.
    if under_reset {
        probe
            .target_reset_deassert()
            .map_err(|error| detailed_error("自动识别后释放复位失败", error))?;
    }
    probe
        .detach()
        .map_err(|error| detailed_error("结束自动识别连接失败", error))?;
    Ok((probe, detected?))
}

fn attach(config: &ProbeConfig) -> Result<(Session, ChipInfo), String> {
    config.validate()?;
    // Re-enumerate by identity, not list index. Duplicate clone serial numbers
    // are ambiguous and must never silently choose an arbitrary target.
    let mut probe = if let Some(network) = &config.network {
        crate::sticks3_network::open_probe(network)?
    } else {
        let matches: Vec<_> = list_probes()
            .into_iter()
            .filter(|item| probe_id(&item.info) == config.probe_id)
            .collect();
        if matches.len() != 1 {
            return Err("所选烧录器已拔出或存在重复序列号；请只连接一个匹配探针后刷新。StickS3 需要保持 USB DAP 开启".into());
        }
        matches[0].info.open().map_err(|error| {
            format!(
            "{}。请检查 USB 权限，并关闭占用探针的 OpenOCD / IDE；StickS3 使用 CMSIS-DAP / WinUSB",
            detailed_error("无法打开烧录器", error)
        )
        })?
    };
    probe
        .select_protocol(config.protocol.wire())
        .map_err(|error| detailed_error("探针无法使用所选 SWD/JTAG 协议", error))?;
    let speed_khz = probe
        .set_speed(config.speed_khz)
        .map_err(|error| detailed_error("无法设置调试频率", error))?;
    let (probe, resolved) = if let Some(chip) = config.chip.fixed() {
        (probe, ResolvedTarget::fixed(chip))
    } else {
        discover_target(probe, config.connect_under_reset)?
    };
    // Default permissions deliberately prohibit automatic RDP unlock/mass erase.
    let mut session = if config.connect_under_reset {
        probe.attach_under_reset(resolved.target, Permissions::default())
    } else {
        probe.attach(resolved.target, Permissions::default())
    }.map_err(|error| format!("{}。检查目标供电与所选 SWD/JTAG 接线；可降低频率或连接 NRST 后启用复位连接。读保护不会自动解除", detailed_error("无法连接芯片", error)))?;
    let mut core = session
        .core(0)
        .map_err(|error| detailed_error("无法访问核心", error))?;
    let id = core
        .read_word_32(0xe004_2000)
        .map_err(|error| detailed_error("无法读取芯片 ID", error))?;
    let mut size = [0; 2];
    core.read_8(resolved.size_register, &mut size)
        .map_err(|error| detailed_error("无法读取 Flash 容量", error))?;
    let flash_size = usize::from(u16::from_le_bytes(size)) * 1024;
    if let Some(chip) = config.chip.fixed() {
        check_identity(id, u16::from_le_bytes(size), chip)?;
    } else if id & 0xfff != resolved.device_id || flash_size != resolved.flash_size {
        return Err("连接期间芯片信息发生变化，请重新连接并识别".into());
    }
    let mut uid = [0; 12];
    core.read_8(resolved.uid_register, &mut uid)
        .map_err(|error| detailed_error("无法读取芯片 UID", error))?;
    let info = ChipInfo {
        name: resolved.name.into(),
        target: resolved.target.into(),
        device_id: id & 0xfff,
        revision_id: id >> 16,
        flash_start: FLASH_START,
        flash_size,
        uid: uid.iter().map(|byte| format!("{byte:02X}")).collect(),
        speed_khz,
        probe_id: config.probe_id.clone(),
        protocol: config.protocol,
    };
    drop(core);
    Ok((session, info))
}

fn check_confirmed_target(
    expected: Option<&TargetIdentity>,
    actual: &ChipInfo,
) -> Result<(), String> {
    let expected = expected.ok_or("请先连接并识别目标芯片，再确认烧录或擦除")?;
    if expected.device_id != actual.device_id
        || expected.flash_size != actual.flash_size
        || expected.uid != actual.uid
    {
        return Err("目标芯片或容量已改变；请重新连接并识别，然后确认本次操作".into());
    }
    Ok(())
}

pub(crate) fn reserve(app: &AppHandle) -> Result<JobGuard, String> {
    let lifecycle = app.state::<ProductSessionLifecycle>();
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    app.state::<crate::sticks3_network::StickS3NetworkState>()
        .ensure_idle()?;
    if app.state::<crate::state::AppState>().snapshot()?.mode != "disconnected"
        || app.state::<crate::gamebox::GameBoxState>().snapshot()?.mode
            != crate::gamebox::GameBoxMode::Disconnected
        || app.state::<crate::nfc::NfcState>().snapshot()?.mode != crate::nfc::NfcMode::Disconnected
        || app
            .state::<crate::sticks3::StickS3State>()
            .snapshot()?
            .connected
    {
        return Err("请先断开设备串口/演示/Mock 会话，再操作目标固件".into());
    }
    app.state::<FirmwareState>().begin()
}

fn operation_index(operation: ProgressOperation) -> (usize, &'static str, &'static str) {
    match operation {
        ProgressOperation::Fill => (0, "preserving", "正在备份受影响扇区中的未覆盖数据"),
        ProgressOperation::Erase => (1, "erasing", "正在擦除固件涉及的扇区"),
        ProgressOperation::Program => (2, "programming", "正在写入固件"),
        ProgressOperation::Verify => (3, "verifying", "正在回读校验固件"),
    }
}

fn flash_progress(state: &FirmwareState) -> FlashProgress<'_> {
    let mut totals = [None; 4];
    let mut completed = [0_u64; 4];
    FlashProgress::new(move |event| match event {
        ProgressEvent::AddProgressBar { operation, total } => {
            totals[operation_index(operation).0] = total
        }
        ProgressEvent::Started(operation) => {
            let (index, stage, message) = operation_index(operation);
            completed[index] = 0;
            state.progress(stage, message, 0, totals[index]);
        }
        ProgressEvent::Progress {
            operation, size, ..
        } => {
            let (index, stage, message) = operation_index(operation);
            completed[index] += size;
            state.progress(stage, message, completed[index], totals[index]);
        }
        _ => {}
    })
}

fn read_flash(
    session: &mut Session,
    size: usize,
    state: &FirmwareState,
    blank_check: bool,
) -> Result<Vec<u8>, String> {
    let mut core = session
        .core(0)
        .map_err(|error| detailed_error("无法访问核心", error))?;
    core.halt(Duration::from_secs(2))
        .map_err(|error| detailed_error("无法暂停核心", error))?;
    let mut data = vec![0; size];
    for (index, chunk) in data.chunks_mut(4096).enumerate() {
        let offset = index * 4096;
        core.read_8(FLASH_START + offset as u64, chunk)
            .map_err(|error| {
                detailed_error(
                    &format!(
                        "读取 {:#010X} 失败（可能受读保护）",
                        FLASH_START + offset as u64
                    ),
                    error,
                )
            })?;
        if blank_check && chunk.iter().any(|byte| *byte != 0xff) {
            return Err(format!(
                "擦除校验失败：{:#010X} 附近仍有非 FF 数据",
                FLASH_START + offset as u64
            ));
        }
        state.progress(
            if blank_check {
                "blank-check"
            } else {
                "reading"
            },
            if blank_check {
                "正在逐字节检查整片 Flash 是否为空"
            } else {
                "正在读取完整主 Flash"
            },
            (offset + chunk.len()) as u64,
            Some(size as u64),
        );
    }
    Ok(data)
}

fn while_halted<T>(
    session: &mut Session,
    work: impl FnOnce(&mut Session) -> Result<T, String>,
) -> Result<T, String> {
    let was_halted = session
        .core(0)
        .and_then(|mut core| core.core_halted())
        .map_err(|error| detailed_error("无法读取核心状态", error))?;
    session
        .core(0)
        .and_then(|mut core| core.halt(Duration::from_secs(2)))
        .map_err(|error| detailed_error("无法暂停核心", error))?;
    let result = work(session);
    let restore = if was_halted {
        Ok(())
    } else {
        session
            .core(0)
            .and_then(|mut core| core.run())
            .map_err(|error| detailed_error("读取结束，但恢复运行失败", error))
    };
    match (result, restore) {
        (Err(error), Err(restore)) => Err(format!("{error}；{restore}")),
        (Err(error), _) | (_, Err(error)) => Err(error),
        (Ok(value), Ok(())) => Ok(value),
    }
}

fn verify_image(
    session: &mut Session,
    image: &PreparedImage,
    state: &FirmwareState,
) -> Result<(), String> {
    while_halted(session, |session| {
        let mut core = session
            .core(0)
            .map_err(|error| detailed_error("无法访问核心", error))?;
        let mut completed = 0;
        for (address, data) in &image.chunks {
            for (index, expected) in data.chunks(4096).enumerate() {
                let address = address + (index * 4096) as u64;
                let mut actual = vec![0; expected.len()];
                core.read_8(address, &mut actual)
                    .map_err(|error| detailed_error("回读校验失败", error))?;
                if let Some(offset) = actual.iter().zip(expected).position(|(a, b)| a != b) {
                    return Err(format!(
                        "校验不一致：地址 {:#010X}，文件 {:02X}，芯片 {:02X}",
                        address + offset as u64,
                        expected[offset],
                        actual[offset]
                    ));
                }
                completed += expected.len() as u64;
                state.progress(
                    "verifying",
                    "正在逐字节比较文件与 Flash",
                    completed,
                    Some(image.summary.programmed_size as u64),
                );
            }
        }
        Ok(())
    })
}

enum Operation {
    Identify,
    Read,
    Erase,
    Flash(PreparedImage),
    Verify(PreparedImage),
    Reset,
}

async fn execute(
    app: AppHandle,
    config: ProbeConfig,
    operation: Operation,
) -> Result<FirmwareReport, String> {
    config.validate()?;
    // Reserve synchronously before queueing the worker; connections also check
    // this state while holding the same lifecycle lock.
    let guard = reserve(&app)?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = guard;
        let state = app.state::<FirmwareState>();
        execute_job(&config, operation, &state)
    })
    .await
    .map_err(|error| format!("固件后台任务中断: {error}"))?
}

fn execute_job(
    config: &ProbeConfig,
    operation: Operation,
    state: &FirmwareState,
) -> Result<FirmwareReport, String> {
    let result = (|| {
        let (mut session, chip) = attach(config)?;
        if config.chip == TargetSelection::AUTO
            && matches!(operation, Operation::Erase | Operation::Flash(_))
        {
            check_confirmed_target(config.expected_target.as_ref(), &chip)?;
        }
        if let Operation::Flash(image) | Operation::Verify(image) = &operation {
            validate_detected_capacity(image, chip.flash_size)?;
        }
        let flash_size = chip.flash_size;
        let mut report = FirmwareReport {
            chip,
            message: String::new(),
            bytes: 0,
            sha256: None,
            data: None,
        };
        match operation {
            Operation::Identify => {
                report.message =
                    "芯片连接成功，已读取器件 ID、实际 Flash 容量与 UID；探针连接已释放".into();
            }
            Operation::Read => {
                let data = while_halted(&mut session, |session| {
                    read_flash(session, flash_size, state, false)
                })?;
                report.bytes = data.len();
                report.sha256 = Some(sha256(&data));
                report.data = Some(data);
                report.message =
                    "完整主 Flash 已读取，可查看或导出 BIN 备份；核心运行状态已恢复".into();
            }
            Operation::Erase => {
                state.progress("erasing", "正在擦除整片主 Flash，请勿断电或拔线", 0, None);
                // erase_all also walks OTP in the built-in F411 target. Use
                // the explicitly bounded main-Flash range instead.
                flashing::erase(
                    &mut session,
                    &mut FlashProgress::empty(),
                    FLASH_START,
                    FLASH_START + flash_size as u64,
                    false,
                )
                .map_err(|error| detailed_error("主 Flash 擦除失败", error))?;
                read_flash(&mut session, flash_size, state, true)?;
                session
                    .core(0)
                    .and_then(|mut core| core.reset_and_halt(Duration::from_secs(2)))
                    .map_err(|error| detailed_error("Flash 已擦除，但核心复位失败", error))?;
                report.bytes = flash_size;
                report.message =
                    "整片主 Flash 已擦除并确认全部为 FF；需要重新烧录固件才能使用".into();
            }
            Operation::Flash(image) => {
                let mut loader = session.target().flash_loader();
                for (address, data) in &image.chunks {
                    loader
                        .add_data(*address, data)
                        .map_err(|error| detailed_error("无法生成烧录计划", error))?;
                }
                let mut options = DownloadOptions::default();
                options.keep_unwritten_bytes = true;
                options.verify = true;
                options.progress = flash_progress(state);
                loader.commit(&mut session, options).map_err(|error| {
                    detailed_error("烧录或校验失败，请重新烧录后确认设备状态", error)
                })?;
                state.progress("resetting", "校验通过，正在复位并启动固件", 0, None);
                session
                    .core(0)
                    .and_then(|mut core| core.reset())
                    .map_err(|error| {
                        detailed_error("固件校验通过，但复位启动失败，请手动重新上电", error)
                    })?;
                report.bytes = image.summary.programmed_size;
                report.sha256 = Some(image.summary.sha256);
                report.message =
                    "固件烧录与回读校验通过，已复位启动；覆盖范围之外的数据已保留".into();
            }
            Operation::Verify(image) => {
                verify_image(&mut session, &image, state)?;
                report.bytes = image.summary.programmed_size;
                report.sha256 = Some(image.summary.sha256);
                report.message = "文件范围内的 Flash 逐字节校验通过；核心运行状态已恢复".into();
            }
            Operation::Reset => {
                session
                    .core(0)
                    .and_then(|mut core| core.reset())
                    .map_err(|error| detailed_error("目标芯片复位失败", error))?;
                report.message = "目标芯片已复位运行".into();
            }
        }
        Ok::<_, String>(report)
    })();
    match &result {
        Ok(report) => state.progress(
            "complete",
            &report.message,
            report.bytes as u64,
            Some(report.bytes as u64),
        ),
        Err(error) => state.progress("error", error, 0, None),
    }
    result
}

#[tauri::command]
pub fn firmware_status(state: State<'_, FirmwareState>) -> FirmwareStatus {
    state.snapshot()
}

#[tauri::command]
pub async fn firmware_list_probes() -> Result<Vec<ProbeOption>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        list_probes()
            .into_iter()
            .map(|item| ProbeOption {
                id: probe_id(&item.info),
                name: item.info.identifier,
                serial_number: item.info.serial_number,
                accessible: item.accessibility == Accessibility::Accessible,
            })
            .collect()
    })
    .await
    .map_err(|error| format!("枚举 SWD 烧录器失败: {error}"))
}

#[tauri::command]
pub async fn firmware_inspect(image: ImageRequest) -> Result<ImageSummary, String> {
    tauri::async_runtime::spawn_blocking(move || prepare_image(&image).map(|image| image.summary))
        .await
        .map_err(|error| format!("固件解析任务中断: {error}"))?
}

#[tauri::command]
pub async fn firmware_read(app: AppHandle, config: ProbeConfig) -> Result<FirmwareReport, String> {
    execute(app, config, Operation::Read).await
}

#[tauri::command]
pub async fn firmware_identify(
    app: AppHandle,
    config: ProbeConfig,
) -> Result<FirmwareReport, String> {
    execute(app, config, Operation::Identify).await
}

#[tauri::command]
pub async fn firmware_reset(app: AppHandle, config: ProbeConfig) -> Result<FirmwareReport, String> {
    execute(app, config, Operation::Reset).await
}

#[tauri::command]
pub async fn firmware_verify(
    app: AppHandle,
    config: ProbeConfig,
    image: ImageRequest,
) -> Result<FirmwareReport, String> {
    if config.chip != image.chip {
        return Err("文件检查时的目标芯片已改变，请重新检查".into());
    }
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_image(&image))
        .await
        .map_err(|error| format!("固件解析任务中断: {error}"))??;
    execute(app, config, Operation::Verify(prepared)).await
}

#[tauri::command]
pub async fn firmware_erase(
    app: AppHandle,
    config: ProbeConfig,
    confirmation: String,
) -> Result<FirmwareReport, String> {
    validate_erase(config.chip, &confirmation)?;
    execute(app, config, Operation::Erase).await
}

fn validate_erase(chip: TargetSelection, confirmation: &str) -> Result<(), String> {
    if chip.fixed() == Some(Chip::Stm32f103c8t6) {
        return Err("游戏机更新会保留末尾 2 KiB 设置区，不提供整片擦除".into());
    }
    if confirmation != "ERASE" {
        return Err("请输入 ERASE 确认清空全部主 Flash（包括固件和参数）".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn firmware_flash(
    app: AppHandle,
    config: ProbeConfig,
    image: ImageRequest,
    confirmed_sha256: String,
) -> Result<FirmwareReport, String> {
    if config.chip != image.chip {
        return Err("固件检查时的目标芯片与当前产品不一致，请重新检查".into());
    }
    let prepared = tauri::async_runtime::spawn_blocking(move || prepare_image(&image))
        .await
        .map_err(|error| format!("固件解析任务中断: {error}"))??;
    if confirmed_sha256 != prepared.summary.sha256 {
        return Err("固件内容与确认时的 SHA-256 不一致，请重新选择文件".into());
    }
    execute(app, config, Operation::Flash(prepared)).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_wrong_identity_and_capacity_before_operations() {
        assert!(check_identity(0x1000_0431, 512, Chip::Stm32f411ceu).is_ok());
        assert!(check_identity(0x413, 512, Chip::Stm32f411ceu).is_err());
        assert!(check_identity(0x431, 256, Chip::Stm32f411ceu).is_err());
        assert!(check_identity(0x431, 0xffff, Chip::Stm32f411ceu).is_err());
        assert!(check_identity(0x2003_0410, 64, Chip::Stm32f103c8t6).is_ok());
        assert!(check_identity(0x410, 128, Chip::Stm32f103c8t6).is_err());
        assert!(check_identity(0x410, 0xffff, Chip::Stm32f103c8t6).is_err());
        assert!(check_identity(0x431, 64, Chip::Stm32f103c8t6).is_err());
        assert!(check_identity(0x410, 512, Chip::Stm32f411ceu).is_err());
        assert!(check_identity(0x2003_6468, 128, Chip::Stm32g431cbu6).is_ok());
        assert!(check_identity(0x468, 64, Chip::Stm32g431cbu6).is_err());
        assert!(check_identity(0x410, 128, Chip::Stm32g431cbu6).is_err());
        assert!(check_identity(0x410, 128, Chip::Stm32f103cbt6).is_ok());
        assert!(check_identity(0x410, 64, Chip::Stm32f103cbt6).is_err());
    }

    #[test]
    fn full_erase_requires_confirmation_and_cannot_clear_gamebox_settings() {
        assert!(validate_erase(Chip::Stm32f411ceu.into(), "ERASE").is_ok());
        assert!(validate_erase(Chip::Stm32f411ceu.into(), "").is_err());
        assert!(validate_erase(Chip::Stm32f103c8t6.into(), "ERASE").is_err());
        assert!(validate_erase(TargetSelection::AUTO, "ERASE").is_ok());
        assert!(validate_erase(TargetSelection::AUTO, "").is_err());
    }

    #[test]
    fn automatic_mutations_require_the_same_detected_chip_capacity_and_uid() {
        let actual = ChipInfo {
            name: "STM32F1".into(),
            target: "STM32F103C8Tx".into(),
            device_id: 0x410,
            revision_id: 0x2000,
            flash_start: FLASH_START,
            flash_size: 64 * 1024,
            uid: "0102030405060708090A0B0C".into(),
            speed_khz: 100,
            probe_id: "303a:4004:fixture".into(),
            protocol: DebugProtocol::Swd,
        };
        assert!(check_confirmed_target(None, &actual).is_err());
        let expected = TargetIdentity {
            device_id: actual.device_id,
            flash_size: actual.flash_size,
            uid: actual.uid.clone(),
        };
        assert!(check_confirmed_target(Some(&expected), &actual).is_ok());
        for changed in [
            TargetIdentity {
                flash_size: 128 * 1024,
                ..expected.clone()
            },
            TargetIdentity {
                uid: "different-board".into(),
                ..expected.clone()
            },
            TargetIdentity {
                device_id: 0x468,
                ..expected.clone()
            },
        ] {
            assert!(check_confirmed_target(Some(&changed), &actual).is_err());
        }
    }

    #[test]
    fn job_is_exclusive_and_unlocks_after_failure() {
        let state = FirmwareState::default();
        let guard = state.begin().unwrap();
        assert!(state.ensure_idle().is_err());
        assert!(state.begin().is_err());
        drop(guard);
        assert!(state.ensure_idle().is_ok());
        assert_eq!(state.snapshot().stage, "error");
        let guard = state.begin().unwrap();
        state.progress("complete", "done", 1, Some(1));
        drop(guard);
        assert_eq!(state.snapshot().stage, "complete");
        assert!(!state.snapshot().busy);
    }

    #[test]
    fn network_configuration_binds_endpoint_and_serial_and_usb_defaults_stay_compatible() {
        let legacy = serde_json::json!({ "probeId": "303a:4004:fixture", "chip": "auto", "speedKhz": 100, "connectUnderReset": false });
        let config: ProbeConfig = serde_json::from_value(legacy.clone()).unwrap();
        assert_eq!(config.protocol, DebugProtocol::Swd);
        assert!(config.network.is_none());
        assert!(config.validate().is_ok());
        let mut wireless = legacy;
        wireless["probeId"] = "tcp:172.18.7.163:4441:14C19FD536F4".into();
        wireless["protocol"] = "jtag".into();
        wireless["network"] =
            serde_json::json!({ "host": "172.18.7.163", "port": 4441, "serial": "14C19FD536F4" });
        let config: ProbeConfig = serde_json::from_value(wireless.clone()).unwrap();
        assert!(config.validate().is_ok());
        wireless["network"]["serial"] = "AABBCCDDEEFF".into();
        assert!(serde_json::from_value::<ProbeConfig>(wireless.clone())
            .unwrap()
            .validate()
            .is_err());
        wireless["network"] = serde_json::Value::Null;
        assert!(serde_json::from_value::<ProbeConfig>(wireless.clone())
            .unwrap()
            .validate()
            .is_err());
        wireless["protocol"] = "invalid".into();
        assert!(serde_json::from_value::<ProbeConfig>(wireless).is_err());
    }

    #[test]
    fn builtin_targets_and_algorithms_are_available_offline() {
        let registry = probe_rs::config::Registry::from_builtin_families();
        for (chip, algorithm) in [
            (Chip::Stm32f411ceu, "stm32f4xx_1024"),
            (Chip::Stm32f103c8t6, "stm32f10x_128"),
            (Chip::Stm32f103cbt6, "stm32f10x_128"),
            (Chip::Stm32g431cbu6, "stm32g47x-8x_512"),
        ] {
            let target = registry.get_target_by_name(chip.target()).unwrap();
            assert!(target
                .flash_algorithms
                .iter()
                .any(|algo| algo.name == algorithm));
            assert!(target.memory_map.iter().any(|region| matches!(
                region,
                probe_rs::config::MemoryRegion::Nvm(region)
                    if region.range == (FLASH_START..FLASH_START + chip.size() as u64)
            )));
            let mut loader = target.flash_loader();
            assert!(loader.add_data(FLASH_START, &[1, 2, 3, 4]).is_ok());
        }
    }
}

#[cfg(test)]
#[path = "firmware_hardware_tests.rs"]
mod hardware_tests;
