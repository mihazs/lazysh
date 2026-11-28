//! Which slice of a projected conversation one page carries. The projection yields every message of
//! the active branch in order; a window cuts a page of at most `limit` messages and 512 KiB from it
//! at a message id, so a reader can walk to either end of a session and keep its place while the
//! file grows.
use super::{message_size, Error, Result, MAX_PAGE};
use serde_json::{json, Value};

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub enum Window {
    /// The newest messages: what the live view shows.
    #[default]
    Tail,
    /// The oldest messages: the first page of the session.
    Start,
    /// The messages just before the one with this id.
    Before(String),
    /// The messages just after the one with this id.
    After(String),
}

/// The longest text one block carries. A command, its output or a reply can be megabytes, so the rest is cut and said so.
pub const MAX_TEXT: usize = 262_144;
/// What one message may serialize to: a page holds at most `MAX_PAGE`, and a message that alone exceeds it ends paging.
const MAX_MESSAGE: usize = MAX_PAGE - MAX_PAGE / 16;
/// Room kept under the cap for the note that says how much was left out, so that the cut text still fits `MAX_TEXT` for the client.
const NOTE_ROOM: usize = 64;
/// Cuts the text of a message's blocks to `cap` bytes each (the note included), at a character boundary, with a note of how much was left out.
fn cut(message: &mut Value, cap: usize) {
    for block in message["blocks"].as_array_mut().into_iter().flatten() {
        let Some(full) = block["text"].as_str().filter(|text| text.len() > cap) else {
            continue;
        };
        let mut end = cap.saturating_sub(NOTE_ROOM);
        while !full.is_char_boundary(end) {
            end -= 1;
        }
        let left = full.len() - end;
        block["text"] = json!(format!("{}\n… [{left} more bytes not shown]", &full[..end]));
    }
}
/// Bounds a message to a page: each text to `MAX_TEXT`, then to half that again until the serialized message fits, since
/// escaping can make the JSON several times the text.
pub fn fit(message: &mut Value) {
    let mut cap = MAX_TEXT;
    cut(message, cap);
    while cap > 256 && message_size(message).map_or(true, |size| size > MAX_MESSAGE) {
        cap /= 2;
        cut(message, cap);
    }
}

pub struct Selected {
    pub messages: Vec<Value>,
    pub has_older: bool,
    pub has_newer: bool,
}

pub(super) fn position(
    window: &Window,
    len: usize,
    find: impl Fn(&str) -> Result<usize>,
) -> Result<(bool, usize)> {
    Ok(match window {
        Window::Tail => (false, len),
        Window::Start => (true, 0),
        Window::Before(id) => (false, find(id)?),
        Window::After(id) => (true, find(id)? + 1),
    })
}

/// `all` is ordered oldest first. A page that cannot take even the next message (it alone exceeds
/// the 512 KiB budget) is an error: a reader that pages on would otherwise stop at a silent dead end.
pub fn select(all: Vec<Value>, window: &Window, limit: u8) -> Result<Selected> {
    let find = |id: &str| {
        all.iter()
            .position(|message| message["id"].as_str() == Some(id))
            .ok_or(Error::InvalidArgument)
    };
    let (forward, at) = position(window, all.len(), find)?;
    let (mut lo, mut hi) = (at, at);
    let mut bytes = 0;
    while hi - lo < usize::from(limit) {
        let Some(next) = (if forward {
            (hi < all.len()).then_some(hi)
        } else {
            lo.checked_sub(1)
        }) else {
            break;
        };
        let size = message_size(&all[next])?;
        if bytes + size > MAX_PAGE {
            break;
        }
        bytes += size;
        if forward {
            hi += 1;
        } else {
            lo = next;
        }
    }
    if lo == hi && (if forward { hi < all.len() } else { lo > 0 }) {
        return Err(Error::InvalidEvent);
    }
    Ok(Selected {
        has_older: lo > 0,
        has_newer: hi < all.len(),
        messages: all[lo..hi].to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn session(count: usize) -> Vec<Value> {
        (0..count)
            .map(|n| json!({"id": format!("m{n}"), "role": "user", "blocks": [{"type": "text", "text": "x"}]}))
            .collect()
    }
    fn ids(selected: &Selected) -> Vec<&str> {
        selected
            .messages
            .iter()
            .map(|m| m["id"].as_str().unwrap())
            .collect()
    }

    #[test]
    fn pages_walk_from_the_tail_to_the_first_message_without_gaps() {
        let all = session(25_000);
        let mut window = Window::Tail;
        let mut seen = Vec::new();
        loop {
            let page = select(all.clone(), &window, 100).unwrap();
            assert!(page.messages.len() <= 100 && !page.has_newer == (window == Window::Tail));
            seen.splice(0..0, ids(&page).into_iter().map(str::to_owned));
            if !page.has_older {
                break;
            }
            window = Window::Before(seen[0].clone());
        }
        assert_eq!(seen.len(), 25_000);
        assert_eq!((seen[0].as_str(), seen[24_999].as_str()), ("m0", "m24999"));
    }

    #[test]
    fn start_and_after_walk_forward_to_the_tail() {
        let all = session(250);
        let first = select(all.clone(), &Window::Start, 100).unwrap();
        assert_eq!(
            (ids(&first)[0], first.has_older, first.has_newer),
            ("m0", false, true)
        );
        let second = select(all.clone(), &Window::After("m99".into()), 100).unwrap();
        assert_eq!(ids(&second)[0], "m100");
        let last = select(all, &Window::After("m199".into()), 100).unwrap();
        assert_eq!((last.messages.len(), last.has_newer), (50, false));
    }

    #[test]
    fn unknown_anchor_is_rejected_and_an_oversized_neighbour_is_not_a_dead_end() {
        let mut all = session(3);
        assert!(select(all.clone(), &Window::Before("gone".into()), 10).is_err());
        all[1]["blocks"][0]["text"] = json!("y".repeat(MAX_PAGE));
        assert!(select(all, &Window::Before("m2".into()), 10).is_err());
    }
}
