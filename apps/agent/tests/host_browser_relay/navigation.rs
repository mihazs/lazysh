//! The relay's navigation, tabs, dialogs and notices (docs/host-browser.md, "Controls"), driven through its real
//! standard input and output like the rest of this file: over the fake browser, which records every call it gets,
//! and over a real Chrome or Chromium on a loopback site, where the host has one.
use super::*;
use std::sync::{Arc, Mutex};

static NOTHING: Value = Value::Null;
/// The calls that are the relay's own reading of the browser: the poll, the history request, the
/// acknowledgements, and for Firefox the tree, the screenshots and the titles. A message of the client never
/// causes them by itself.
const READING: [&str; 6] = [
    "Target.getTargets",
    "Page.getNavigationHistory",
    "Page.screencastFrameAck",
    "browsingContext.getTree",
    "browsingContext.captureScreenshot",
    "script.evaluate",
];

/// What a client knows from the relay's messages so far: the newest tab list, and every dialog, notice and refusal.
#[derive(Debug, Default)]
pub(super) struct Known {
    pub(super) state: Value,
    pub(super) tabs: Value,
    /// How many tab lists the relay has sent.
    pub(super) tab_lists: u32,
    pub(super) dialogs: Vec<Value>,
    pub(super) dialogs_closed: u32,
    pub(super) notices: Vec<(String, u64)>,
    pub(super) refusals: Vec<(String, u64)>,
    pub(super) frames: u32,
    /// The middle pixel of the newest frame that was a picture.
    pub(super) center: Option<[u8; 3]>,
    pub(super) closed: Option<Value>,
}
impl Known {
    pub(super) fn tabs(&self) -> &[Value] {
        self.tabs["tabs"].as_array().map_or(&[], Vec::as_slice)
    }
    pub(super) fn shown(&self) -> &Value {
        let active = &self.tabs["activeId"];
        self.tabs()
            .iter()
            .find(|tab| tab["id"] == *active)
            .unwrap_or(&NOTHING)
    }
    pub(super) fn ids(&self) -> Vec<&str> {
        self.tabs()
            .iter()
            .filter_map(|tab| tab["id"].as_str())
            .collect()
    }
    /// The shown page's title and address.
    pub(super) fn at(&self, title: &str, url: &str) -> bool {
        self.shown()["title"] == title && self.shown()["url"] == url
    }
    pub(super) fn refused(&self, reason: &str, count: u64) -> bool {
        self.refusals.contains(&(reason.to_string(), count))
    }
    pub(super) fn noticed(&self, kind: &str, count: u64) -> bool {
        self.notices.contains(&(kind.to_string(), count))
    }
    /// The newest frame is mostly the color `(red, green, blue)`, give or take what a JPEG does to it.
    pub(super) fn shows(&self, color: [u8; 3]) -> bool {
        self.center.is_some_and(|pixel| {
            pixel
                .iter()
                .zip(color)
                .all(|(got, want)| got.abs_diff(want) < 60)
        })
    }
}

