#![allow(dead_code, unused_imports)]
//! ai-usagebar library — shared core for the Waybar widget and TUI binaries.
//!
//! The crate is organized by concern, not by binary:
//! - low-level primitives (`cache`, `countdown`, `pacing`, `pango`, `theme`)
//! - the vendor abstraction (`vendor`, `vendors::*`, `usage`)
//! - bin-specific composition (`widget`, `tui`) which lives next to its binary
//!
//! The binaries (`ai-usagebar`, `ai-usagebar-tui`, and on Windows/macOS
//! `ai-usagebar-tray`) are thin: they parse CLI args, instantiate vendors,
//! and hand off to a renderer in this crate.

mod active;
mod anthropic;
mod anthropic_api;
mod antigravity;
mod balance;
mod cache;
mod claude_desktop;
mod cline;
mod commandcode;
mod config;
mod copilot;
mod countdown;
mod cursor;
mod custom;
mod deepinfra;
mod deepseek;
mod detect;
mod devin;
mod display;
mod droid;
mod error;
mod format;
mod grok;
mod grokbot;
/// Source-scanning helpers for structural guard tests. Test-only.
#[cfg(test)]
pub(crate) mod guard;
mod jwt;
mod kilo;
mod kimi;
mod kiro;
mod lyceum;
mod minimax;
mod modelstudio;
mod moonshot;
mod muse;
mod nous;
mod novita;
mod ollama;
mod openai;
mod opencode_go;
mod openrouter;
mod orcarouter;
mod outcome;
mod pacing;
mod pango;
mod process;
mod report;
mod safe_storage;
mod serde_helpers;
mod supergrok;
mod synthetic;
mod theme;
mod tooltip;
mod tui;
mod usage;
mod vendor;
mod waybar;
mod widget;
mod zai;

pub use error::{AppError, Result};

pub use config::Config;
pub use detect::has_local_credentials;
pub use report::{
    Entry, ReportTarget, provider_key, refresh_target, render_entries, targets, unavailable_entry,
};
pub use vendor::VendorId;

pub use vendor::{HTTP_CLIENT_TIMEOUT, register_secret_env_vars, same_origin_redirect_policy};

pub use config::resolved_path as resolved_config_path;
