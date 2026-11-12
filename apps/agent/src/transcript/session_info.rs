//! The `session` object of a conversation page: model, mode, context, cost and where the agent
//! works (folder name, git branch, worktree name) as recorded.
//!
//! Absent means unknown, never zero. Only bounded scalars are copied; no prompt text, full paths
//! or credentials. Claude Code records the model and usage on assistant records, `permission-mode`,
//! `cost-state` and `worktree-state` records, and the folder and branch on every record; Codex
//! records `session_meta`, `turn_context` and `token_count` events.
use serde_json::{json, Map, Value};

const MAX_LABEL: usize = 64;
const MAX_NAME: usize = 128;

/// A short identifier such as `claude-opus-5-5`, `plan` or `danger-full-access`.
fn label(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        !text.is_empty()
            && text.len() <= MAX_LABEL
            && text
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || "-_.:/ ".contains(c))
    })
}

/// A folder or branch name: printable text, bounded, since names are not limited to a safe alphabet.
pub(super) fn name(value: &Value) -> Option<&str> {
    value.as_str().filter(|text| {
        !text.is_empty() && text.len() <= MAX_NAME && !text.chars().any(char::is_control)
    })
}

/// The last component of a path; the full path is not sent.
fn folder(path: &Value) -> Option<Value> {
    let last = path
        .as_str()?
        .rsplit(['/', '\\'])
        .find(|part| !part.is_empty())?;
    name(&json!(last)).map(|text| json!(text))
}

#[derive(Default)]
pub(super) struct Session(Map<String, Value>);

impl Session {
    fn set(&mut self, key: &str, value: Option<Value>) {
        match value {
            Some(value) => self.0.insert(key.into(), value),
            None => self.0.remove(key),
        };
    }

    /// What the session has loaded (MCP servers, skills, agents, instruction files), under `info`.
    pub(super) fn with_info(mut self, info: Option<Value>) -> Self {
        self.set("info", info);
        self
    }

    pub(super) fn into_value(self) -> Option<Value> {
        (!self.0.is_empty()).then_some(Value::Object(self.0))
    }

    /// `permission_mode` and the total cost come from file-level records; the rest from the
    /// active chain, newest first.
    pub(super) fn claude(
        newest_first: &[&Value],
        permission_mode: Option<&Value>,
        cost_usd: Option<f64>,
        worktree: Option<&Value>,
    ) -> Self {
        let mut session = Self::default();
        let assistants = newest_first
            .iter()
            .filter(|record| record["type"] == "assistant");
        session.set(
            "model",
            assistants
                .clone()
                .find_map(|record| label(&record["message"]["model"]))
                .filter(|model| !model.starts_with('<'))
                .map(|model| json!(model)),
        );
        session.set(
            "usage",
            assistants.clone().find_map(|record| {
                let usage = &record["message"]["usage"];
                let total = [
                    "input_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                    "output_tokens",
                ]
                .iter()
                .map(|key| usage[*key].as_u64())
                .try_fold(0u64, |sum, count| {
                    count.map(|count| sum.saturating_add(count))
                })?;
                Some(json!({"usedTokens":total}))
            }),
        );
        session.set("mode", permission_mode.and_then(label).map(|m| json!(m)));
        session.set(
            "folder",
            newest_first
                .iter()
                .find_map(|record| folder(&record["cwd"])),
        );
        session.set(
            "branch",
            newest_first
                .iter()
                .find_map(|record| name(&record["gitBranch"]))
                .map(|branch| json!(branch)),
        );
        session.set("worktree", worktree.and_then(name).map(|text| json!(text)));
        session.set(
            "cost",
            cost_usd
                .filter(|usd| usd.is_finite() && *usd >= 0.0)
                .map(|usd| json!({"usd":usd})),
        );
        session
    }