/// A relay and what its client has been told, keeping up the way the app does: each frame is acknowledged.
pub(super) struct Client {
    pub(super) relay: Relay,
    pub(super) known: Known,
}
impl Client {
    pub(super) fn new(relay: Relay) -> Self {
        Self {
            relay,
            known: Known::default(),
        }
    }
    pub(super) fn send(&mut self, message: Value) {
        self.relay.send(message);
    }
    pub(super) fn absorb(&mut self, message: Message) {
        let known = &mut self.known;
        match message {
            Message::Frame { sequence, jpeg, .. } => {
                known.frames += 1;
                known.center = image::load_from_memory(&jpeg).ok().map(|image| {
                    let image = image.to_rgb8();
                    image.get_pixel(image.width() / 2, image.height() / 2).0
                });
                // The client takes its time to decode, so the relay does not spin a fake browser at full speed.
                std::thread::sleep(Duration::from_millis(10));
                self.relay
                    .send(json!({"type": "ack", "sequence": sequence}));
            }
            Message::Json(message) => {
                let text = |key: &str| message[key].as_str().unwrap_or_default().to_string();
                match message["type"].as_str().unwrap_or_default() {
                    "state" if known.state.is_null() => known.state = message,
                    "tabs" => {
                        known.tabs = message;
                        known.tab_lists += 1;
                    }
                    "dialog" => known.dialogs.push(message),
                    "dialogClosed" => known.dialogs_closed += 1,
                    "notice" => known
                        .notices
                        .push((text("kind"), message["count"].as_u64().unwrap())),
                    "refused" => known
                        .refusals
                        .push((text("reason"), message["count"].as_u64().unwrap())),
                    "closed" => known.closed = Some(message),
                    _ => {}
                }
            }
        }
    }
    /// Read messages until what the client knows satisfies `done`; `what` is named when it never does.
    pub(super) fn until(&mut self, what: &str, done: impl Fn(&Known) -> bool) {
        let deadline = Instant::now() + WAIT * 2;
        while !done(&self.known) {
            let wait = deadline.saturating_duration_since(Instant::now());
            match self.relay.within(wait) {
                Some(message) => self.absorb(message),
                None => panic!("never {what}; the client knows {:#?}", self.known),
            }
        }
    }
    /// Wait until the relay has handled everything sent so far: it answers a request for the list after the
    /// messages before it, and messages are handled in order.
    pub(super) fn settled(&mut self) {
        let lists = self.known.tab_lists;
        self.send(json!({"type": "tabs"}));
        self.until("the relay answered", |known| known.tab_lists > lists);
    }
    /// The last message that is valid ends what came before it: eight refused addresses and four other refused
    /// messages were counted, and the valid address opened.
    pub(super) fn ends_with_a_valid_address(&mut self) {
        self.send(json!({"type": "navigate", "url": "http://127.0.0.1:3000/last"}));
        self.until("the refusals were counted", |known| {
            known.refused("AddressRefused", 8) && known.refused("OperationRefused", 4)
        });
        self.until("the valid address was opened", |known| {
            known.shown()["url"] == "http://127.0.0.1:3000/last"
        });
    }
    /// A reload asks the site again: the page at `count` tells how many times it was asked.
    pub(super) fn reloads_the_counting_page(&mut self, site: &Site, count: &str) {
        self.send(json!({"type": "navigate", "url": count}));
        self.until("the first count", |known| known.at("count=1", count));
        self.send(json!({"type": "reload"}));
        self.until("the second count", |known| known.at("count=2", count));
        assert!(site.asked("/count") >= 2);
    }
    /// A tap at a point, with Control on.
    pub(super) fn tap(&mut self, x: u32, y: u32) {
        self.relay.tap(x, y);
    }
}

impl Fixture {
    /// A fake browser's relay, opened on a blank page, and a client that has its first frame.
    fn client(&self, mode: &str) -> Client {
        let mut relay = self.serve(mode, "Chrome/120.0.0.0");
        relay.open("about:blank");
        let mut client = Client::new(relay);
        client.until("the first page", |known| {
            known.frames > 0 && !known.tabs().is_empty()
        });
        client
    }
    /// Every call the browser received is one the allow-list passes.
    pub(super) fn assert_allowed(&self) {
        for call in self.commands() {
            let method = call["method"].as_str().unwrap();
            assert_eq!(allow::command(method, &call["params"]), Ok(()), "{method}");
        }
    }
    /// The calls the browser has received, less the relay's own reading.
    pub(super) fn made(&self) -> Vec<Value> {
        let own = |call: &Value| READING.contains(&call["method"].as_str().unwrap());
        self.commands()
            .into_iter()
            .filter(|call| !own(call))
            .collect()
    }
    /// The calls received after the first `before`, once there are `count` of them.
    pub(super) fn made_after(&self, before: usize, count: usize) -> Vec<Value> {
        let deadline = Instant::now() + WAIT;
        loop {
            let calls = self.made().split_off(before);
            if calls.len() >= count || Instant::now() > deadline {
                return calls;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }
}

/// Each call as its method, and the page session it went to when it went to one: `Page.reload@S1`.
pub(super) fn named(calls: &[Value]) -> Vec<String> {
    calls
        .iter()
        .map(|call| match call["sessionId"].as_str() {
            Some(session) => format!("{}@{session}", call["method"].as_str().unwrap()),
            None => call["method"].as_str().unwrap().to_string(),
        })
        .collect()
}

/// The parameters of the one call of `method` in `calls`.
pub(super) fn params<'a>(calls: &'a [Value], method: &str) -> &'a Value {
    let mut found = calls.iter().filter(|call| call["method"] == method);
    let call = found
        .next()
        .unwrap_or_else(|| panic!("no {method} in {calls:?}"));
    assert!(
        found.next().is_none(),
        "{method} more than once in {calls:?}"
    );
    &call["params"]
}

