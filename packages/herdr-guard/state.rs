// Copyright 2026 lazysh contributors. SPDX-License-Identifier: Apache-2.0
//! Actor-owned authority. Targets are resolved without fallback; final live
//! validation and enqueue occur in one server turn, not a process attestation.

use super::protocol::{
    canonical_digest, valid_operation, Cancellation, Input, OwnershipReply, Secret, Target,
    BINDING_TTL, CHALLENGE_TTL, MAX_BINDINGS, REGISTER_TTL,
};
use std::collections::HashMap;
use std::time::Instant;

type Outcome<T> = Result<T, &'static str>;

pub(crate) struct Registry {
    boot: Secret,
    clients: HashMap<u64, Owner>,
}
struct Owner {
    nonce: Secret,
    ticket: Option<Secret>,
    registered: Instant,
    presented: bool,
    ownership: Option<Secret>,
    ownership_cancellation: Option<Cancellation>,
    last_preparation: u64,
    last_navigation: u64,
    preparing: Option<Preparation>,
    binding: Option<Binding>,
}
struct Preparation {
    operation: u64,
    source: String,
    cancellation: Cancellation,
}
struct Binding {
    receipt: Secret,
    source: String,
    target: Target,
    preparation: u64,
    preparation_cancellation: Cancellation,
    prepared: Instant,
    next_operation: u64,
    pending: Option<Pending>,
}
struct Pending {
    challenge: Secret,
    admitted: Instant,
    input: Input,
}

pub(crate) struct Prepared {
    pub(crate) boot: Secret,
    pub(crate) receipt: Secret,
    pub(crate) target: Target,
    pub(crate) preparation: u64,
    pub(crate) source: String,
}
pub(crate) struct Challenge {
    pub(crate) client: u64,
    pub(crate) boot: Secret,
    pub(crate) nonce: Secret,
    pub(crate) target: Target,
}
impl Owner {
    fn revoke(&mut self) {
        self.ticket.take();
        self.ownership.take();
        self.preparing.take();
        self.binding.take();
    }
}
impl Registry {
    fn owner_by_credential(
        &mut self,
        credential: &Secret,
        receipt: bool,
    ) -> Option<(u64, &mut Owner)> {
        self.clients.iter_mut().find_map(|(&client, owner)| {
            let matches = if receipt {
                owner
                    .binding
                    .as_ref()
                    .is_some_and(|binding| &binding.receipt == credential)
            } else {
                owner.ownership.as_ref() == Some(credential)
            };
            matches.then_some((client, owner))
        })
    }

    pub(crate) fn new() -> std::io::Result<Self> {
        Ok(Self {
            boot: Secret::generate()?,
            clients: HashMap::new(),
        })
    }
    #[cfg(test)]
    pub(crate) fn boot(&self) -> Secret {
        self.boot.clone()
    }

    pub(crate) fn register(&mut self, client: u64, nonce: Secret, now: Instant) -> Outcome<Secret> {
        self.expire(now);
        if client == 0
            || client == u64::MAX
            || self.clients.contains_key(&client)
            || self.clients.len() >= MAX_BINDINGS
            || self.clients.values().any(|owner| owner.nonce == nonce)
        {
            return Err("guard_unavailable");
        }
        let ticket = Secret::generate().map_err(|_| "guard_unavailable")?;
        self.clients.insert(
            client,
            Owner {
                nonce,
                ticket: Some(ticket.clone()),
                registered: now,
                presented: false,
                ownership: None,
                ownership_cancellation: None,
                last_preparation: 0,
                last_navigation: 0,
                preparing: None,
                binding: None,
            },
        );
        Ok(ticket)
    }

    pub(crate) fn take_ack(
        &mut self,
        client: u64,
        now: Instant,
    ) -> Option<super::protocol::Registered> {
        self.expire(now);
        let owner = self.clients.get_mut(&client)?;
        if owner.presented {
            return None;
        }
        let ticket = owner.ticket.as_ref()?.clone();
        owner.presented = true;
        Some(super::protocol::Registered {
            boot: self.boot.clone(),
            nonce: owner.nonce.clone(),
            ticket,
        })
    }

