// Modified by lazysh: server-only insertion generations for guarded terminal identity.
use std::collections::HashMap;

use super::{TerminalId, TerminalRuntime};

/// Server-owned live terminal runtimes, keyed by durable terminal id.
///
/// This sits outside `AppState` so pure state can stay focused on workspace,
/// pane, and terminal metadata while the server/application layer owns PTYs,
/// parser backends, detector tasks, and channels.
#[derive(Default)]
pub(crate) struct TerminalRuntimeRegistry {
    runtimes: HashMap<TerminalId, RuntimeEntry>,
}

struct RuntimeEntry {
    runtime: TerminalRuntime,
    generation: Option<u64>,
}

static NEXT_RUNTIME_GENERATION: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);

fn allocate_generation(counter: &std::sync::atomic::AtomicU64) -> Option<u64> {
    use std::sync::atomic::Ordering;
    counter
        .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |value| {
            value.checked_add(1)
        })
        .ok()
}

impl TerminalRuntimeRegistry {
    pub(crate) fn new() -> Self {
        Self::default()
    }

    pub(crate) fn get(&self, terminal_id: &TerminalId) -> Option<&TerminalRuntime> {
        self.runtimes.get(terminal_id).map(|entry| &entry.runtime)
    }

    pub(crate) fn generation(&self, terminal_id: &TerminalId) -> Option<u64> {
        self.runtimes.get(terminal_id)?.generation
    }

    pub(crate) fn insert(
        &mut self,
        terminal_id: TerminalId,
        runtime: TerminalRuntime,
    ) -> Option<TerminalRuntime> {
        let generation = allocate_generation(&NEXT_RUNTIME_GENERATION);
        self.runtimes
            .insert(
                terminal_id,
                RuntimeEntry {
                    runtime,
                    generation,
                },
            )
            .map(|entry| entry.runtime)
    }

    pub(crate) fn remove(&mut self, terminal_id: &TerminalId) -> Option<TerminalRuntime> {
        self.runtimes.remove(terminal_id).map(|entry| entry.runtime)
    }

    pub(crate) fn values(&self) -> impl Iterator<Item = &TerminalRuntime> {
        self.runtimes.values().map(|entry| &entry.runtime)
    }

    #[cfg(unix)]
    pub(crate) fn iter(&self) -> impl Iterator<Item = (&TerminalId, &TerminalRuntime)> {
        self.runtimes.iter().map(|(id, entry)| (id, &entry.runtime))
    }

    #[cfg(unix)]
    pub(crate) fn set_handoff_readers_paused(&self, paused: bool) {
        for runtime in self.values() {
            runtime.set_handoff_reader_paused(paused);
        }
    }

    #[cfg(unix)]
    pub(crate) fn assume_handoff_ownership(&mut self) {
        for runtime in self.runtimes.values_mut() {
            runtime.runtime.assume_handoff_ownership();
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.runtimes.len()
    }

    #[cfg(unix)]
    pub(crate) fn nudge_child_redraw_after_handoff(&self) {
        for runtime in self.values() {
            runtime.nudge_child_redraw_after_handoff();
        }
    }

    #[cfg(unix)]
    pub(crate) fn drain_for_handoff(
        &mut self,
    ) -> impl Iterator<Item = (TerminalId, TerminalRuntime)> + '_ {
        self.runtimes.drain().map(|(id, entry)| (id, entry.runtime))
    }

    #[cfg(test)]
    pub(crate) fn drain(&mut self) -> impl Iterator<Item = (TerminalId, TerminalRuntime)> + '_ {
        self.runtimes.drain().map(|(id, entry)| (id, entry.runtime))
    }
}

impl From<HashMap<TerminalId, TerminalRuntime>> for TerminalRuntimeRegistry {
    fn from(runtimes: HashMap<TerminalId, TerminalRuntime>) -> Self {
        let mut registry = Self::new();
        for (id, runtime) in runtimes {
            registry.insert(id, runtime);
        }
        registry
    }
}

#[cfg(test)]
#[path = "../../../herdr-guard/runtime_tests.rs"]
mod guard_identity_tests;
