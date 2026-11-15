//! Real OpenSSH acceptance: a launched agent runs as the only process of a new terminal session, in its folder.
use super::*;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::sync::Mutex;
use tauri::Manager;

type App = tauri::App<tauri::test::MockRuntime>;

/// A stub `claude` on the login shell's PATH that prints the folder and every argument it was started with.
pub(super) fn environment(directory: &Path) -> String {
    let agent = directory.join("claude-stub");
    fs::write(
        &agent,
        "#!/bin/sh\nprintf 'AGENT<%s>' \"$PWD\"\nfor a in \"$@\"; do printf '<%s>' \"$a\"; done\nprintf 'END\\n'\n",
    )
    .unwrap();
    fs::set_permissions(&agent, fs::Permissions::from_mode(0o755)).unwrap();
    openssh_tool_environment(directory, agent, "claude")
}

/// What the new terminal printed, until it closed.
async fn run(app: &App, id: &str, request: serde_json::Value) -> (String, String) {
    let seen = Arc::new(Mutex::new((Vec::<u8>::new(), false)));
    let sink = seen.clone();
    let events = Channel::new(move |body| {
        if let tauri::ipc::InvokeResponseBody::Json(text) = body {
            let event: serde_json::Value = serde_json::from_str(&text).unwrap();
            let mut seen = sink.lock().unwrap();
            if event["type"] == "closed" {
                seen.1 = true;
            } else {
                seen.0.extend(
                    event["data"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|b| b.as_u64().unwrap() as u8),
                );
            }
        }
        Ok(())
    });
    let child = agent_terminal(
        access_lease(),
        app.state(),
        id.into(),
        serde_json::from_value(request).unwrap(),
        80,
        24,
        events,
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap()
    .session_id;
    timeout(Duration::from_secs(10), async {
        while !seen.lock().unwrap().1 {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("the agent terminal did not close");
    let output = String::from_utf8_lossy(&seen.lock().unwrap().0).into_owned();
    (child, output)
}

pub(super) async fn verify(app: &App, id: &str, directory: &Path) {
    // The folder is made by the app's prepare step, hostile name and all, then the terminal runs the agent in it.
    let folder = directory
        .join("new parent")
        .join("it's $(touch INJECTED1) here");
    let directory_name = folder.to_str().unwrap().to_owned();
    let request = || {
        serde_json::json!({
            "target":{"type":"directory","label":"x","directory":directory_name,"create":true},
            "agent":{"kind":"claude","name":"claude-1a2b","prompt":"say 'hi' $(touch INJECTED2); `x`"},
        })
    };
    let prepared = crate::herdr_create::terminal_launch_prepare(
        app.state(),
        id.into(),
        serde_json::from_value(request()).unwrap(),
        access_lease(),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap();
    assert!(folder.is_dir());
    let value = serde_json::to_value(&prepared).unwrap();
    assert_eq!(value["folder"], directory_name);
    assert!(value.get("failure").is_none(), "{value}");

    let (child, output) = run(app, id, request()).await;
    assert!(
        output.contains(&format!(
            "AGENT<{}><say 'hi' $(touch INJECTED2); `x`>END",
            fs::canonicalize(&folder).unwrap().display()
        )),
        "{output:?}"
    );
    // The agent was the terminal's only process: its exit closed the session, and nothing was run as shell syntax.
    assert!(app.state::<AppState>().session(&child).await.is_err());
    for name in ["INJECTED1", "INJECTED2"] {
        assert!(!directory.join(name).exists() && !folder.join(name).exists());
    }
    assert!(!directory.join("new parent").join("INJECTED1").exists());

    // A folder that is not there stops the terminal with the shell's own error and no agent output.
    let missing = directory.join("missing");
    let (_, output) = run(
        app,
        id,
        serde_json::json!({
            "target":{"type":"directory","label":"x","directory":missing.to_str().unwrap()},
            "agent":{"kind":"claude","name":"claude-1a2b"},
        }),
    )
    .await;
    assert!(!output.contains("AGENT<"), "{output:?}");
}