    pub(crate) fn claim(
        &mut self,
        boot: &Secret,
        ticket: &Secret,
        cancellation: Cancellation,
        now: Instant,
    ) -> Outcome<OwnershipReply> {
        self.expire(now);
        if boot != &self.boot {
            return Err("guard_stale");
        }
        let owner = self
            .clients
            .values_mut()
            .find(|owner| owner.presented && owner.ticket.as_ref() == Some(ticket))
            .ok_or("guard_stale")?;
        // Spend before entropy, publication or cancellation: an uncertain claim
        // never retries the startup ticket or creates replacement authority.
        owner.ticket.take();
        owner.ownership_cancellation = Some(cancellation.clone());
        if cancellation.cancelled() {
            return Err("guard_stale");
        }
        let ownership = Secret::generate().map_err(|_| "guard_unavailable")?;
        owner.ownership = Some(ownership.clone());
        Ok(OwnershipReply {
            boot: self.boot.clone(),
            ownership,
            last_preparation: 0,
        })
    }

    pub(crate) fn begin_preparation(
        &mut self,
        boot: &Secret,
        ownership: &Secret,
        operation: u64,
        source: String,
        cancellation: Cancellation,
        now: Instant,
    ) -> Outcome<u64> {
        self.expire(now);
        if boot != &self.boot || !valid_operation(operation) || !canonical_digest(&source) {
            return Err("guard_invalid");
        }
        let (client, owner) = self
            .owner_by_credential(ownership, false)
            .ok_or("guard_stale")?;
        if operation <= owner.last_preparation {
            return Err("guard_stale");
        }
        if owner.preparing.is_some()
            || owner
                .binding
                .as_ref()
                .is_some_and(|binding| binding.pending.is_some())
        {
            return Err("guard_busy");
        }
        // Gaps are intentional: the actor spends its number before an RPC and
        // cannot know remote admission after a lost response. Never replay it.
        owner.last_preparation = operation;
        owner.binding.take();
        owner.preparing = Some(Preparation {
            operation,
            source,
            cancellation,
        });
        Ok(client)
    }

    pub(crate) fn complete_preparation(
        &mut self,
        client: u64,
        target: Option<Target>,
        now: Instant,
    ) -> Outcome<Prepared> {
        self.expire(now);
        let owner = self.clients.get_mut(&client).ok_or("guard_stale")?;
        let preparation = owner.preparing.take().ok_or("guard_stale")?;
        if owner.ownership.is_none() || preparation.cancellation.cancelled() {
            return Err("guard_stale");
        }
        let target = target.filter(Target::valid).ok_or("guard_stale")?;
        let receipt = Secret::generate().map_err(|_| "guard_unavailable")?;
        owner.binding = Some(Binding {
            receipt: receipt.clone(),
            source: preparation.source.clone(),
            target: target.clone(),
            preparation: preparation.operation,
            preparation_cancellation: preparation.cancellation,
            prepared: now,
            next_operation: 1,
            pending: None,
        });
        Ok(Prepared {
            boot: self.boot.clone(),
            receipt,
            target,
            preparation: preparation.operation,
            source: preparation.source,
        })
    }

    pub(crate) fn admit(
        &mut self,
        boot: &Secret,
        receipt: &Secret,
        source: &str,
        operation: u64,
        input: Input,
        now: Instant,
    ) -> Outcome<Challenge> {
        self.expire(now);
        if boot != &self.boot || !input.valid() || !valid_operation(operation) {
            return Err("guard_invalid");
        }
        let (client, owner) = self
            .owner_by_credential(receipt, true)
            .ok_or("guard_stale")?;
        let binding = owner.binding.as_mut().ok_or("guard_stale")?;
        if binding.source != source
            || binding.next_operation != operation
            || binding.pending.is_some()
        {
            owner.binding.take();
            return Err("guard_stale");
        }
        binding.next_operation += 1;
        let nonce = match Secret::generate() {
            Ok(nonce) => nonce,
            Err(_) => {
                owner.binding.take();
                return Err("guard_unavailable");
            }
        };
        let target = binding.target.clone();
        binding.pending = Some(Pending {
            challenge: nonce.clone(),
            admitted: now,
            input,
        });
        Ok(Challenge {
            client,
            boot: self.boot.clone(),
            nonce,
            target,
        })
    }

    pub(crate) fn pending_matches(
        &mut self,
        client: u64,
        boot: &Secret,
        challenge: &Secret,
        now: Instant,
    ) -> bool {
        self.expire(now);
        boot == &self.boot
            && self
                .clients
                .get(&client)
                .and_then(|owner| owner.binding.as_ref())
                .and_then(|binding| binding.pending.as_ref())
                .is_some_and(|pending| &pending.challenge == challenge)
    }

