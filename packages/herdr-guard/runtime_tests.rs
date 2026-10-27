// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
use super::*;

fn runtime() -> TerminalRuntime {
    TerminalRuntime::test_with_channel(80, 24).0
}

#[tokio::test]
async fn same_terminal_id_replacement_and_registry_restore_never_reuse_generation() {
    let id = TerminalId::alloc();
    let mut registry = TerminalRuntimeRegistry::new();
    registry.insert(id.clone(), runtime());
    let original = registry.generation(&id).unwrap();
    registry.insert(id.clone(), runtime());
    let replacement = registry.generation(&id).unwrap();
    assert_ne!(original, replacement);
    assert!(registry.remove(&id).is_some());
    registry.insert(id.clone(), runtime());
    assert_ne!(replacement, registry.generation(&id).unwrap());
    let restored = TerminalRuntimeRegistry::from(HashMap::from([(id.clone(), runtime())]));
    assert_ne!(original, restored.generation(&id).unwrap());
    assert_ne!(registry.generation(&id), restored.generation(&id));
}

#[test]
fn generation_overflow_is_permanently_unavailable_without_wrapping() {
    let counter = std::sync::atomic::AtomicU64::new(u64::MAX - 1);
    assert_eq!(allocate_generation(&counter), Some(u64::MAX - 1));
    assert_eq!(allocate_generation(&counter), None);
    assert_eq!(allocate_generation(&counter), None);
}

#[tokio::test]
async fn same_terminal_id_replacement_invalidates_the_prepared_guard() {
    use crate::guarded_input::protocol::{Input, Target, Viewport};
    let now = std::time::Instant::now();
    let terminal = TerminalId::alloc();
    let mut runtimes = TerminalRuntimeRegistry::new();
    runtimes.insert(terminal.clone(), runtime());
    let target = Target {
        workspace: "workspace".into(),
        tab: "tab".into(),
        pane: "pane".into(),
        terminal: terminal.to_string(),
        runtime_generation: runtimes.generation(&terminal).unwrap(),
        viewport: Viewport {
            x: 0,
            y: 0,
            width: 80,
            height: 24,
        },
    };
    let (mut authority, owner, _) = crate::guarded_input::state::tests::claimed(
        now,
        crate::guarded_input::protocol::Cancellation::default(),
    );
    let source = "ab".repeat(32);
    let prepared = crate::guarded_input::state::tests::prepare(
        &mut authority,
        &owner,
        1,
        &source,
        target.clone(),
        crate::guarded_input::protocol::Cancellation::default(),
        now,
    );
    let challenge = authority
        .admit(
            &prepared.boot,
            &prepared.receipt,
            &source,
            1,
            Input::RequestStop,
            now,
        )
        .unwrap();
    runtimes.insert(terminal.clone(), runtime());
    let mut current = target;
    current.runtime_generation = runtimes.generation(&terminal).unwrap();
    assert_eq!(
        authority
            .commit(7, &challenge.boot, &challenge.nonce, &current, now)
            .err(),
        Some("guard_stale")
    );
}
