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
const BIDI_ALLOWED: [&str; 6] = [
    "browsingContext.captureScreenshot",
    "browsingContext.getTree",
    "browsingContext.setViewport",
    "script.evaluate",
    "session.end",
    "session.new",
];

/// The one script the relay ever runs in a page: it reads the title, because `browsingContext.getTree` has none.
pub const TITLE_EXPRESSION: &str = "document.title";

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
        _ => Ok(()),
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

    #[test]
    fn the_bidi_list_names_no_denied_class() {
        // Script is on the list only to read the title: `bidi` checks the expression.
        for method in BIDI_ALLOWED.into_iter().filter(|m| *m != "script.evaluate") {
            assert_eq!(bidi_class(method), Refusal::Unlisted, "{method}");
        }
    }
}
