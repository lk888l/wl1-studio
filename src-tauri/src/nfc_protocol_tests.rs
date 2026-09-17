//! Exercises the real serial Link over a PTY, including ACK framing and PICC
//! authentication state. No physical card is touched by these tests.
use super::*;

static PTY_CREATION: Mutex<()> = Mutex::new(());

fn emulate(mut respond: impl FnMut(&[u8]) -> Vec<u8> + Send + 'static) -> Link {
    let guard = PTY_CREATION.lock().unwrap();
    let (mut device, mut host) = serialport::TTYPort::pair().unwrap();
    drop(guard);
    host.set_timeout(PORT_TIMEOUT).unwrap();
    device.set_timeout(Duration::from_millis(500)).unwrap();
    thread::spawn(move || {
        let mut parser = pn532::FrameParser::new();
        let mut buffer = [0; 512];
        loop {
            match device.read(&mut buffer) {
                Ok(0) => break,
                Ok(count) => parser.push(&buffer[..count]),
                Err(error) if error.kind() == ErrorKind::TimedOut => continue,
                Err(_) => break,
            }
            while let Some(frame) = parser.next_frame() {
                let Pn532Frame::Response(body) = frame else {
                    continue;
                };
                assert_eq!(body[0], pn532::HOST_TFI);
                let response = respond(&body[1..]);
                let mut body = vec![pn532::CHIP_TFI];
                body.extend(response);
                let len = body.len() as u8;
                let checksum = body
                    .iter()
                    .fold(0u8, |sum, byte| sum.wrapping_add(*byte))
                    .wrapping_neg();
                let mut wire = vec![0, 0, 0xFF, 0, 0xFF, 0, 0, 0, 0xFF, len, len.wrapping_neg()];
                wire.extend(body);
                wire.extend([checksum, 0]);
                if device.write_all(&wire).is_err() {
                    return;
                }
            }
        }
    });
    Link::new(Box::new(host), Arc::new(AtomicBool::new(false)))
}

fn target() -> PassiveTarget {
    PassiveTarget {
        target: 1,
        sens_res: [0, 4],
        sel_res: 8,
        uid: vec![1, 2, 3, 4],
    }
}

fn control(command: &[u8]) -> Option<Vec<u8>> {
    match command[0] {
        0x14 => Some(vec![0x15]),
        0x02 => Some(vec![3, 0x32, 1, 6, 7]),
        0x32 => Some(vec![0x33]),
        0x52 => Some(vec![0x53, 0]),
        0x4A => Some(vec![0x4B, 1, 1, 0, 4, 8, 4, 1, 2, 3, 4]),
        _ => None,
    }
}

fn source() -> CardDump {
    let sectors = mifare::sector_map(CardKind::Classic1K);
    CardDump {
        uid: "05060708".into(),
        atqa: "0004".into(),
        sak: 8,
        kind: CardKind::Classic1K,
        label: "MIFARE Classic 1K".into(),
        unit_size: 16,
        units: (0..64)
            .map(|index| {
                let mut bytes = [index as u8; 16];
                if index % 4 == 3 {
                    bytes[..6].fill(0);
                    bytes[6..10].copy_from_slice(&[0xFF, 7, 0x80, 0x69]);
                    bytes[10..].fill(0xFF);
                }
                DataUnit {
                    index,
                    sector: (index / 4) as u8,
                    data: Some(mifare::format_hex(&bytes)),
                    error: None,
                    is_trailer: index % 4 == 3,
                    is_manufacturer: index == 0,
                }
            })
            .collect(),
        sectors: sectors
            .iter()
            .map(|sector| SectorDump {
                index: sector.index,
                first_block: sector.first_block,
                block_count: sector.block_count,
                trailer_block: sector.trailer_block(),
                key_a: Some("FFFFFFFFFFFF".into()),
                key_b: Some("FFFFFFFFFFFF".into()),
                key_source: KeySource::Dictionary,
                resolved: true,
                access_summary: None,
                message: None,
            })
            .collect(),
        read_at: 0,
        duration_ms: 0,
        unresolved_sectors: 0,
        warnings: vec![],
    }
}

