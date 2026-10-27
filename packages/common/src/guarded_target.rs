// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Exact shared target-shape boundary for guarded Herdr input.
pub fn valid_guarded_target(ids: [&str; 4], generation: u64, width: u16, height: u16) -> bool {
    ids.into_iter().all(|value| {
        !value.is_empty() && value.len() <= 128 && !value.chars().any(char::is_control)
    }) && generation > 0
        && width > 0
        && height > 0
}

#[cfg(test)]
mod tests {
    use super::valid_guarded_target;

    #[test]
    fn every_identity_and_runtime_dimension_keeps_the_existing_boundary() {
        let longest = "é".repeat(64);
        assert!(valid_guarded_target([&longest; 4], u64::MAX, u16::MAX, 1));
        for invalid in [String::new(), "a".repeat(129), "pane\n".into()] {
            for position in 0..4 {
                let mut ids = ["ordinary"; 4];
                ids[position] = &invalid;
                assert!(!valid_guarded_target(ids, 1, 80, 24));
            }
        }
        for (generation, width, height) in [(0, 80, 24), (1, 0, 24), (1, 80, 0)] {
            assert!(!valid_guarded_target(
                ["ordinary"; 4],
                generation,
                width,
                height
            ));
        }
    }
}
