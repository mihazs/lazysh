// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Owned native process fixture. It never implements SSH or opens a network.
fn main() {
    use std::io::Write;
    let marker = std::env::var_os("HERDR_GUARD_SSH_MARKER").expect("owned marker required");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(marker)
        .expect("owned marker creation");
    file.write_all(b"attempted").expect("owned marker write");
    std::process::exit(88);
}
