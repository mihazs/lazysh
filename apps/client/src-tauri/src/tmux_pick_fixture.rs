//! Owned real SSH/tmux acceptance of the guarded `pick`: a stand-in dialog (`tmux_pick_dialog.sh`) runs in a real pane and a pick is
//! delivered only while the pane, read again right before the key, still shows the dialog the card was read from. No provider,
//! account or WebView.
use super::agent_session::{lines, log_until};
use super::multiline::ready;
use super::*;
use serde_json::{json, Value};
use std::path::Path;

const DIALOG: &str = include_str!("tmux_pick_dialog.sh");
/// The approval prompt Codex 0.167.0 drew in a real tmux pane: the Agent view's recorded corpus.
const APPROVAL: &str = include_str!("../../src/test/agentDialogs/codex-approval.txt");

/// The rows of the dialog as the card reads them (its explaining text down to the footer), with the highlight on option `at`.
fn dialog_rows(screen: &str, at: usize) -> Vec<String> {
    let screen = screen
        .replace("› 1.", "  1.")
        .replace(&format!("  {at}. "), &format!("› {at}. "));
    let rows: Vec<&str> = screen.lines().collect();
    let first = rows
        .iter()
        .position(|row| row.trim() == "Would you like to run the following command?")
        .unwrap();
    let last = rows
        .iter()
        .rposition(|row| row.trim() == "Press enter to confirm or esc to cancel")
        .unwrap();
    rows[first..=last]
        .iter()
        .map(|row| row.trim_end().to_owned())
        .collect()
}
fn pick(
    operation: u32,
    receipt: &Value,
    source: &Value,
    rows: i32,
    enter: bool,
    seen: &[String],
) -> Value {
    json!({"kind":"input","receipt":receipt,"source":source,"operation":operation,
        "input":{"kind":"pick","rows":rows,"enter":enter,"seen":seen}})
}

fn dismiss(operation: u32, receipt: &Value, source: &Value, seen: &[String]) -> Value {
    json!({"kind":"input","receipt":receipt,"source":source,"operation":operation,
        "input":{"kind":"dismiss","seen":seen}})
}

#[tokio::test]
#[ignore = "requires owned OpenSSH and tmux 3.4+; fresh-capture pick acceptance"]
async fn real_tmux_pick_is_delivered_only_to_the_dialog_it_was_read_from() {
    for case in ["answers", "dismiss", "twice", "replaced", "race"] {
        eprintln!("owned pick case: {case}");
        timeout(Duration::from_secs(40), probe(case))
            .await
            .expect("bounded pick fixture");
    }
}

