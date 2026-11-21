// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! The `lazysh-managed` build never replaces itself with a stock Herdr release.
//!
//! Upstream's updater downloads a release from herdr.dev and overwrites the running
//! executable, and the background check polls its manifest. For a managed build that would
//! silently swap the guarded derivative for stock Herdr, so `main.rs` loads this module as
//! `crate::update` and keeps the unchanged upstream file as `crate::stock_update`. Only the
//! four entry points below differ; every other name is upstream's own, which leaves
//! `src/update.rs` byte-identical to the pinned source. Externally managed installs
//! (Homebrew, mise, Nix) are treated the same way upstream does: `herdr update` fails,
//! `herdr channel set preview` is rejected and `herdr channel set stable` only records the
//! channel and prints guidance.
use crate::events::AppEvent;
pub(crate) use crate::stock_update::*;

const ONLY_LAZYSH: &str = "updates arrive only through lazysh";

/// `herdr update`, and the self-update that `herdr channel set` would otherwise run.
pub fn self_update(_options: SelfUpdateOptions) -> Result<Version, String> {
    Err(format!(
        "self-update is disabled for the lazysh-managed Herdr build; {ONLY_LAZYSH}"
    ))
}

/// The background check never contacts the stock update manifest.
pub fn auto_update(_events: tokio::sync::mpsc::Sender<AppEvent>) {
    tracing::info!("update check skipped: {ONLY_LAZYSH}");
}

pub(crate) fn preview_channel_rejection_for_current_install() -> Option<&'static str> {
    Some(
        "preview channel is only available for direct Herdr installs; the lazysh-managed Herdr build updates only through lazysh",
    )
}

pub(crate) fn package_manager_channel_update_guidance_for_current_install() -> Option<&'static str>
{
    Some("Updates to the lazysh-managed Herdr build arrive only through lazysh; nothing was downloaded or replaced.")
}
