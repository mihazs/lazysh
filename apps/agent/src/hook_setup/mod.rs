//! Explicit, profile-scoped lifecycle hook setup; configuration is not reporting evidence.
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod commit;
mod discovery;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod files;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod json;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod record;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod render;
#[cfg(any(target_os = "linux", target_os = "macos"))]
mod state;
use crate::{Error, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde_json::{json, Value};
use std::path::PathBuf;

#[derive(Clone, Copy, ValueEnum, serde::Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentProfile {
    Claude,
    Codex,
    Droid,
    Gemini,
    Cursor,
    Opencode,
    Cline,
    Copilot,
    Amp,
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
impl AgentProfile {
    fn agent(self) -> record::Agent {
        match self {
            Self::Claude => record::Agent::Claude,
            Self::Codex => record::Agent::Codex,
            Self::Droid => record::Agent::Droid,
            Self::Gemini => record::Agent::Gemini,
            Self::Cursor => record::Agent::Cursor,
            Self::Opencode => record::Agent::Opencode,
            Self::Cline => record::Agent::Cline,
            Self::Copilot => record::Agent::Copilot,
            Self::Amp => record::Agent::Amp,
        }
    }
}
#[derive(Args)]
pub struct Target {
    #[arg(long, value_enum)]
    pub agent: AgentProfile,
    /// Existing, explicitly selected provider configuration directory.
    #[arg(long)]
    pub profile_root: PathBuf,
}
#[derive(Subcommand)]
pub enum Command {
    /// Discover known installed executables and profile directories without reading configuration.
    Discover {
        /// Explicitly opt into newer managed-provider metadata; default v1 stays compatible.
        #[arg(long, default_value_t = 1, value_parser = clap::value_parser!(u8).range(1..=3))]
        schema_version: u8,
    },
    /// Preview a hook asset without accessing a provider profile; output labels its dialect and binding.
    Preview {
        #[arg(long, value_enum)]
        agent: AgentProfile,
    },
    /// Inspect ownership and return separate install/update and remove plan hashes.
    Status {
        #[command(flatten)]
        target: Target,
    },
    /// Install or update only owned entries after inspecting the exact plan.
    Install {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        expected_plan: String,
    },
    /// Remove only the exact owned entries; preserve foreign configuration.
    Remove {
        #[command(flatten)]
        target: Target,
        #[arg(long)]
        expected_plan: String,
    },
}
pub fn run(command: Command) -> Result<Value> {
    match command {
        Command::Discover { schema_version } => Ok(discovery::run(schema_version)),
        Command::Preview { agent } => preview(agent),
        other => manage(other),
    }
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn preview(agent: AgentProfile) -> Result<Value> {
    let source = std::env::current_exe()?;
    let agent = agent.agent();
    let (asset, dialect) = if agent == record::Agent::Copilot {
        let text = render::owned_file(agent, &source).map_err(Error::Installation)?;
        (
            serde_json::from_str(&text).map_err(|_| Error::Installation("HooksInvalidTemplate"))?,
            "shell-free-exec",
        )
    } else if agent.is_whole_file() {
        (
            Value::String(render::owned_file(agent, &source).map_err(Error::Installation)?),
            if agent == record::Agent::Amp {
                "amp-javascript"
            } else if agent == record::Agent::Cline {
                "cline-javascript"
            } else {
                "bun-javascript"
            },
        )
    } else {
        let entries = render::entries(agent, &source).map_err(Error::Installation)?;
        let asset = if matches!(
            agent,
            record::Agent::Gemini | record::Agent::Cursor | record::Agent::Droid
        ) {
            let content = render::configuration(agent, "{}", &[], &entries)
                .map_err(|_| Error::Installation("HooksInvalidTemplate"))?;
            serde_json::from_str(&content)
                .map_err(|_| Error::Installation("HooksInvalidTemplate"))?
        } else {
            serde_json::to_value(entries)
                .map_err(|_| Error::Installation("HooksInvalidTemplate"))?
        };
        (asset, "posix-shell")
    };
    Ok(
        json!({"schemaVersion":1,"agent":agent,"binary":source,"asset":asset,"dialect":dialect,"binaryBinding":"currentExecutable","reporting":"notChecked","trust":"notChecked"}),
    )
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn preview(agent: AgentProfile) -> Result<Value> {
    // Reuse the original print-only templates, never quote a Windows path as POSIX.
    // These assets are not a Windows installer or a verified executable binding.
    let (asset, dialect) = match agent {
        AgentProfile::Claude => (crate::claude_config(), "posix-shell"),
        AgentProfile::Codex => (crate::hooks::codex_config(), "posix-shell"),
        AgentProfile::Droid => (crate::hooks::droid_config(), "posix-shell"),
        AgentProfile::Gemini => (crate::hooks::gemini_config(), "posix-shell"),
        AgentProfile::Cursor => (crate::hooks::cursor_config(), "posix-shell"),
        AgentProfile::Copilot => (crate::hooks::copilot_config(), "shell-free-exec"),
        AgentProfile::Cline => (
            crate::hooks::cline_plugin()["content"].clone(),
            "cline-javascript",
        ),
        AgentProfile::Amp => (
            crate::hooks::amp_plugin()["content"].clone(),
            "amp-javascript",
        ),
        AgentProfile::Opencode => (
            crate::hooks::opencode_plugin()["content"].clone(),
            "bun-javascript",
        ),
    };
    Ok(
        json!({"schemaVersion":1,"agent":agent,"asset":asset,"dialect":dialect,"binaryBinding":"unboundTemplate","managedSetupSupported":false,"reporting":"notChecked","trust":"notChecked"}),
    )
}
#[cfg(any(target_os = "linux", target_os = "macos"))]
fn manage(command: Command) -> Result<Value> {
    let source = std::env::current_exe()?;
    let (target, action) = match &command {
        Command::Status { target } => (target, None),
        Command::Install { target, .. } => (target, Some(files::Action::Install)),
        Command::Remove { target, .. } => (target, Some(files::Action::Remove)),
        Command::Preview { .. } | Command::Discover { .. } => unreachable!(),
    };
    let selected = files::Target {
        agent: target.agent.agent(),
        profile: target.profile_root.clone(),
    };
    if let Some(action) = action {
        let expected = match command {
            Command::Install { expected_plan, .. } | Command::Remove { expected_plan, .. } => {
                expected_plan
            }
            _ => unreachable!(),
        };
        let outcome = commit::apply(selected, &source, action, &expected)?;
        return Ok(
            json!({"schemaVersion":1,"outcome":outcome,"reporting":"notChecked","trust":"notChecked"}),
        );
    }
    let inspected = match files::inspect(selected, &source) {
        Err(Error::Installation(
            reason @ ("HooksAclUnsupported" | "HooksDroidStandaloneRequired"),
        )) => {
            return Ok(
                json!({"schemaVersion":1,"supported":false,"reason":reason,"reporting":"notChecked","trust":"notChecked"}),
            )
        }
        other => other?,
    };
    if inspected.observation == Some(state::Observation::Conflict) {
        return Ok(
            json!({"schemaVersion":1,"supported":true,"agent":target.agent.agent(),"profileRoot":target.profile_root,"state":"conflict","installPlan":null,"removePlan":null,"reporting":"notChecked","trust":"notChecked"}),
        );
    }
    let remove = inspected.plan(files::Action::Remove)?;
    let install = match inspected.plan(files::Action::Install) {
        Err(Error::Installation("HooksAmpShadow")) => {
            return Ok(
                json!({"schemaVersion":1,"supported":true,"agent":target.agent.agent(),"profileRoot":target.profile_root,"state":inspected.observation,"installPlan":null,"removePlan":remove.digest()?,"binary":remove.binary,"reason":"HooksAmpShadow","reporting":"notChecked","trust":"notChecked"}),
            );
        }
        other => other?,
    };
    Ok(
        json!({"schemaVersion":1,"supported":true,"agent":target.agent.agent(),"profileRoot":target.profile_root,"state":inspected.observation,"installPlan":install.digest()?,"removePlan":remove.digest()?,"binary":install.binary,"reporting":"notChecked","trust":"notChecked"}),
    )
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn manage(command: Command) -> Result<Value> {
    match command {
        Command::Status { .. } => Ok(
            json!({"schemaVersion":1,"supported":false,"reason":"HooksAclUnsupported","reporting":"notChecked","trust":"notChecked"}),
        ),
        _ => Err(Error::Installation("HooksAclUnsupported")),
    }
}
