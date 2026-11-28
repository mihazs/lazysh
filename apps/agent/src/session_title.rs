//! A session's name: one bounded line the companion keeps beside its report, so two sessions of one folder
//! can be told apart. It comes from the first prompt a hook reports, or from a title an agent reports itself.
//! No model is involved, and only this line is kept: the rest of a prompt is still discarded.
use crate::Event;
use rusqlite::{params, Transaction};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// Characters a title keeps, the ellipsis included.
pub(crate) const MAX: usize = 80;

// Additive like `session_waiting`: a companion that predates it never reads or writes this table.
pub(crate) const SCHEMA: &str = "CREATE TABLE IF NOT EXISTS session_title (
    agent TEXT NOT NULL, session_id TEXT NOT NULL, title TEXT NOT NULL, source TEXT NOT NULL,
    PRIMARY KEY (agent,session_id));";

/// A title and whether the agent named it itself (`vendor`) or it was cut from the first prompt.
/// Only the text is serialized: a snapshot never says which source chose it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(from = "String", into = "String")]
pub struct Title {
    text: String,
    vendor: bool,
}

impl Title {
    /// The title of a prompt, if the prompt says anything.
    pub fn prompt(text: &str) -> Option<Self> {
        clean(text).map(|text| Self {
            text,
            vendor: false,
        })
    }
    /// A title the agent reports for its own session.
    pub fn vendor(text: &str) -> Option<Self> {
        clean(text).map(|text| Self { text, vendor: true })
    }
    pub fn as_str(&self) -> &str {
        &self.text
    }
    /// Whether the agent named its session itself; serialization drops it, so a kept report carries it beside the title.
    pub(crate) fn is_vendor(&self) -> bool {
        self.vendor
    }
    pub(crate) fn with_source(mut self, vendor: bool) -> Self {
        self.vendor = vendor;
        self
    }
}

/// What a deserialized title is: an agent reporting its own, which the generic event cleans again.
impl From<String> for Title {
    fn from(text: String) -> Self {
        Self { text, vendor: true }
    }
}

impl From<Title> for String {
    fn from(title: Title) -> Self {
        title.text
    }
}

/// One line: whitespace collapsed, control characters dropped, at most `MAX` characters. A bare slash
/// command (`/clear`) says nothing about the session, so it yields no title.
fn clean(text: &str) -> Option<String> {
    let masked: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let line = masked.split_whitespace().collect::<Vec<_>>().join(" ");
    if line.is_empty() || (line.starts_with('/') && !line.contains(' ')) {
        return None;
    }
    // shortcut: the cut is on a character, not a grapheme cluster; revisit if a combined emoji is cut visibly.
    Some(if line.chars().count() > MAX {
        line.chars().take(MAX - 1).chain(['…']).collect()
    } else {
        line
    })
}

/// The title of the prompt a hook payload carries in its `prompt` field.
pub(crate) fn from_payload(payload: &Value) -> Option<Title> {
    payload.get("prompt")?.as_str().and_then(Title::prompt)
}

/// A prompt title never replaces one already chosen; the agent's own title replaces a prompt title or an earlier own title.
pub(crate) fn write(
    transaction: &Transaction<'_>,
    event: &Event,
    title: &Title,
) -> rusqlite::Result<()> {
    transaction
        .execute(
            "INSERT INTO session_title VALUES (?1,?2,?3,?4)
            ON CONFLICT(agent,session_id) DO UPDATE SET title=excluded.title,source=excluded.source
            WHERE excluded.source='vendor'",
            params![
                event.agent,
                event.session_id,
                title.text,
                if title.vendor { "vendor" } else { "prompt" }
            ],
        )
        .map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_title_is_one_bounded_line_without_control_characters() {
        let prompt = |text: &str| Title::prompt(text).map(|title| title.text);
        assert_eq!(
            prompt("  Fix the\n\tlogin \u{1b}bug\u{7}  ").as_deref(),
            Some("Fix the login bug")
        );
        for empty in ["", "   \n\t", "\u{1b}\u{7}", "/clear", "/compact"] {
            assert_eq!(prompt(empty), None, "{empty:?}");
        }
        assert_eq!(
            prompt("/review pull 12").as_deref(),
            Some("/review pull 12")
        );
        for long in ["x".repeat(500), "é".repeat(500), "語 ".repeat(500)] {
            let title = prompt(&long).unwrap();
            assert_eq!(title.chars().count(), MAX, "{title}");
            assert!(title.ends_with('…') && !title.chars().any(char::is_control));
        }
        let exact = "y".repeat(MAX);
        assert_eq!(prompt(&exact), Some(exact));
    }
}
