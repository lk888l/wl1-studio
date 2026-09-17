//! MIFARE Classic / Ultralight card model: layout, default keys, dumps and
//! write plans.
//!
//! The PN532 manual defers card-internal structure to the MIFARE specification
//! (UM0701 §7.3.8), so the sector geometry, trailer layout and access-bit
//! decoding below come from the MF1S50/MF1S70 memory organisation rather than
//! from the PN532 documentation.
//!
//! Nothing here performs I/O. Hidden keys require successful authentication;
//! readable Key B bytes are data and cannot be used for authentication.

use serde::{Deserialize, Serialize};

pub const BLOCK_BYTES: usize = 16;
pub const KEY_BYTES: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CardKind {
    /// Explicit names rather than a case-convention rule: `Iso14443_4` under
    /// camelCase would serialise to `iso144434` and lose the separator.
    #[serde(rename = "classic1k")]
    Classic1K,
    #[serde(rename = "classic4k")]
    Classic4K,
    #[serde(rename = "ultralight")]
    Ultralight,
    /// ISO/IEC 14443-4: DESFire, Plus SL3, JavaCard. Not readable with the
    /// MIFARE Classic command set.
    #[serde(rename = "iso14443_4")]
    Iso14443_4,
    #[serde(rename = "unknown")]
    Unknown,
}

impl CardKind {
    /// SAK is the single-byte select acknowledge from the Type A activation.
    pub fn from_sak(sak: u8) -> Self {
        match sak {
            0x08 => Self::Classic1K,
            0x18 => Self::Classic4K,
            0x00 => Self::Ultralight,
            0x20 | 0x28 | 0x38 | 0x98 | 0x88 => Self::Iso14443_4,
            _ => Self::Unknown,
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Classic1K => "MIFARE Classic 1K",
            Self::Classic4K => "MIFARE Classic 4K",
            Self::Ultralight => "MIFARE Ultralight / NTAG",
            Self::Iso14443_4 => "ISO/IEC 14443-4 卡片",
            Self::Unknown => "未知卡型",
        }
    }

    /// Classic cards need sector authentication; Ultralight uses unauthenticated
    /// page reads; 14443-4 cards need an APDU session this app does not open.
    pub fn is_classic(self) -> bool {
        matches!(self, Self::Classic1K | Self::Classic4K)
    }
}

/// One MIFARE Classic sector. Small sectors hold four 16-byte blocks; the eight
/// large sectors of a 4K card hold sixteen.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sector {
    pub index: u8,
    pub first_block: u16,
    pub block_count: u8,
}

impl Sector {
    /// The block holding Key A, the access bits and Key B. Authenticating here
    /// is equivalent to authenticating anywhere else in the sector, and it is
    /// the block a full read needs anyway.
    pub fn trailer_block(self) -> u16 {
        self.first_block + u16::from(self.block_count) - 1
    }

    pub fn blocks(self) -> std::ops::Range<u16> {
        self.first_block..self.first_block + u16::from(self.block_count)
    }

    /// All blocks except the sector trailer, including the manufacturer block
    /// in sector zero; write callers decide whether to include that block.
    pub fn data_blocks(self) -> std::ops::Range<u16> {
        self.first_block..self.trailer_block()
    }
}

/// Sector map for a card kind. Returns an empty map for card types that have no
/// MIFARE Classic sectors.
pub fn sector_map(kind: CardKind) -> Vec<Sector> {
    match kind {
        CardKind::Classic1K => (0..16)
            .map(|index| Sector {
                index,
                first_block: u16::from(index) * 4,
                block_count: 4,
            })
            .collect(),
        CardKind::Classic4K => {
            let mut sectors: Vec<Sector> = (0..32)
                .map(|index| Sector {
                    index,
                    first_block: u16::from(index) * 4,
                    block_count: 4,
                })
                .collect();
            sectors.extend((32..40).map(|index| Sector {
                index,
                first_block: 128 + (u16::from(index) - 32) * 16,
                block_count: 16,
            }));
            sectors
        }
        _ => Vec::new(),
    }
}