#[test]
fn each_navigation_message_becomes_exactly_its_calls_whether_or_not_control_is_on() {
    let fixture = Fixture::enabled();
    let mut client = fixture.client("");
    // Navigation is not input: Control is off, as it is when a session starts.
    let capabilities = client.known.state["capabilities"].clone();
    assert_eq!(
        capabilities,
        json!({"view": true, "control": true, "navigation": true, "tabs": true})
    );
    let fixture_page = "http://127.0.0.1:3000/secret-path";
    assert!(client.known.at("Fixture page", fixture_page));
    assert_eq!(client.known.tabs["canGoBack"], false);

    let address = "https://example.com/a";
    let step = |client: &mut Client, message: Value, expected: &[(&str, Value)]| {
        let before = fixture.made().len();
        client.send(message);
        let calls = fixture.made_after(before, expected.len());
        let wanted: Vec<_> = expected
            .iter()
            .map(|(method, _)| (*method).to_string())
            .collect();
        assert_eq!(named(&calls), wanted);
        for ((method, wanted), call) in expected.iter().zip(&calls) {
            assert_eq!(&call["params"], wanted, "{method}");
        }
    };
    step(
        &mut client,
        json!({"type": "navigate", "url": address}),
        &[("Page.navigate@S1", json!({"url": address}))],
    );
    // The title is the real one, read from the browser's list: its change notice only carried the address.
    client.until("the address followed", |known| {
        known.at("Title of example.com/a", address)
            && known.tabs["canGoBack"] == true
            && known.tabs["loading"] == false
    });
    assert_eq!(client.known.tabs["canGoForward"], false);

    step(
        &mut client,
        json!({"type": "back"}),
        &[("Page.navigateToHistoryEntry@S1", json!({"entryId": 100}))],
    );
    client.until("back", |known| {
        known.at("Title of 127.0.0.1:3000/secret-path", fixture_page)
            && known.tabs["canGoForward"] == true
    });
    assert_eq!(client.known.tabs["canGoBack"], false);
    step(
        &mut client,
        json!({"type": "forward"}),
        &[("Page.navigateToHistoryEntry@S1", json!({"entryId": 101}))],
    );
    client.until("forward", |known| {
        known.at("Title of example.com/a", address) && known.tabs["canGoBack"] == true
    });
    step(
        &mut client,
        json!({"type": "reload"}),
        &[("Page.reload@S1", json!({}))],
    );
    step(
        &mut client,
        json!({"type": "stop"}),
        &[("Page.stopLoading@S1", json!({}))],
    );
    assert!(
        client.known.refusals.is_empty(),
        "{:?}",
        client.known.refusals
    );
    client.relay.stop();
}

#[test]
fn an_address_outside_the_allowed_set_or_a_tab_that_is_not_listed_is_dropped_and_counted() {
    let fixture = Fixture::enabled();
    let mut client = fixture.client("");
    let before = fixture.made().len();
    let long = format!("https://a.test/{}", "a".repeat(2100));
    // Eight addresses the relay's own rule refuses, as the app's address bar would have before them.
    for address in [
        "file:///etc/passwd",
        "javascript:alert(1)",
        "data:text/html,hi",
        "chrome://settings",
        "view-source:https://a.test/",
        "https://a.test/ a space",
        "",
        long.as_str(),
    ] {
        client.send(json!({"type": "navigate", "url": address}));
    }
    // A tab the browser does not have, a dialog nobody is asking, and messages that name a protocol method or a
    // field that the closed set does not have.
    client.send(json!({"type": "activateTab", "id": "T9"}));
    client.send(json!({"type": "closeTab", "id": "T9"}));
    client.send(json!({"type": "answerDialog", "accept": true}));
    client.send(
        json!({"type": "navigate", "url": "https://a.test/", "method": "Network.getCookies"}),
    );
    client.send(json!({"type": "reload", "ignoreCache": true}));
    client.ends_with_a_valid_address();
    assert_eq!(
        named(&fixture.made().split_off(before)),
        ["Page.navigate@S1"]
    );
    assert_eq!(client.known.tabs().len(), 1);
    fixture.assert_allowed();
    client.relay.stop();
}

