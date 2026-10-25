/// RIFF header for signed 16-bit little-endian mono PCM at 16 kHz.
pub fn pcm16_mono_16khz_header(data_bytes: u32) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(44);
    bytes.extend_from_slice(b"RIFF");
    bytes.extend_from_slice(
        &data_bytes
            .checked_add(36)
            .expect("PCM size exceeds RIFF")
            .to_le_bytes(),
    );
    bytes.extend_from_slice(b"WAVEfmt ");
    bytes.extend_from_slice(&16u32.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&1u16.to_le_bytes());
    bytes.extend_from_slice(&16000u32.to_le_bytes());
    bytes.extend_from_slice(&32000u32.to_le_bytes());
    bytes.extend_from_slice(&2u16.to_le_bytes());
    bytes.extend_from_slice(&16u16.to_le_bytes());
    bytes.extend_from_slice(b"data");
    bytes.extend_from_slice(&data_bytes.to_le_bytes());
    bytes
}

#[cfg(test)]
mod tests {
    #[test]
    fn header_declares_exact_format_and_data_length() {
        let header = super::pcm16_mono_16khz_header(3200);
        assert_eq!(header.len(), 44);
        assert_eq!(&header[..4], b"RIFF");
        assert_eq!(u32::from_le_bytes(header[4..8].try_into().unwrap()), 3236);
        assert_eq!(&header[8..16], b"WAVEfmt ");
        assert_eq!(
            &header[20..36],
            &[1, 0, 1, 0, 128, 62, 0, 0, 0, 125, 0, 0, 2, 0, 16, 0]
        );
        assert_eq!(u32::from_le_bytes(header[40..44].try_into().unwrap()), 3200);
    }
}
