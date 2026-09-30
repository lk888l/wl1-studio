//! Opt-in tests use the exact backend worker used by Tauri commands.
use super::*;
use crate::firmware_image::ImageFormat;

#[test]
#[ignore = "Requires STICKS3_NO_TARGET=1, STICKS3_TEST_IP and STICKS3_TEST_SERIAL; no target may be wired"]
fn sticks3_network_no_target_identification() {
    assert_eq!(std::env::var("STICKS3_NO_TARGET").as_deref(), Ok("1"));
    let device = NetworkDevice {
        host: std::env::var("STICKS3_TEST_IP").unwrap(),
        port: 4441,
        serial: std::env::var("STICKS3_TEST_SERIAL").unwrap(),
    };
    for protocol in [DebugProtocol::Swd, DebugProtocol::Jtag] {
        let config = ProbeConfig {
            probe_id: device.probe_id(),
            chip: TargetSelection::AUTO,
            speed_khz: 100,
            connect_under_reset: false,
            expected_target: None,
            network: Some(device.clone()),
            protocol,
        };
        // Ensure an unreachable/offline probe cannot count as the expected no-target result.
        drop(crate::sticks3_network::open_probe(&device).unwrap());
        let state = FirmwareState::default();
        let job = state.begin().unwrap();
        let error = execute_job(&config, Operation::Identify, &state)
            .err()
            .expect("No target cannot report chip identity");
        assert!(
            error.contains("ARM 调试接口")
                || error.contains("目标自动识别")
                || error.contains("芯片识别寄存器"),
            "{error}"
        );
        assert_eq!(state.snapshot().stage, "error");
        drop(job);
        assert!(!state.snapshot().busy);
        println!("{protocol:?}: expected no-target failure, job released: {error}");
    }
}

#[test]
#[ignore = "Requires StickS3 + G431 and explicit WL1_SWD_* environment variables"]
fn sticks3_g431_read_and_verify() {
    let probe_id = std::env::var("WL1_SWD_PROBE").expect("set the exact probe identity");
    assert!(probe_id.starts_with("303a:4004:"));
    let baseline =
        std::fs::read(std::env::var("WL1_SWD_BASELINE").expect("set backup path")).unwrap();
    let output =
        std::path::PathBuf::from(std::env::var("WL1_SWD_OUTPUT").expect("set output directory"));
    assert_eq!(baseline.len(), 128 * 1024);
    let config = ProbeConfig {
        probe_id,
        chip: Chip::Stm32g431cbu6.into(),
        speed_khz: std::env::var("WL1_SWD_SPEED")
            .unwrap_or_else(|_| "100".into())
            .parse()
            .unwrap(),
        connect_under_reset: false,
        expected_target: None,
        network: None,
        protocol: DebugProtocol::Swd,
    };
    let state = FirmwareState::default();
    let _job = state.begin().unwrap();
    let identified = execute_job(&config, Operation::Identify, &state).unwrap();
    println!("IDENTITY {}", serde_json::to_string(&identified).unwrap());
    let report = execute_job(&config, Operation::Read, &state).unwrap();
    let data = report.data.as_ref().unwrap();
    std::fs::create_dir_all(&output).unwrap();
    std::fs::write(output.join("probe-rs-flash.bin"), data).unwrap();
    assert_eq!(
        data, &baseline,
        "full Flash must match the independent backup"
    );
    println!(
        "READ {} bytes SHA256 {}",
        report.bytes,
        report.sha256.as_deref().unwrap()
    );
    let mut request = ImageRequest {
        format: ImageFormat::Bin,
        data: baseline,
        base_address: FLASH_START,
        chip: config.chip,
    };
    execute_job(
        &config,
        Operation::Verify(prepare_image(&request).unwrap()),
        &state,
    )
    .unwrap();
    // A mismatch at the very last byte must be reported, including its address.
    request.data[128 * 1024 - 1] ^= 1;
    let error = execute_job(
        &config,
        Operation::Verify(prepare_image(&request).unwrap()),
        &state,
    )
    .err()
    .unwrap();
    assert!(error.contains("0x0801FFFF"), "{error}");
    println!("MISMATCH correctly rejected: {error}");
    execute_job(&config, Operation::Reset, &state).unwrap();
    std::fs::write(
        output.join("identity.json"),
        serde_json::to_vec_pretty(&identified).unwrap(),
    )
    .unwrap();
}