#[test]
fn a_page_that_opens_another_shows_it_and_switching_opening_and_closing_tabs_follow() {
    let fixture = Fixture::enabled();
    let mut client = fixture.client("");
    let before = fixture.made().len();
    client.send(json!({"type": "navigate", "url": "http://fake.test/popup"}));
    // The popup takes the view, like in a browser: the shown page is left and the popup's frames start.
    client.until("the popup is shown", |known| {
        known.ids() == ["T1", "T2"]
            && known.tabs["activeId"] == "T2"
            && known.shown()["title"] == "Title of fake.test/popup-page"
    });
    let calls = fixture.made_after(before, 9);
    assert_eq!(
        named(&calls),
        [
            "Page.navigate@S1",
            "Target.attachToTarget",
            "Page.enable@S2",
            "Page.setInterceptFileChooserDialog@S2",
            "Emulation.setDeviceMetricsOverride@S2",
            "Target.activateTarget",
            "Page.stopScreencast@S1",
            "Target.detachFromTarget",
            "Page.startScreencast@S2",
        ]
    );
    assert_eq!(
        params(&calls, "Target.attachToTarget"),
        &json!({"targetId": "T2", "flatten": true})
    );
    assert_eq!(
        params(&calls, "Target.detachFromTarget"),
        &json!({"sessionId": "S1"})
    );
    let frames = client.known.frames;
    client.until("frames from the popup", |known| known.frames > frames + 1);

    // Back to the first page: a session of its own again, and its frames.
    let before = fixture.made().len();
    client.send(json!({"type": "activateTab", "id": "T1"}));
    client.until("the first tab is shown", |known| {
        known.tabs["activeId"] == "T1" && known.shown()["title"] == "Title of fake.test/popup"
    });
    let calls = fixture.made_after(before, 8);
    assert_eq!(
        named(&calls),
        [
            "Target.attachToTarget",
            "Page.enable@S3",
            "Page.setInterceptFileChooserDialog@S3",
            "Emulation.setDeviceMetricsOverride@S3",
            "Target.activateTarget",
            "Page.stopScreencast@S2",
            "Target.detachFromTarget",
            "Page.startScreencast@S3",
        ]
    );
    assert_eq!(
        params(&calls, "Target.activateTarget"),
        &json!({"targetId": "T1"})
    );
    // Showing the page that is shown is not a switch.
    let made = fixture.made().len();
    client.send(json!({"type": "activateTab", "id": "T1"}));
    client.settled();
    assert_eq!(fixture.made().len(), made);

    // A new blank tab takes the view and is created through the allow-listed call.
    client.send(json!({"type": "newTab"}));
    client.until("the new tab", |known| {
        known.ids() == ["T1", "T2", "T3"] && known.tabs["activeId"] == "T3"
    });
    assert_eq!(
        params(&fixture.made(), "Target.createTarget"),
        &json!({"url": "about:blank"})
    );

    // Closing the shown tab shows the one before it; closing one that is not shown leaves the view alone.
    client.send(json!({"type": "closeTab", "id": "T3"}));
    client.until("the last tab is back", |known| {
        known.ids() == ["T1", "T2"] && known.tabs["activeId"] == "T2"
    });
    client.send(json!({"type": "closeTab", "id": "T1"}));
    client.until("the first tab is gone", |known| {
        known.ids() == ["T2"] && known.tabs["activeId"] == "T2"
    });
    // A browser keeps a page: closing the last one makes a blank one first and shows it, and the session goes on.
    client.send(json!({"type": "closeTab", "id": "T2"}));
    client.until("a blank page replaces the last tab", |known| {
        known.ids() == ["T4"] && known.tabs["activeId"] == "T4"
    });
    let calls = fixture.made();
    let created = calls
        .iter()
        .rposition(|call| call["method"] == "Target.createTarget")
        .unwrap();
    let closed = calls
        .iter()
        .position(|call| {
            call["method"] == "Target.closeTarget" && call["params"]["targetId"] == "T2"
        })
        .unwrap();
    assert!(
        created < closed,
        "the blank page was made after the last tab was closed"
    );
    assert!(client.known.closed.is_none());
    fixture.assert_allowed();
    client.relay.stop();
}

