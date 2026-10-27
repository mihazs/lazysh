// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
use super::*;
use crate::guarded_input::protocol::Viewport;

pub(crate) fn target() -> Target {
    Target {
        workspace: "workspace".into(),
        tab: "tab".into(),
        pane: "pane".into(),
        terminal: "terminal".into(),
        runtime_generation: 1,
        viewport: Viewport {
            x: 0,
            y: 0,
            width: 80,
            height: 24,
        },
    }
}
pub(crate) fn registered(now: Instant) -> (Registry, super::super::protocol::Registered) {
    let mut registry = Registry::new().unwrap();
    registry
        .register(7, Secret::generate().unwrap(), now)
        .unwrap();
    let ack = registry.take_ack(7, now).unwrap();
    (registry, ack)
}

pub(crate) fn assert_spent_ticket(
    registry: &mut Registry,
    boot: &Secret,
    ticket: &Secret,
    now: Instant,
) {
    assert_eq!(
        registry
            .claim(boot, ticket, Cancellation::default(), now)
            .err(),
        Some("guard_stale")
    );
}

pub(crate) fn claimed(
    now: Instant,
    cancellation: Cancellation,
) -> (Registry, OwnershipReply, Secret) {
    let (mut registry, ack) = registered(now);
    let owner = registry
        .claim(&ack.boot, &ack.ticket, cancellation, now)
        .unwrap();
    (registry, owner, ack.ticket)
}
pub(crate) fn prepare(
    registry: &mut Registry,
    owner: &OwnershipReply,
    number: u64,
    source: &str,
    target: Target,
    cancellation: Cancellation,
    now: Instant,
) -> Prepared {
    let client = registry
        .begin_preparation(
            &owner.boot,
            &owner.ownership,
            number,
            source.into(),
            cancellation,
            now,
        )
        .unwrap();
    registry
        .complete_preparation(client, Some(target), now)
        .unwrap()
}
fn prepared(now: Instant) -> (Registry, OwnershipReply, Prepared, String) {
    let (mut registry, owner, _) = claimed(now, Cancellation::default());
    let source = "ab".repeat(32);
    let binding = prepare(
        &mut registry,
        &owner,
        1,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    (registry, owner, binding, source)
}
fn admitted(registry: &mut Registry, binding: &Prepared, source: &str, now: Instant) -> Challenge {
    registry
        .admit(
            &binding.boot,
            &binding.receipt,
            source,
            1,
            Input::Send {
                text: "literal\ntext\t🙂".into(),
            },
            now,
        )
        .unwrap()
}

#[test]
fn claim_ticket_is_once_and_wrong_reader_cannot_commit() {
    let now = Instant::now();
    let (mut registry, owner, ticket) = claimed(now, Cancellation::default());
    assert_spent_ticket(&mut registry, &owner.boot, &ticket, now);
    let source = "ab".repeat(32);
    let binding = prepare(
        &mut registry,
        &owner,
        1,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    let challenge = admitted(&mut registry, &binding, &source, now);
    assert_eq!(
        registry
            .commit(8, &challenge.boot, &challenge.nonce, &target(), now)
            .err(),
        Some("guard_stale")
    );
    assert!(
        matches!(registry.commit(7, &challenge.boot, &challenge.nonce, &target(), now), Ok(Input::Send { text }) if text == "literal\ntext\t🙂")
    );
    assert_eq!(
        registry
            .commit(7, &challenge.boot, &challenge.nonce, &target(), now)
            .err(),
        Some("guard_stale")
    );
}

#[test]
fn binding_expiry_requires_explicit_prepare_but_not_new_client_or_lease() {
    let now = Instant::now();
    let (mut registry, owner, binding, source) = prepared(now);
    let later = now + BINDING_TTL;
    assert_eq!(
        registry
            .admit(
                &binding.boot,
                &binding.receipt,
                &source,
                1,
                Input::RequestStop,
                later
            )
            .err(),
        Some("guard_stale")
    );
    let replacement = prepare(
        &mut registry,
        &owner,
        3,
        &source,
        target(),
        Cancellation::default(),
        later,
    );
    assert!(replacement.receipt != binding.receipt);
    assert_eq!(registry.clients.len(), 1);
    assert!(registry
        .admit(
            &replacement.boot,
            &replacement.receipt,
            &source,
            1,
            Input::RequestStop,
            later
        )
        .is_ok());
}

#[test]
fn lost_and_out_of_order_preparations_cannot_overwrite_newer_binding() {
    let now = Instant::now();
    let (mut registry, owner, _) = claimed(now, Cancellation::default());
    let source = "ab".repeat(32);
    // Numbers 1 and 2 never arrived. Explicit 3 remains usable without guessing
    // whether the lost requests were admitted, and no request is replayed.
    let current = prepare(
        &mut registry,
        &owner,
        3,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    for number in [1, 2, 3] {
        assert_eq!(
            registry
                .begin_preparation(
                    &owner.boot,
                    &owner.ownership,
                    number,
                    source.clone(),
                    Cancellation::default(),
                    now
                )
                .err(),
            Some("guard_stale")
        );
    }
    assert!(registry
        .admit(
            &current.boot,
            &current.receipt,
            &source,
            1,
            Input::RequestStop,
            now
        )
        .is_ok());
}

#[test]
fn preparation_and_input_busy_are_not_queued_or_automatically_retried() {
    let now = Instant::now();
    let (mut registry, owner, _) = claimed(now, Cancellation::default());
    let source = "ab".repeat(32);
    registry
        .begin_preparation(
            &owner.boot,
            &owner.ownership,
            1,
            source.clone(),
            Cancellation::default(),
            now,
        )
        .unwrap();
    assert_eq!(
        registry
            .begin_preparation(
                &owner.boot,
                &owner.ownership,
                2,
                source.clone(),
                Cancellation::default(),
                now
            )
            .err(),
        Some("guard_busy")
    );
    let binding = registry
        .complete_preparation(7, Some(target()), now)
        .unwrap();
    let challenge = admitted(&mut registry, &binding, &source, now);
    assert_eq!(
        registry
            .begin_preparation(
                &owner.boot,
                &owner.ownership,
                3,
                source.clone(),
                Cancellation::default(),
                now
            )
            .err(),
        Some("guard_busy")
    );
    assert!(registry
        .commit(7, &challenge.boot, &challenge.nonce, &target(), now)
        .is_ok());
    let replacement = prepare(
        &mut registry,
        &owner,
        4,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    assert_eq!(replacement.preparation, 4);
}

#[test]
fn stale_release_cancellation_and_commit_do_not_retire_newer_input() {
    let now = Instant::now();
    let (mut registry, owner, _) = claimed(now, Cancellation::default());
    let source = "ab".repeat(32);
    let old_cancel = Cancellation::default();
    let old = prepare(
        &mut registry,
        &owner,
        1,
        &source,
        target(),
        old_cancel.clone(),
        now,
    );
    let old_challenge = admitted(&mut registry, &old, &source, now);
    assert!(registry
        .commit(7, &old_challenge.boot, &old_challenge.nonce, &target(), now)
        .is_ok());
    let current = prepare(
        &mut registry,
        &owner,
        2,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    let challenge = admitted(&mut registry, &current, &source, now);
    old_cancel.cancel();
    assert!(registry.release(&owner.boot, &old.receipt, now).is_none());
    assert!(registry
        .cancel_preparation(&owner.boot, &owner.ownership, 1, now)
        .is_none());
    assert_eq!(
        registry
            .commit(7, &old_challenge.boot, &old_challenge.nonce, &target(), now)
            .err(),
        Some("guard_stale")
    );
    assert!(registry
        .commit(7, &challenge.boot, &challenge.nonce, &target(), now)
        .is_ok());
}

#[test]
fn matching_cancel_and_revoke_fail_closed_without_reclaim_or_renewal() {
    let now = Instant::now();
    let (mut registry, owner, ticket) = claimed(now, Cancellation::default());
    let source = "ab".repeat(32);
    let old = prepare(
        &mut registry,
        &owner,
        1,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    assert_eq!(
        registry.cancel_preparation(&owner.boot, &owner.ownership, 1, now),
        Some(7)
    );
    assert_eq!(
        registry
            .admit(&old.boot, &old.receipt, &source, 1, Input::RequestStop, now)
            .err(),
        Some("guard_stale")
    );
    let current = prepare(
        &mut registry,
        &owner,
        2,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    assert_eq!(
        registry.revoke_ownership(&owner.boot, &owner.ownership, now),
        Some(7)
    );
    assert_eq!(
        registry
            .admit(
                &current.boot,
                &current.receipt,
                &source,
                1,
                Input::RequestStop,
                now
            )
            .err(),
        Some("guard_stale")
    );
    assert_eq!(
        registry
            .begin_preparation(
                &owner.boot,
                &owner.ownership,
                3,
                source,
                Cancellation::default(),
                now
            )
            .err(),
        Some("guard_stale")
    );
    assert_spent_ticket(&mut registry, &owner.boot, &ticket, now);
    assert_eq!(
        registry.register(7, Secret::generate().unwrap(), now).err(),
        Some("guard_unavailable")
    );
}

#[test]
fn captured_ownership_cancellation_cannot_be_replaced_by_fresh_flag() {
    let now = Instant::now();
    let cancelled = Cancellation::default();
    let (mut registry, owner, ticket) = claimed(now, cancelled.clone());
    let source = "ab".repeat(32);
    let binding = prepare(
        &mut registry,
        &owner,
        1,
        &source,
        target(),
        Cancellation::default(),
        now,
    );
    cancelled.cancel();
    assert_eq!(
        registry
            .admit(
                &binding.boot,
                &binding.receipt,
                &source,
                1,
                Input::RequestStop,
                now
            )
            .err(),
        Some("guard_stale")
    );
    assert_eq!(
        registry
            .begin_preparation(
                &owner.boot,
                &owner.ownership,
                2,
                source,
                Cancellation::default(),
                now
            )
            .err(),
        Some("guard_stale")
    );
    assert_spent_ticket(&mut registry, &owner.boot, &ticket, now);
    // This is the protocol's original cancellation lifetime, not execution of
    // lazysh's separate Tauri vault AccessLease or native SSH actor.
}

#[test]
fn uncertain_claim_expiry_and_disconnect_do_not_restore_ticket() {
    let now = Instant::now();
    let flag = Cancellation::default();
    let (mut registry, owner, ticket) = claimed(now, flag.clone());
    flag.cancel(); // Claimed response was lost/abandoned before publication.
    assert_eq!(
        registry
            .begin_preparation(
                &owner.boot,
                &owner.ownership,
                1,
                "ab".repeat(32),
                Cancellation::default(),
                now
            )
            .err(),
        Some("guard_stale")
    );
    assert_spent_ticket(&mut registry, &owner.boot, &ticket, now);
    registry.disconnected(7);
    assert_eq!(
        registry
            .begin_preparation(
                &owner.boot,
                &owner.ownership,
                2,
                "ab".repeat(32),
                Cancellation::default(),
                now
            )
            .err(),
        Some("guard_stale")
    );
    assert!(registry.clients.is_empty());
    registry
        .register(9, Secret::generate().unwrap(), now)
        .unwrap();
    let expired = registry.take_ack(9, now).unwrap();
    assert_eq!(
        registry
            .claim(
                &expired.boot,
                &expired.ticket,
                Cancellation::default(),
                now + REGISTER_TTL
            )
            .err(),
        Some("guard_stale")
    );
    assert_eq!(
        registry
            .register(9, Secret::generate().unwrap(), now + REGISTER_TTL)
            .err(),
        Some("guard_unavailable")
    );
}

#[test]
fn target_source_and_pending_deadline_reject_without_owner_renewal() {
    for alteration in [0, 1, 2] {
        let now = Instant::now();
        let (mut registry, owner, binding, source) = prepared(now);
        let challenge = admitted(&mut registry, &binding, &source, now);
        let mut current = target();
        let later = match alteration {
            0 => {
                current.terminal = "replacement".into();
                now
            }
            1 => {
                current.runtime_generation += 1;
                now
            }
            _ => now + CHALLENGE_TTL,
        };
        assert_eq!(
            registry
                .commit(7, &challenge.boot, &challenge.nonce, &current, later)
                .err(),
            Some("guard_stale")
        );
        let next = prepare(
            &mut registry,
            &owner,
            2,
            &source,
            target(),
            Cancellation::default(),
            later,
        );
        assert_eq!(
            registry
                .admit(
                    &next.boot,
                    &next.receipt,
                    &"cd".repeat(32),
                    1,
                    Input::RequestStop,
                    later
                )
                .err(),
            Some("guard_stale")
        );
    }
}

#[test]
fn competing_registration_and_saturated_transport_ids_cannot_recreate_authority() {
    let now = Instant::now();
    let mut registry = Registry::new().unwrap();
    for client in [0, u64::MAX] {
        assert_eq!(
            registry
                .register(client, Secret::generate().unwrap(), now)
                .err(),
            Some("guard_unavailable")
        );
    }
    let nonce = Secret::generate().unwrap();
    let ticket = registry.register(1, nonce.clone(), now).unwrap();
    registry.take_ack(1, now).unwrap();
    let owner = registry
        .claim(&registry.boot(), &ticket, Cancellation::default(), now)
        .unwrap();
    registry.disconnected(1);
    let new_ticket = registry.register(2, nonce, now).unwrap();
    registry.take_ack(2, now).unwrap();
    assert!(new_ticket != ticket);
    assert_spent_ticket(&mut registry, &owner.boot, &ticket, now);
    assert!(registry
        .claim(&owner.boot, &new_ticket, Cancellation::default(), now)
        .is_ok());
}
