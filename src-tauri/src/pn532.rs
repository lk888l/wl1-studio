//! PN532 HSU frame codec and command builders.
//!
//! Wire format per NXP UM0701-02 §6.2.1. A normal information frame is
//! `00 00 FF LEN LCS TFI DATA DCS 00`, where `LEN` counts the TFI byte plus the
//! payload, `LCS` is the two's complement of `LEN`, and `DCS` is the two's
//! complement of the byte sum over `TFI + DATA`. ACK and NACK are fixed
//! six-byte frames that share the start code, so every parser here must
//! discriminate them from a short information frame before trusting `LEN`.
//!
//! This module performs no I/O. It is deliberately testable without a reader
//! attached, which is why the codec and the serial session live apart.

/// Frame identifier used by the host (and expected in every response).
pub const HOST_TFI: u8 = 0xD4;
/// Frame identifier the PN532 answers with.
pub const CHIP_TFI: u8 = 0xD5;
/// The PN532 reports application errors under this reserved TFI.
pub const ERROR_TFI: u8 = 0x7F;

/// The three bytes that follow the `00 FF` start code of an ACK. ACK and NACK
/// share the start code and differ only here, which is why a parser must match
/// them before it trusts the byte in the LEN position.
pub const ACK_TAIL: [u8; 3] = [0x00, 0xFF, 0x00];
/// ... and of a NACK, which is host→PN532 only.
pub const NACK_TAIL: [u8; 3] = [0xFF, 0x00, 0x00];

pub const CMD_GET_FIRMWARE_VERSION: u8 = 0x02;
pub const CMD_SAM_CONFIGURATION: u8 = 0x14;
pub const CMD_RF_CONFIGURATION: u8 = 0x32;
pub const CMD_IN_LIST_PASSIVE_TARGET: u8 = 0x4A;
pub const CMD_IN_DATA_EXCHANGE: u8 = 0x40;
pub const CMD_IN_RELEASE: u8 = 0x52;

/// SAMConfiguration mode 0x01: normal PCD operation. The chip boots in LowVbat
/// mode, where the host cannot get a normal command/ACK dialog until this is
/// sent (UM0701 §3.1.3.3).
pub const SAM_MODE_NORMAL: u8 = 0x01;

/// InListPassiveTarget BrTy for 106 kbps ISO/IEC14443-3 Type A, i.e. MIFARE.
pub const BR_106K_TYPE_A: u8 = 0x00;

/// Longest information frame the PN532 accepts: LEN counts TFI plus payload.
const MAX_FRAME_BYTES: usize = 255;

/// The PN532 does not answer at all if a frame has a bad LCS or DCS, so a
/// silent link is indistinguishable from an unwritten byte. Keeping the
/// checksum arithmetic in one place makes that failure mode auditable.
fn two_complement(value: u16) -> u8 {
    ((0x100_u16.wrapping_sub(value & 0xFF)) & 0xFF) as u8
}

fn data_checksum(body: &[u8]) -> u8 {
    two_complement(body.iter().fold(0_u16, |sum, byte| sum + u16::from(*byte)))
}

