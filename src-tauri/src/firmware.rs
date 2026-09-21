//! WL1 and GameBox ST-Link/SWD service. Jobs own USB on a blocking worker and
//! reserve the product lifecycle before attaching. No probe-rs CLI is spawned.
use std::sync::{Arc, Mutex};
use std::time::Duration;

use probe_rs::flashing::{self, DownloadOptions, FlashProgress, ProgressEvent, ProgressOperation};
use probe_rs::probe::{
    list::Accessibility, stlink::StLinkFactory, DebugProbeInfo, ProbeFactory, WireProtocol,
};
use probe_rs::{MemoryInterface, Permissions, Session};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::commands::ProductSessionLifecycle;
use crate::firmware_image::{
    prepare_image, sha256, Chip, ImageRequest, ImageSummary, PreparedImage, FLASH_START,
};

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
            message: "正在连接 ST-Link / SWD…".into(),
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

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProbeConfig {
    pub probe_id: String,
    pub chip: Chip,
    pub speed_khz: u32,
    pub connect_under_reset: bool,
}

impl ProbeConfig {
    fn validate(&self) -> Result<(), String> {
        if self.probe_id.is_empty() || self.probe_id.len() > 256 {
            return Err("请刷新并选择 ST-Link".into());
        }
        if ![100, 400, 1000, 1800, 4000].contains(&self.speed_khz) {
            return Err("SWD 频率不在支持的范围内".into());
        }
        Ok(())
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChipInfo {
    pub name: String,
    pub device_id: u32,
    pub revision_id: u32,
    pub flash_start: u64,
    pub flash_size: usize,
    pub uid: String,
    pub speed_khz: u32,
    pub probe_id: String,
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
            "芯片实测 Flash 为 {size_kib} KiB，与产品固定目标 {} 的 {} KiB 不一致；请检查所连接的设备",
            chip.name(), chip.size() / 1024
        ));
    }
    Ok(())
}

fn attach(config: &ProbeConfig) -> Result<(Session, ChipInfo), String> {
    config.validate()?;
    // Re-enumerate by identity, not list index. Duplicate clone serial numbers
    // are ambiguous and must never silently choose an arbitrary target.
    let matches: Vec<_> = StLinkFactory
        .list_probes()
        .into_iter()
        .filter(|item| probe_id(&item.info) == config.probe_id)
        .collect();
    if matches.len() != 1 {
        return Err("所选 ST-Link 已拔出或存在重复序列号；请只连接一个匹配探针后刷新".into());
    }
    let mut probe = matches[0].info.open().map_err(|error| {
        format!(
            "{}。请使用页面中的 USB 支持设置，并关闭占用探针的调试软件",
            detailed_error("无法打开 ST-Link", error)
        )
    })?;
    probe
        .select_protocol(WireProtocol::Swd)
        .map_err(|error| detailed_error("无法选择 SWD", error))?;
    let speed_khz = probe
        .set_speed(config.speed_khz)
        .map_err(|error| detailed_error("无法设置 SWD 频率", error))?;
    // Default permissions deliberately prohibit automatic RDP unlock/mass erase.
    let mut session = if config.connect_under_reset {
        probe.attach_under_reset(config.chip.target(), Permissions::default())
    } else {
        probe.attach(config.chip.target(), Permissions::default())
    }.map_err(|error| format!("{}。检查供电、GND/SWDIO/SWCLK；可降低 SWD 频率或连接 NRST 后启用复位连接。读保护不会自动解除", detailed_error("无法连接芯片", error)))?;
    let mut core = session
        .core(0)
        .map_err(|error| detailed_error("无法访问核心", error))?;
    let id = core
        .read_word_32(0xe004_2000)
        .map_err(|error| detailed_error("无法读取芯片 ID", error))?;
    let mut size = [0; 2];
    core.read_8(config.chip.size_register(), &mut size)
        .map_err(|error| detailed_error("无法读取 Flash 容量", error))?;
    check_identity(id, u16::from_le_bytes(size), config.chip)?;
    let mut uid = [0; 12];
    core.read_8(config.chip.uid_register(), &mut uid)
        .map_err(|error| detailed_error("无法读取芯片 UID", error))?;
    let info = ChipInfo {
        name: config.chip.name().into(),
        device_id: id & 0xfff,
        revision_id: id >> 16,
        flash_start: FLASH_START,
        flash_size: config.chip.size(),
        uid: uid.iter().map(|byte| format!("{byte:02X}")).collect(),
        speed_khz,
        probe_id: config.probe_id.clone(),
    };
    drop(core);
    Ok((session, info))
}