/// Keys from published vendor defaults and the two reference open-source
/// readers (`libnfc`/`mfoc` and MIFARE Classic Tool). This is a dictionary, not
/// a recovery attack: an unknown key simply stays unresolved.
pub const DEFAULT_KEYS: [[u8; KEY_BYTES]; 44] = [
    // The near-universal factory transport key.
    [0xFF; 6],
    [0x00; 6],
    // NXP / Mifare application notes.
    [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5],
    [0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7],
    [0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5],
    [0x4D, 0x3A, 0x99, 0xC3, 0x51, 0xDD],
    [0x1A, 0x98, 0x2C, 0x7E, 0x45, 0x9A],
    [0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF],
    // Public-transport and access-control vendor defaults.
    [0x71, 0x4C, 0x5C, 0x88, 0x6E, 0x97],
    [0x58, 0x7E, 0xE5, 0xF9, 0x35, 0x0F],
    [0xA0, 0x47, 0x8C, 0xC3, 0x90, 0x91],
    [0x53, 0x3C, 0xB6, 0xC7, 0x23, 0xF6],
    [0x8F, 0xD0, 0xA4, 0xF2, 0x56, 0xE9],
    [0x48, 0x45, 0x58, 0x41, 0x43, 0x54],
    [0x5A, 0x5A, 0x5A, 0x5A, 0x5A, 0x5A],
    [0xA0, 0xB0, 0xC0, 0xD0, 0xE0, 0xF0],
    [0x1A, 0x2B, 0x3C, 0x4D, 0x5E, 0x6F],
    [0x12, 0x34, 0x56, 0x78, 0x9A, 0xBC],
    [0x01, 0x02, 0x03, 0x04, 0x05, 0x06],
    [0x11, 0x22, 0x33, 0x44, 0x55, 0x66],
    [0x00, 0x11, 0x22, 0x33, 0x44, 0x55],
    [0x22, 0x22, 0x22, 0x22, 0x22, 0x22],
    [0x33, 0x33, 0x33, 0x33, 0x33, 0x33],
    [0x44, 0x44, 0x44, 0x44, 0x44, 0x44],
    [0x55, 0x55, 0x55, 0x55, 0x55, 0x55],
    [0x66, 0x66, 0x66, 0x66, 0x66, 0x66],
    [0x77, 0x77, 0x77, 0x77, 0x77, 0x77],
    [0x12, 0x12, 0x12, 0x12, 0x12, 0x12],
    [0x13, 0x13, 0x13, 0x13, 0x13, 0x13],
    [0x14, 0x14, 0x14, 0x14, 0x14, 0x14],
    [0x15, 0x15, 0x15, 0x15, 0x15, 0x15],
    [0x16, 0x16, 0x16, 0x16, 0x16, 0x16],
    [0x17, 0x17, 0x17, 0x17, 0x17, 0x17],
    [0x18, 0x18, 0x18, 0x18, 0x18, 0x18],
    [0x19, 0x19, 0x19, 0x19, 0x19, 0x19],
    [0x20, 0x20, 0x20, 0x20, 0x20, 0x20],
    [0x45, 0x42, 0x30, 0x30, 0x31, 0x44],
    [0x44, 0x49, 0x47, 0x49, 0x32, 0x30],
    [0x50, 0x41, 0x53, 0x53, 0x31, 0x32],
    [0x00, 0x01, 0x02, 0x03, 0x04, 0x05],
    [0x00, 0x00, 0x00, 0x00, 0x00, 0x01],
    [0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE],
    [0x4B, 0x4C, 0x4D, 0x4E, 0x4F, 0x50],
    [0x00, 0x00, 0xFF, 0xFF, 0x00, 0x00],
];

/// Renders a key the way it is written on cards and in vendor documentation.
pub fn format_key(key: &[u8; KEY_BYTES]) -> String {
    key.iter().map(|byte| format!("{byte:02X}")).collect()
}

pub fn format_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

/// Parses a user-supplied key. Whitespace, `:` and `-` separators are accepted
/// because that is how keys are pasted in practice.
pub fn parse_key(text: &str) -> Result<[u8; KEY_BYTES], String> {
    let cleaned: String = text
        .chars()
        .filter(|character| !character.is_whitespace() && *character != ':' && *character != '-')
        .collect();
    if cleaned.len() != KEY_BYTES * 2 {
        return Err(format!(
            "密钥必须是 {KEY_BYTES} 字节（12 个十六进制字符），当前为 {} 个字符",
            cleaned.len()
        ));
    }
    if !cleaned.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("密钥只能包含十六进制字符 0-9 A-F".into());
    }
    let mut key = [0_u8; KEY_BYTES];
    for (index, slot) in key.iter_mut().enumerate() {
        *slot = u8::from_str_radix(&cleaned[index * 2..index * 2 + 2], 16)
            .map_err(|_| "密钥只能包含十六进制字符 0-9 A-F".to_owned())?;
    }
    Ok(key)
}

