//! What the relay has said that the renderer has not read yet.
//!
//! The renderer pulls one message at a time, so a slow webview slows nothing but itself: the queue keeps the
//! newest frame and the newest message of each other kind (state, page, refused, closed), so it never grows,
//! and the relay's own pacing (two unacknowledged frames at most) stops it from sending more than the
//! renderer decoded.
use super::wire::{self, Control};
use crate::ssh::{Result, SshError};
use std::{
    collections::VecDeque,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tokio::{sync::Notify, time::Instant};

/// A pull that found nothing for this long; the renderer asks again.
pub(super) const IDLE: u8 = 0;

enum Item {
    /// The tag and the frame, as the relay sent them.
    Frame(Vec<u8>),
    Control(Control),
}
impl Item {
    fn kind(&self) -> u8 {
        match self {
            Self::Frame(_) => 0,
            Self::Control(Control::State { .. }) => 1,
            Self::Control(Control::Page { .. }) => 2,
            Self::Control(Control::Refused { .. }) => 3,
            Self::Control(Control::Closed { .. }) => 4,
        }
    }
    fn is_closed(&self) -> bool {
        matches!(self, Self::Control(Control::Closed { .. }))
    }
    /// What the renderer reads: the relay's tag, then the frame or the JSON object.
    fn bytes(self) -> Vec<u8> {
        match self {
            Self::Frame(frame) => frame,
            Self::Control(control) => {
                let mut bytes = vec![wire::JSON];
                // A validated message is plain data: it serializes.
                bytes.extend(serde_json::to_vec(&control).unwrap_or_default());
                bytes
            }
        }
    }
}

#[derive(Default)]
struct Queue {
    items: VecDeque<Item>,
    /// The closing message is queued: nothing after it is kept.
    closing: bool,
    /// The closing message was read, or the app lock dropped everything.
    over: bool,
}

#[derive(Default)]
pub(super) struct Outbox {
    queue: Mutex<Queue>,
    ready: Notify,
    pulling: AtomicBool,
}
impl Outbox {
    fn queue(&self) -> std::sync::MutexGuard<'_, Queue> {
        self.queue
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn push(&self, item: Item) {
        let mut queue = self.queue();
        if queue.closing || queue.over {
            return;
        }
        queue.closing = item.is_closed();
        let kind = item.kind();
        queue.items.retain(|queued| queued.kind() != kind);
        queue.items.push_back(item);
        drop(queue);
        self.ready.notify_one();
    }
    pub(super) fn frame(&self, frame: Vec<u8>) {
        self.push(Item::Frame(frame));
    }
    pub(super) fn control(&self, control: Control) {
        self.push(Item::Control(control));
    }
    /// The view is hidden: a frame that was queued before must not be the first thing it shows again.
    pub(super) fn drop_frames(&self) {
        self.queue().items.retain(|queued| queued.kind() != 0);
    }
    /// The app lock: nothing the page showed stays, and nothing more is kept.
    pub(super) fn seal(&self) {
        let mut queue = self.queue();
        queue.items.clear();
        queue.over = true;
        drop(queue);
        self.ready.notify_one();
    }

    /// The next message for the renderer, or one idle byte after `wait` with nothing. One pull at a time: a
    /// second one is refused, so two renderers cannot split a stream between them.
    pub(super) async fn pull(&self, wait: Duration) -> Result<Vec<u8>> {
        if self.pulling.swap(true, Ordering::AcqRel) {
            return Err(SshError::new(
                "busy",
                "The host browser is already being read",
            ));
        }
        let _released = Released(&self.pulling);
        let deadline = Instant::now() + wait;
        loop {
            {
                let mut queue = self.queue();
                if let Some(item) = queue.items.pop_front() {
                    queue.over |= item.is_closed();
                    return Ok(item.bytes());
                }
                if queue.over {
                    return Err(SshError::new("disconnected", "The host browser has ended"));
                }
            }
            if tokio::time::timeout_at(deadline, self.ready.notified())
                .await
                .is_err()
            {
                return Ok(vec![IDLE]);
            }
        }
    }
}

struct Released<'a>(&'a AtomicBool);
impl Drop for Released<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