pub(crate) fn reserve(app: &AppHandle) -> Result<JobGuard, String> {
    let lifecycle = app.state::<ProductSessionLifecycle>();
    let _lifecycle = lifecycle.0.lock().map_err(|_| "产品会话生命周期锁已损坏")?;
    if app.state::<crate::state::AppState>().snapshot()?.mode != "disconnected"
        || app.state::<crate::gamebox::GameBoxState>().snapshot()?.mode
            != crate::gamebox::GameBoxMode::Disconnected
        || app.state::<crate::nfc::NfcState>().snapshot()?.mode != crate::nfc::NfcMode::Disconnected
    {
        return Err("请先断开设备串口/演示/Mock 会话，再操作 SWD 固件".into());
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

enum Operation {
    Read,
    Erase,
    Flash(PreparedImage),
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
        let result = (|| {
            let (mut session, chip) = attach(&config)?;
            let mut report = FirmwareReport {
                chip,
                message: String::new(),
                bytes: 0,
                sha256: None,
                data: None,
            };
            match operation {
                Operation::Read => {
                    let data = read_flash(&mut session, config.chip.size(), &state, false)?;
                    report.bytes = data.len();
                    report.sha256 = Some(sha256(&data));
                    report.data = Some(data);
                    report.message =
                        "完整主 Flash 已读取，可查看或导出 BIN 备份；设备将退出调试状态".into();
                }
                Operation::Erase => {
                    state.progress("erasing", "正在擦除整片主 Flash，请勿断电或拔线", 0, None);
                    // erase_all also walks OTP in the built-in F411 target. Use
                    // the explicitly bounded main-Flash range instead.
                    flashing::erase(
                        &mut session,
                        &mut FlashProgress::empty(),
                        FLASH_START,
                        FLASH_START + config.chip.size() as u64,
                        false,
                    )
                    .map_err(|error| detailed_error("主 Flash 擦除失败", error))?;
                    read_flash(&mut session, config.chip.size(), &state, true)?;
                    session
                        .core(0)
                        .and_then(|mut core| core.reset_and_halt(Duration::from_secs(2)))
                        .map_err(|error| detailed_error("Flash 已擦除，但核心复位失败", error))?;
                    report.bytes = config.chip.size();
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
                    options.progress = flash_progress(&state);
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
    })
    .await
    .map_err(|error| format!("固件后台任务中断: {error}"))?
}

#[tauri::command]
pub fn firmware_status(state: State<'_, FirmwareState>) -> FirmwareStatus {
    state.snapshot()
}

#[tauri::command]
pub async fn firmware_list_probes() -> Result<Vec<ProbeOption>, String> {
    tauri::async_runtime::spawn_blocking(|| {
        StLinkFactory
            .list_probes()
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
    .map_err(|error| format!("枚举 ST-Link 失败: {error}"))
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
pub async fn firmware_erase(
    app: AppHandle,
    config: ProbeConfig,
    confirmation: String,
) -> Result<FirmwareReport, String> {
    validate_erase(config.chip, &confirmation)?;
    execute(app, config, Operation::Erase).await
}

fn validate_erase(chip: Chip, confirmation: &str) -> Result<(), String> {
    if chip == Chip::Stm32f103c8t6 {
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
    }

    #[test]
    fn full_erase_requires_confirmation_and_cannot_clear_gamebox_settings() {
        assert!(validate_erase(Chip::Stm32f411ceu, "ERASE").is_ok());
        assert!(validate_erase(Chip::Stm32f411ceu, "").is_err());
        assert!(validate_erase(Chip::Stm32f103c8t6, "ERASE").is_err());
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
    fn builtin_targets_and_algorithms_are_available_offline() {
        let registry = probe_rs::config::Registry::from_builtin_families();
        for (chip, algorithm) in [
            (Chip::Stm32f411ceu, "stm32f4xx_1024"),
            (Chip::Stm32f103c8t6, "stm32f10x_128"),
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