#[test]
fn a_page_listed_that_is_gone_by_the_time_it_is_shown_is_dropped_and_the_session_goes_on() {
    let fixture = Fixture::enabled();
    let mut client = fixture.client("ghost");
    client.until("the ghost is listed", |known| known.ids() == ["T1", "T9"]);
    let before = fixture.made().len();
    client.send(json!({"type": "activateTab", "id": "T9"}));
    client.until("the ghost is dropped", |known| known.ids() == ["T1"]);
    // The page that was shown was not left for a page that could not be attached.
    let calls = fixture.made_after(before, 1);
    assert_eq!(named(&calls), ["Target.attachToTarget"]);
    assert_eq!(client.known.tabs["activeId"], "T1");
    assert!(client.known.closed.is_none());
    // The poll still lists it, and it stays gone.
    std::thread::sleep(Duration::from_millis(2500));
    client.send(json!({"type": "tabs"}));
    client.until("the list again", |known| known.ids() == ["T1"]);
    client.relay.stop();
}

#[test]
fn a_page_that_opens_windows_without_end_is_held_to_sixteen_tabs() {
    let fixture = Fixture::enabled();
    let mut client = fixture.client("");
    for _ in 0..17 {
        client.send(json!({"type": "newTab"}));
    }
    client.until("sixteen tabs and a refusal", |known| {
        known.tabs().len() == 16 && known.refused("OperationRefused", 1)
    });
    assert_eq!(client.known.tabs["activeId"], "T16");
    // The tab list can arrive before the fake browser records the last screencast start.
    let deadline = Instant::now() + WAIT;
    while !fixture
        .made()
        .iter()
        .any(|call| call["method"] == "Page.startScreencast" && call["sessionId"] == "S16")
    {
        assert!(
            Instant::now() < deadline,
            "the final tab did not start its screencast"
        );
        std::thread::sleep(Duration::from_millis(20));
    }
    // A page that opens one more: the browser has it, and the relay closes it again without showing it.
    let before = fixture.made().len();
    client.send(json!({"type": "navigate", "url": "http://fake.test/popup"}));
    let calls = fixture.made_after(before, 2);
    assert_eq!(named(&calls), ["Page.navigate@S16", "Target.closeTarget"]);
    assert_eq!(calls[1]["params"], json!({"targetId": "T17"}));
    // Its destruction is announced; the list and the shown page are as they were.
    std::thread::sleep(QUIET);
    client.settled();
    assert!(client.known.tabs().len() == 16 && client.known.tabs["activeId"] == "T16");
    assert_eq!(fixture.made().len(), before + 2);
    assert!(client.known.closed.is_none());
    client.relay.stop();
}

