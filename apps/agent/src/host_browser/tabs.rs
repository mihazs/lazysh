//! What the relay keeps about the browser's pages and tells the client about them: the tab list, how far back and
//! forward reach, and the page's own dialogs (docs/host-browser.md, "Controls"). Pure data; the relay makes the
//! calls. Everything a page chose (title, address, dialog text) is untrusted and bounded here.
use serde_json::{json, Value};

/// The pages the relay lists. A page opened beyond this is closed again, so a page that opens windows in a loop
/// cannot grow the list or the work of showing each one.
pub const MAX_TABS: usize = 16;
pub const MAX_TITLE: usize = 200;
const MAX_ID: usize = 64;
pub const MAX_URL: usize = 2048;
const MAX_DIALOG: usize = 1000;
/// The tab list stays inside the client's 64 KiB limit for one JSON message, whatever the pages are called.
const MAX_LIST: usize = 48 << 10;
const DIALOG_KINDS: [&str; 4] = ["alert", "confirm", "prompt", "beforeunload"];

/// At most `max` characters, cut on a character boundary.
pub fn bounded(text: &str, max: usize) -> String {
    text.chars().take(max).collect()
}

#[derive(Clone, Debug, PartialEq)]
pub struct Tab {
    pub id: String,
    pub title: String,
    pub url: String,
}
impl Tab {
    /// A page among a browser's targets. A worker, an extension or the browser's own page is not a tab.
    pub fn page(info: &Value) -> Option<Self> {
        let id = info["targetId"].as_str().filter(|id| id.len() <= MAX_ID)?;
        (info["type"] == "page").then(|| Self {
            id: id.to_string(),
            title: bounded(info["title"].as_str().unwrap_or_default(), MAX_TITLE),
            url: bounded(info["url"].as_str().unwrap_or_default(), MAX_URL),
        })
    }
}

impl Tab {
    /// A top-level browsing context of Firefox (`browsingContext.getTree`), which has an address but no title: the
    /// title is read separately.
    pub fn context(info: &Value) -> Option<Self> {
        let id = info["context"].as_str().filter(|id| id.len() <= MAX_ID)?;
        Some(Self {
            id: id.to_string(),
            title: String::new(),
            url: bounded(info["url"].as_str().unwrap_or_default(), MAX_URL),
        })
    }
}

/// The `tabs` message: the list and the shown page's history and loading state, as the controls show them. A
/// list too long for one message loses its last pages, never the shown one.
pub fn view(tabs: &[Tab], shown: &str, back: bool, forward: bool, loading: bool) -> Value {
    let mut listed: Vec<&Tab> = tabs.iter().collect();
    loop {
        let message = json!({
            "type": "tabs",
            "tabs": listed.iter().map(|tab| json!({"id": tab.id, "title": tab.title, "url": tab.url})).collect::<Vec<_>>(),
            "activeId": shown,
            "canGoBack": back,
            "canGoForward": forward,
            "loading": loading,
        });
        match listed.iter().rposition(|tab| tab.id != shown) {
            Some(last) if message.to_string().len() > MAX_LIST => listed.remove(last),
            _ => return message,
        };
    }
}

/// The history entries one step back and one step forward from the shown one, by the browser's own id.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Reach {
    pub back: Option<i64>,
    pub forward: Option<i64>,
}
impl Reach {
    /// From the result of `Page.getNavigationHistory`; a result that is not one reaches nowhere.
    pub fn of(history: &Value) -> Self {
        let entries = history["entries"].as_array().map_or(&[][..], Vec::as_slice);
        let entry = |at: Option<usize>| entries.get(at?)?["id"].as_i64();
        let current = history["currentIndex"].as_u64().map(|at| at as usize);
        Self {
            back: entry(current.and_then(|at| at.checked_sub(1))),
            forward: entry(current.map(|at| at + 1)),
        }
    }
}

