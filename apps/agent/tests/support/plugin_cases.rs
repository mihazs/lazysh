//! The three JavaScript plugin hosts' minimal events, shared by every platform's launcher test.
use crate::record::{self, Agent};
use serde_json::Value;
use std::{path::Path, process::Command};

/// Per plugin provider: the script that loads the rendered plugin and sends one working event, the agent name
/// the companion should report and the session id it should report it under.
pub fn cases() -> [(Agent, &'static str, &'static str, String); 3] {
    [
        (
            record::Agent::Opencode,
            r#"
            const { LazyshPlugin } = await import(process.env.LAZYSH_OWNED_PLUGIN);
            const hooks = await LazyshPlugin({ directory: '/owned/opencode-project' });
            await hooks.event({ event: { type: 'session.status', properties: { sessionID: 'owned-plugin', status: { type: 'busy' } } } });
        "#,
            "OpenCode",
            "owned-plugin".to_string(),
        ),
        (
            record::Agent::Cline,
            r#"
            const { default: plugin } = await import(process.env.LAZYSH_OWNED_PLUGIN);
            plugin.setup({}, { cwd: '/owned/cline-project' });
            await plugin.hooks.beforeRun({ snapshot: { agentId: 'owned-root', conversationId: 'owned-conversation', runId: 'owned-run' } });
        "#,
            "Cline CLI",
            format!(
                "cline:{}",
                record::hash(b"cline-v1\0owned-root\0owned-conversation")
            ),
        ),
        (
            record::Agent::Amp,
            r#"
            const { default: plugin } = await import(process.env.LAZYSH_OWNED_PLUGIN);
            const callbacks = new Map();
            plugin({ system: { workspaceRoot: 'file:///owned/amp-project' }, helpers: { filePathFromURI: () => '/owned/amp-project' }, on: (event, callback) => { callbacks.set(event, callback); return { unsubscribe() {} }; }, onDispose() {} });
            callbacks.get('session.start')({}, { thread: { id: 'owned-amp-thread', state: { subscribe(callback) { callback('running'); return { unsubscribe() {} }; }, get: async () => 'running' } } });
        "#,
            "Amp",
            "owned-amp-thread".to_string(),
        ),
    ]
}

/// Loads `plugin` in `runtime` with the script's event and expects it to succeed without a word. With `bare`
/// the plugin host starts with an empty environment, so only the absolute companion path can reach the binary.
pub fn load(runtime: &Path, script: &str, plugin: &Path, state: &Path, bare: bool) {
    let mut command = Command::new(runtime);
    command.args(["-e", script]);
    if bare {
        command.env_clear();
    }
    let output = command
        .env("PATH", "")
        .env("LAZYSH_OWNED_PLUGIN", plugin)
        .env("LAZYSH_STATE_DIR", state)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    // Name what the plugin host wrote: a bare `is_empty` assertion hid it when this failed on a loaded runner.
    assert!(
        output.stdout.is_empty() && output.stderr.is_empty(),
        "plugin host wrote stderr={:?} stdout={:?}: {command:?}",
        String::from_utf8_lossy(&output.stderr),
        String::from_utf8_lossy(&output.stdout)
    );
}
/// The companion's snapshot shows the one working session the event started.
pub fn assert_working(report: &Value, agent: &str, session: &str) {
    assert_eq!(report["sessions"][0]["sessionId"], session);
    assert_eq!(report["sessions"][0]["agent"], agent);
    assert_eq!(report["sessions"][0]["state"], "working");
}