#[test]
fn reader_preserves_readable_key_b_without_trying_forbidden_authentication() {
    let mut active = false;
    let mut link = emulate(move |cmd| {
        if let Some(reply) = control(cmd) {
            active = false;
            return reply;
        }
        assert_eq!(cmd[0], 0x40);
        match cmd[2] {
            0x60 => {
                active = cmd[4..10] == [0xFF; 6];
                vec![0x41, if active { 0 } else { 0x14 }]
            }
            0x61 => panic!("readable Key B must not be used for authentication"),
            0x30 => {
                assert!(active);
                let mut bytes = [0; 16];
                if cmd[3] % 4 == 3 {
                    bytes[6..10].copy_from_slice(&[0xFF, 7, 0x80, 0x69]);
                    bytes[10..].fill(0xA5);
                }
                [vec![0x41, 0], bytes.to_vec()].concat()
            }
            _ => panic!("read operation attempted a write"),
        }
    });
    let dump = link.read_card(&ReadOptions::default(), |_| {}).unwrap();
    assert!(dump.units.iter().all(|unit| unit.data.is_some()));
    assert!(dump
        .sectors
        .iter()
        .all(|sector| sector.key_b.as_deref() == Some("A5A5A5A5A5A5")));
    assert!(dump.warnings.is_empty());
}

#[test]
fn reader_reauthenticates_after_denial_and_uses_custom_key_b_for_missing_block() {
    let mut active = None;
    let mut link = emulate(move |cmd| {
        if let Some(reply) = control(cmd) {
            active = None;
            return reply;
        }
        match cmd[2] {
            0x60 | 0x61 => {
                let is_b = cmd[2] == 0x61;
                let valid = cmd[4..10] == if is_b { [0xAB; 6] } else { [0xFF; 6] };
                active = valid.then_some(is_b);
                vec![0x41, if valid { 0 } else { 0x14 }]
            }
            0x30 => {
                let Some(is_b) = active else {
                    return vec![0x41, 0x14];
                };
                if cmd[3] % 4 == 1 && !is_b {
                    active = None;
                    return vec![0x41, 0x14];
                }
                let mut bytes = [0; 16];
                if cmd[3] % 4 == 3 {
                    bytes[6..10].copy_from_slice(&[0x7F, 7, 0x88, 0x69]);
                }
                [vec![0x41, 0], bytes.to_vec()].concat()
            }
            _ => panic!("unexpected command"),
        }
    });
    let dump = link
        .read_card(
            &ReadOptions {
                extra_keys: vec!["ABABABABABAB".into()],
                sector_keys: vec![],
            },
            |_| {},
        )
        .unwrap();
    assert!(dump.units.iter().all(|unit| unit.data.is_some()));
    assert!(dump
        .sectors
        .iter()
        .all(|sector| sector.key_a.as_deref() == Some("FFFFFFFFFFFF")
            && sector.key_b.as_deref() == Some("ABABABABABAB")));
}

