//! Parse and bound every byte before a probe is opened. No filesystem paths or
//! caller-provided target descriptions cross the firmware command boundary.
use object::read::elf::{FileHeader, ProgramHeader};
use object::{elf, LittleEndian};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const FLASH_START: u64 = 0x0800_0000;
pub const MAX_FILE_SIZE: usize = 16 * 1024 * 1024;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Chip {
    Stm32f411xc,
    Stm32f411xe,
}

impl Chip {
    pub fn size(self) -> usize {
        match self {
            Self::Stm32f411xc => 256 * 1024,
            Self::Stm32f411xe => 512 * 1024,
        }
    }

    pub fn target(self) -> &'static str {
        match self {
            Self::Stm32f411xc => "STM32F411CC",
            Self::Stm32f411xe => "STM32F411CE",
        }
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
    pub chip: Chip,
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

fn validate_range(address: u64, length: usize, chip: Chip) -> Result<(), String> {
    let end = address.checked_add(length as u64).ok_or("固件地址溢出")?;
    if address < FLASH_START || end > FLASH_START + chip.size() as u64 {
        return Err(format!(
            "固件范围 {address:#010X}..{end:#010X} 超出所选芯片主 Flash；不允许写入 RAM、OTP 或选项字节"
        ));
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
            chip: Chip::Stm32f411xc,
        }
    }

    #[test]
    fn bin_bounds_use_selected_capacity_and_checked_arithmetic() {
        let mut image = request(ImageFormat::Bin, vec![0x5a; 256 * 1024], FLASH_START);
        assert!(prepare_image(&image).is_ok());
        image.data.push(0);
        assert!(prepare_image(&image).is_err());
        image.chip = Chip::Stm32f411xe;
        assert!(prepare_image(&image).is_ok());
        image.base_address = u64::MAX;
        assert!(prepare_image(&image).is_err());
        image.base_address = 0x1fff_7800;
        assert!(prepare_image(&image).is_err());
        image.base_address = 0x2000_0000;
        assert!(prepare_image(&image).is_err());
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
        bytes[64..68].copy_from_slice(&0x2000_0000_u32.to_le_bytes());
        assert!(prepare_image(&request(ImageFormat::Elf, bytes, FLASH_START)).is_err());
    }
}
