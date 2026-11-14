//! The `update` output contract: newline-delimited JSON with a final `result`, or fixed human text.
//! Nothing here ever prints a URL, an environment value or remote text.
use serde::Serialize;
use serde_json::{json, Value};
use std::io::Write;

/// Exit status and `error.kind` of a failed run. Messages are fixed strings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    Internal,
    Usage,
    NetworkUnavailable,
    ReleaseUnavailable,
    VerificationFailed,
    DowngradeRefused,
    SelfTestFailed,
    RolledBack,
    Busy,
    UnsafeInstallLocation,
    NoPreviousVersion,
    Uncertain,
}
impl Failure {
    pub fn code(self) -> u8 {
        match self {
            Self::Internal => 1,
            Self::Usage => 2,
            Self::NetworkUnavailable => 20,
            Self::ReleaseUnavailable => 21,
            Self::VerificationFailed => 22,
            Self::DowngradeRefused => 23,
            Self::SelfTestFailed => 24,
            Self::RolledBack => 25,
            Self::Busy => 26,
            Self::UnsafeInstallLocation => 27,
            Self::NoPreviousVersion => 28,
            Self::Uncertain => 29,
        }
    }
    pub fn kind(self) -> &'static str {
        match self {
            Self::Internal => "internal",
            Self::Usage => "usage",
            Self::NetworkUnavailable => "networkUnavailable",
            Self::ReleaseUnavailable => "releaseUnavailable",
            Self::VerificationFailed => "verificationFailed",
            Self::DowngradeRefused => "downgradeRefused",
            Self::SelfTestFailed => "selfTestFailed",
            Self::RolledBack => "rolledBack",
            Self::Busy => "busy",
            Self::UnsafeInstallLocation => "unsafeInstallLocation",
            Self::NoPreviousVersion => "noPreviousVersion",
            Self::Uncertain => "uncertain",
        }
    }
    fn message(self) -> &'static str {
        match self {
            Self::Internal => "Unexpected failure",
            Self::Usage => "The change was not confirmed",
            Self::NetworkUnavailable => "The release server is unreachable or rate limited",
            Self::ReleaseUnavailable => "No compatible verified release is published",
            Self::VerificationFailed => {
                "The release did not match its published digest, size or origin"
            }
            Self::DowngradeRefused => "The requested version is older than the installed one",
            Self::SelfTestFailed => "The new companion failed its self-test; nothing was replaced",
            Self::RolledBack => {
                "The new companion failed after the replace; the previous one was restored"
            }
            Self::Busy => "Another update or installation is running",
            Self::UnsafeInstallLocation => "Unsupported platform or unsafe install location",
            Self::NoPreviousVersion => "There is no previous companion to restore",
            Self::Uncertain => {
                "The replace may have completed but could not be confirmed; run update --status"
            }
        }
    }
}
impl From<lazysh_companion_release::Error> for Fault {
    fn from(error: lazysh_companion_release::Error) -> Self {
        use lazysh_companion_release::Kind;
        Self {
            failure: match error.kind {
                Kind::Network => Failure::NetworkUnavailable,
                Kind::Unavailable => Failure::ReleaseUnavailable,
                Kind::Verification => Failure::VerificationFailed,
            },
            detail: error.detail.map(|detail| detail.as_str()),
            retry_after_seconds: error.retry_after_seconds,
        }
    }
}
/// A failure with its optional closed detail.
#[derive(Clone, Copy, Debug)]
pub struct Fault {
    pub failure: Failure,
    pub detail: Option<&'static str>,
    pub retry_after_seconds: Option<u64>,
}
impl From<Failure> for Fault {
    fn from(failure: Failure) -> Self {
        Self {
            failure,
            detail: None,
            retry_after_seconds: None,
        }
    }
}
impl Fault {
    pub fn detail(failure: Failure, detail: &'static str) -> Self {
        Self {
            detail: Some(detail),
            ..Self::from(failure)
        }
    }
}
impl From<crate::Error> for Fault {
    fn from(error: crate::Error) -> Self {
        match error {
            crate::Error::Installation("InstallBusy") => Failure::Busy,
            crate::Error::Installation(_) | crate::Error::UnsupportedStateFilesystem => {
                Failure::UnsafeInstallLocation
            }
            _ => Failure::Internal,
        }
        .into()
    }
}
impl From<std::io::Error> for Fault {
    fn from(_: std::io::Error) -> Self {
        Failure::Internal.into()
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Current {
    pub version: Option<String>,
    pub path: String,
    pub sha256: String,
    pub bytes: u64,
    pub managed: bool,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Latest {
    pub version: String,
    pub channel: &'static str,
    pub target: String,
    pub tag: String,
    pub commit: String,
    pub asset: String,
    pub bytes: u64,
    pub sha256: String,
}
/// Everything a run knows when it ends; fields that do not apply stay `None`.
#[derive(Default)]
pub struct Report {
    pub action: &'static str,
    pub outcome: &'static str,
    pub fault: Option<Fault>,
    pub current: Option<Current>,
    pub previous: Option<Value>,
    pub latest: Option<Latest>,
    /// `lastCheck` and `lastOperation` of `--status`.
    pub history: Option<(Value, Value)>,
}
impl Report {
    pub fn new(action: &'static str) -> Self {
        Self {
            action,
            ..Self::default()
        }
    }
    /// End the run as a failure; what was learned before it (current, latest) stays in the report.
    pub fn fail(&mut self, fault: Fault) {
        self.outcome = if fault.failure == Failure::Uncertain {
            "uncertain"
        } else {
            "failed"
        };
        self.fault = Some(fault);
    }
    pub fn exit_code(&self, available: bool) -> u8 {
        match (&self.fault, available) {
            (Some(fault), _) => fault.failure.code(),
            (None, true) => 10,
            (None, false) => 0,
        }
    }
    fn value(&self, exit_code: u8) -> Value {
        let error = self.fault.map(|fault| {
            let mut error = json!({"kind":fault.failure.kind(),"message":fault.failure.message(),
                "retryAfterSeconds":fault.retry_after_seconds});
            if let Some(detail) = fault.detail {
                error["detail"] = json!(detail);
            }
            error
        });
        let mut value = json!({"schemaVersion":1,"event":"result","action":self.action,
            "outcome":self.outcome,"exitCode":exit_code,"error":error,"current":self.current,
            "previous":self.previous,"latest":self.latest,
            "checkedAt":chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)});
        if let Some((check, operation)) = &self.history {
            value["lastCheck"] = check.clone();
            value["lastOperation"] = operation.clone();
        }
        value
    }
    fn human(&self) -> String {
        let mut lines = Vec::new();
        if let Some(current) = &self.current {
            lines.push(format!(
                "installed: {} ({}{})",
                current.version.as_deref().unwrap_or("unknown version"),
                current.path,
                if current.managed {
                    ""
                } else {
                    ", not the managed copy"
                }
            ));
        }
        if let Some(previous) = self.previous.as_ref().and_then(|v| v["version"].as_str()) {
            lines.push(format!("previous: {previous}"));
        }
        if let Some(latest) = &self.latest {
            lines.push(format!(
                "latest: {} ({}, {})",
                latest.version, latest.channel, latest.target
            ));
        }
        if let Some((check, operation)) = &self.history {
            for (name, entry) in [("last check", check), ("last operation", operation)] {
                if !entry.is_null() {
                    lines.push(format!("{name}: {entry}"));
                }
            }
        }
        lines.push(match (self.outcome, self.fault) {
            ("available", _) => "An update is available.".into(),
            ("upToDate", _) => "Already up to date.".into(),
            ("updated", _) => {
                "Updated. The previous version is kept; `lazysh-agent update --rollback` restores it."
                    .into()
            }
            ("dryRunOk", _) => "Dry run passed. Nothing was changed.".into(),
            ("rolledBack", _) => "Restored the previous version.".into(),
            (_, Some(fault)) => format!("failed: {}", fault.failure.message()),
            _ => String::new(),
        });
        lines.retain(|line| !line.is_empty());
        lines.join("\n")
    }
}

/// Writes the run's output; a closed stdout is not a failure of the update itself.
pub struct Output {
    json: bool,
    last_progress: std::cell::Cell<Option<std::time::Instant>>,
}
impl Output {
    pub fn new(json: bool) -> Self {
        Self {
            json,
            last_progress: std::cell::Cell::new(None),
        }
    }
    /// `downloading` events, at most four per second; the last one (all bytes) is always sent.
    pub fn progress(&self, bytes: u64, total: u64) {
        let now = std::time::Instant::now();
        let due = self
            .last_progress
            .get()
            .is_none_or(|last| now.duration_since(last) >= std::time::Duration::from_millis(250));
        if self.json && (due || bytes == total) {
            self.last_progress.set(Some(now));
            let _ = writeln!(
                std::io::stdout().lock(),
                "{}",
                json!({"schemaVersion":1,"event":"stage","stage":"downloading","bytes":bytes,"total":total})
            );
        }
    }
    pub fn stage(&self, stage: &str) {
        if self.json {
            let _ = writeln!(
                std::io::stdout().lock(),
                "{}",
                json!({"schemaVersion":1,"event":"stage","stage":stage})
            );
        }
    }
    /// Print the result and return the exit status; `available` is the `--check` 10.
    pub fn finish(&self, report: Report, available: bool) -> std::process::ExitCode {
        let code = report.exit_code(available);
        if self.json {
            let _ = writeln!(std::io::stdout().lock(), "{}", report.value(code));
        } else if report.fault.is_some() {
            let _ = writeln!(
                std::io::stderr().lock(),
                "lazysh-agent: update: {}",
                report.human()
            );
        } else {
            let _ = writeln!(std::io::stdout().lock(), "{}", report.human());
        }
        std::process::ExitCode::from(code)
    }
}
