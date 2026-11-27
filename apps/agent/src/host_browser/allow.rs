//! What the host browser relay may send to a browser, and what it refuses (docs/host-browser.md, "Relay
//! protocol", "Threat model" and "What it will not do").
//!
//! A closed list: a protocol method that is not named here is refused, so a method that a later browser version
//! adds can never become reachable by accident. The phone never sends a raw protocol command; the relay maps its
//! own fixed messages onto the methods below and asks [`command`] before it sends each one, and asks [`address`]
//! before it opens a page. A refusal names a class, never the page, so it is safe to log.
use serde_json::Value;

/// Why an operation is refused. Deliberately carries no URL, title or text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Refusal {
    /// Cookies and every kind of page storage: the web sessions in the profile.
    Session,
    /// Running script in a page or in the browser, and reading or editing its DOM.
    Script,
    /// Downloads, file choosers and file transfer.
    Files,
    /// Permission prompts, geolocation and the host's clipboard.
    Permission,
    /// A page address that is not http, https or about:blank.
    Address,
    /// Not named in the closed list.
    Unlisted,
}
impl Refusal {
    pub fn reason(self) -> &'static str {
        match self {
            Self::Session => "SessionDataRefused",
            Self::Script => "ScriptRefused",
            Self::Files => "FileTransferRefused",
            Self::Permission => "PermissionRefused",
            Self::Address => "AddressRefused",
            Self::Unlisted => "OperationRefused",
        }
    }
}

/// The only protocol methods the Chrome adapter sends, taken from the adapter table in the specification.
const ALLOWED: [&str; 27] = [
    "Browser.getVersion",
    "Emulation.setDeviceMetricsOverride",
    "Emulation.setPageScaleFactor",
    "Input.dispatchKeyEvent",
    "Input.dispatchMouseEvent",
    "Input.dispatchTouchEvent",
    "Input.imeSetComposition",
    "Input.insertText",
    "Page.enable",
    "Page.getNavigationHistory",
    "Page.handleJavaScriptDialog",
    "Page.navigate",
    "Page.navigateToHistoryEntry",
    "Page.reload",
    "Page.screencastFrameAck",
    "Page.startScreencast",
    "Page.stopLoading",
    "Page.stopScreencast",
    "Target.activateTarget",
    "Target.attachToTarget",
    "Target.closeTarget",
    "Target.createTarget",
    "Target.detachFromTarget",
    "Target.getTargets",
    "Target.setDiscoverTargets",
    // Allowed only to deny: see `command`.
    "Browser.setDownloadBehavior",
    "Page.setInterceptFileChooserDialog",
];

/// The only WebDriver BiDi commands the Firefox adapter sends (docs/host-browser.md, "Adapters and
/// capabilities"). The same closed-list rule as [`ALLOWED`]: a command that a later Firefox adds is not reachable.
const BIDI_ALLOWED: [&str; 14] = [
    "browsingContext.activate",
    "browsingContext.captureScreenshot",
    "browsingContext.close",
    "browsingContext.create",
    "browsingContext.getTree",
    "browsingContext.navigate",
    "browsingContext.reload",
    "browsingContext.setViewport",
    "browsingContext.traverseHistory",
    "input.performActions",
    "input.releaseActions",
    "script.evaluate",
    "session.end",
    "session.new",
];

/// The one script the relay ever runs in a page: it reads the title, because `browsingContext.getTree` has none.
pub const TITLE_EXPRESSION: &str = "document.title";

/// What a navigation may wait for before Firefox answers.
const WAITS: [&str; 3] = ["none", "interactive", "complete"];

/// Editing commands that read or write the host's clipboard; a key event may carry them.
const CLIPBOARD_COMMANDS: [&str; 4] = ["copy", "cut", "paste", "pasteandmatchstyle"];

/// A page address the relay opens: `http`, `https` or `about:blank`, printable ASCII, at most 2048 bytes. The
/// same rule applies to a typed address and to a page's first URL.
pub fn address(url: &str) -> Result<(), Refusal> {
    let web = url.starts_with("http://") || url.starts_with("https://");
    if url == "about:blank"
        || (web && url.len() <= 2048 && url.chars().all(|c| c.is_ascii_graphic()))
    {
        Ok(())
    } else {
        Err(Refusal::Address)
    }
}