#[test]
#[ignore = "Requires a connected supported STM32, exact WL1_SWD_PROBE and an independent WL1_SWD_BASELINE backup"]
fn sticks3_automatic_capacity_read_and_verify() {
    let probe_id = std::env::var("WL1_SWD_PROBE").expect("set the exact probe identity");
    assert!(probe_id.starts_with("303a:4004:"));
    let baseline =
        std::fs::read(std::env::var("WL1_SWD_BASELINE").expect("set independent backup path"))
            .unwrap();
    let config = ProbeConfig {
        probe_id,
        chip: TargetSelection::AUTO,
        speed_khz: std::env::var("WL1_SWD_SPEED")
            .unwrap_or_else(|_| "100".into())
            .parse()
            .unwrap(),
        connect_under_reset: false,
        expected_target: None,
        network: None,
        protocol: DebugProtocol::Swd,
    };
    let state = FirmwareState::default();
    let _job = state.begin().unwrap();
    let identified = execute_job(&config, Operation::Identify, &state).unwrap();
    assert_eq!(identified.chip.flash_size, baseline.len());
    println!(
        "AUTOMATIC IDENTITY {}",
        serde_json::to_string(&identified).unwrap()
    );
    let report = execute_job(&config, Operation::Read, &state).unwrap();
    assert_eq!(report.data.as_ref().unwrap(), &baseline);
    assert_eq!(report.bytes, baseline.len());
    let mut request = ImageRequest {
        format: ImageFormat::Bin,
        data: baseline,
        base_address: FLASH_START,
        chip: TargetSelection::AUTO,
    };
    execute_job(
        &config,
        Operation::Verify(prepare_image(&request).unwrap()),
        &state,
    )
    .unwrap();
    request.data.push(0xff);
    let error = execute_job(
        &config,
        Operation::Verify(prepare_image(&request).unwrap()),
        &state,
    )
    .err()
    .unwrap();
    assert!(error.contains("超出实测"), "{error}");
    if let Ok(directory) = std::env::var("WL1_SWD_OUTPUT") {
        let output = std::path::PathBuf::from(directory);
        std::fs::create_dir_all(&output).unwrap();
        std::fs::write(output.join("automatic-flash.bin"), report.data.unwrap()).unwrap();
        std::fs::write(
            output.join("automatic-identity.json"),
            serde_json::to_vec_pretty(&identified).unwrap(),
        )
        .unwrap();
    }
}

#[test]
#[ignore = "Requires connected StickS3 and STM32F103 reporting 64 KiB; set WL1_SWD_PROBE to the exact probe identity"]
fn sticks3_f103_auto_identify() {
    let probe_id = std::env::var("WL1_SWD_PROBE").expect("set the exact probe identity");
    assert!(probe_id.starts_with("303a:4004:"));
    let config = ProbeConfig {
        probe_id,
        chip: TargetSelection::AUTO,
        speed_khz: 100,
        connect_under_reset: false,
        expected_target: None,
        network: None,
        protocol: DebugProtocol::Swd,
    };
    let state = FirmwareState::default();
    let _job = state.begin().unwrap();
    let report = execute_job(&config, Operation::Identify, &state).unwrap();
    assert_eq!(report.chip.device_id, 0x410);
    assert_eq!(report.chip.flash_size, 64 * 1024);
    assert_eq!(report.chip.target, "STM32F103C8Tx");
    println!("{}", serde_json::to_string(&report).unwrap());
}