/// The `dialog` message for `Page.javascriptDialogOpening`; `None` for a kind the controls cannot show.
pub fn dialog(params: &Value) -> Option<Value> {
    let kind = params["type"]
        .as_str()
        .filter(|kind| DIALOG_KINDS.contains(kind))?;
    let text = |key: &str| bounded(params[key].as_str().unwrap_or_default(), MAX_DIALOG);
    Some(
        json!({"type": "dialog", "kind": kind, "message": text("message"), "defaultPrompt": text("defaultPrompt")}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tab(id: &str) -> Tab {
        Tab {
            id: id.into(),
            title: format!("title {id}"),
            url: format!("http://127.0.0.1/{id}"),
        }
    }

    #[test]
    fn page_text_is_cut_on_a_character_boundary() {
        assert_eq!(bounded("héllo", 2), "hé");
        assert_eq!(bounded("ab", 10), "ab");
    }

    #[test]
    fn only_pages_are_tabs_and_their_text_is_bounded() {
        let info = |kind: &str| json!({"targetId": "T1", "type": kind, "title": "é".repeat(500), "url": "u".repeat(3000)});
        let tab = Tab::page(&info("page")).unwrap();
        assert_eq!(tab.title.chars().count(), MAX_TITLE);
        assert_eq!(tab.url.len(), MAX_URL);
        for other in ["service_worker", "background_page", "browser", "iframe"] {
            assert_eq!(Tab::page(&info(other)), None, "{other}");
        }
        for bad in [
            json!({"type": "page"}),
            json!({"type": "page", "targetId": 1}),
            json!({"type": "page", "targetId": "x".repeat(65)}),
        ] {
            assert_eq!(Tab::page(&bad), None, "{bad}");
        }
    }

    #[test]
    fn a_context_has_an_address_and_a_bounded_id() {
        let tab = Tab::context(&json!({"context": "C1", "url": "u".repeat(3000)})).unwrap();
        assert_eq!((tab.id.as_str(), tab.title.as_str()), ("C1", ""));
        assert_eq!(tab.url.len(), MAX_URL);
        for bad in [
            json!({}),
            json!({"context": 1}),
            json!({"context": "x".repeat(65)}),
        ] {
            assert_eq!(Tab::context(&bad), None, "{bad}");
        }
    }

    #[test]
    fn the_view_says_which_page_is_shown_and_how_far_it_can_go() {
        let message = view(&[tab("A"), tab("B")], "B", true, false, true);
        assert_eq!(
            message,
            json!({
                "type": "tabs",
                "tabs": [
                    {"id": "A", "title": "title A", "url": "http://127.0.0.1/A"},
                    {"id": "B", "title": "title B", "url": "http://127.0.0.1/B"},
                ],
                "activeId": "B",
                "canGoBack": true,
                "canGoForward": false,
                "loading": true,
            })
        );
    }

    #[test]
    fn a_list_too_long_for_one_message_keeps_the_shown_page_and_fits() {
        // Four-byte characters in every title and address: far more than a message may carry.
        let heavy = |id: &str| Tab {
            id: id.into(),
            title: "😀".repeat(MAX_TITLE),
            url: "😀".repeat(MAX_URL),
        };
        let tabs: Vec<_> = (0..MAX_TABS).map(|n| heavy(&format!("T{n}"))).collect();
        for shown in ["T0", "T7", "T15"] {
            let message = view(&tabs, shown, false, false, false);
            assert!(message.to_string().len() <= MAX_LIST, "{shown}");
            let listed = message["tabs"].as_array().unwrap();
            assert!(listed.iter().any(|tab| tab["id"] == shown), "{shown}");
            assert!(listed.len() < MAX_TABS);
        }
        let few = view(&tabs[..2], "T1", false, false, false);
        assert_eq!(few["tabs"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn history_reaches_one_step_each_way_by_entry_id_and_never_past_an_end() {
        let history = |current: u64, ids: &[i64]| json!({"currentIndex": current, "entries": ids.iter().map(|id| json!({"id": id})).collect::<Vec<_>>()});
        let reach = |back, forward| Reach { back, forward };
        assert_eq!(
            Reach::of(&history(1, &[10, 20, 30])),
            reach(Some(10), Some(30))
        );
        assert_eq!(Reach::of(&history(0, &[10, 20])), reach(None, Some(20)));
        assert_eq!(Reach::of(&history(1, &[10, 20])), reach(Some(10), None));
        assert_eq!(Reach::of(&history(0, &[10])), reach(None, None));
        for nothing in [
            json!({}),
            json!({"entries": []}),
            json!({"currentIndex": 3, "entries": [{"id": 1}]}),
            json!({"currentIndex": "1", "entries": [{"id": 1}, {"id": 2}]}),
        ] {
            assert_eq!(Reach::of(&nothing), reach(None, None), "{nothing}");
        }
    }

    #[test]
    fn a_dialog_is_one_of_four_kinds_with_bounded_text() {
        let long = "x".repeat(2000);
        let message =
            dialog(&json!({"type": "prompt", "message": long, "defaultPrompt": "ação"})).unwrap();
        assert_eq!(message["kind"], "prompt");
        assert_eq!(message["message"].as_str().unwrap().len(), MAX_DIALOG);
        assert_eq!(message["defaultPrompt"], "ação");
        for kind in DIALOG_KINDS {
            assert!(dialog(&json!({"type": kind})).is_some(), "{kind}");
        }
        for bad in [json!({"type": "print"}), json!({"type": 1}), json!({})] {
            assert_eq!(dialog(&bad), None, "{bad}");
        }
    }
}
