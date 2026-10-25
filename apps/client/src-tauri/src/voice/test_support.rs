pub(super) fn ggml_bytes() -> Vec<u8> {
    let mut bytes = vec![0; 1024];
    bytes[..4].copy_from_slice(b"lmgg");
    for (index, value) in [51864i32, 1500, 512, 8, 6, 448, 512, 8, 6, 80, 1]
        .iter()
        .enumerate()
    {
        bytes[4 + index * 4..8 + index * 4].copy_from_slice(&value.to_le_bytes());
    }
    bytes
}