fn class(method: &str) -> Refusal {
    let (domain, name) = method.split_once('.').unwrap_or((method, ""));
    match domain {
        "Network" | "Storage" | "DOMStorage" | "IndexedDB" | "CacheStorage" | "Fetch"
        | "Audits" => Refusal::Session,
        "Runtime" | "Debugger" | "DOM" | "DOMDebugger" | "Console" | "Profiler" => Refusal::Script,
        "Page" if name.starts_with("addScript") || name == "createIsolatedWorld" => Refusal::Script,
        "Page" if name.contains("ownload") || name.contains("ileChooser") => Refusal::Files,
        "Browser" if name.contains("ownload") => Refusal::Files,
        "Browser" if name.contains("ermission") => Refusal::Permission,
        "Emulation" if name.contains("eolocation") => Refusal::Permission,
        "Target" if name.starts_with("expose") || name.starts_with("send") => Refusal::Script,
        _ => Refusal::Unlisted,
    }
}

fn bidi_class(method: &str) -> Refusal {
    let domain = method.split_once('.').map_or(method, |(domain, _)| domain);
    match (domain, method) {
        ("storage" | "network", _) => Refusal::Session,
        ("script" | "webExtension", _) => Refusal::Script,
        ("permissions", _) | (_, "emulation.setGeolocationOverride") => Refusal::Permission,
        // `startScreencast` writes a video file on the host and delivers no frames (measured).
        (_, "input.setFiles" | "browsingContext.startScreencast") => Refusal::Files,
        _ => Refusal::Unlisted,
    }
}

fn text<'a>(params: &'a Value, key: &str) -> &'a str {
    params.get(key).and_then(Value::as_str).unwrap_or_default()
}

