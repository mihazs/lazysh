use super::*;

const SNAPSHOT: &str = include_str!("fixtures/listeners-snapshot.json");
const LOOPBACK: u16 = 42593;
const WILDCARD: u16 = 45053;

fn listener(age: Option<u64>) -> Listener {
    Listener {
        source: "companion",
        bind: "loopback",
        owned_by_session_user: true,
        age_seconds: age,
        comm: None,
        pid: None,
    }
}

#[test]
fn a_listener_is_the_sign_ins_own_when_it_started_two_minutes_before_to_half_a_minute_after_the_hint(
) {
    // (age of the hint, age of the listener's process, verdict). The hint is `hint_age` old, so the
    // process started `hint_age - age` seconds after the hint (negative: before it).
    for (hint_age, age, expected) in [
        (0, 0, Presence::Confirmed),
        (5, 3, Presence::Confirmed),
        (2, 122, Presence::Confirmed), // started 120 s before the hint
        (2, 123, Presence::Stale),     // 121 s before
        (0, 3600, Presence::Stale),
        (30, 0, Presence::Confirmed), // appeared 30 s after the hint
        (31, 0, Presence::Stale),     // 31 s after
        (0, 86_000, Presence::Stale),
    ] {
        assert_eq!(
            decide(Some(listener(Some(age))), hint_age).state,
            expected,
            "hint {hint_age} s old, process {age} s old"
        );
    }
    assert_eq!(decide(None, 5).state, Presence::Absent);
    assert_eq!(decide(Some(listener(None)), 5).state, Presence::Unproven);
}

#[test]
fn the_companions_real_answer_is_read_by_port_and_prefers_the_session_users_socket() {
    let loopback = from_companion(SNAPSHOT, LOOPBACK).unwrap().unwrap();
    assert_eq!(
        (
            loopback.source,
            loopback.bind,
            loopback.owned_by_session_user,
            loopback.age_seconds,
            loopback.comm.as_deref()
        ),
        ("companion", "loopback", true, Some(1), Some("python3"))
    );
    assert!(loopback.pid.is_some());
    assert_eq!(
        from_companion(SNAPSHOT, WILDCARD).unwrap().unwrap().bind,
        "wildcard"
    );
    assert_eq!(
        from_companion(SNAPSHOT, 9).unwrap(),
        None,
        "a port nothing listens on is an answer: absent"
    );

    let both = SNAPSHOT.replace(
        &format!("\"port\":{WILDCARD}"),
        &format!("\"port\":{LOOPBACK}"),
    );
    let other_first = both.replacen(
        "\"ownedBySessionUser\":true",
        "\"ownedBySessionUser\":false",
        1,
    );
    let chosen = from_companion(&other_first, LOOPBACK).unwrap().unwrap();
    assert!(
        chosen.owned_by_session_user,
        "the user's own socket wins over another user's"
    );

    let foreign = SNAPSHOT.replace(
        "\"ownedBySessionUser\":true",
        "\"ownedBySessionUser\":false",
    );
    assert!(
        !from_companion(&foreign, LOOPBACK)
            .unwrap()
            .unwrap()
            .owned_by_session_user
    );
}

#[test]
fn anything_but_the_documented_answer_is_no_answer() {
    for text in [
        "",
        "not json",
        "{}",
        r#"{"schemaVersion":2,"event":"snapshot","listeners":[]}"#,
        r#"{"schemaVersion":1,"event":"listen","listeners":[]}"#,
        r#"{"schemaVersion":1,"event":"snapshot"}"#,
        COMPANION_REQUIRED,
    ] {
        assert_eq!(from_companion(text, 8085), None, "{text:?}");
    }
}

#[test]
fn the_ss_and_lsof_fallback_shows_a_process_only_for_the_session_users_sockets() {
    let rows = previews::parse_listeners(
        "LISTEN 0 512 127.0.0.1:8085 0.0.0.0:* users:((\"aws\",pid=4312,fd=7))\n\
         LISTEN 0 128 0.0.0.0:53000 0.0.0.0:*\n\
         LISTEN 0 128 [::1]:9005 [::]:* users:((\"firebase\",pid=77,fd=9))",
    );
    let ours = from_fallback(rows, 8085).unwrap();
    assert_eq!(
        (
            ours.source,
            ours.bind,
            ours.owned_by_session_user,
            ours.age_seconds
        ),
        ("fallback", "loopback", true, None)
    );
    assert_eq!((ours.comm.as_deref(), ours.pid), (Some("aws"), Some(4312)));

    let rows = || {
        previews::parse_listeners("LISTEN 0 128 0.0.0.0:53000 0.0.0.0:*\nLISTEN 0 128 [::1]:9005 [::]:* users:((\"firebase\",pid=77,fd=9))")
    };
    let daemon = from_fallback(rows(), 53000).unwrap();
    assert_eq!(
        (daemon.bind, daemon.owned_by_session_user, daemon.comm),
        ("wildcard", false, None)
    );
    assert_eq!(from_fallback(rows(), 9005).unwrap().bind, "loopback");
    assert_eq!(from_fallback(rows(), 1234), None);
}

#[test]
fn a_verdict_serializes_for_the_app_without_empty_fields() {
    let verdict = decide(
        Some(Listener {
            comm: Some("aws".into()),
            pid: Some(7),
            ..listener(Some(2))
        }),
        1,
    );
    assert_eq!(
        serde_json::to_value(&verdict).unwrap(),
        serde_json::json!({"state": "confirmed", "listener": {"source": "companion", "bind": "loopback", "ownedBySessionUser": true, "ageSeconds": 2, "comm": "aws", "pid": 7}})
    );
    assert_eq!(
        serde_json::to_value(decide(None, 1)).unwrap(),
        serde_json::json!({"state": "absent"})
    );
}