#[test]
fn a_page_dialog_reaches_the_client_as_text_and_only_its_answer_goes_back() {
    let fixture = Fixture::enabled();
    let mut client = fixture.client("");
    client.send(json!({"type": "navigate", "url": "http://fake.test/dialog"}));
    client.until("the dialog", |known| known.dialogs.len() == 1);
    assert_eq!(
        client.known.dialogs[0],
        json!({"type": "dialog", "kind": "confirm", "message": "Leave the page?", "defaultPrompt": ""})
    );
    // An answer that is too long to be one is refused, and the dialog stays open.
    client.send(json!({"type": "answerDialog", "accept": true, "text": "a".repeat(5000)}));
    client.until("the long answer was refused", |known| {
        known.refused("InputOutOfRange", 1)
    });
    let before = fixture.made().len();
    client.send(json!({"type": "answerDialog", "accept": true, "text": "ação"}));
    let calls = fixture.made_after(before, 1);
    assert_eq!(named(&calls), ["Page.handleJavaScriptDialog@S1"]);
    assert_eq!(
        calls[0]["params"],
        json!({"accept": true, "promptText": "ação"})
    );
    client.until("the dialog closed", |known| known.dialogs_closed == 1);

    // A dialog the person walks away from is dismissed, so that its page is not left blocked.
    client.send(json!({"type": "navigate", "url": "http://fake.test/dialog"}));
    client.until("the second dialog", |known| known.dialogs.len() == 2);
    let before = fixture.made().len();
    client.send(json!({"type": "newTab"}));
    client.until("the dialog was dismissed", |known| {
        known.dialogs_closed == 2 && known.tabs().len() == 2
    });
    // The page is left after its dialog is dismissed, not before: its session is still the shown one.
    let calls = fixture.made_after(before, 10);
    let at = |method: &str| {
        named(&calls)
            .iter()
            .position(|call| call.starts_with(method))
            .unwrap()
    };
    assert!(
        at("Page.handleJavaScriptDialog") < at("Page.stopScreencast"),
        "{:?}",
        named(&calls)
    );
    assert_eq!(
        params(&calls, "Page.handleJavaScriptDialog"),
        &json!({"accept": false})
    );
    assert!(named(&calls).contains(&"Page.handleJavaScriptDialog@S1".to_string()));
    client.relay.stop();
}

#[test]
fn a_denied_download_and_a_denied_file_chooser_are_reported_and_a_flood_stays_small() {
    let fixture = Fixture::enabled();
    let mut client = fixture.client("");
    for _ in 0..4 {
        client.send(json!({"type": "navigate", "url": "http://fake.test/download"}));
    }
    client.send(json!({"type": "navigate", "url": "http://fake.test/chooser"}));
    client.until("the notices", |known| {
        known.noticed("download", 4) && known.noticed("fileChooser", 1)
    });
    // The first attempt, the second and the fourth: the third is not told again.
    assert_eq!(
        client.known.notices,
        [
            ("download".to_string(), 1),
            ("download".to_string(), 2),
            ("download".to_string(), 4),
            ("fileChooser".to_string(), 1)
        ]
    );
    // Both were denied before any page could use them, and the denial covers each page that is shown later.
    client.send(json!({"type": "newTab"}));
    client.until("the second page", |known| known.tabs().len() == 2);
    let calls = fixture.made();
    assert_eq!(
        params(&calls, "Browser.setDownloadBehavior"),
        &json!({"behavior": "deny", "eventsEnabled": true})
    );
    let chooser: Vec<_> = calls
        .iter()
        .filter(|call| call["method"] == "Page.setInterceptFileChooserDialog")
        .collect();
    assert_eq!(chooser.len(), 2);
    assert!(chooser
        .iter()
        .all(|call| call["params"] == json!({"enabled": true})));
    assert!(client.known.dialogs.is_empty());
    client.relay.stop();
}

/// The page that a real browser is shown on a loopback site: three colored links, one that opens a page in
/// another tab, one that is a file and one that is a page in the same tab.
const START: &str =
    "<!doctype html><title>Start</title><style>body{margin:0}a{display:block;height:200px}</style>
<a href=\"/popup\" target=\"_blank\" style=\"background:#c80000\"></a>
<a href=\"/file\" style=\"background:#0000c8\"></a>
<a href=\"/next\" style=\"background:#c8c800\"></a>";
const POPUP: &str =
    "<!doctype html><title>Popup</title><body style=\"margin:0;background:#00c800\">";
const NEXT: &str = "<!doctype html><title>Next</title><body style=\"margin:0;background:#c800c8\">";
/// A page that asks a question and reports the answer in its title.
const QUESTION: &str = "<!doctype html><title>asked</title><style>body{margin:0}button{display:block;width:412px;height:200px}</style>
<button onclick=\"document.title = 'answer=' + confirm('Delete everything?')\"></button>";
const PAYLOAD: &str = "payload-bytes-that-must-not-reach-a-disk";
pub(super) const YELLOW: [u8; 3] = [200, 200, 0];
pub(super) const GREEN: [u8; 3] = [0, 200, 0];