/// Whether the relay may send `method` with `params` to the browser. Fails closed.
pub fn command(method: &str, params: &Value) -> Result<(), Refusal> {
    if !ALLOWED.contains(&method) {
        return Err(class(method));
    }
    match method {
        // The relay sets the download behavior only to deny it, before a page can start a download.
        "Browser.setDownloadBehavior" if text(params, "behavior") != "deny" => Err(Refusal::Files),
        // Intercepting the file chooser is how it is denied: the browser reports it and no file is supplied.
        "Page.setInterceptFileChooserDialog"
            if params.get("enabled") != Some(&Value::Bool(true)) =>
        {
            Err(Refusal::Files)
        }
        "Page.navigate" | "Target.createTarget" => address(text(params, "url")),
        "Input.dispatchKeyEvent" => {
            let clipboard = params
                .get("commands")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|name| CLIPBOARD_COMMANDS.contains(&name.to_ascii_lowercase().as_str()));
            if clipboard {
                Err(Refusal::Permission)
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

/// Whether the relay may send the WebDriver BiDi `method` with `params` to Firefox. Fails closed.
pub fn bidi(method: &str, params: &Value) -> Result<(), Refusal> {
    if !BIDI_ALLOWED.contains(&method) {
        return Err(bidi_class(method));
    }
    match method {
        // Script runs only to read the title, in a sandbox realm the page's own script cannot see or replace.
        "script.evaluate"
            if text(params, "expression") != TITLE_EXPRESSION
                || params.get("awaitPromise") != Some(&Value::Bool(false))
                || params["target"]["sandbox"].as_str().is_none() =>
        {
            Err(Refusal::Script)
        }
        "input.performActions" => bidi_actions(params),
        "input.releaseActions" if !is_context_only(params) => Err(Refusal::Unlisted),
        "browsingContext.navigate" if address(text(params, "url")).is_err() => {
            Err(Refusal::Address)
        }
        "browsingContext.activate"
        | "browsingContext.close"
        | "browsingContext.create"
        | "browsingContext.navigate"
        | "browsingContext.reload"
        | "browsingContext.traverseHistory" => tab_command(method, params),
        _ => Ok(()),
    }
}

/// The WebDriver key values of the keys that are not text (the private-use points of the specification), by the
/// name the client sends. Any other point of the range is refused: one of them releases every key, others open
/// menus or press modifiers the client never asks for.
pub(super) const BIDI_NAMED_KEYS: [(&str, char); 13] = [
    ("Backspace", '\u{E003}'),
    ("Tab", '\u{E004}'),
    ("Enter", '\u{E006}'),
    ("Escape", '\u{E00C}'),
    ("PageUp", '\u{E00E}'),
    ("PageDown", '\u{E00F}'),
    ("End", '\u{E010}'),
    ("Home", '\u{E011}'),
    ("ArrowLeft", '\u{E012}'),
    ("ArrowUp", '\u{E013}'),
    ("ArrowRight", '\u{E014}'),
    ("ArrowDown", '\u{E015}'),
    ("Delete", BIDI_DELETE),
];
/// Alt, Control, Meta and Shift, in the order of the client's modifier bits.
pub(super) const BIDI_MODIFIER_KEYS: [char; 4] = ['\u{E00A}', BIDI_CONTROL, BIDI_META, BIDI_SHIFT];
const BIDI_CONTROL: char = '\u{E009}';
const BIDI_META: char = '\u{E03D}';
const BIDI_SHIFT: char = '\u{E008}';
const BIDI_DELETE: char = '\u{E017}';
/// The range of key values that name keys and not text.
pub(super) const BIDI_KEY_RANGE: std::ops::RangeInclusive<char> = '\u{E000}'..='\u{E0FF}';

/// The most actions one call carries: a key down and a key up for each character of the longest text, and a chord.
const MAX_BIDI_ACTIONS: usize = 8200;
/// A coordinate is in a viewport of at most 2048 CSS pixels; a wheel moves at most 10000 on an axis; a tick lasts at
/// most a second.
const MAX_BIDI_COORDINATE: f64 = 2048.0;
const MAX_BIDI_DELTA: f64 = 10_000.0;
const MAX_BIDI_TICK: f64 = 1000.0;

fn is_context_only(params: &Value) -> bool {
    params["context"].is_string() && params.as_object().is_some_and(|fields| fields.len() == 1)
}

/// `input.performActions`: one source of pointer, wheel or key actions at most each, in the page's own context, with
/// every number inside the bounds. A key sequence that would reach the host's clipboard is refused, as in Chrome.
fn bidi_actions(params: &Value) -> Result<(), Refusal> {
    let (Some(sources), true) = (params["actions"].as_array(), params["context"].is_string())
    else {
        return Err(Refusal::Unlisted);
    };
    let total: usize = sources
        .iter()
        .map(|source| source["actions"].as_array().map_or(0, Vec::len))
        .sum();
    if sources.is_empty() || sources.len() > 3 || total > MAX_BIDI_ACTIONS {
        return Err(Refusal::Unlisted);
    }
    for source in sources {
        let kind = source["type"].as_str().unwrap_or_default();
        let id_and_actions = source["id"].is_string() && source["actions"].is_array();
        // Pointer sources are mice: a touch pointer would need its own measured mapping.
        let pointer_ok = kind != "pointer" || source["parameters"]["pointerType"] == "mouse";
        if !id_and_actions || !pointer_ok || !["pointer", "wheel", "key"].contains(&kind) {
            return Err(Refusal::Unlisted);
        }
        let mut held = Vec::new();
        for action in source["actions"].as_array().into_iter().flatten() {
            bidi_action(kind, action, &mut held)?;
        }
    }
    Ok(())
}

fn bidi_action(kind: &str, action: &Value, held: &mut Vec<char>) -> Result<(), Refusal> {
    let value = |key: &str| action[key].as_f64();
    let within = |key: &str, limit: f64| value(key).is_some_and(|n| n.abs() <= limit);
    let at = ["x", "y"]
        .into_iter()
        .all(|key| value(key).is_some_and(|n| (0.0..=MAX_BIDI_COORDINATE).contains(&n)));
    let on_viewport = action["origin"] == "viewport";
    let quick = action.get("duration").is_none() || within("duration", MAX_BIDI_TICK);
    let button = action["button"].as_u64().is_some_and(|button| button <= 2);
    let ok = match (kind, action["type"].as_str().unwrap_or_default()) {
        ("pointer", "pointerMove") => at && on_viewport && quick,
        ("pointer", "pointerDown" | "pointerUp") => button,
        ("wheel", "scroll") => {
            at && on_viewport
                && quick
                && within("deltaX", MAX_BIDI_DELTA)
                && within("deltaY", MAX_BIDI_DELTA)
        }
        ("key", name @ ("keyDown" | "keyUp")) => {
            let mut characters = action["value"].as_str().unwrap_or_default().chars();
            let (Some(key), None) = (characters.next(), characters.next()) else {
                return Err(Refusal::Unlisted);
            };
            let named = BIDI_NAMED_KEYS.iter().any(|(_, value)| *value == key);
            if BIDI_KEY_RANGE.contains(&key) && !named && !BIDI_MODIFIER_KEYS.contains(&key) {
                return Err(Refusal::Unlisted);
            }
            if name == "keyUp" {
                held.retain(|modifier| *modifier != key);
                return Ok(());
            }
            let chord = held.contains(&BIDI_CONTROL) || held.contains(&BIDI_META);
            let clipboard = (chord && "cxv".contains(key.to_ascii_lowercase()))
                || (held.contains(&BIDI_SHIFT) && key == BIDI_DELETE);
            if clipboard {
                return Err(Refusal::Permission);
            }
            if BIDI_MODIFIER_KEYS.contains(&key) {
                held.push(key);
            }
            true
        }
        _ => false,
    };
    ok.then_some(()).ok_or(Refusal::Unlisted)
}

/// The page and tab commands take exactly the parameters the relay sends, and nothing a client could add: a
/// context to act on, a fixed wait, one history step, and a plain new tab (no user context, no reference tab).
fn tab_command(method: &str, params: &Value) -> Result<(), Refusal> {
    let wait = params
        .get("wait")
        .is_none_or(|wait| wait.as_str().is_some_and(|wait| WAITS.contains(&wait)));
    let context = params["context"].is_string();
    let (keys, valid): (&[&str], bool) = match method {
        "browsingContext.navigate" => (&["context", "url", "wait"], context && wait),
        "browsingContext.reload" => (&["context", "wait"], context && wait),
        "browsingContext.traverseHistory" => (
            &["context", "delta"],
            context && matches!(params["delta"].as_i64(), Some(-1 | 1)),
        ),
        "browsingContext.create" => (
            &["type", "background"],
            params["type"] == "tab" && params.get("background").is_none_or(Value::is_boolean),
        ),
        _ => (&["context"], context),
    };
    let only_keys = params
        .as_object()
        .is_some_and(|map| map.keys().all(|key| keys.contains(&key.as_str())));
    if valid && only_keys {
        Ok(())
    } else {
        Err(Refusal::Unlisted)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn every_denied_class_is_refused_with_its_reason() {
        let none = json!({});
        for (method, params, refusal) in [
            // The web sessions in the profile.
            ("Network.getCookies", none.clone(), Refusal::Session),
            ("Network.getAllCookies", none.clone(), Refusal::Session),
            (
                "Network.setCookie",
                json!({"name":"a","value":"b"}),
                Refusal::Session,
            ),
            (
                "Network.clearBrowserCookies",
                none.clone(),
                Refusal::Session,
            ),
            ("Storage.getCookies", none.clone(), Refusal::Session),
            ("Storage.clearDataForOrigin", none.clone(), Refusal::Session),
            (
                "DOMStorage.getDOMStorageItems",
                none.clone(),
                Refusal::Session,
            ),
            ("IndexedDB.requestData", none.clone(), Refusal::Session),
            ("Fetch.enable", none.clone(), Refusal::Session),
            // Script and DOM access from the phone.
            (
                "Runtime.evaluate",
                json!({"expression":"document.cookie"}),
                Refusal::Script,
            ),
            ("Runtime.callFunctionOn", none.clone(), Refusal::Script),
            (
                "Page.addScriptToEvaluateOnNewDocument",
                none.clone(),
                Refusal::Script,
            ),
            ("Debugger.enable", none.clone(), Refusal::Script),
            ("DOM.getDocument", none.clone(), Refusal::Script),
            // Downloads, the file chooser and file transfer.
            (
                "Browser.setDownloadBehavior",
                json!({"behavior":"allow"}),
                Refusal::Files,
            ),
            (
                "Browser.setDownloadBehavior",
                json!({"behavior":"allowAndName"}),
                Refusal::Files,
            ),
            (
                "Browser.setDownloadBehavior",
                json!({"behavior":"default"}),
                Refusal::Files,
            ),
            ("Browser.setDownloadBehavior", none.clone(), Refusal::Files),
            (
                "Page.setDownloadBehavior",
                json!({"behavior":"allow"}),
                Refusal::Files,
            ),
            (
                "Page.setInterceptFileChooserDialog",
                json!({"enabled":false}),
                Refusal::Files,
            ),
            (
                "Page.setInterceptFileChooserDialog",
                none.clone(),
                Refusal::Files,
            ),
            ("DOM.setFileInputFiles", none.clone(), Refusal::Script),
            // Permissions, geolocation and the clipboard.
            (
                "Browser.grantPermissions",
                json!({"permissions":["clipboardReadWrite"]}),
                Refusal::Permission,
            ),
            ("Browser.setPermission", none.clone(), Refusal::Permission),
            (
                "Emulation.setGeolocationOverride",
                none.clone(),
                Refusal::Permission,
            ),
            (
                "Input.dispatchKeyEvent",
                json!({"type":"keyDown","commands":["paste"]}),
                Refusal::Permission,
            ),
            (
                "Input.dispatchKeyEvent",
                json!({"type":"keyDown","commands":["selectAll","Copy"]}),
                Refusal::Permission,
            ),
            (
                "Input.dispatchKeyEvent",
                json!({"type":"keyDown","commands":["cut"]}),
                Refusal::Permission,
            ),
            // Page addresses that are not http, https or about:blank.
            (
                "Page.navigate",
                json!({"url":"file:///etc/passwd"}),
                Refusal::Address,
            ),
            (
                "Page.navigate",
                json!({"url":"chrome://settings"}),
                Refusal::Address,
            ),
            (
                "Page.navigate",
                json!({"url":"view-source:https://example.com"}),
                Refusal::Address,
            ),
            (
                "Page.navigate",
                json!({"url":"javascript:alert(1)"}),
                Refusal::Address,
            ),
            (
                "Page.navigate",
                json!({"url":"data:text/html,x"}),
                Refusal::Address,
            ),
            (
                "Page.navigate",
                json!({"url":"blob:https://example.com/x"}),
                Refusal::Address,
            ),
            ("Page.navigate", none.clone(), Refusal::Address),
            (
                "Target.createTarget",
                json!({"url":"file:///home/user/.ssh/id_ed25519"}),
                Refusal::Address,
            ),
            ("Target.createTarget", none.clone(), Refusal::Address),
            // Anything the list does not name, including methods a later browser adds.
            ("Browser.close", none.clone(), Refusal::Unlisted),
            ("Browser.crash", none.clone(), Refusal::Unlisted),
            ("Target.setAutoAttach", none.clone(), Refusal::Unlisted),
            (
                "Target.exposeDevToolsProtocol",
                none.clone(),
                Refusal::Script,
            ),
            (
                "Security.setIgnoreCertificateErrors",
                none.clone(),
                Refusal::Unlisted,
            ),
            ("Page.setBypassCSP", none.clone(), Refusal::Unlisted),
            ("Input.dispatchDragEvent", none.clone(), Refusal::Unlisted),
            ("SystemInfo.getInfo", none.clone(), Refusal::Unlisted),
            ("Madeup.method", none.clone(), Refusal::Unlisted),
            ("", none.clone(), Refusal::Unlisted),
            (
                "page.navigate",
                json!({"url":"https://example.com"}),
                Refusal::Unlisted,
            ),
        ] {
            assert_eq!(command(method, &params), Err(refusal), "{method} {params}");
        }
    }

    #[test]
    fn the_operations_the_phone_needs_are_allowed() {
        for (method, params) in [
            (
                "Page.startScreencast",
                json!({"format":"jpeg","quality":60}),
            ),
            ("Page.screencastFrameAck", json!({"sessionId":1})),
            ("Page.navigate", json!({"url":"https://example.com/a?b=1"})),
            ("Page.navigate", json!({"url":"http://127.0.0.1:3000/"})),
            ("Page.navigate", json!({"url":"about:blank"})),
            ("Page.reload", json!({})),
            ("Page.getNavigationHistory", json!({})),
            ("Page.handleJavaScriptDialog", json!({"accept":false})),
            (
                "Input.dispatchMouseEvent",
                json!({"type":"mousePressed","x":1,"y":2}),
            ),
            ("Input.dispatchTouchEvent", json!({"type":"touchStart"})),
            ("Input.insertText", json!({"text":"ação 日本"})),
            (
                "Input.dispatchKeyEvent",
                json!({"type":"keyDown","key":"Enter"}),
            ),
            (
                "Input.dispatchKeyEvent",
                json!({"type":"keyDown","commands":["selectAll"]}),
            ),
            ("Target.getTargets", json!({})),
            ("Target.createTarget", json!({"url":"https://example.com"})),
            ("Target.closeTarget", json!({"targetId":"x"})),
            ("Browser.setDownloadBehavior", json!({"behavior":"deny"})),
            (
                "Page.setInterceptFileChooserDialog",
                json!({"enabled":true}),
            ),
            ("Browser.getVersion", json!({})),
        ] {
            assert_eq!(command(method, &params), Ok(()), "{method} {params}");
        }
    }

    #[test]
    fn the_allowed_list_names_no_denied_class() {
        for method in ALLOWED {
            assert!(
                matches!(class(method), Refusal::Unlisted | Refusal::Files),
                "{method} belongs to a denied class"
            );
        }
    }

    #[test]
    fn addresses_are_web_pages_or_blank() {
        for good in ["about:blank", "http://a", "https://example.com/p?q=1#f"] {
            assert_eq!(address(good), Ok(()), "{good}");
        }
        for bad in [
            "",
            "file:///etc/passwd",
            "chrome://settings",
            "javascript:alert(1)",
            "data:text/html,x",
            "view-source:http://a",
            "about:srcdoc",
            "http://a b",
            "https://example.com/\n",
            "--no-sandbox",
        ] {
            assert_eq!(address(bad), Err(Refusal::Address), "{bad:?}");
        }
        let long = format!("https://example.com/{}", "a".repeat(2048));
        assert_eq!(address(&long), Err(Refusal::Address));
    }

    #[test]
    fn a_refusal_names_a_class_and_never_the_page() {
        let secret = "https://internal.example/reset?token=s3cr3t";
        let refused = command("Network.getCookies", &json!({"urls":[secret]})).unwrap_err();
        assert!(!format!("{refused:?} {}", refused.reason()).contains("s3cr3t"));
        let refused = command("Page.navigate", &json!({"url":"file:///s3cr3t"})).unwrap_err();
        assert_eq!(refused.reason(), "AddressRefused");
    }
    #[test]
    fn every_denied_bidi_class_is_refused_with_its_reason() {
        let none = json!({});
        for (method, params, refusal) in [
            ("storage.getCookies", none.clone(), Refusal::Session),
            ("storage.deleteCookies", none.clone(), Refusal::Session),
            ("network.addIntercept", none.clone(), Refusal::Session),
            ("network.setExtraHeaders", none.clone(), Refusal::Session),
            ("script.callFunction", none.clone(), Refusal::Script),
            ("script.addPreloadScript", none.clone(), Refusal::Script),
            ("webExtension.install", none.clone(), Refusal::Script),
            ("input.setFiles", none.clone(), Refusal::Files),
            (
                "browsingContext.startScreencast",
                none.clone(),
                Refusal::Files,
            ),
            (
                "permissions.setPermission",
                none.clone(),
                Refusal::Permission,
            ),
            (
                "emulation.setGeolocationOverride",
                none.clone(),
                Refusal::Permission,
            ),
            ("browser.close", none.clone(), Refusal::Unlisted),
            ("browser.removeUserContext", none.clone(), Refusal::Unlisted),
            ("browsingContext.print", none.clone(), Refusal::Unlisted),
            ("session.subscribe", none.clone(), Refusal::Unlisted),
            ("Madeup.method", none.clone(), Refusal::Unlisted),
            // Script that is not the title, or that the page could intercept or wait on.
            (
                "script.evaluate",
                json!({"expression":"document.cookie","awaitPromise":false,"target":{"context":"c","sandbox":"s"}}),
                Refusal::Script,
            ),
            (
                "script.evaluate",
                json!({"expression":"document.title","awaitPromise":false,"target":{"context":"c"}}),
                Refusal::Script,
            ),
            (
                "script.evaluate",
                json!({"expression":"document.title","awaitPromise":true,"target":{"context":"c","sandbox":"s"}}),
                Refusal::Script,
            ),
            (
                "script.evaluate",
                json!({"expression":"document.title;1","awaitPromise":false,"target":{"context":"c","sandbox":"s"}}),
                Refusal::Script,
            ),
            ("script.evaluate", none.clone(), Refusal::Script),
            // Addresses that are not web pages or blank, however Firefox would treat them (`file:` opens).
            (
                "browsingContext.navigate",
                json!({"context":"c","url":"file:///etc/hostname","wait":"none"}),
                Refusal::Address,
            ),
            (
                "browsingContext.navigate",
                json!({"context":"c","url":"javascript:alert(1)"}),
                Refusal::Address,
            ),
            (
                "browsingContext.navigate",
                json!({"context":"c","url":"data:text/html,x"}),
                Refusal::Address,
            ),
            (
                "browsingContext.navigate",
                json!({"context":"c"}),
                Refusal::Address,
            ),
            // Parameters outside what the relay sends.
            (
                "browsingContext.navigate",
                json!({"context":"c","url":"https://a.test/","wait":"forever"}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.navigate",
                json!({"context":1,"url":"https://a.test/"}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.navigate",
                json!({"context":"c","url":"https://a.test/","referrer":"x"}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.reload",
                json!({"context":"c","ignoreCache":true}),
                Refusal::Unlisted,
            ),
            ("browsingContext.reload", none.clone(), Refusal::Unlisted),
            (
                "browsingContext.traverseHistory",
                json!({"context":"c","delta":5}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.traverseHistory",
                json!({"context":"c","delta":0}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.traverseHistory",
                json!({"context":"c","delta":-1.5}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.create",
                json!({"type":"window"}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.create",
                json!({"type":"tab","userContext":"u"}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.create",
                json!({"type":"tab","referenceContext":"c"}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.create",
                json!({"type":"tab","background":"yes"}),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.close",
                json!({"context":"c","promptUnload":true}),
                Refusal::Unlisted,
            ),
            ("browsingContext.close", none.clone(), Refusal::Unlisted),
            ("browsingContext.activate", none.clone(), Refusal::Unlisted),
            // Nothing else of the domain: no stop exists, and the rest stays closed.
            ("browsingContext.stop", none.clone(), Refusal::Unlisted),
            (
                "browsingContext.setBypassCSP",
                none.clone(),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.handleUserPrompt",
                none.clone(),
                Refusal::Unlisted,
            ),
            (
                "browsingContext.locateNodes",
                none.clone(),
                Refusal::Unlisted,
            ),
        ] {
            assert_eq!(bidi(method, &params), Err(refusal), "{method} {params}");
        }
    }

    #[test]
    fn the_bidi_commands_the_firefox_adapter_needs_are_allowed() {
        let target = json!({"context":"c","sandbox":"lazysh"});
        for (method, params) in [
            ("session.new", json!({"capabilities":{}})),
            ("session.end", json!({})),
            ("browsingContext.getTree", json!({})),
            (
                "browsingContext.navigate",
                json!({"context":"c","url":"https://example.com/a?b=1","wait":"none"}),
            ),
            (
                "browsingContext.navigate",
                json!({"context":"c","url":"about:blank"}),
            ),
            (
                "browsingContext.reload",
                json!({"context":"c","wait":"complete"}),
            ),
            (
                "browsingContext.traverseHistory",
                json!({"context":"c","delta":-1}),
            ),
            (
                "browsingContext.traverseHistory",
                json!({"context":"c","delta":1}),
            ),
            (
                "browsingContext.create",
                json!({"type":"tab","background":true}),
            ),
            ("browsingContext.activate", json!({"context":"c"})),
            ("browsingContext.close", json!({"context":"c"})),
            (
                "browsingContext.setViewport",
                json!({"context":"c","viewport":{"width":412,"height":915}}),
            ),
            (
                "browsingContext.captureScreenshot",
                json!({"context":"c","origin":"viewport","format":{"type":"image/jpeg","quality":0.6}}),
            ),
            (
                "script.evaluate",
                json!({"expression":TITLE_EXPRESSION,"awaitPromise":false,"target":target}),
            ),
        ] {
            assert_eq!(bidi(method, &params), Ok(()), "{method} {params}");
        }
    }

    fn mouse(actions: Value) -> Value {
        json!({"type":"pointer","id":"mouse","parameters":{"pointerType":"mouse"},"actions":actions})
    }
    fn keyboard(events: &[(&'static str, char)]) -> Value {
        super::super::input::key_source(events.to_vec())
    }
    fn perform(source: Value) -> Result<(), Refusal> {
        bidi(
            "input.performActions",
            &json!({"context":"c","actions":[source]}),
        )
    }

    #[test]
    fn the_bidi_input_the_relay_sends_is_allowed() {
        let to = json!({"type":"pointerMove","x":10,"y":20,"origin":"viewport"});
        let scroll =
            json!({"type":"scroll","x":10,"y":20,"deltaX":0,"deltaY":-400,"origin":"viewport"});
        for source in [
            mouse(json!([to, {"type":"pointerDown","button":2}])),
            mouse(json!([to, {"type":"pointerUp","button":0}])),
            json!({"type":"wheel","id":"wheel","actions":[scroll]}),
            keyboard(&[
                ("keyDown", 'ç'),
                ("keyUp", 'ç'),
                ("keyDown", '😀'),
                ("keyUp", '😀'),
            ]),
            keyboard(&[("keyDown", '\u{E003}'), ("keyUp", '\u{E003}')]),
            keyboard(&[
                ("keyDown", '\u{E009}'),
                ("keyDown", 'a'),
                ("keyUp", 'a'),
                ("keyUp", '\u{E009}'),
            ]),
        ] {
            assert_eq!(perform(source.clone()), Ok(()), "{source}");
        }
        assert_eq!(
            bidi("input.releaseActions", &json!({"context":"c"})),
            Ok(())
        );
    }

    #[test]
    fn bidi_input_outside_its_bounds_is_refused() {
        let to = |x: f64, y: f64| json!({"type":"pointerMove","x":x,"y":y,"origin":"viewport"});
        let down = |value: char| ("keyDown", value);
        let long = || vec![json!({"type":"keyDown","value":"a"}); MAX_BIDI_ACTIONS + 1];
        for (source, refusal) in [
            // A touch pointer, a source that is not one of the three, a position outside any viewport, a position
            // relative to the pointer or an element, and a tick that lasts longer than a second.
            (
                json!({"type":"pointer","id":"p","parameters":{"pointerType":"touch"},"actions":[to(1.0, 1.0)]}),
                Refusal::Unlisted,
            ),
            (
                json!({"type":"none","id":"n","actions":[]}),
                Refusal::Unlisted,
            ),
            (mouse(json!([to(2049.0, 1.0)])), Refusal::Unlisted),
            (mouse(json!([to(1.0, -1.0)])), Refusal::Unlisted),
            (
                mouse(json!([{"type":"pointerMove","x":1,"y":1,"origin":"pointer"}])),
                Refusal::Unlisted,
            ),
            (
                mouse(
                    json!([{"type":"pointerMove","x":1,"y":1,"origin":{"type":"element","element":{"sharedId":"e"}}}]),
                ),
                Refusal::Unlisted,
            ),
            (
                mouse(
                    json!([{"type":"pointerMove","x":1,"y":1,"origin":"viewport","duration":1001}]),
                ),
                Refusal::Unlisted,
            ),
            (
                mouse(json!([{"type":"pointerDown","button":3}])),
                Refusal::Unlisted,
            ),
            (
                mouse(json!([{"type":"pause","duration":5}])),
                Refusal::Unlisted,
            ),
            (
                json!({"type":"wheel","id":"w","actions":[{"type":"scroll","x":1,"y":1,"deltaX":0,"deltaY":10001,"origin":"viewport"}]}),
                Refusal::Unlisted,
            ),
            // A value that is not one key, a key of the private-use range that is not on the closed list (U+E000
            // releases every key, U+E031 is F1), and more actions than the longest text.
            (
                json!({"type":"key","id":"k","actions":[{"type":"keyDown","value":"ab"}]}),
                Refusal::Unlisted,
            ),
            (keyboard(&[down('\u{E000}')]), Refusal::Unlisted),
            (keyboard(&[down('\u{E031}')]), Refusal::Unlisted),
            (
                json!({"type":"key","id":"k","actions":long()}),
                Refusal::Unlisted,
            ),
            // The clipboard: Control or Meta with C, X or V, and Shift with Delete.
            (
                keyboard(&[down('\u{E009}'), down('v')]),
                Refusal::Permission,
            ),
            (
                keyboard(&[down('\u{E03D}'), down('C')]),
                Refusal::Permission,
            ),
            (
                keyboard(&[down('\u{E008}'), down('\u{E017}')]),
                Refusal::Permission,
            ),
        ] {
            assert_eq!(perform(source.clone()), Err(refusal), "{source}");
        }
        for params in [
            json!({"actions":[mouse(json!([]))]}),
            json!({"context":"c","actions":[]}),
            json!({"context":"c","actions":[mouse(json!([])), mouse(json!([])), mouse(json!([])), mouse(json!([]))]}),
            json!({"context":"c"}),
        ] {
            assert_eq!(
                bidi("input.performActions", &params),
                Err(Refusal::Unlisted),
                "{params}"
            );
        }
        // A key that was let go of no longer makes a chord.
        assert_eq!(
            perform(keyboard(&[
                down('\u{E009}'),
                ("keyUp", '\u{E009}'),
                down('v')
            ])),
            Ok(())
        );
        for params in [
            json!({}),
            json!({"context":"c","all":true}),
            json!({"context":1}),
        ] {
            assert_eq!(
                bidi("input.releaseActions", &params),
                Err(Refusal::Unlisted),
                "{params}"
            );
        }
    }

    #[test]
    fn the_bidi_list_names_no_denied_class() {
        // Script is on the list only to read the title: `bidi` checks the expression.
        for method in BIDI_ALLOWED.into_iter().filter(|m| *m != "script.evaluate") {
            assert_eq!(bidi_class(method), Refusal::Unlisted, "{method}");
        }
    }
}