/// Encodes one host→PN532 information frame. `payload` is the command code
/// followed by its parameters, without the TFI byte.
pub fn encode_frame(payload: &[u8]) -> Result<Vec<u8>, String> {
    if payload.is_empty() {
        return Err("PN532 命令不能为空".into());
    }
    let len = payload.len() + 1;
    if len > MAX_FRAME_BYTES {
        return Err(format!(
            "PN532 单帧数据 {len} 字节超过 255 字节上限；请拆分数据后重试"
        ));
    }
    let len = len as u8;
    let mut frame = Vec::with_capacity(payload.len() + 8);
    frame.extend_from_slice(&[0x00, 0x00, 0xFF, len, two_complement(u16::from(len))]);
    frame.push(HOST_TFI);
    frame.extend_from_slice(payload);
    frame.push(data_checksum(&[&[HOST_TFI][..], payload].concat()));
    frame.push(0x00);
    Ok(frame)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pn532Frame {
    Ack,
    Nack,
    /// Application-level error frame (TFI 0x7F). UM0701's syntax-error frame is
    /// `00 00 FF 01 FF 7F 81 00`, whose LEN of 1 covers the TFI alone, so in
    /// practice there is no status byte. It is kept optional rather than
    /// modelled as a zero code that could be mistaken for a real value.
    Error(Option<u8>),
    /// Normal response. `data` still begins with the response command code.
    Response(Vec<u8>),
}

/// Incremental frame splitter. Serial reads rarely align with frame
/// boundaries, and the link carries ACK/NACK/error frames interleaved with
/// responses, so callers must be able to feed arbitrary chunks and drain
/// whole frames.
#[derive(Default)]
pub struct FrameParser {
    buffer: Vec<u8>,
}

impl FrameParser {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, bytes: &[u8]) {
        self.buffer.extend_from_slice(bytes);
    }

    pub fn clear(&mut self) {
        self.buffer.clear();
    }

    /// Position of the `00 FF` start code, or `None` when the buffer holds no
    /// complete pair.
    fn find_start_code(&self) -> Option<usize> {
        self.buffer.windows(2).position(|pair| pair == [0x00, 0xFF])
    }

    /// Discards leading bytes that cannot begin a frame, keeping a trailing
    /// `0x00` because it may be the first half of a start code split across
    /// two reads.
    fn resync(&mut self) {
        if self.buffer.last() == Some(&0x00) {
            let keep = self.buffer.len() - 1;
            self.buffer.drain(..keep);
        } else {
            self.buffer.clear();
        }
    }

    pub fn next_frame(&mut self) -> Option<Pn532Frame> {
        loop {
            let Some(start) = self.find_start_code() else {
                // Nothing framing-worthy is buffered. Trim to at most a
                // trailing zero, which may be the first half of a start code
                // split across two reads; without this a noisy line would grow
                // the buffer without bound.
                self.resync();
                return None;
            };
            if start > 0 {
                self.buffer.drain(..start);
            }
            // The buffer now begins at the start code, so ACK and NACK are the
            // three bytes after it. They are matched before LEN is read because
            // both are shorter than any information frame.
            if self.buffer.len() < 3 {
                return None;
            }
            if self.buffer[2] == ACK_TAIL[0] || self.buffer[2] == NACK_TAIL[0] {
                if self.buffer.len() < 5 {
                    return None;
                }
                let tail = &self.buffer[2..5];
                // An extended information frame also begins `00 FF FF`, but it
                // marks itself with a second 0xFF in the LEN slot. No command
                // this app issues produces one, so treating it as a NACK keeps
                // the parse deterministic.
                let matched = if tail == ACK_TAIL {
                    Some(Pn532Frame::Ack)
                } else if tail == NACK_TAIL {
                    Some(Pn532Frame::Nack)
                } else {
                    None
                };
                if let Some(frame) = matched {
                    self.buffer.drain(..5);
                    return Some(frame);
                }
                self.buffer.drain(..1);
                continue;
            }
            if self.buffer.len() < 4 {
                return None;
            }
            let len = usize::from(self.buffer[2]);
            let lcs = self.buffer[3];
            // 0xFF/0xFF marks the extended frame form, which never carries a
            // response to the commands this app issues. Drop a byte so the
            // search can advance instead of stalling on it.
            if len == 0xFF || lcs != two_complement(len as u16) {
                self.buffer.drain(..1);
                continue;
            }
            let total = len + 6;
            if self.buffer.len() < total {
                return None;
            }
            let body = self.buffer[4..4 + len].to_vec();
            let dcs = self.buffer[4 + len];
            if dcs != data_checksum(&body) {
                self.buffer.drain(..1);
                continue;
            }
            self.buffer.drain(..total);
            return match body.first().copied() {
                Some(ERROR_TFI) => Some(Pn532Frame::Error(body.get(1).copied())),
                _ => Some(Pn532Frame::Response(body)),
            };
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FirmwareVersion {
    pub ic: u8,
    pub version: u8,
    pub revision: u8,
    pub support: u8,
}

impl FirmwareVersion {
    /// UM0701 §7.2.2: the IC byte is 0x32 on a genuine PN532.
    pub fn is_pn532(&self) -> bool {
        self.ic == 0x32
    }

    pub fn supports_iso14443a(&self) -> bool {
        self.support & 0x01 != 0
    }
}

pub fn get_firmware_version_command() -> Vec<u8> {
    vec![CMD_GET_FIRMWARE_VERSION]
}

/// Normal-mode SAM configuration. `timeout` is only meaningful in virtual-card
/// mode; `irq` must be sent explicitly whenever a timeout is present because
/// the two are positional.
pub fn sam_configuration_command(timeout: u8, irq: u8) -> Vec<u8> {
    vec![CMD_SAM_CONFIGURATION, SAM_MODE_NORMAL, timeout, irq]
}

/// RFConfiguration CfgItem 0x05 — the three retry counters.
///
/// `passive_activation` matters most: its power-on default is 0xFF, which
/// makes InListPassiveTarget retry forever when no card is present
/// (UM0701 §7.3.5). One attempt keeps every scan bounded so the host can poll
/// and stay cancellable.
pub fn rf_configuration_max_retries(atr: u8, psl: u8, passive_activation: u8) -> Vec<u8> {
    vec![CMD_RF_CONFIGURATION, 0x05, atr, psl, passive_activation]
}

pub fn in_list_passive_target_command(max_targets: u8, baud_rate: u8) -> Vec<u8> {
    vec![CMD_IN_LIST_PASSIVE_TARGET, max_targets, baud_rate]
}

pub fn in_data_exchange_command(target: u8, data_out: &[u8]) -> Vec<u8> {
    let mut command = Vec::with_capacity(data_out.len() + 2);
    command.push(CMD_IN_DATA_EXCHANGE);
    command.push(target);
    command.extend_from_slice(data_out);
    command
}

pub fn in_release_command(target: u8) -> Vec<u8> {
    vec![CMD_IN_RELEASE, target]
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PassiveTarget {
    pub target: u8,
    /// ATQA, most significant byte first as transmitted by the card.
    pub sens_res: [u8; 2],
    pub sel_res: u8,
    pub uid: Vec<u8>,
}

pub fn parse_firmware_version(data: &[u8]) -> Result<FirmwareVersion, String> {
    // `data` begins with the response code, already checked by the caller.
    if data.len() < 5 {
        return Err(format!(
            "PN532 固件版本响应长度异常：期望 5 字节，实际 {} 字节",
            data.len()
        ));
    }
    Ok(FirmwareVersion {
        ic: data[1],
        version: data[2],
        revision: data[3],
        support: data[4],
    })
}

/// Parses the `D5 4B ...` payload of InListPassiveTarget. `data` starts at the
/// response code, so the target count is at offset 1. A count of zero is a
/// normal "no card in the field" result, not an error.
pub fn parse_list_passive_target(data: &[u8]) -> Result<Vec<PassiveTarget>, String> {
    let Some(&count) = data.get(1) else {
        return Err("PN532 寻卡响应缺少目标数量字段".into());
    };
    let mut targets = Vec::with_capacity(usize::from(count));
    let mut position = 2;
    for _ in 0..count {
        let fields = data
            .get(position..position + 5)
            .ok_or("PN532 寻卡响应在目标头处被截断")?;
        let target = fields[0];
        let sens_res = [fields[1], fields[2]];
        let sel_res = fields[3];
        let uid_length = usize::from(fields[4]);
        position += 5;
        let uid = data
            .get(position..position + uid_length)
            .ok_or("PN532 寻卡响应在 UID 处被截断")?
            .to_vec();
        position += uid_length;
        // ISO/IEC14443-4 targets append an ATS; skip it so a second target's
        // fields stay aligned. Everything this app reads is pre-14443-4 Type A,
        // but a mixed field is possible and must not desynchronise the parse.
        if sel_res & 0x20 != 0 {
            if let Some(&ats_length) = data.get(position) {
                position = (position + 1 + usize::from(ats_length)).min(data.len());
            }
        }
        targets.push(PassiveTarget {
            target,
            sens_res,
            sel_res,
            uid,
        });
    }
    Ok(targets)
}

/// Splits an `D5 41 ...` payload into status and data. A non-zero status
/// carries no data field at all, so callers must not read past it.
pub fn parse_data_exchange(data: &[u8]) -> Result<(u8, Vec<u8>), String> {
    let Some(&status) = data.get(1) else {
        return Err("PN532 数据交换响应缺少状态字节".into());
    };
    Ok((status, data.get(2..).unwrap_or_default().to_vec()))
}

/// UM0701 Table 13. Codes are shared by every RF command, so one table serves
/// the whole app.
pub fn status_text(code: u8) -> &'static str {
    match code {
        0x00 => "成功",
        0x01 => "超时：卡片未应答",
        0x02 => "CRC 校验错误",
        0x03 => "奇偶校验错误",
        0x04 => "防冲突阶段位计数错误",
        0x05 => "Mifare 操作帧错误",
        0x06 => "106 kbps 位防冲突检测到异常冲突",
        0x07 => "通信缓冲区不足",
        0x09 => "RF 缓冲区溢出",
        0x0A => "有源通信模式下对方未及时开启射频场",
        0x0B => "RF 协议错误",
        0x0D => "温度过高，天线驱动已自动关闭",
        0x0E => "内部缓冲区溢出",
        0x10 => "参数无效",
        0x12 => "目标模式下不支持收到的命令",
        0x13 => "数据格式与协议不符",
        0x14 => "Mifare 认证失败（密钥不匹配）",
        0x23 => "UID 校验字节错误",
        0x25 => "设备状态无效",
        0x26 => "当前宿主接口配置下不允许该操作",
        0x27 => "当前上下文不接受该命令（目标号未知或状态不符）",
        0x29 => "作为目标时已被发起方释放",
        0x2A => "卡片 ID 与预期不符",
        0x2B => "先前激活的卡片已离开射频场",
        0x2C => "NFCID3 不匹配",
        0x2D => "检测到过流事件",
        0x2E => "DEP 帧缺少 NAD",
        _ => "未知错误",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn firmware_request_matches_the_manual_example() {
        // UM0701 §7.2.2 worked example.
        assert_eq!(
            encode_frame(&get_firmware_version_command()).unwrap(),
            [0x00, 0x00, 0xFF, 0x02, 0xFE, 0xD4, 0x02, 0x2A, 0x00]
        );
    }

    #[test]
    fn authenticate_and_read_frames_use_the_manual_payloads() {
        // UM0701 §7.3.8: authenticate key FFFFFFFFFFFF on block 0x02 of a card
        // whose UID is E2 3F B8 1E. LEN counts TFI plus the 14 payload bytes.
        let mut auth = vec![0x60, 0x02];
        auth.extend_from_slice(&[0xFF; 6]);
        auth.extend_from_slice(&[0xE2, 0x3F, 0xB8, 0x1E]);
        assert_eq!(
            encode_frame(&in_data_exchange_command(1, &auth)).unwrap(),
            [
                0x00, 0x00, 0xFF, 0x0F, 0xF1, 0xD4, 0x40, 0x01, 0x60, 0x02, 0xFF, 0xFF, 0xFF, 0xFF,
                0xFF, 0xFF, 0xE2, 0x3F, 0xB8, 0x1E, 0x98, 0x00
            ]
        );
        assert_eq!(
            encode_frame(&in_data_exchange_command(1, &[0x30, 0x02])).unwrap(),
            [0x00, 0x00, 0xFF, 0x05, 0xFB, 0xD4, 0x40, 0x01, 0x30, 0x02, 0xB9, 0x00]
        );
        assert_eq!(
            encode_frame(&in_list_passive_target_command(1, BR_106K_TYPE_A)).unwrap(),
            [0x00, 0x00, 0xFF, 0x04, 0xFC, 0xD4, 0x4A, 0x01, 0x00, 0xE1, 0x00]
        );
    }

    #[test]
    fn every_encoded_frame_round_trips_through_its_own_length_prefix() {
        // Guards the LEN/LCS invariant across the whole command set rather than
        // one hand-checked example per command.
        for payload in [
            get_firmware_version_command(),
            sam_configuration_command(0x00, 0x01),
            rf_configuration_max_retries(0x02, 0x01, 0x01),
            in_list_passive_target_command(1, BR_106K_TYPE_A),
            in_release_command(1),
            in_data_exchange_command(1, &[0xA0, 0x04]),
            in_data_exchange_command(1, &[0x5A; 200]),
        ] {
            let frame = encode_frame(&payload).unwrap();
            // Layout: 00 | 00 FF | LEN LCS | TFI payload | DCS 00
            assert_eq!(frame.len(), payload.len() + 8);
            assert_eq!(frame[3], payload.len() as u8 + 1);
            assert_eq!(frame[4], two_complement(payload.len() as u16 + 1));
            assert_eq!(frame[5], HOST_TFI);
            assert_eq!(&frame[6..6 + payload.len()], &payload[..]);
            assert_eq!(
                data_checksum(&[&[HOST_TFI][..], &payload[..]].concat()),
                frame[frame.len() - 2]
            );
            assert_eq!(frame[frame.len() - 1], 0x00);
        }
    }

    #[test]
    fn checksums_are_two_complement_not_bitwise_not() {
        // LEN 0x02 -> LCS 0xFE (not 0xFD), DCS over D4+02 -> 0x2A.
        let frame = encode_frame(&[0x02]).unwrap();
        assert_eq!(frame[4], 0xFE);
        assert_eq!(frame[7], 0x2A);
        // A payload whose byte sum is exactly 0x00 must still produce DCS 0x00.
        let frame = encode_frame(&[0x2C]).unwrap();
        assert_eq!(data_checksum(&[0xD4, 0x2C]), 0x00);
        assert_eq!(*frame.last().unwrap(), 0x00);
    }

    #[test]
    fn rejects_empty_and_oversized_payloads() {
        assert!(encode_frame(&[]).is_err());
        assert!(encode_frame(&vec![0x00; 255]).is_err());
        assert!(encode_frame(&vec![0x00; 254]).is_ok());
    }

    /// The on-wire forms, rebuilt from the tails so the two definitions cannot
    /// drift apart.
    fn ack_frame() -> Vec<u8> {
        [&[0x00, 0x00, 0xFF][..], &ACK_TAIL[..]].concat()
    }
    fn nack_frame() -> Vec<u8> {
        [&[0x00, 0x00, 0xFF][..], &NACK_TAIL[..]].concat()
    }

    #[test]
    fn parser_recognises_ack_nack_and_error_frames() {
        let mut parser = FrameParser::new();
        parser.push(&ack_frame());
        assert_eq!(parser.next_frame(), Some(Pn532Frame::Ack));
        parser.push(&nack_frame());
        assert_eq!(parser.next_frame(), Some(Pn532Frame::Nack));
        // UM0701 §6.2.3 syntax-error frame: LEN covers the TFI only.
        parser.push(&[0x00, 0x00, 0xFF, 0x01, 0xFF, 0x7F, 0x81, 0x00]);
        assert_eq!(parser.next_frame(), Some(Pn532Frame::Error(None)));
        assert_eq!(parser.next_frame(), None);
    }

    #[test]
    fn parser_survives_split_and_coalesced_reads() {
        // A GetFirmwareVersion response: D5 03 32 01 06 07 (FW 1.6, Type A+B+18092).
        let ack_then_response = [
            &ack_frame()[..],
            &[
                0x00, 0x00, 0xFF, 0x06, 0xFA, 0xD5, 0x03, 0x32, 0x01, 0x06, 0x07, 0xE8, 0x00,
            ][..],
        ]
        .concat();
        let mut parser = FrameParser::new();
        for chunk in ack_then_response.chunks(3) {
            parser.push(chunk);
        }
        assert_eq!(parser.next_frame(), Some(Pn532Frame::Ack));
        assert_eq!(
            parser.next_frame(),
            Some(Pn532Frame::Response(vec![
                0xD5, 0x03, 0x32, 0x01, 0x06, 0x07
            ]))
        );
        assert_eq!(parser.next_frame(), None);
    }

    #[test]
    fn parser_handles_every_two_byte_split_of_an_ack() {
        // A start code straddling a read boundary is the common real-world case.
        let ack = ack_frame();
        for split in 0..ack.len() {
            let mut parser = FrameParser::new();
            parser.push(&ack[..split]);
            assert_eq!(parser.next_frame(), None, "split {split} 不应提前成帧");
            parser.push(&ack[split..]);
            assert_eq!(parser.next_frame(), Some(Pn532Frame::Ack), "split {split}");
        }
    }

    #[test]
    fn parser_keeps_a_trailing_zero_that_may_start_a_frame() {
        let mut parser = FrameParser::new();
        parser.push(&[0xAA, 0xBB, 0x00]);
        assert_eq!(parser.next_frame(), None);
        parser.push(&[0xFF, 0x02, 0xFE, 0xD5, 0x03, 0x28, 0x00]);
        assert_eq!(
            parser.next_frame(),
            Some(Pn532Frame::Response(vec![0xD5, 0x03]))
        );
    }

    #[test]
    fn a_short_information_frame_is_not_mistaken_for_an_ack() {
        // `00 FF 00` also opens an ACK, so the trailing bytes must agree too.
        let mut parser = FrameParser::new();
        parser.push(&[0x00, 0x00, 0xFF, 0x00, 0xFF, 0x01]);
        assert_eq!(parser.next_frame(), None);
    }

    #[test]
    fn parser_discards_frames_with_bad_checksums() {
        let mut parser = FrameParser::new();
        // Correct DCS 0x2A corrupted to 0x00.
        parser.push(&[0x00, 0x00, 0xFF, 0x02, 0xFE, 0xD4, 0x02, 0x00, 0x00]);
        assert_eq!(parser.next_frame(), None);
        // The next well-formed frame must still be recovered.
        parser.push(&[0x00, 0x00, 0xFF, 0x02, 0xFE, 0xD4, 0x02, 0x2A, 0x00]);
        assert_eq!(
            parser.next_frame(),
            Some(Pn532Frame::Response(vec![0xD4, 0x02]))
        );
    }

    #[test]
    fn parses_the_manual_list_passive_target_example() {
        // UM0701 §7.3.5: 92 2E 58 32, ATQA 04 00, SAK 08.
        let data = [
            0x4B, 0x01, 0x01, 0x04, 0x00, 0x08, 0x04, 0x92, 0x2E, 0x58, 0x32,
        ];
        assert_eq!(
            parse_list_passive_target(&data).unwrap(),
            [PassiveTarget {
                target: 1,
                sens_res: [0x04, 0x00],
                sel_res: 0x08,
                uid: vec![0x92, 0x2E, 0x58, 0x32],
            }]
        );
    }

    #[test]
    fn no_card_in_field_is_an_empty_result_not_an_error() {
        assert_eq!(parse_list_passive_target(&[0x4B, 0x00]).unwrap(), []);
    }

    #[test]
    fn truncated_targets_are_reported_instead_of_panicking() {
        assert!(parse_list_passive_target(&[0x4B]).is_err());
        assert!(parse_list_passive_target(&[0x4B, 0x01, 0x01, 0x04]).is_err());
        // UID length runs past the end of the buffer.
        assert!(
            parse_list_passive_target(&[0x4B, 0x01, 0x01, 0x04, 0x00, 0x08, 0x07, 0x92]).is_err()
        );
    }

    #[test]
    fn seven_byte_uid_targets_keep_a_second_target_aligned() {
        let data = [
            0x4B, 0x02, // two targets
            0x01, 0x44, 0x00, 0x00, 0x07, 0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, //
            0x02, 0x04, 0x00, 0x08, 0x04, 0x92, 0x2E, 0x58, 0x32,
        ];
        let targets = parse_list_passive_target(&data).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].uid, [0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66]);
        assert_eq!(targets[1].uid, [0x92, 0x2E, 0x58, 0x32]);
    }

    #[test]
    fn iso14443_4_targets_skip_their_ats_before_the_next_target() {
        let data = [
            0x4B, 0x02, //
            0x01, 0x44, 0x00, 0x20, 0x07, 0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, //
            0x02, 0xAA, 0xBB, // ATS, length byte 0x02 then two bytes
            0x02, 0x04, 0x00, 0x08, 0x04, 0x92, 0x2E, 0x58, 0x32,
        ];
        let targets = parse_list_passive_target(&data).unwrap();
        assert_eq!(targets.len(), 2);
        assert_eq!(targets[0].sel_res, 0x20);
        assert_eq!(targets[1].uid, [0x92, 0x2E, 0x58, 0x32]);
    }

    #[test]
    fn an_ats_length_that_overruns_the_buffer_does_not_panic() {
        let data = [
            0x4B, 0x01, 0x01, 0x44, 0x00, 0x20, 0x07, 0x04, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66,
            0xFF, // claims 255 more bytes
        ];
        assert_eq!(parse_list_passive_target(&data).unwrap().len(), 1);
    }

    #[test]
    fn zero_status_carries_data_while_error_status_carries_none() {
        assert_eq!(
            parse_data_exchange(&[0x41, 0x00, 0x01, 0x02]).unwrap(),
            (0x00, vec![0x01, 0x02])
        );
        assert_eq!(parse_data_exchange(&[0x41, 0x14]).unwrap(), (0x14, vec![]));
        assert!(parse_data_exchange(&[0x41]).is_err());
    }

    #[test]
    fn authentication_failure_reports_the_mifare_code() {
        // 0x14 is the auth error; 0x0E is an unrelated buffer overflow and must
        // never be surfaced as a key mismatch.
        assert!(status_text(0x14).contains("认证失败"));
        assert_ne!(status_text(0x14), status_text(0x0E));
        assert_eq!(status_text(0x00), "成功");
        assert_eq!(status_text(0x99), "未知错误");
    }

    #[test]
    fn firmware_version_identifies_a_pn532() {
        let version = parse_firmware_version(&[0x03, 0x32, 0x01, 0x06, 0x07]).unwrap();
        assert!(version.is_pn532());
        assert!(version.supports_iso14443a());
        assert_eq!(version.revision, 6);
        // A truncated reply must not be read as a valid PN532.
        assert!(parse_firmware_version(&[0x03, 0x32, 0x01, 0x06]).is_err());
        assert!(parse_firmware_version(&[0x03, 0x32]).is_err());
        // Genuine PN532 only: 0x32 is the IC byte.
        assert!(!parse_firmware_version(&[0x03, 0x31, 0x01, 0x06, 0x07])
            .unwrap()
            .is_pn532());
    }

    #[test]
    fn sam_configuration_always_sends_normal_mode() {
        assert_eq!(
            sam_configuration_command(0x00, 0x01),
            [0x14, 0x01, 0x00, 0x01]
        );
    }

    #[test]
    fn passive_activation_retries_are_bounded_away_from_the_infinite_default() {
        let command = rf_configuration_max_retries(0x02, 0x01, 0x01);
        assert_eq!(command, [0x32, 0x05, 0x02, 0x01, 0x01]);
        assert_ne!(command[4], 0xFF);
    }
}