/// The three access-bit nibbles of a sector trailer.
///
/// Decoded per MF1S50YYX_V1 §8.7, including all three redundancy pairs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AccessBits {
    pub c1: [u8; 4],
    pub c2: [u8; 4],
    pub c3: [u8; 4],
}

impl AccessBits {
    /// Table 7: readable Key B is data, not an authentication key.
    pub fn key_b_readable(self) -> bool {
        matches!(self.block(3), (0, 0, 0) | (0, 1, 0) | (0, 0, 1))
    }

    pub fn block(self, block: usize) -> (u8, u8, u8) {
        (self.c1[block], self.c2[block], self.c3[block])
    }

    /// Compact `C1C2C3` rendering per block, e.g. `000 000 000 001`.
    pub fn summary(self) -> String {
        (0..4)
            .map(|block| {
                let (c1, c2, c3) = self.block(block);
                format!("{c1}{c2}{c3}")
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
}

/// Decodes the three access-bit bytes of a sector trailer.
///
/// Byte 6 carries one nibble and its complement in byte 7; byte 8 carries the
/// third nibble complemented in its low half. Each nibble supplies one bit for
/// all four blocks. The complement pairs are checked so a hand-edited or
/// corrupted trailer is reported as undecodable rather than silently yielding
/// a plausible-looking triplet.
pub fn decode_access_bits(trailer: &[u8]) -> Option<AccessBits> {
    let bytes = trailer.get(6..9)?;
    let (b6, b7, b8) = (bytes[0], bytes[1], bytes[2]);

    // Nibble A: byte 7 high, complemented in byte 6 low.
    // Nibble B: byte 6 high, inverted.
    // Nibble C: byte 8 high, complemented in byte 7 low.
    if (b7 >> 4) != ((b6 & 0x0F) ^ 0x0F)
        || (b8 >> 4) != ((b7 & 0x0F) ^ 0x0F)
        || (b8 & 0x0F) != ((b6 >> 4) ^ 0x0F)
    {
        return None;
    }

    let mut bits = AccessBits {
        c1: [0; 4],
        c2: [0; 4],
        c3: [0; 4],
    };
    for block in 0..4 {
        let shift = 4 + block as u32;
        bits.c1[block] = (b7 >> shift) & 1;
        bits.c2[block] = ((b6 >> shift) & 1) ^ 1;
        bits.c3[block] = (b8 >> shift) & 1;
    }
    Some(bits)
}

/// Where a sector's key came from, so the UI can distinguish a confirmed
/// dictionary hit from a value that merely sat in a trailer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KeySource {
    Dictionary,
    Harvested,
    Manual,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SectorDump {
    pub index: u8,
    pub first_block: u16,
    pub block_count: u8,
    pub trailer_block: u16,
    pub key_a: Option<String>,
    pub key_b: Option<String>,
    pub key_source: KeySource,
    pub resolved: bool,
    pub access_summary: Option<String>,
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataUnit {
    pub index: u16,
    pub sector: u8,
    /// Hex payload, absent when the block could not be read.
    pub data: Option<String>,
    pub error: Option<String>,
    pub is_trailer: bool,
    /// Sector 0 block 0: the manufacturer block, read-only on genuine cards.
    pub is_manufacturer: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardDump {
    pub uid: String,
    pub atqa: String,
    pub sak: u8,
    pub kind: CardKind,
    pub label: String,
    /// 16 for Classic blocks, 4 for Ultralight pages.
    pub unit_size: u8,
    pub units: Vec<DataUnit>,
    pub sectors: Vec<SectorDump>,
    pub read_at: u64,
    pub duration_ms: u64,
    pub unresolved_sectors: u8,
    pub warnings: Vec<String>,
}

impl CardDump {
    pub fn is_readable(&self) -> bool {
        self.units.iter().any(|unit| unit.data.is_some())
    }
}

/// Validates the BCC byte that a MIFARE Classic manufacturer block carries.
///
/// Block 0 is `UID(4) BCC(1) SAK(1) ATQA(2) manufacturer(8)` and the BCC is the
/// XOR of the four UID bytes. A mismatched BCC means the dump came from a card
/// with a 7-byte UID, or was edited by hand; either way the value must not be
/// written back verbatim without the operator seeing it.
pub fn manufacturer_bcc_is_valid(block: &[u8]) -> Option<bool> {
    let uid = block.get(0..4)?;
    let bcc = *block.get(4)?;
    Some(uid.iter().fold(0_u8, |acc, byte| acc ^ byte) == bcc)
}

pub fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    if !text.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("包含非十六进制字符".into());
    }
    if !text.len().is_multiple_of(2) {
        return Err("十六进制字符串长度必须为偶数".into());
    }
    (0..text.len() / 2)
        .map(|index| {
            u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
                .map_err(|_| "包含非十六进制字符".to_owned())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_k_and_four_k_sector_geometry_matches_the_datasheet() {
        let one_k = sector_map(CardKind::Classic1K);
        assert_eq!(one_k.len(), 16);
        assert_eq!(one_k[0].trailer_block(), 3);
        assert_eq!(one_k[15].trailer_block(), 63);

        let four_k = sector_map(CardKind::Classic4K);
        assert_eq!(four_k.len(), 40);
        // 32 small sectors of four blocks, then 8 large sectors of sixteen.
        assert_eq!(four_k[31].first_block, 124);
        assert_eq!(four_k[31].trailer_block(), 127);
        assert_eq!(four_k[32].first_block, 128);
        assert_eq!(four_k[32].block_count, 16);
        assert_eq!(four_k[39].trailer_block(), 255);
        // Large sectors must sit inside the 4K address space.
        assert_eq!(four_k[39].trailer_block() + 1, 256);
    }

    #[test]
    fn unknown_and_14443_4_cards_have_no_sectors() {
        assert!(sector_map(CardKind::Unknown).is_empty());
        assert!(sector_map(CardKind::Ultralight).is_empty());
        assert!(sector_map(CardKind::Iso14443_4).is_empty());
    }

    #[test]
    fn sak_maps_to_the_expected_card_kinds() {
        assert_eq!(CardKind::from_sak(0x08), CardKind::Classic1K);
        assert_eq!(CardKind::from_sak(0x18), CardKind::Classic4K);
        assert_eq!(CardKind::from_sak(0x00), CardKind::Ultralight);
        assert!(!CardKind::from_sak(0x20).is_classic());
        assert_eq!(CardKind::from_sak(0x20), CardKind::Iso14443_4);
        assert!(CardKind::Classic1K.is_classic());
    }

    #[test]
    fn default_key_dictionary_covers_the_factory_transport_key_and_has_no_duplicates() {
        assert_eq!(DEFAULT_KEYS[0], [0xFF; 6]);
        assert!(DEFAULT_KEYS.contains(&[0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5]));
        for (index, key) in DEFAULT_KEYS.iter().enumerate() {
            assert!(
                !DEFAULT_KEYS[..index].contains(key),
                "重复密钥 {index}: {}",
                format_key(key)
            );
        }
    }

    #[test]
    fn access_bits_decode_the_factory_transport_trailer() {
        // FF FF FF FF FF FF | FF 07 80 69 | FF FF FF FF FF FF
        let mut trailer = vec![0xFF; 16];
        trailer[6..10].copy_from_slice(&[0xFF, 0x07, 0x80, 0x69]);
        let bits = decode_access_bits(&trailer).unwrap();
        assert_eq!(bits.c1, [0, 0, 0, 0]);
        assert_eq!(bits.c2, [0, 0, 0, 0]);
        assert_eq!(bits.c3, [0, 0, 0, 1]);
        assert_eq!(bits.summary(), "000 000 000 001");
    }

    #[test]
    fn access_bits_decode_a_second_transport_trailer() {
        let mut trailer = vec![0x00; 16];
        trailer[6..10].copy_from_slice(&[0x7F, 0x07, 0x88, 0x40]);
        let bits = decode_access_bits(&trailer).unwrap();
        assert_eq!(bits.c1, [0, 0, 0, 0]);
        assert_eq!(bits.c2, [0, 0, 0, 1]);
        assert_eq!(bits.c3, [0, 0, 0, 1]);
        assert_eq!(bits.summary(), "000 000 000 011");
    }

    #[test]
    fn inconsistent_access_nibbles_are_rejected() {
        // Byte 6's low nibble must be the complement of byte 7's high nibble.
        let mut trailer = vec![0x00; 16];
        trailer[6..9].copy_from_slice(&[0xF0, 0x07, 0x80]);
        assert!(decode_access_bits(&trailer).is_none());
        // Byte 7's low nibble must be the complement of byte 8's high nibble.
        let mut trailer = vec![0x00; 16];
        trailer[6..9].copy_from_slice(&[0xFF, 0x07, 0x90]);
        assert!(decode_access_bits(&trailer).is_none());
    }

    #[test]
    fn short_trailers_are_rejected_rather_than_indexed_out_of_range() {
        assert!(decode_access_bits(&[0x00; 8]).is_none());
        assert!(decode_access_bits(&[]).is_none());
    }

    #[test]
    fn key_parsing_accepts_common_separators_and_rejects_bad_length() {
        assert_eq!(parse_key("FFFFFFFFFFFF").unwrap(), [0xFF; 6]);
        assert_eq!(parse_key("ff ff ff ff ff ff").unwrap(), [0xFF; 6]);
        assert_eq!(
            parse_key("A0:A1:A2:A3:A4:A5").unwrap(),
            [0xA0, 0xA1, 0xA2, 0xA3, 0xA4, 0xA5]
        );
        assert_eq!(
            parse_key("d3-f7-d3-f7-d3-f7").unwrap(),
            [0xD3, 0xF7, 0xD3, 0xF7, 0xD3, 0xF7]
        );
        assert!(parse_key("FFFFFFFFFF").is_err());
        assert!(parse_key("FFFFFFFFFFFFF").is_err());
        assert!(parse_key("GGGGGGGGGGGG").is_err());
    }

    #[test]
    fn manufacturer_bcc_is_validated_against_the_uid_xor() {
        // UID 92 2E 58 32 -> BCC 92^2E^58^32 = 0xD6
        let mut block = vec![0x92, 0x2E, 0x58, 0x32, 0xD6, 0x08, 0x04, 0x00];
        block.extend_from_slice(&[0x00; 8]);
        assert_eq!(manufacturer_bcc_is_valid(&block), Some(true));
        block[4] = 0x00;
        assert_eq!(manufacturer_bcc_is_valid(&block), Some(false));
        assert_eq!(manufacturer_bcc_is_valid(&[0x01, 0x02]), None);
    }

    #[test]
    fn hex_helpers_round_trip() {
        assert_eq!(format_hex(&[0x92, 0x2E, 0x58, 0x32]), "922E5832");
        assert_eq!(decode_hex("922E5832").unwrap(), [0x92, 0x2E, 0x58, 0x32]);
        assert_eq!(format_key(&[0xFF; 6]), "FFFFFFFFFFFF");
        assert!(decode_hex("ABC").is_err());
        assert!(decode_hex("ZZ").is_err());
    }

    #[test]
    fn dump_reports_only_read_units_towards_its_byte_count() {
        let dump = CardDump {
            uid: "922E5832".into(),
            atqa: "0400".into(),
            sak: 0x08,
            kind: CardKind::Classic1K,
            label: CardKind::Classic1K.label().into(),
            unit_size: 16,
            units: vec![
                DataUnit {
                    index: 0,
                    sector: 0,
                    data: Some("00".repeat(16)),
                    error: None,
                    is_trailer: false,
                    is_manufacturer: true,
                },
                DataUnit {
                    index: 1,
                    sector: 0,
                    data: None,
                    error: Some("认证失败".into()),
                    is_trailer: false,
                    is_manufacturer: false,
                },
            ],
            sectors: vec![],
            read_at: 0,
            duration_ms: 0,
            unresolved_sectors: 1,
            warnings: vec![],
        };
        assert!(dump.is_readable());
        assert_eq!(
            dump.units.iter().filter(|unit| unit.data.is_some()).count(),
            1
        );
    }
}