/// A loopback site, and what the browser asked it for.
pub(super) struct Site {
    port: u16,
    asked: Arc<Mutex<Vec<String>>>,
}
impl Site {
    pub(super) fn start() -> Self {
        let asked = Arc::new(Mutex::new(Vec::new()));
        let seen = asked.clone();
        let (port, _) = serve_pages(move |path| {
            let count = {
                let mut seen = seen.lock().unwrap();
                seen.push(path.to_string());
                seen.iter().filter(|asked| *asked == path).count()
            };
            let page = |body: String| Reply {
                content_type: "text/html",
                headers: "",
                body,
            };
            match path {
                "/start" => page(START.into()),
                "/popup" => page(POPUP.into()),
                "/next" => page(NEXT.into()),
                "/question" => page(QUESTION.into()),
                // The page that tells how many times it was asked for, which is how a reload shows.
                "/count" => page(format!("<!doctype html><title>count={count}</title>")),
                "/file" => Reply {
                    content_type: "application/octet-stream",
                    headers: "Content-Disposition: attachment; filename=\"loot.bin\"\r\n",
                    body: PAYLOAD.into(),
                },
                _ => page("<!doctype html><title>other</title>".into()),
            }
        });
        Self { port, asked }
    }
    pub(super) fn url(&self, path: &str) -> String {
        format!("http://127.0.0.1:{}{path}", self.port)
    }
    pub(super) fn asked(&self, path: &str) -> usize {
        self.asked
            .lock()
            .unwrap()
            .iter()
            .filter(|asked| *asked == path)
            .count()
    }
}

/// A relay over the host's real Chrome or Chromium, opened on the site's start page, with a home of its own for
/// the browser. `None` on a host that has no browser.
fn real_client(site: &Site, path: &str) -> Option<(Fixture, Client, PathBuf)> {
    let Some(binary) = chrome() else {
        eprintln!("skipped: no Chrome or Chromium on PATH");
        return None;
    };
    let fixture = Fixture::enabled();
    let home = fixture.directory.path().join("home");
    let config = home.join(".config");
    fs::create_dir_all(&config).unwrap();
    let envs = [
        ("HOME", home.as_path()),
        ("XDG_CONFIG_HOME", config.as_path()),
        ("XDG_CACHE_HOME", home.as_path()),
        ("XDG_DATA_HOME", home.as_path()),
    ];
    let mut relay = Relay::start(
        &fixture.state,
        &envs,
        &["--binary", binary.to_str().unwrap(), "--no-sandbox"],
    );
    relay.open(&site.url(path));
    Some((fixture, Client::new(relay), home))
}

/// The real browser through the relay: a page opens another through a link, the tabs switch, and the page goes
/// back, forward and reloads, with the tab list and the address following each step.
#[test]
fn a_real_browser_opens_a_second_tab_through_a_link_switches_goes_back_and_reloads() {
    let site = Site::start();
    let Some((_fixture, mut client, _)) = real_client(&site, "/start") else {
        return;
    };
    let start = site.url("/start");
    client.until("the start page", |known| {
        known.at("Start", &start) && known.shows(YELLOW)
    });
    assert_eq!(client.known.state["capabilities"]["navigation"], true);
    client.send(json!({"type": "control", "on": true}));

    // The first link opens a page in a new tab, which takes the view and streams its own pixels.
    client.tap(200, 100);
    let popup = site.url("/popup");
    client.until("the popup in a second tab", |known| {
        known.tabs().len() == 2 && known.at("Popup", &popup) && known.shows(GREEN)
    });
    let first = client.known.tabs()[0]["id"].as_str().unwrap().to_string();
    let second = client.known.tabs()[1]["id"].as_str().unwrap().to_string();
    assert_eq!(client.known.tabs["activeId"], second.as_str());

    client.send(json!({"type": "activateTab", "id": first}));
    client.until("the first tab again", |known| {
        known.tabs["activeId"] == first.as_str() && known.at("Start", &start) && known.shows(YELLOW)
    });

    let next = site.url("/next");
    client.send(json!({"type": "navigate", "url": next}));
    client.until("the next page", |known| {
        known.at("Next", &next) && known.tabs["canGoBack"] == true && known.tabs["loading"] == false
    });
    client.send(json!({"type": "back"}));
    client.until("back at the start", |known| {
        known.at("Start", &start) && known.tabs["canGoForward"] == true && known.shows(YELLOW)
    });
    client.send(json!({"type": "forward"}));
    client.until("forward again", |known| known.at("Next", &next));

    let count = site.url("/count");
    client.reloads_the_counting_page(&site, &count);

    // Closing the tab that is not shown leaves the view where it is.
    client.send(json!({"type": "closeTab", "id": second}));
    client.until("one tab", |known| {
        known.ids() == [first.as_str()] && known.at("count=2", &count)
    });
    assert!(client.known.closed.is_none());
    assert!(
        client.known.refusals.is_empty(),
        "{:?}",
        client.known.refusals
    );
    client.relay.stop();
}