    pub(crate) fn commit(
        &mut self,
        client: u64,
        boot: &Secret,
        challenge: &Secret,
        live_target: &Target,
        now: Instant,
    ) -> Outcome<Input> {
        if !self.pending_matches(client, boot, challenge, now) {
            return Err("guard_stale");
        }
        let owner = self.clients.get_mut(&client).ok_or("guard_stale")?;
        let binding = owner.binding.as_mut().ok_or("guard_stale")?;
        let pending = binding.pending.take().ok_or("guard_stale")?;
        if &binding.target != live_target {
            owner.binding.take();
            return Err("guard_stale");
        }
        Ok(pending.input)
    }

    pub(crate) fn release(&mut self, boot: &Secret, receipt: &Secret, now: Instant) -> Option<u64> {
        self.expire(now);
        if boot != &self.boot {
            return None;
        }
        let (client, owner) = self.owner_by_credential(receipt, true)?;
        owner.binding.take();
        Some(client)
    }

    pub(crate) fn current_owner_id(
        &mut self,
        boot: &Secret,
        ownership: &Secret,
        now: Instant,
    ) -> Option<u64> {
        self.current_owner(boot, ownership, now)
            .map(|(client, _)| client)
    }

    pub(crate) fn navigate(
        &mut self,
        boot: &Secret,
        ownership: &Secret,
        operation: u64,
        now: Instant,
    ) -> Outcome<u64> {
        if !valid_operation(operation) {
            return Err("guard_invalid");
        }
        let (client, owner) = self
            .current_owner(boot, ownership, now)
            .ok_or("guard_stale")?;
        if operation <= owner.last_navigation {
            return Err("guard_stale");
        }
        owner.last_navigation = operation;
        owner.preparing.take();
        owner.binding.take();
        Ok(client)
    }

    fn current_owner(
        &mut self,
        boot: &Secret,
        ownership: &Secret,
        now: Instant,
    ) -> Option<(u64, &mut Owner)> {
        self.expire(now);
        if boot != &self.boot {
            return None;
        }
        self.owner_by_credential(ownership, false)
    }

    pub(crate) fn cancel_preparation(
        &mut self,
        boot: &Secret,
        ownership: &Secret,
        operation: u64,
        now: Instant,
    ) -> Option<u64> {
        let (client, owner) = self.current_owner(boot, ownership, now)?;
        let preparing = owner
            .preparing
            .as_ref()
            .is_some_and(|preparing| preparing.operation == operation);
        let bound = owner
            .binding
            .as_ref()
            .is_some_and(|binding| binding.preparation == operation);
        if preparing {
            owner.preparing.take();
        }
        if bound {
            owner.binding.take();
        }
        (preparing || bound).then_some(client)
    }

    pub(crate) fn revoke_ownership(
        &mut self,
        boot: &Secret,
        ownership: &Secret,
        now: Instant,
    ) -> Option<u64> {
        let (client, owner) = self.current_owner(boot, ownership, now)?;
        owner.revoke();
        Some(client)
    }

    pub(crate) fn revoke_client(&mut self, client: u64) {
        if let Some(owner) = self.clients.get_mut(&client) {
            owner.revoke();
        }
    }
    pub(crate) fn disconnected(&mut self, client: u64) {
        self.clients.remove(&client);
    }

    pub(crate) fn expire(&mut self, now: Instant) {
        // Retired owners remain until transport disconnect, so expiry cannot
        // reopen registration or reset preparation numbers on that connection.
        for owner in self.clients.values_mut() {
            if owner
                .ownership_cancellation
                .as_ref()
                .is_some_and(Cancellation::cancelled)
            {
                owner.revoke();
            }
            if owner.ticket.is_some()
                && now.saturating_duration_since(owner.registered) >= REGISTER_TTL
            {
                owner.ticket.take();
            }
            if owner
                .preparing
                .as_ref()
                .is_some_and(|preparing| preparing.cancellation.cancelled())
            {
                owner.preparing.take();
            }
            if owner.binding.as_ref().is_some_and(|binding| {
                binding.preparation_cancellation.cancelled()
                    || now.saturating_duration_since(binding.prepared) >= BINDING_TTL
                    || binding.pending.as_ref().is_some_and(|pending| {
                        now.saturating_duration_since(pending.admitted) >= CHALLENGE_TTL
                    })
            }) {
                owner.binding.take();
            }
        }
    }
}

#[cfg(test)]
#[path = "state_tests.rs"]
pub(crate) mod tests;
