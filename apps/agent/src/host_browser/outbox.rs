//! What the relay owes the client, and the pacing that keeps a slow link from building a queue.
//!
//! Controls (state, refusals, the final `closed`) go out in order and are few. Page information and frames are
//! one slot each: a newer one replaces an older one that was not sent yet, so a slow device sees fewer frames
//! instead of old ones. At most [`WINDOW`] frames are unacknowledged at once; the client acknowledges a frame
//! after it decoded it, so its decode time is part of the pacing.
use super::wire::{self, Frame};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    io::{self, Write},
    sync::{Condvar, Mutex, MutexGuard},
};

pub const WINDOW: u32 = 2;

#[derive(Default)]
struct Slots {
    controls: VecDeque<Vec<u8>>,
    page: Option<Vec<u8>>,
    frame: Option<Vec<u8>>,
    in_flight: u32,
    paused: bool,
    done: bool,
}
impl Slots {
    /// The next message to write, in the order controls, page information, frame.
    fn next(&mut self) -> Option<Vec<u8>> {
        if let Some(control) = self.controls.pop_front() {
            return Some(control);
        }
        if let Some(page) = self.page.take() {
            return Some(page);
        }
        if self.in_flight < WINDOW && !self.paused {
            if let Some(frame) = self.frame.take() {
                self.in_flight += 1;
                return Some(frame);
            }
        }
        None
    }
}

#[derive(Default)]
pub struct Outbox {
    slots: Mutex<Slots>,
    wake: Condvar,
}
impl Outbox {
    fn slots(&self) -> MutexGuard<'_, Slots> {
        self.slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
    fn change(&self, apply: impl FnOnce(&mut Slots)) {
        apply(&mut self.slots());
        self.wake.notify_all();
    }

    pub fn control(&self, value: Value) {
        self.change(|slots| slots.controls.push_back(wire::encode_json(&value)));
    }
    pub fn page(&self, title: &str, url: &str) {
        let page = wire::encode_json(&json!({"type": "page", "title": title, "url": url}));
        self.change(|slots| slots.page = Some(page));
    }
    pub fn frame(&self, frame: &Frame) {
        let frame = wire::encode_frame(frame);
        self.change(|slots| {
            if !slots.paused {
                slots.frame = Some(frame);
            }
        });
    }
    /// The device decoded one frame.
    pub fn ack(&self) {
        self.change(|slots| slots.in_flight = slots.in_flight.saturating_sub(1));
    }
    /// Paused: no frame is held or sent. Resuming forgets frames the hidden device never acknowledged.
    pub fn pause(&self, paused: bool) {
        self.change(|slots| {
            slots.paused = paused;
            slots.frame = None;
            slots.in_flight = 0;
        });
    }
    /// The last message: written after the controls before it, and then [`drain`](Self::drain) returns.
    pub fn close(&self, reason: &str, detail: Option<&str>) {
        let mut closed = json!({"type": "closed", "reason": reason});
        if let Some(detail) = detail {
            closed["detail"] = detail.into();
        }
        self.change(|slots| {
            slots.controls.push_back(wire::encode_json(&closed));
            slots.page = None;
            slots.frame = None;
            slots.done = true;
        });
    }

    /// Write messages until [`close`](Self::close) was written or the writer fails (the client is gone).
    pub fn drain(&self, writer: &mut impl Write) -> io::Result<()> {
        loop {
            let message = {
                let mut slots = self.slots();
                loop {
                    if let Some(message) = slots.next() {
                        break Some(message);
                    }
                    if slots.done {
                        break None;
                    }
                    slots = self
                        .wake
                        .wait(slots)
                        .unwrap_or_else(|poisoned| poisoned.into_inner());
                }
            };
            let Some(message) = message else {
                return Ok(());
            };
            writer.write_all(&message)?;
            writer.flush()?;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(sequence: u32) -> Frame {
        Frame {
            sequence,
            width: 1,
            height: 1,
            scroll_y: 0.0,
            timestamp_ms: 0,
            jpeg: vec![sequence as u8],
        }
    }
    /// The sequence of the frame the next write would carry, if any.
    fn sent(outbox: &Outbox) -> Option<u32> {
        let message = outbox.slots().next()?;
        assert_eq!(message[4], wire::FRAME);
        Some(u32::from_be_bytes(message[5..9].try_into().unwrap()))
    }

    #[test]
    fn a_slow_device_sees_the_newest_frame_and_at_most_two_unacknowledged() {
        let outbox = Outbox::default();
        for sequence in 1..=5 {
            outbox.frame(&frame(sequence));
        }
        assert_eq!(sent(&outbox), Some(5), "older frames were not replaced");
        assert_eq!(sent(&outbox), None);
        outbox.frame(&frame(6));
        assert_eq!(sent(&outbox), Some(6));
        outbox.frame(&frame(7));
        assert_eq!(sent(&outbox), None, "a third frame went out unacknowledged");
        outbox.ack();
        assert_eq!(sent(&outbox), Some(7));
    }

    #[test]
    fn a_paused_outbox_holds_no_frame_and_forgets_unacknowledged_ones() {
        let outbox = Outbox::default();
        outbox.frame(&frame(1));
        outbox.frame(&frame(2));
        assert_eq!(sent(&outbox), Some(2));
        outbox.pause(true);
        outbox.frame(&frame(3));
        assert_eq!(sent(&outbox), None);
        outbox.pause(false);
        outbox.frame(&frame(4));
        assert_eq!(sent(&outbox), Some(4));
        outbox.frame(&frame(5));
        assert_eq!(sent(&outbox), Some(5));
    }

    #[test]
    fn closed_is_last_and_replaces_what_was_not_sent() {
        let outbox = Outbox::default();
        outbox.control(json!({"type": "state", "state": "running"}));
        outbox.frame(&frame(1));
        outbox.close("ClientClosed", None);
        let mut written = Vec::new();
        outbox.drain(&mut written).unwrap();
        let mut input = written.as_slice();
        let mut types = Vec::new();
        while let Some((tag, body)) = wire::read(&mut input, wire::MAX_JPEG).unwrap() {
            assert_eq!(tag, wire::JSON);
            types.push(serde_json::from_slice::<Value>(&body).unwrap()["type"].clone());
        }
        assert_eq!(types, ["state", "closed"]);
    }
}
