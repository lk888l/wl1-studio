//! Parse files before opening a probe. Product bounds are checked offline;
//! automatic targets also check every segment against the live Flash capacity.
//! No filesystem paths or caller-provided target descriptions cross the boundary.
use object::read::elf::{FileHeader, ProgramHeader};
use object::{elf, LittleEndian};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FLASH_START: u64 = 0x0800_0000;
pub const MAX_FILE_SIZE: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Chip {
    Stm32f411ceu,
    Stm32f103c8t6,
    Stm32f103cbt6,
    Stm32g431cbu6,
}

impl Chip {
    pub fn name(self) -> &'static str {
        match self {
            Self::Stm32f411ceu => "STM32F411CEU",
            Self::Stm32f103c8t6 => "STM32F103C8T6",
            Self::Stm32f103cbt6 => "STM32F103CBT6",
            Self::Stm32g431cbu6 => "STM32G431CBU6",
        }
    }

    pub fn size(self) -> usize {
        match self {
            Self::Stm32f411ceu => 512 * 1024,
            Self::Stm32f103c8t6 => 64 * 1024,
            Self::Stm32f103cbt6 | Self::Stm32g431cbu6 => 128 * 1024,
        }
    }

    pub fn program_size(self) -> usize {
        match self {
            Self::Stm32f411ceu | Self::Stm32f103cbt6 | Self::Stm32g431cbu6 => self.size(),
            // GameBox reserves the last two 1-KiB pages for persistent settings.
            Self::Stm32f103c8t6 => 62 * 1024,
        }
    }

    pub fn target(self) -> &'static str {
        match self {
            Self::Stm32f411ceu => "STM32F411CEUx",
            Self::Stm32f103c8t6 => "STM32F103C8Tx",
            Self::Stm32f103cbt6 => "STM32F103CBTx",
            Self::Stm32g431cbu6 => "STM32G431CBUx",
        }
    }

    pub fn device_id(self) -> u32 {
        match self {
            Self::Stm32f411ceu => 0x431,
            Self::Stm32f103c8t6 | Self::Stm32f103cbt6 => 0x410,
            Self::Stm32g431cbu6 => 0x468,
        }
    }

    pub fn size_register(self) -> u64 {
        match self {
            Self::Stm32f411ceu => 0x1fff_7a22,
            Self::Stm32f103c8t6 | Self::Stm32f103cbt6 => 0x1fff_f7e0,
            Self::Stm32g431cbu6 => 0x1fff_75e0,
        }
    }

    pub fn uid_register(self) -> u64 {
        match self {
            Self::Stm32f411ceu => 0x1fff_7a10,
            Self::Stm32f103c8t6 | Self::Stm32f103cbt6 => 0x1fff_f7e8,
            Self::Stm32g431cbu6 => 0x1fff_7590,
        }
    }
}

/// Product profiles retain their fixed layout. A standalone SWD probe resolves
/// its Flash bounds from the connected target instead of a product profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AutomaticTarget {
    Auto,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(untagged)]
pub enum TargetSelection {
    Fixed(Chip),
    Automatic(AutomaticTarget),
}

impl TargetSelection {
    pub const AUTO: Self = Self::Automatic(AutomaticTarget::Auto);

    pub fn fixed(self) -> Option<Chip> {
        match self {
            Self::Fixed(chip) => Some(chip),
            Self::Automatic(_) => None,
        }
    }
}

