// Copyright 2026 lazysh contributors. SPDX-License-Identifier: GPL-3.0-or-later
pub fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}