#[test]
fn writer_retries_key_b_then_verifies_only_written_blocks_when_trailers_are_skipped() {
    let mut active = None;
    let mut memory = [[0u8; 16]; 64];
    let mut link = emulate(move |cmd| {
        if let Some(reply) = control(cmd) {
            active = None;
            return reply;
        }
        match cmd[2] {
            0x60 | 0x61 => {
                active = Some(cmd[2] == 0x61);
                vec![0x41, 0]
            }
            0xA0 => {
                assert_ne!(cmd[3], 0, "UID must be excluded");
                assert_ne!(cmd[3] % 4, 3, "trailers must be excluded");
                if active != Some(true) {
                    active = None;
                    return vec![0x41, 0x14];
                }
                memory[usize::from(cmd[3])].copy_from_slice(&cmd[4..20]);
                vec![0x41, 0]
            }
            0x30 => {
                assert!(active.is_some());
                [vec![0x41, 0], memory[usize::from(cmd[3])].to_vec()].concat()
            }
            _ => panic!("unexpected command"),
        }
    });
    let options: WriteOptions =
        serde_json::from_str(r#"{"writeTrailers":false,"sectors":[0]}"#).unwrap();
    let report = link.write_card(&source(), &options, |_| {}).unwrap();
    assert_eq!(report.blocks_written, 2);
    assert_eq!(report.blocks_skipped, 2);
    assert_eq!(report.blocks_verified, 2);
    assert!(report.verified);
    assert!(!report.complete_copy);
    assert!(!report.uid_matches);
}

#[test]
fn trailer_verification_checks_protected_keys_by_authentication_and_readable_fields_by_read() {
    let mut expected = [0; 16];
    expected[..6].fill(0xAA);
    expected[6..10].copy_from_slice(&[0x7F, 7, 0x88, 0x69]);
    expected[10..].fill(0xBB);
    let mut link = emulate(move |cmd| {
        if let Some(reply) = control(cmd) {
            return reply;
        }
        match cmd[2] {
            0x60 => vec![0x41, if cmd[4..10] == [0xAA; 6] { 0 } else { 0x14 }],
            0x61 => vec![0x41, if cmd[4..10] == [0xBB; 6] { 0 } else { 0x14 }],
            0x30 => {
                let mut masked = expected;
                masked[..6].fill(0);
                masked[10..].fill(0);
                [vec![0x41, 0], masked.to_vec()].concat()
            }
            _ => panic!("unexpected command"),
        }
    });
    assert!(link.verify_trailer(&mut target(), 3, &expected).unwrap());
    expected[10..].fill(0xCC);
    assert!(!link.verify_trailer(&mut target(), 3, &expected).unwrap());
}

#[test]
fn changed_card_is_rejected_before_further_memory_commands() {
    let mut link = emulate(|cmd| {
        let mut reply = control(cmd).expect("no memory command may reach another card");
        if cmd[0] == 0x4A {
            *reply.last_mut().unwrap() = 9;
        }
        reply
    });
    link.needs_reselect = true;
    assert!(link
        .ensure_selected(&mut target())
        .unwrap_err()
        .contains("更换"));
}

#[test]
fn source_card_and_invalid_dump_are_rejected_before_writes() {
    let mut link = emulate(|cmd| control(cmd).expect("no card memory access permitted"));
    let options: WriteOptions = serde_json::from_str("{}").unwrap();
    let mut dump = source();
    dump.uid = "01020304".into();
    assert!(link
        .write_card(&dump, &options, |_| {})
        .unwrap_err()
        .contains("保护原卡"));
    dump.units[63].index = 0;
    assert!(link
        .write_card(&dump, &options, |_| {})
        .unwrap_err()
        .contains("重复"));
}

#[test]
fn unknown_protected_key_b_and_any_access_bit_corruption_refuse_trailer() {
    let mut trailer = [0; 16];
    trailer[6..10].copy_from_slice(&[0x7F, 7, 0x88, 0x69]);
    assert!(prepare_trailer(&trailer, Some("FFFFFFFFFFFF"), None).is_none());
    let complete = prepare_trailer(&trailer, Some("FFFFFFFFFFFF"), Some("AABBCCDDEEFF")).unwrap();
    assert_eq!(&complete[10..], &[0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
    for byte in 6..9 {
        for bit in 0..8 {
            let mut broken = complete;
            broken[byte] ^= 1 << bit;
            assert!(mifare::decode_access_bits(&broken).is_none());
        }
    }
}

#[test]
fn uid_authentication_uses_last_cascade_and_unicode_hex_never_panics() {
    assert_eq!(
        authentication_uid(&[4, 1, 2, 3, 4, 5, 6]).unwrap(),
        [3, 4, 5, 6]
    );
    assert_eq!(authentication_uid(&[1, 2, 3, 4]).unwrap(), [1, 2, 3, 4]);
    assert!(authentication_uid(&[1, 2, 3]).is_err());
    assert!(mifare::parse_key("中中中中").is_err());
    assert!(mifare::decode_hex("中中").is_err());
}

#[test]
fn ntag_writes_only_user_pages_and_verifies_without_touching_lock_or_password_pages() {
    let mut memory = [[0u8; 4]; 45];
    let mut link = emulate(move |cmd| {
        if let Some(mut reply) = control(cmd) {
            if cmd[0] == 0x4A {
                reply[5] = 0;
            }
            return reply;
        }
        if cmd[0] == 0x42 {
            return vec![0x43, 0, 0, 4, 4, 2, 1, 0, 0x0F, 3];
        }
        match cmd[2] {
            0xA2 => {
                assert!(
                    (4..40).contains(&cmd[3]),
                    "must preserve manufacturer/OTP/lock/config/password pages"
                );
                memory[usize::from(cmd[3])].copy_from_slice(&cmd[4..8]);
                vec![0x41, 0]
            }
            0x30 => {
                let page = usize::from(cmd[3]);
                assert!(page + 4 <= 45, "must not depend on rollover");
                [vec![0x41, 0], memory[page..page + 4].concat()].concat()
            }
            _ => panic!("unexpected command"),
        }
    });
    let mut dump = source();
    dump.kind = CardKind::Ultralight;
    dump.sak = 0;
    dump.unit_size = 4;
    dump.sectors.clear();
    dump.units = (0..45)
        .map(|index| DataUnit {
            index,
            sector: 0,
            data: Some("AABBCCDD".into()),
            error: None,
            is_trailer: false,
            is_manufacturer: index < 3,
        })
        .collect();
    let options: WriteOptions = serde_json::from_str("{}").unwrap();
    let report = link.write_card(&dump, &options, |_| {}).unwrap();
    assert_eq!(report.blocks_written, 36);
    assert_eq!(report.blocks_verified, 36);
    assert_eq!(report.blocks_skipped, 9);
    assert!(report.verified);
    assert!(!report.complete_copy);
}

#[test]
fn ntag_read_preserves_missing_page_addresses_and_does_not_roll_over() {
    let mut link = emulate(|cmd| {
        if let Some(mut reply) = control(cmd) {
            if cmd[0] == 0x4A {
                reply[5] = 0;
            }
            return reply;
        }
        if cmd[0] == 0x42 {
            return vec![0x43, 0, 0, 4, 4, 2, 1, 0, 0x0F, 3];
        }
        assert_eq!(cmd[2], 0x30);
        if cmd[3] == 8 {
            return vec![0x41, 1];
        }
        assert!(cmd[3] <= 41);
        let mut bytes = vec![0x41, 0];
        for page in cmd[3]..cmd[3] + 4 {
            bytes.extend([page; 4]);
        }
        bytes
    });
    let dump = link.read_card(&ReadOptions::default(), |_| {}).unwrap();
    assert_eq!(dump.units.len(), 45);
    assert!(dump.units[8..12].iter().all(|unit| unit.data.is_none()));
    assert_eq!(dump.units[12].data.as_deref(), Some("0C0C0C0C"));
    assert_eq!(dump.units[44].data.as_deref(), Some("2C2C2C2C"));
}

#[test]
fn full_clone_changes_uid_last_and_verifies_under_the_new_identity() {
    let mut uid = vec![1, 2, 3, 4];
    let mut memory = [[0u8; 16]; 64];
    let mut writes = 0;
    let mut active = false;
    let mut link = emulate(move |cmd| {
        if let Some(mut reply) = control(cmd) {
            if cmd[0] == 0x4A {
                reply[7..11].copy_from_slice(&uid);
            }
            active = false;
            return reply;
        }
        match cmd[2] {
            0x60 | 0x61 => {
                active = cmd[4..10] == [0xFF; 6] && cmd[10..14] == uid;
                vec![0x41, if active { 0 } else { 0x14 }]
            }
            0xA0 => {
                assert!(active);
                if cmd[3] == 0 {
                    assert_eq!(writes, 63, "UID changes only after data and trailers");
                    uid = cmd[4..8].to_vec();
                }
                memory[usize::from(cmd[3])].copy_from_slice(&cmd[4..20]);
                writes += 1;
                vec![0x41, 0]
            }
            0x30 => {
                assert!(active);
                let mut bytes = memory[usize::from(cmd[3])];
                if cmd[3] % 4 == 3 {
                    bytes[..6].fill(0);
                }
                [vec![0x41, 0], bytes.to_vec()].concat()
            }
            _ => panic!("unexpected command"),
        }
    });
    let mut dump = source();
    dump.units[0].data = Some("050607080C0804000000000000000000".into());
    let options: WriteOptions = serde_json::from_str(r#"{"writeManufacturerBlock":true}"#).unwrap();
    let report = link.write_card(&dump, &options, |_| {}).unwrap();
    assert_eq!(report.blocks_written, 64);
    assert_eq!(report.blocks_verified, 64);
    assert_eq!(report.blocks_skipped, 0);
    assert_eq!(report.uid, dump.uid);
    assert!(report.complete_copy);
}

#[test]
fn request_timeout_cancels_and_waits_for_worker_before_releasing_busy() {
    let (sender, receiver) = mpsc::channel();
    let cancel = Arc::new(AtomicBool::new(false));
    let handle = SessionHandle {
        session_id: 1,
        jobs: sender,
        cancel: Arc::clone(&cancel),
    };
    let completed = Arc::new(AtomicBool::new(false));
    let done = Arc::clone(&completed);
    let worker = thread::spawn(move || {
        let NfcJob::Read { reply, .. } = receiver.recv().unwrap() else {
            panic!("wrong job");
        };
        while !cancel.load(Ordering::Acquire) {
            thread::yield_now();
        }
        done.store(true, Ordering::Release);
        reply.send(Err(CANCELLED.into())).unwrap();
    });
    let busy = AtomicBool::new(false);
    let result: Result<CardDump, String> = run_busy(&busy, &handle, || {
        handle.request(Duration::from_millis(1), |reply| NfcJob::Read {
            options: ReadOptions::default(),
            reply,
        })
    });
    assert!(result.unwrap_err().contains("超时"));
    assert!(completed.load(Ordering::Acquire));
    assert!(!busy.load(Ordering::Acquire));
    worker.join().unwrap();
}