    /// Feed every rollout record in order; later records replace earlier values.
    pub(super) fn codex(&mut self, record: &Value) {
        let payload = &record["payload"];
        match record["type"].as_str() {
            Some("session_meta") => {
                self.set("folder", folder(&payload["cwd"]));
                self.set("branch", name(&payload["git"]["branch"]).map(|b| json!(b)));
            }
            Some("turn_context") => {
                self.set(
                    "folder",
                    folder(&payload["cwd"]).or_else(|| self.0.get("folder").cloned()),
                );
                self.set("model", label(&payload["model"]).map(|m| json!(m)));
                let mode = &payload["collaboration_mode"];
                self.set("mode", label(&mode["mode"]).map(|m| json!(m)));
                self.set(
                    "effort",
                    label(&mode["settings"]["reasoning_effort"]).map(|m| json!(m)),
                );
                self.set(
                    "approval",
                    label(&payload["approval_policy"]).map(|m| json!(m)),
                );
                let sandbox = label(&payload["sandbox_policy"]["type"])
                    .or_else(|| label(&payload["permission_profile"]["type"]));
                self.set("sandbox", sandbox.map(|m| json!(m)));
            }
            Some("event_msg") if payload["type"] == "token_count" => {
                let info = &payload["info"];
                let used = info["last_token_usage"]["total_tokens"].as_u64();
                self.set(
                    "usage",
                    used.map(|used| {
                        let mut usage = json!({"usedTokens":used});
                        if let Some(limit) = info["model_context_window"].as_u64() {
                            usage["limitTokens"] = json!(limit);
                        }
                        usage
                    }),
                );
                let limits: Vec<Value> = ["primary", "secondary"]
                    .iter()
                    .filter_map(|kind| {
                        let window = &payload["rate_limits"][*kind];
                        let percent = window["used_percent"]
                            .as_f64()
                            .filter(|p| p.is_finite() && (0.0..=100.0).contains(p))?;
                        Some(json!({
                            "kind":kind,"usedPercent":percent,
                            "windowMinutes":window["window_minutes"].as_u64(),
                            "resetsAt":window["resets_at"].as_u64(),
                        }))
                    })
                    .collect();
                self.set("rateLimits", (!limits.is_empty()).then(|| json!(limits)));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_session_reports_what_is_recorded_and_omits_the_rest() {
        let synthetic = json!({"type":"assistant","message":{"model":"<synthetic>"}});
        let assistant = json!({"type":"assistant","message":{"model":"claude-opus-5-5","usage":{
            "input_tokens":2,"cache_read_input_tokens":100,"cache_creation_input_tokens":30,"output_tokens":8}}});
        let user = json!({"type":"user"});
        let session = Session::claude(
            &[&user, &synthetic, &assistant],
            Some(&json!("plan")),
            Some(3.5),
            None,
        )
        .into_value()
        .unwrap();
        assert_eq!(
            session,
            json!({"model":"claude-opus-5-5","usage":{"usedTokens":140},"mode":"plan","cost":{"usd":3.5}})
        );
        assert!(Session::claude(&[&user], None, None, None)
            .into_value()
            .is_none());
        // Unknown stays absent; a malformed label is not displayed.
        let odd = json!({"type":"assistant","message":{"model":"x\u{1b}[31m"}});
        assert!(
            Session::claude(&[&odd], Some(&json!("a".repeat(65))), None, None)
                .into_value()
                .is_none()
        );
    }

    #[test]
    fn claude_reports_the_folder_name_branch_and_worktree_but_never_the_path() {
        let old = json!({"type":"user","cwd":"/home/me/old","gitBranch":"main"});
        let new = json!({"type":"assistant","cwd":"/home/me/dev/.worktrees/fix-login/","gitBranch":"fix/login"});
        let session = Session::claude(&[&new, &old], None, None, Some(&json!("fix-login")))
            .into_value()
            .unwrap();
        assert_eq!(
            session,
            json!({"folder":"fix-login","branch":"fix/login","worktree":"fix-login"})
        );
        // A control character, an empty name or an oversized one is dropped; the others stay.
        let odd = json!({"type":"user","cwd":"/","gitBranch":"x\u{1b}[31m"});
        let long = json!({"type":"user","cwd":"C:\\Users\\me\\proj","gitBranch":"b".repeat(129)});
        assert_eq!(
            Session::claude(&[&odd, &long], None, None, Some(&json!(""))).into_value(),
            Some(json!({"folder":"proj"}))
        );
    }

    #[test]
    fn codex_reports_the_folder_and_branch_of_the_session() {
        let mut session = Session::default();
        session.codex(&json!({"type":"session_meta","payload":{"cwd":"/work/app","git":{"branch":"main","commit_hash":"abc"}}}));
        assert_eq!(session.0["folder"], "app");
        assert_eq!(session.0["branch"], "main");
        session.codex(&json!({"type":"turn_context","payload":{"cwd":"/work/app/sub"}}));
        assert_eq!(session.0["folder"], "sub");
        assert_eq!(session.0["branch"], "main");
        session.codex(&json!({"type":"session_meta","payload":{"cwd":"/work/app"}}));
        assert!(session.0.get("branch").is_none());
    }

    #[test]
    fn codex_session_follows_the_latest_records_and_clears_unavailable_usage() {
        let mut session = Session::default();
        session.codex(&json!({"type":"turn_context","payload":{
            "model":"gpt-6.1-terra","approval_policy":"never","sandbox_policy":{"type":"danger-full-access"},
            "collaboration_mode":{"mode":"plan","settings":{"reasoning_effort":"medium"}}}}));
        session.codex(&json!({"type":"event_msg","payload":{"type":"token_count","info":{
            "last_token_usage":{"total_tokens":32248},"model_context_window":475000},
            "rate_limits":{"primary":{"used_percent":43.0,"window_minutes":10080,"resets_at":1793774148},"secondary":null}}}));
        assert_eq!(
            session.0["usage"],
            json!({"usedTokens":32248,"limitTokens":475000})
        );
        assert_eq!(session.0["mode"], "plan");
        assert_eq!(session.0["sandbox"], "danger-full-access");
        assert_eq!(session.0["rateLimits"][0]["usedPercent"], 43.0);
        session.codex(&json!({"type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":null}}));
        assert!(session.0.get("usage").is_none() && session.0.get("rateLimits").is_none());
        assert_eq!(session.0["model"], "gpt-6.1-terra");
    }
}