impl From<Chip> for TargetSelection {
    fn from(chip: Chip) -> Self {
        Self::Fixed(chip)
    }
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ImageFormat {
    Bin,
    Hex,
    Elf,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ImageRequest {
    pub format: ImageFormat,
    pub data: Vec<u8>,
    pub base_address: u64,
    pub chip: TargetSelection,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageRegion {
    pub address: u64,
    pub length: usize,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageSummary {
    pub file_size: usize,
    pub programmed_size: usize,
    pub sha256: String,
    pub regions: Vec<ImageRegion>,
}

pub struct PreparedImage {
    pub chunks: Vec<(u64, Vec<u8>)>,
    pub summary: ImageSummary,
}

pub fn sha256(data: &[u8]) -> String {
    format!("{:x}", Sha256::digest(data))
}

fn validate_range(address: u64, length: usize, selection: TargetSelection) -> Result<(), String> {
    // Before discovery, only parse/validate the file and the STM32 main-Flash
    // address window. The real capacity is checked again on the live session.
    let chip = selection.fixed();
    let capacity = chip.map(Chip::size).unwrap_or(MAX_FILE_SIZE);
    let end = address.checked_add(length as u64).ok_or("固件地址溢出")?;
    if address < FLASH_START || end > FLASH_START + capacity as u64 {
        return Err(format!(
            "固件范围 {address:#010X}..{end:#010X} 超出主 Flash 地址范围；不允许写入 RAM、OTP 或选项字节"
        ));
    }
    if chip.is_some_and(|chip| end > FLASH_START + chip.program_size() as u64) {
        return Err(
            "固件覆盖游戏机设置保留区 0x0800F800–0x0800FFFF；更新只能写入前 62 KiB 应用区".into(),
        );
    }
    Ok(())
}

pub fn validate_detected_capacity(image: &PreparedImage, flash_size: usize) -> Result<(), String> {
    if flash_size == 0 || flash_size > MAX_FILE_SIZE {
        return Err("芯片 Flash 容量无效，请重新连接并识别".into());
    }
    for (address, data) in &image.chunks {
        let end = address
            .checked_add(data.len() as u64)
            .ok_or("固件地址溢出")?;
        if *address < FLASH_START || end > FLASH_START + flash_size as u64 {
            return Err(format!(
                "固件范围 {address:#010X}..{end:#010X} 超出实测 {} KiB Flash（结束地址 {:#010X}）；请使用适合此容量的固件",
                flash_size / 1024,
                FLASH_START + flash_size as u64 - 1
            ));
        }
    }
    Ok(())
}

pub fn prepare_image(request: &ImageRequest) -> Result<PreparedImage, String> {
    if request.data.is_empty() || request.data.len() > MAX_FILE_SIZE {
        return Err("固件文件必须非空且不超过 16 MiB".into());
    }
    let mut chunks = match request.format {
        ImageFormat::Bin => {
            validate_range(request.base_address, request.data.len(), request.chip)?;
            vec![(request.base_address, request.data.clone())]
        }
        ImageFormat::Hex => parse_hex(&request.data)?,
        ImageFormat::Elf => parse_elf(&request.data)?,
    };
    chunks.retain(|(_, bytes)| !bytes.is_empty());
    chunks.sort_by_key(|(address, _)| *address);
    let mut merged: Vec<(u64, Vec<u8>)> = Vec::new();
    for (address, bytes) in chunks {
        validate_range(address, bytes.len(), request.chip)?;
        if let Some((previous, previous_bytes)) = merged.last_mut() {
            let end = *previous + previous_bytes.len() as u64;
            if address < end {
                return Err("固件包含重叠的数据范围，已拒绝烧录".into());
            }
            if address == end {
                previous_bytes.extend(bytes);
                continue;
            }
        }
        merged.push((address, bytes));
    }
    if merged.is_empty() {
        return Err("固件没有可烧录的数据".into());
    }
    let summary = ImageSummary {
        file_size: request.data.len(),
        programmed_size: merged.iter().map(|(_, data)| data.len()).sum(),
        sha256: sha256(&request.data),
        regions: merged
            .iter()
            .map(|(address, bytes)| ImageRegion {
                address: *address,
                length: bytes.len(),
            })
            .collect(),
    };
    Ok(PreparedImage {
        chunks: merged,
        summary,
    })
}

fn parse_hex(data: &[u8]) -> Result<Vec<(u64, Vec<u8>)>, String> {
    let text = std::str::from_utf8(data).map_err(|_| "HEX 必须是有效的 ASCII 文本")?;
    let mut base = 0_u64;
    let mut eof = false;
    let mut chunks = Vec::new();
    for (index, line) in text.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if eof {
            return Err("HEX 文件结束记录之后仍包含数据".into());
        }
        let record = ihex::Record::from_record_string(line)
            .map_err(|error| format!("HEX 第 {} 行无效（含校验和检查）: {error}", index + 1))?;
        match record {
            ihex::Record::Data { offset, value } => chunks.push((base + u64::from(offset), value)),
            ihex::Record::EndOfFile => eof = true,
            ihex::Record::ExtendedSegmentAddress(value) => base = u64::from(value) << 4,
            ihex::Record::ExtendedLinearAddress(value) => base = u64::from(value) << 16,
            ihex::Record::StartSegmentAddress { .. } | ihex::Record::StartLinearAddress(_) => {}
        }
    }
    if !eof {
        return Err("HEX 缺少文件结束记录".into());
    }
    Ok(chunks)
}

fn parse_elf(data: &[u8]) -> Result<Vec<(u64, Vec<u8>)>, String> {
    let header = elf::FileHeader32::<LittleEndian>::parse(data)
        .map_err(|error| format!("无法解析 ELF32: {error}"))?;
    if header.e_ident.data != elf::ELFDATA2LSB
        || header.e_machine.get(LittleEndian) != elf::EM_ARM
        || header.e_type.get(LittleEndian) != elf::ET_EXEC
    {
        return Err("仅支持已链接的 ARM 32 位小端 ELF 固件".into());
    }
    let segments = header
        .program_headers(LittleEndian, data)
        .map_err(|error| format!("ELF 程序段无效: {error}"))?;
    let mut chunks = Vec::new();
    for segment in segments {
        if segment.p_type(LittleEndian) != elf::PT_LOAD {
            continue;
        }
        let bytes = segment
            .data(LittleEndian, data)
            .map_err(|_| "ELF 数据段不完整")?;
        if !bytes.is_empty() {
            // .data runs in RAM but its load address is in Flash. Never use VMA.
            chunks.push((u64::from(segment.p_paddr(LittleEndian)), bytes.to_vec()));
        }
    }
    Ok(chunks)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(format: ImageFormat, data: Vec<u8>, base_address: u64) -> ImageRequest {
        ImageRequest {
            format,
            data,
            base_address,
            chip: Chip::Stm32f411ceu.into(),
        }
    }

    #[test]
    fn bin_bounds_use_product_capacity_and_checked_arithmetic() {
        let mut image = request(ImageFormat::Bin, vec![0x5a; 512 * 1024], FLASH_START);
        assert!(prepare_image(&image).is_ok());
        image.data.push(0);
        assert!(prepare_image(&image).is_err());
        image.base_address = u64::MAX;
        assert!(prepare_image(&image).is_err());
        image.base_address = 0x1fff_7800;
        assert!(prepare_image(&image).is_err());
        image.base_address = 0x2000_0000;
        assert!(prepare_image(&image).is_err());
    }

    #[test]
    fn swd_128k_targets_accept_full_backups_and_reject_system_memory() {
        for chip in [Chip::Stm32f103cbt6, Chip::Stm32g431cbu6] {
            let mut image = request(ImageFormat::Bin, vec![0xa5; 128 * 1024], FLASH_START);
            image.chip = chip.into();
            assert!(prepare_image(&image).is_ok());
            image.data.push(0);
            assert!(prepare_image(&image).is_err());
            image.data = vec![1];
            image.base_address = FLASH_START + 128 * 1024 - 1;
            assert!(prepare_image(&image).is_ok());
            image.base_address += 1;
            assert!(prepare_image(&image).is_err());
            image.base_address = 0x1fff_7800;
            assert!(prepare_image(&image).is_err());
        }
    }

    #[test]
    fn automatic_swd_uses_live_capacity_and_allows_full_64k_without_gamebox_policy() {
        let mut image = request(ImageFormat::Bin, vec![0xa5; 64 * 1024], FLASH_START);
        image.chip = TargetSelection::AUTO;
        let prepared = prepare_image(&image).unwrap();
        assert!(validate_detected_capacity(&prepared, 64 * 1024).is_ok());
        image.data.push(0);
        // Offline parsing cannot guess capacity. A live 64-KiB target rejects
        // the extra byte before any loader or erase operation can start.
        let prepared = prepare_image(&image).unwrap();
        let error = validate_detected_capacity(&prepared, 64 * 1024).unwrap_err();
        assert!(error.contains("实测 64 KiB"));
        assert!(validate_detected_capacity(&prepared, 128 * 1024).is_ok());
        assert!(validate_detected_capacity(&prepared, 0).is_err());
        image.data = vec![0x55];
        image.base_address = FLASH_START + 64 * 1024 - 1;
        assert!(validate_detected_capacity(&prepare_image(&image).unwrap(), 64 * 1024).is_ok());
        image.base_address += 1;
        assert!(validate_detected_capacity(&prepare_image(&image).unwrap(), 64 * 1024).is_err());
        for address in [0x1fff_7800, 0x2000_0000, u64::MAX] {
            image.base_address = address;
            assert!(prepare_image(&image).is_err());
        }
    }

    #[test]
    fn auto_target_has_an_explicit_ipc_value_without_changing_fixed_profiles() {
        assert_eq!(
            serde_json::from_str::<TargetSelection>("\"auto\"").unwrap(),
            TargetSelection::AUTO
        );
        assert_eq!(
            serde_json::to_string(&TargetSelection::AUTO).unwrap(),
            "\"auto\""
        );
        let fixed = serde_json::from_str::<TargetSelection>("\"stm32f103c8t6\"").unwrap();
        assert_eq!(fixed.fixed(), Some(Chip::Stm32f103c8t6));
        assert!(serde_json::from_str::<TargetSelection>("\"unknown-chip\"").is_err());
    }

    #[test]
    fn gamebox_bin_preserves_settings_and_rejects_full_flash_backups_as_updates() {
        let mut image = request(ImageFormat::Bin, vec![0x5a; 62 * 1024], FLASH_START);
        image.chip = Chip::Stm32f103c8t6.into();
        assert!(prepare_image(&image).is_ok());
        image.data.push(0);
        assert!(prepare_image(&image).err().unwrap().contains("设置保留区"));
        image.data = vec![0xff; 64 * 1024];
        assert!(prepare_image(&image).err().unwrap().contains("设置保留区"));
        image.data = vec![1];
        image.base_address = FLASH_START + 62 * 1024 - 1;
        assert!(prepare_image(&image).is_ok());
        image.base_address += 1;
        assert!(prepare_image(&image).is_err());
        image.base_address = FLASH_START + 64 * 1024;
        assert!(prepare_image(&image).is_err());
    }

    #[test]
    fn removed_wl1_chip_choices_are_rejected_at_the_ipc_boundary() {
        for chip in ["stm32f411xc", "stm32f411xe", "stm32f411cc", "stm32f103cb"] {
            assert!(serde_json::from_value::<Chip>(serde_json::json!(chip)).is_err());
        }
        assert_eq!(
            serde_json::from_str::<Chip>("\"stm32f411ceu\"").unwrap(),
            Chip::Stm32f411ceu
        );
        assert_eq!(
            serde_json::from_str::<Chip>("\"stm32f103c8t6\"").unwrap(),
            Chip::Stm32f103c8t6
        );
    }

    fn hex(lines: &[ihex::Record]) -> ImageRequest {
        request(
            ImageFormat::Hex,
            lines
                .iter()
                .map(|record| record.to_record_string().unwrap())
                .collect::<Vec<_>>()
                .join("\n")
                .into_bytes(),
            FLASH_START,
        )
    }

    #[test]
    fn hex_addresses_checksum_eof_and_overlap_are_checked() {
        let records = [
            ihex::Record::ExtendedLinearAddress(0x0800),
            ihex::Record::Data {
                offset: 0x4000,
                value: vec![1, 2, 3],
            },
            ihex::Record::EndOfFile,
        ];
        let image = prepare_image(&hex(&records)).unwrap();
        assert_eq!(image.chunks, vec![(FLASH_START + 0x4000, vec![1, 2, 3])]);
        assert!(prepare_image(&hex(&records[..2])).is_err());
        assert!(prepare_image(&hex(&[
            records[0].clone(),
            records[1].clone(),
            records[1].clone(),
            records[2].clone()
        ]))
        .is_err());
        assert!(prepare_image(&hex(&[records[2].clone(), records[1].clone()])).is_err());
        assert!(prepare_image(&request(
            ImageFormat::Hex,
            b":020000040800F3\n:00000001FF".to_vec(),
            FLASH_START
        ))
        .is_err());
        assert!(prepare_image(&hex(&[
            ihex::Record::ExtendedLinearAddress(0x1fff),
            records[1].clone(),
            records[2].clone()
        ]))
        .is_err());
    }

    #[test]
    fn gamebox_hex_checks_every_segment_against_the_settings_boundary() {
        for (offset, length, accepted) in
            [(0xf7ff, 1, true), (0xf7ff, 2, false), (0xf800, 1, false)]
        {
            let mut image = hex(&[
                ihex::Record::ExtendedLinearAddress(0x0800),
                ihex::Record::Data {
                    offset: 0,
                    value: vec![1, 2, 3, 4],
                },
                ihex::Record::Data {
                    offset,
                    value: vec![0x5a; length],
                },
                ihex::Record::EndOfFile,
            ]);
            image.chip = Chip::Stm32f103c8t6.into();
            assert_eq!(prepare_image(&image).is_ok(), accepted);
        }
    }

    #[test]
    fn automatic_hex_checks_sparse_segments_against_measured_flash_end() {
        let mut image = hex(&[
            ihex::Record::ExtendedLinearAddress(0x0800),
            ihex::Record::Data {
                offset: 0,
                value: vec![1, 2, 3, 4],
            },
            ihex::Record::ExtendedLinearAddress(0x0801),
            ihex::Record::Data {
                offset: 0,
                value: vec![0x42],
            },
            ihex::Record::EndOfFile,
        ]);
        image.chip = TargetSelection::AUTO;
        let prepared = prepare_image(&image).unwrap();
        assert!(validate_detected_capacity(&prepared, 64 * 1024).is_err());
        assert!(validate_detected_capacity(&prepared, 128 * 1024).is_ok());
    }

    #[test]
    fn empty_and_non_arm_images_are_rejected() {
        assert!(prepare_image(&request(ImageFormat::Bin, vec![], FLASH_START)).is_err());
        assert!(prepare_image(&hex(&[ihex::Record::EndOfFile])).is_err());
        assert!(prepare_image(&request(
            ImageFormat::Elf,
            b"not an elf".to_vec(),
            FLASH_START
        ))
        .is_err());
    }

    #[test]
    fn elf_uses_physical_load_address_and_ignores_bss() {
        let mut bytes = vec![0; 120];
        bytes[..7].copy_from_slice(b"\x7fELF\x01\x01\x01");
        bytes[16..18].copy_from_slice(&elf::ET_EXEC.to_le_bytes());
        bytes[18..20].copy_from_slice(&elf::EM_ARM.to_le_bytes());
        bytes[20..24].copy_from_slice(&1_u32.to_le_bytes());
        bytes[28..32].copy_from_slice(&52_u32.to_le_bytes());
        bytes[40..42].copy_from_slice(&52_u16.to_le_bytes());
        bytes[42..44].copy_from_slice(&32_u16.to_le_bytes());
        bytes[44..46].copy_from_slice(&2_u16.to_le_bytes());
        bytes[52..56].copy_from_slice(&elf::PT_LOAD.to_le_bytes());
        bytes[56..60].copy_from_slice(&116_u32.to_le_bytes());
        bytes[60..64].copy_from_slice(&0x2000_0000_u32.to_le_bytes());
        bytes[64..68].copy_from_slice(&(FLASH_START as u32 + 0x4000).to_le_bytes());
        bytes[68..72].copy_from_slice(&4_u32.to_le_bytes());
        bytes[72..76].copy_from_slice(&4_u32.to_le_bytes());
        bytes[84..88].copy_from_slice(&elf::PT_LOAD.to_le_bytes());
        bytes[96..100].copy_from_slice(&0x2000_0010_u32.to_le_bytes());
        bytes[104..108].copy_from_slice(&100_u32.to_le_bytes());
        bytes[116..120].copy_from_slice(&[1, 2, 3, 4]);
        let image = prepare_image(&request(ImageFormat::Elf, bytes.clone(), FLASH_START)).unwrap();
        assert_eq!(image.chunks, vec![(FLASH_START + 0x4000, vec![1, 2, 3, 4])]);
        let mut gamebox_image = request(ImageFormat::Elf, bytes.clone(), FLASH_START);
        gamebox_image.chip = Chip::Stm32f103c8t6.into();
        assert!(prepare_image(&gamebox_image).is_ok());
        gamebox_image.data[64..68].copy_from_slice(&0x0800_f800_u32.to_le_bytes());
        assert!(prepare_image(&gamebox_image)
            .err()
            .unwrap()
            .contains("设置保留区"));
        bytes[64..68].copy_from_slice(&0x2000_0000_u32.to_le_bytes());
        assert!(prepare_image(&request(ImageFormat::Elf, bytes, FLASH_START)).is_err());
    }
}
