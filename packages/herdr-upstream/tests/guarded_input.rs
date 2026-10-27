// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
// New optional-fork acceptance; reuses the original project's protocol observers.
#![cfg(unix)]
#[path = "../../herdr-guard/acceptance.rs"]
mod acceptance;
pub mod support;
#[path = "support/terminal_screen.rs"]
pub mod terminal_screen;
