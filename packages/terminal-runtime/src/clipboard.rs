//! The consent side of OSC 52 ([#1320]). The VT decodes a write request (libghostty-vt bounds one
//! payload at 192 KiB, accepts only the standard clipboard and never answers a query) and the
//! runtime queues it in [`crate::Events::clipboard_writes`]; this is the policy the existing consent
//! flow applies on top, kept from `decodeClipboardRequest` in `preferences.ts`: nothing is offered
//! unless it is at most 64 KiB and valid UTF-8, and a write is only ever offered, never applied.
//!
//! [#1320]: https://github.com/mihazs/lazysh/issues/1320

/// Largest decoded OSC 52 write offered for consent. Its base64 form is the 87,384 characters
/// `decodeClipboardRequest` accepts at most.
pub const MAX_CLIPBOARD_TEXT_BYTES: usize = 64 * 1024;

/// The text of one queued OSC 52 write as the consent panel shows it, or `None` when policy drops
/// it (over the bound, or not UTF-8: a partial or lossy copy is never offered).
pub fn clipboard_consent_text(payload: &[u8]) -> Option<String> {
    if payload.len() > MAX_CLIPBOARD_TEXT_BYTES {
        return None;
    }
    String::from_utf8(payload.to_vec()).ok()
}