/// Every file at or below `roots` whose name contains one of `names`.
fn files_named(roots: &[&Path], names: &[&str]) -> Vec<PathBuf> {
    fn walk(path: &Path, names: &[&str], found: &mut Vec<PathBuf>) {
        for entry in fs::read_dir(path).into_iter().flatten().flatten() {
            let path = entry.path();
            let name = entry.file_name().to_string_lossy().to_string();
            if names.iter().any(|wanted| name.contains(wanted)) {
                found.push(path.clone());
            }
            if path.is_dir() {
                walk(&path, names, found);
            }
        }
    }
    let mut found = Vec::new();
    roots.iter().for_each(|root| walk(root, names, &mut found));
    found
}

/// A download that the page starts is denied: one notice, and no file under the browser's home or its profile.
#[test]
fn a_real_browser_denies_a_download_with_one_notice_and_writes_no_file() {
    let site = Site::start();
    let Some((fixture, mut client, home)) = real_client(&site, "/start") else {
        return;
    };
    let start = site.url("/start");
    client.until("the start page", |known| known.at("Start", &start));
    client.send(json!({"type": "control", "on": true}));
    client.tap(200, 300);
    client.until("the notice", |known| known.noticed("download", 1));
    assert!(
        site.asked("/file") >= 1,
        "the browser never asked for the file, so nothing was denied"
    );
    // A write would be done long before this; the page is still the start page and nothing else was told.
    std::thread::sleep(Duration::from_secs(2));
    client.send(json!({"type": "tabs"}));
    client.until("the list again", |known| known.at("Start", &start));
    assert_eq!(client.known.notices, [("download".to_string(), 1)]);

    // Under the browser's home and its profile (both are under the fixture's directory) there is no file.
    let roots = [fixture.directory.path()];
    let wanted = ["loot.bin", "crdownload"];
    assert_eq!(files_named(&roots, &wanted), Vec::<PathBuf>::new());
    // The search can fail: a file where a download would go is found.
    let planted = home.join("Downloads");
    fs::create_dir_all(&planted).unwrap();
    fs::write(planted.join("loot.bin"), PAYLOAD).unwrap();
    assert_eq!(files_named(&roots, &wanted), [planted.join("loot.bin")]);
    client.relay.stop();
}

/// A real page's own question reaches the client as text, blocks nothing else, and is answered through the relay.
#[test]
fn a_real_browser_asks_the_clients_question_and_takes_its_answer() {
    let site = Site::start();
    let Some((_fixture, mut client, _)) = real_client(&site, "/question") else {
        return;
    };
    let question = site.url("/question");
    client.until("the question page", |known| known.at("asked", &question));
    client.send(json!({"type": "control", "on": true}));
    client.tap(200, 100);
    client.until("the dialog", |known| known.dialogs.len() == 1);
    assert_eq!(client.known.dialogs[0]["kind"], "confirm");
    assert_eq!(client.known.dialogs[0]["message"], "Delete everything?");
    // The relay's reading goes on while the page waits, and the page has not moved on.
    client.send(json!({"type": "tabs"}));
    client.until("the list while it waits", |known| {
        known.at("asked", &question)
    });
    client.send(json!({"type": "answerDialog", "accept": true}));
    client.until("the answer", |known| {
        known.at("answer=true", &question) && known.dialogs_closed == 1
    });
    client.relay.stop();
}