async fn probe(case: &str) {
    let f = Fixture::new().await;
    let servers = NamedServers::chat_a(&f);
    let (script, screen, log) = (
        f.dir.path().join("dialog.sh"),
        f.dir.path().join("screen.txt"),
        f.dir.path().join("dialog.log"),
    );
    fs::write(&script, DIALOG).unwrap();
    fs::write(&screen, APPROVAL).unwrap();
    let start = |copies: usize, screen: &Path| {
        format!(
            "exec bash {} {} {} {copies}",
            quote(script.to_str().unwrap()),
            quote(screen.to_str().unwrap()),
            quote(log.to_str().unwrap())
        )
    };
    // The window is 100 columns wide, as the corpus was captured, so no row of the dialog wraps.
    assert_eq!(
        servers.direct(
            "chat-a",
            &[
                "new-session",
                "-d",
                "-x",
                "100",
                "-y",
                "40",
                "-s",
                "recorded",
                "-P",
                "-F",
                "#{pane_id}",
                &start(if case == "twice" { 2 } else { 1 }, &screen)
            ]
        ),
        "%0"
    );
    assert_eq!(log_until(&log, 1).await, ["READY"]);
    let (state, app, _access, lease) = chat_fixture_app(f.dir.path().join("pick-config"));
    let parent = f.neutral(&state, &lease).await;
    // The client is as large as the window the dialog was recorded in (100 columns; tmux keeps one row for its status line), so no row wraps or scrolls away.
    let child = attach_tmux(
        lease.clone(),
        app.state(),
        parent.session_id.clone(),
        Some("chat-a".into()),
        "recorded".into(),
        100,
        40,
        Channel::new(|_| Ok(())),
    )
    .await
    .unwrap()
    .into_inner()
    .unwrap()
    .session_id;
    chat_fixture_adopt(&app, &lease, &child).await;
    assert_eq!(
        servers.direct(
            "chat-a",
            &[
                "display-message",
                "-p",
                "-t",
                "%0",
                "#{pane_width}x#{pane_height}"
            ]
        ),
        "100x39"
    );
    let source = json!({"agent":"codex","path":"/owned/rollout.jsonl","view":"conversation","inlineImages":false});
    let bound = chat_fixture_bind(&app, &lease, &child, &source).await;
    let receipt = bound["receipt"].clone();

    let call = |action: Value| chat_fixture_call(&app, &lease, &child, action);
    // What the dialog log holds after a refusal: nothing but what was there before.
    let settled = |expected: Vec<String>| {
        let log = log.clone();
        async move {
            tokio::time::sleep(Duration::from_millis(300)).await;
            assert_eq!(
                lines(&log),
                expected,
                "a refused pick reaches the pane nowhere"
            );
        }
    };
    let refused = |error: Probe<Value>, kind: &str| {
        let error = error.expect_err("the pick must be refused");
        assert!(error.contains(kind), "{error}");
    };
    match case {
        // The card read the real approval prompt: the move reaches the pane, the screen is read back, and only then does Enter.
        "answers" => {
            let moved = call(pick(
                1,
                &receipt,
                &source,
                1,
                false,
                &dialog_rows(APPROVAL, 1),
            ))
            .await
            .unwrap();
            assert_eq!(
                (moved["kind"].as_str(), moved["nextOperation"].as_u64()),
                (Some("delivered"), Some(2))
            );
            assert_eq!(log_until(&log, 2).await, ["READY", "DOWN 2"]);
            ready(&servers, "› 2. Yes, and don't ask again").await;
            call(pick(
                2,
                &receipt,
                &source,
                0,
                true,
                &dialog_rows(APPROVAL, 2),
            ))
            .await
            .unwrap();
            assert_eq!(log_until(&log, 3).await, ["READY", "DOWN 2", "CHOSE 2"]);
            // The dialog is closed now: the card it was read from answers nothing.
            refused(
                call(pick(
                    3,
                    &receipt,
                    &source,
                    0,
                    true,
                    &dialog_rows(APPROVAL, 2),
                ))
                .await,
                "tmux_chat_screen",
            );
            settled(vec!["READY".into(), "DOWN 2".into(), "CHOSE 2".into()]).await;
            refused(
                call(dismiss(3, &receipt, &source, &dialog_rows(APPROVAL, 2))).await,
                "tmux_chat_screen",
            );
            settled(vec!["READY".into(), "DOWN 2".into(), "CHOSE 2".into()]).await;
        }
        "dismiss" => {
            let result = call(dismiss(1, &receipt, &source, &dialog_rows(APPROVAL, 1)))
                .await
                .unwrap();
            assert_eq!(result["nextOperation"], 2);
            assert_eq!(log_until(&log, 2).await, ["READY", "ESC"]);
        }
        // Two prompts that match the card are not one request: nothing is sent, and the destination still stands.
        "twice" => {
            refused(
                call(pick(
                    1,
                    &receipt,
                    &source,
                    1,
                    false,
                    &dialog_rows(APPROVAL, 1),
                ))
                .await,
                "tmux_chat_screen",
            );
            settled(vec!["READY".into()]).await;
            refused(
                call(dismiss(1, &receipt, &source, &dialog_rows(APPROVAL, 1))).await,
                "tmux_chat_screen",
            );
            settled(vec!["READY".into()]).await;
            let stop = call(json!({"kind":"input","receipt":receipt,"source":source,"operation":1,"input":{"kind":"request_stop"}})).await.unwrap();
            assert_eq!(stop["nextOperation"], 2);
            assert_eq!(log_until(&log, 2).await, ["READY", "ESC"]);
        }
        // A pane whose process was replaced, with another command in the same prompt, is not the prompt the card showed.
        "replaced" => {
            let other = f.dir.path().join("other-screen.txt");
            fs::write(&other, APPROVAL.replace("touch note.txt", "rm -rf build")).unwrap();
            servers.direct(
                "chat-a",
                &["respawn-pane", "-k", "-t", "%0", &start(1, &other)],
            );
            assert_eq!(log_until(&log, 2).await, ["READY", "READY"]);
            refused(
                call(pick(
                    1,
                    &receipt,
                    &source,
                    1,
                    false,
                    &dialog_rows(APPROVAL, 1),
                ))
                .await,
                "tmux_chat_screen",
            );
            settled(vec!["READY".into(), "READY".into()]).await;
            // The pane itself gone (another window takes over): the destination is no longer the one confirmed.
            servers.direct(
                "chat-a",
                &["new-window", "-d", "-t", "recorded", &start(1, &screen)],
            );
            assert_eq!(log_until(&log, 3).await, ["READY", "READY", "READY"]);
            servers.direct("chat-a", &["kill-pane", "-t", "%0"]);
            refused(
                call(pick(
                    1,
                    &receipt,
                    &source,
                    1,
                    false,
                    &dialog_rows(APPROVAL, 1),
                ))
                .await,
                "tmux_chat_stale",
            );
            settled(vec!["READY".into(), "READY".into(), "READY".into()]).await;
        }
        // The prompt was answered at the terminal first: the card's pick, which arrives after, sends no key at all.
        "race" => {
            servers.direct("chat-a", &["send-keys", "-t", "%0", "Down", "Enter"]);
            assert_eq!(log_until(&log, 3).await, ["READY", "DOWN 2", "CHOSE 2"]);
            ready(&servers, "You chose option 2").await;
            refused(
                call(pick(
                    1,
                    &receipt,
                    &source,
                    1,
                    false,
                    &dialog_rows(APPROVAL, 1),
                ))
                .await,
                "tmux_chat_screen",
            );
            settled(vec!["READY".into(), "DOWN 2".into(), "CHOSE 2".into()]).await;
        }
        _ => unreachable!(),
    }
}
