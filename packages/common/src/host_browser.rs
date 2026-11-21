/// The host browser relay's viewport limits: 100 to 2048 CSS pixels, scale 1 to 3, at most 8 million pixels once scaled.
pub fn valid_viewport(width: u32, height: u32, scale: f32) -> bool {
    (100..=2048).contains(&width)
        && (100..=2048).contains(&height)
        && (1.0..=3.0).contains(&scale)
        && (width as f32 * height as f32 * scale * scale) <= 8_000_000.0
}

#[cfg(test)]
mod tests {
    use super::valid_viewport;

    #[test]
    fn viewports_are_bounded() {
        assert!(valid_viewport(412, 915, 1.0) && valid_viewport(412, 915, 3.0));
        for (width, height, scale) in [
            (99, 915, 1.0),
            (412, 2049, 1.0),
            (412, 915, 0.5),
            (412, 915, 3.1),
            (2048, 2048, 1.5),
            (412, 915, f32::NAN),
        ] {
            assert!(
                !valid_viewport(width, height, scale),
                "{width}x{height}@{scale}"
            );
        }
    }
}
