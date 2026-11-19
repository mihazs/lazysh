//! The control plane's event stream (#1321): what a reader of text is told, and how seldom.
//!
//! A reader pulls the state ([`TerminalRuntime::control_snapshot`](crate::TerminalRuntime::control_snapshot)) and is told when to
//! pull again. Output arrives at the speed of the program; the [`Doorbell`] turns it into one
//! [`ControlEvent::Changed`] per read of the state, so the messages a reader gets follow how fast it reads and not
//! how much the program prints. What the program reported (title, bell, directory, clipboard) goes out just before
//! the `Changed` that follows it, and at the next read if it arrived while one was already waiting, so none waits for
//! output that may never come. Both run under one lock: the events leave in the order they were taken.

use crate::{ControlEvent, Session};
use std::sync::atomic::{AtomicBool, Ordering::AcqRel, Ordering::Release};
use std::sync::{Arc, Mutex, OnceLock, PoisonError};

pub struct Doorbell {
    sink: Box<dyn Fn(ControlEvent) + Send + Sync>,
    /// Whether the host lets anything leave now (the app is not locked): when it does not, nothing is taken or
    /// sent and the next change rings again.
    permitted: Box<dyn Fn() -> bool + Send + Sync>,
    session: OnceLock<Session>,
    /// A `Changed` went out and the reader has not read since.
    rung: AtomicBool,
    /// Taking events and handing them to the sink are one step, so two threads cannot swap their order.
    order: Mutex<()>,
}

impl Doorbell {
    /// `sink` gets every event, on whatever thread raised it, and must not block: send it and return.
    pub fn new(
        sink: impl Fn(ControlEvent) + Send + Sync + 'static,
        permitted: impl Fn() -> bool + Send + Sync + 'static,
    ) -> Self {
        Self {
            sink: Box::new(sink),
            permitted: Box::new(permitted),
            session: OnceLock::new(),
            rung: AtomicBool::new(false),
            order: Mutex::new(()),
        }
    }

    /// The session whose reports this doorbell sends. The session is built with [`hook`](Self::hook) as its
    /// [`Hooks::changed`](crate::Hooks::changed), so the doorbell is bound after it exists; nothing rings before.
    pub fn bind(&self, session: Session) {
        let _ = self.session.set(session);
    }

    /// The function for [`Hooks::changed`](crate::Hooks::changed). It holds the doorbell weakly: the session owns its
    /// hooks and the doorbell holds the session, so a strong hold would keep both alive after the session closed.
    /// Whoever owns the doorbell (the core of the session) frees it with the session.
    pub fn hook(self: &Arc<Self>) -> Box<dyn Fn() + Send + Sync> {
        let bell = Arc::downgrade(self);
        Box::new(move || {
            if let Some(bell) = bell.upgrade() {
                bell.changed();
            }
        })
    }

    /// Output changed the screen of an active session ([`Hooks::changed`](crate::Hooks::changed); any thread).
    pub fn changed(&self) {
        if !self.rung.swap(true, AcqRel) {
            self.deliver(true);
        }
    }

    /// The reader is about to read the state: a later change rings again. Reports that arrived while a ring was
    /// still unanswered go out now.
    pub fn read(&self) {
        self.rung.store(false, Release);
        self.deliver(false);
    }

    /// Ring now, whatever was rung before: something changed while nobody was told (the session became active).
    pub fn wake(&self) {
        self.rung.store(false, Release);
        self.changed();
    }

    fn deliver(&self, ring: bool) {
        let _order = self.order.lock().unwrap_or_else(PoisonError::into_inner);
        if !(self.permitted)() {
            if ring {
                self.rung.store(false, Release);
            }
            return;
        }
        let events = self
            .session
            .get()
            .and_then(|session| session.with(|runtime| runtime.take_control_events()).ok())
            .unwrap_or_default();
        events.into_iter().for_each(&self.sink);
        if ring {
            (self.sink)(ControlEvent::Changed);
        }
    }
}
