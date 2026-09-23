//! Register-based STM32 discovery. A device ID identifies a die family, not its
//! package marking. Capacity selects an existing, compatible Flash algorithm.
use crate::firmware_image::Chip;

#[derive(Clone, Debug)]
pub struct ResolvedTarget {
    pub name: &'static str,
    pub target: &'static str,
    pub device_id: u32,
    pub flash_size: usize,
    pub size_register: u64,
    pub uid_register: u64,
}

impl ResolvedTarget {
    pub fn fixed(chip: Chip) -> Self {
        Self {
            name: chip.name(),
            target: chip.target(),
            device_id: chip.device_id(),
            flash_size: chip.size(),
            size_register: chip.size_register(),
            uid_register: chip.uid_register(),
        }
    }
}

pub fn size_register(device_id: u32) -> Result<u64, String> {
    match device_id & 0xfff {
        0x410 => Ok(0x1fff_f7e0),
        0x431 => Ok(0x1fff_7a22),
        0x468 => Ok(0x1fff_75e0),
        id => Err(format!(
            "已读到器件 ID {id:#05X}，尚无该系列的自动 Flash 配置；当前支持 STM32F1 中容量、STM32F411 和 STM32G431"
        )),
    }
}

pub fn resolve(device_id: u32, size_kib: u16) -> Result<ResolvedTarget, String> {
    let device_id = device_id & 0xfff;
    let size_register = size_register(device_id)?;
    let (name, target, uid_register) = match (device_id, size_kib) {
        (0x410, 64) => ("STM32F1", "STM32F103C8Tx", 0x1fff_f7e8),
        (0x410, 128) => ("STM32F1", "STM32F103CBTx", 0x1fff_f7e8),
        (0x431, 256) => ("STM32F411", "STM32F411CCUx", 0x1fff_7a10),
        (0x431, 512) => ("STM32F411", "STM32F411CEUx", 0x1fff_7a10),
        (0x468, 32) => ("STM32G431", "STM32G431C6Ux", 0x1fff_7590),
        (0x468, 64) => ("STM32G431", "STM32G431C8Ux", 0x1fff_7590),
        (0x468, 128) => ("STM32G431", "STM32G431CBUx", 0x1fff_7590),
        _ => return Err(format!(
            "器件 ID {device_id:#05X} 的容量寄存器报告 {size_kib} KiB，未找到匹配的 Flash 算法；请检查供电、读保护及芯片资料"
        )),
    };
    Ok(ResolvedTarget {
        name,
        target,
        device_id,
        flash_size: usize::from(size_kib) * 1024,
        size_register,
        uid_register,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use probe_rs::config::{MemoryRegion, Registry};

    #[test]
    fn f1_reported_capacity_selects_the_algorithm_without_guessing_package() {
        let small = resolve(0x2003_0410, 64).unwrap();
        let large = resolve(0x2003_0410, 128).unwrap();
        assert_eq!(small.name, large.name);
        assert_eq!(small.flash_size, 64 * 1024);
        assert_eq!(small.target, "STM32F103C8Tx");
        assert_eq!(large.flash_size, 128 * 1024);
        assert_eq!(large.target, "STM32F103CBTx");
        for size in [0, 1, 63, 65, 256, u16::MAX] {
            assert!(resolve(0x410, size).is_err());
        }
        assert!(resolve(0xfff, 64).is_err());
    }

    #[test]
    fn all_detected_capacities_have_matching_builtin_main_flash_and_algorithms() {
        let registry = Registry::from_builtin_families();
        for (id, sizes) in [
            (0x410, vec![64, 128]),
            (0x431, vec![256, 512]),
            (0x468, vec![32, 64, 128]),
        ] {
            for size in sizes {
                let detected = resolve(id, size).unwrap();
                let target = registry.get_target_by_name(detected.target).unwrap();
                let main = target
                    .memory_map
                    .iter()
                    .find_map(|region| match region {
                        MemoryRegion::Nvm(region) if region.range.start == 0x0800_0000 => {
                            Some(region)
                        }
                        _ => None,
                    })
                    .unwrap();
                assert_eq!(
                    main.range.end - main.range.start,
                    detected.flash_size as u64
                );
                assert!(!target.flash_algorithms.is_empty());
            }
        }
    }
}
