# Host browser feasibility measurements

Status: evidence for the [host browser design](../host-browser.md), umbrella
[#1250](https://github.com/mihazs/lazysh/issues/1250). Measured on 2026-11-11 on one development host.
Nothing here is released behavior. It answers one question: can lazysh show and control the host's
Chrome and Firefox from a phone, and at what cost.

## Answer

| | Chrome / Chromium (DevTools Protocol) | Firefox (WebDriver BiDi) |
| --- | --- | --- |
| Live frames | Yes. Push screencast: 60 frames per second on loopback and through an SSH tunnel, sent only when the page changes. | Yes, by polling screenshots. No push screencast: the BiDi `startScreencast` command writes a video file on the host and delivers no frames. |
| Input | Mouse, touch (including two-finger pinch), wheel, key events, `insertText` and IME composition. Long press needs a right click. | Pointer (touch and mouse), wheel and key actions. No text insertion or composition: one key action per character. No page pinch in the probe. |
| Tabs and navigation | Yes (`Target`, `Page`). | Yes (`browsingContext`). |
| Needs a debug flag at launch | Yes, `--remote-debugging-port` or `--remote-debugging-pipe`. | Yes, `--remote-debugging-port`. |
| Socket-free mode | Yes, `--remote-debugging-pipe`. | No. |
| Attach to the user's running browser | Only by restarting it with the flag (Chrome 136 or newer ignores the flag on the default profile) or, on Chrome 144 or newer, by the user's approval on the host. | Only by restarting it with the flag. A running instance ignores it. |
| Concurrent clients | Several. | One session. A dropped client blocks all later ones until Firefox exits. |
| Cost on the host (this machine) | 41 percent of one core at 60 fps, 185 MB. | 73 percent of one core polled at 60 fps, 520 MB. |

Both are feasible. Chrome is the first target because it streams frames by itself and has a socket-free
mode. Firefox needs a polling relay and a session guard, and is a later milestone.

## Machine and method

- One Linux x86_64 development host with 24 cores. Chromium 156.0.8078.79 (Arch Linux build) in
  `--headless=new`, Firefox 159.0.1 in `--headless`. Client scripts ran in Bun 1.3.14 using its built-in
  WebSocket.
- Every browser used a throwaway profile directory under `/tmp`, started by the script and deleted
  afterwards. No real browser profile, running browser, cookie store, history or saved password was touched or
  read; the host's own Firefox kept running untouched in a separate process. One probe called the BiDi
  `storage.getCookies` command against the empty throwaway Firefox profile only to see whether the command
  exists (it answered with an empty list).
- The SSH path was a real OpenSSH: a throwaway `sshd` on a random loopback port with key authentication and its
  own host key, and `ssh -L` forwarding a local port to the browser's loopback debug port. This is the same
  hop that `direct-tcpip` adds in the app, except that the app's Rust client does not need a local listener.
- Phone links were simulated by a user-space proxy between the client and the SSH-forwarded port. It delays
  each direction by a fixed one-way time and caps the rate, in strict order. Three profiles: Wi-Fi-like
  (10 ms round trip, 50 Mbit/s), LTE-like (40 ms, 20 Mbit/s) and poor (150 ms, 1.5 Mbit/s). These are
  models, not recordings of a real network.
- Fixture page, 412 by 915 CSS pixels at device scale factor 1:
  **scroll** is a long white text page that scrolls by itself (the heaviest realistic page),
  **busy** is a full-viewport canvas with a moving gradient and 60 circles, and **static** is a page that
  only changes when tapped. The same page served from a Bun loopback server.
- Frame sizes below are the encoded image bytes. On the wire, DevTools frames are base64 inside JSON, which is
  about 33 percent larger.
- A measurement is a single run of 5 to 6 seconds, not a statistical study. Differences of a few percent are
  noise.

## Chrome streaming

`Page.startScreencast` is marked experimental in the protocol. It accepts `format` (`jpeg` or `png`),
`quality`, `maxWidth`, `maxHeight` and `everyNthFrame`; Chromium 156 also lists `maxFramesInFlight` and
`sendLastFrame`. Each `Page.screencastFrame` event must be acknowledged with `Page.screencastFrameAck`
before more frames arrive.

Loopback directly and through the SSH tunnel (no simulated link):

| Page | Encoding | Direct | Through SSH | KB per frame | Payload, direct |
| --- | --- | --- | --- | --- | --- |
| scroll | JPEG q60, every frame | 59.6 fps | 59.8 fps | 67.3 | 32.8 Mbit/s |
| busy | JPEG q60, every frame | 60.0 fps | 60.0 fps | 14.6 | 7.2 Mbit/s |
| busy | JPEG q35, every frame | 59.8 fps | 55.6 fps | 10.9 | 5.3 Mbit/s |
| busy | JPEG q60, every 3rd frame | 20.0 fps | 20.0 fps | 14.6 | 2.4 Mbit/s |
| busy | PNG, every frame | 59.4 fps | 59.4 fps | 340 | 165 Mbit/s |
| static | JPEG q60 | 1 frame when nothing changes | | 4 | idle is free |

- The SSH hop itself cost nothing visible at this rate: a protocol round trip rose from 0.09 ms to 0.13 ms.
- Frames are produced only when the page changes. An idle page costs one frame and no bandwidth.
- PNG is unusable on a phone link. Quality 35 against 60 saved about 25 percent.
- Frames come at CSS size. With a device scale factor override the screencast stayed 412 by 915 while
  `Page.captureScreenshot` returned 824 by 1830. A sharp frame needs `--force-device-scale-factor` at launch,
  or a `captureScreenshot` once the page is idle.
- Through the simulated links, scroll page, JPEG:

| Link | q60, every frame | q40, every 3rd frame | q35, 309 by 686, every 6th frame | Protocol round trip |
| --- | --- | --- | --- | --- |
| Wi-Fi-like, 10 ms, 50 Mbit/s | 49.1 fps, 27.1 Mbit/s | 20.0 fps, 8.8 Mbit/s | 9.8 fps, 2.3 Mbit/s | 10.3 ms |
| LTE-like, 40 ms, 20 Mbit/s | 35.2 fps, 19.4 Mbit/s | 19.9 fps, 8.7 Mbit/s | 9.9 fps, 2.4 Mbit/s | 46 ms |
| Poor, 150 ms, 1.5 Mbit/s | 2.9 fps, 1.6 Mbit/s | 3.7 fps, 1.6 Mbit/s | 6.3 fps, 1.5 Mbit/s | 152 ms |

  On the first two links the frame rate follows the requested rate until the rate cap is reached. On the poor
  link every configuration filled the 1.5 Mbit/s cap, so the frame rate was set by bytes per frame, not by the
  round trip. The lesson is that frame size, quality and rate are the levers, and that a text-heavy page at full
  rate needs 27 to 33 Mbit/s.
- Tap to visible change (24 taps per link, mean image brightness crossing a threshold in the next frame):

| Link | Median | 95th percentile |
| --- | --- | --- |
| Loopback directly | 17.3 ms | 25.3 ms |
| Loopback through SSH | 16.6 ms | 24.2 ms |
| Wi-Fi-like | 49.9 ms | 137 ms |
| LTE-like | 95 ms | 98 ms |
| Poor (19 of 24 taps seen in the window) | 319 ms | 330 ms |

  The script awaited the mouse press before sending the release, so each figure includes two sequential round
  trips. A tap sent as press and release without waiting should save one round trip; that is derived, not
  measured. A loopback tap costs one display refresh (16.7 ms).
- `Page.captureScreenshot` as a fallback: 30.8 frames per second on loopback (33 ms each, 5.3 KB for the
  static page), 19.9 on the LTE-like link and 5.4 on the poor link. Tap to visible change by polling: 44 ms on
  loopback, 158 ms on the LTE-like link, 490 ms on the poor link.
- **Hidden tabs do not stream.** With two tabs, the background tab produced 1 frame in 1.5 seconds against 90
  in the foreground, and the protocol reports `Page.screencastVisibilityChanged`. A viewer shows one tab at a
  time, and switching tabs means `Target.activateTarget`, which also switches the tab a person at the host sees
  in a headed window.
- Chrome's address bar and tab strip are not in the frames. The screencast is the page content only, so lazysh
  draws its own address bar and tab list.

## Chrome input and tabs

Probed on a page with mobile emulation and touch emulation on.

| Action | Result |
| --- | --- |
| Tap by `Input.dispatchMouseEvent` press and release | Works. 24 of 24 toggles seen. |
| Tap by `Input.dispatchTouchEvent` | Works and focused an input field. |
| Mouse wheel, `deltaY` 500 | Page scrolled 408 px after 0.5 s (smooth scrolling still in progress). |
| One-finger touch drag of 400 px | Page scrolled 420 px. |
| `Input.synthesizeScrollGesture` (experimental), 300 px | Page scrolled 426 px. |
| Two-finger spread by `Input.dispatchTouchEvent` | Visual viewport scale 1 to 5 (the page's maximum). |
| `Emulation.setPageScaleFactor(2)` | Scale 2. |
| `Input.synthesizePinchGesture` (experimental) | No change in this run. |
| Control and wheel | No zoom. |
| Touch held 700 ms | No `contextmenu` event. |
| Right-button mouse click | `contextmenu` event fired. Long press must map to a right click. |
| `Input.insertText` of `hello éç 世界 😀` | Typed exactly, 16 ms in one call. The protocol describes it as inserting text "that doesn't come from a key press, for example an emoji keyboard or an IME"; a page's key handlers are not exercised by it (not tested). |
| `Input.dispatchKeyEvent` with `text` | Typed the character. Backspace and Enter key events worked and the page saw `Enter`. |
| `Input.imeSetComposition` then `insertText` | Typed the composed character 你. |

Tabs and navigation: `Target.getTargets` lists pages with title and URL (filter to type `page`; a fresh
Chromium profile also reported a built-in extension background page). `Target.createTarget`, `closeTarget` and
`activateTarget` work. `Page.getNavigationHistory` plus `navigateToHistoryEntry` went back, and `Page.reload`
worked. `navigator.webdriver` was `true` in the page, so sites that refuse automated browsers may refuse the
page or a sign-in; that is a real limit for OAuth flows and is not worked around by default.

## Chrome host cost and startup

Same process tree of 11 processes, animated page unless stated:

| State | CPU, share of one core | Memory (PSS) |
| --- | --- | --- |
| Idle static page | 0 percent | 164 MB |
| Screencast of an idle page | 0 percent | 167 MB |
| Animated page, no screencast | 13 percent | 176 MB |
| Screencast at 60 fps | 41 percent | 185 MB |
| Screencast at about 20 fps, 309 by 686, q40 | 26 percent | 193 MB |

Cold start of a fresh profile to a usable debug endpoint: 130 to 136 ms. A browser per session is cheap enough
to start on demand and stop when the session ends.

## Chrome security observations

| Property | Observed on Chromium 156 |
| --- | --- |
| Listening address | `--remote-debugging-port=0` bound `127.0.0.1` only, on a random port. The port and the browser path are written to `<profile>/DevToolsActivePort` and printed on stderr. |
| No socket at all | `--remote-debugging-pipe` opened no TCP listener on the browser process. The browser reads commands on file descriptor 3 and writes on 4, NUL-delimited. Round trip 0.1 ms, 59.5 fps screencast, 9.4 Mbit/s on the wire for the busy page. |
| Authentication | None. The browser id in the URL (`/devtools/browser/<uuid>`) is the only secret, and `GET /json/version` and `/json/list` on the same port return it, and every page's debug URL, to anyone who can connect. A wrong id was refused. |
| Host header | Anything that is not an IP address or `localhost` got HTTP 500 ("Host header is specified and is not an IP address or localhost"). This is the DNS-rebinding defense. Any IP literal, including `10.0.0.5`, was accepted. |
| WebSocket Origin | Any request with an `Origin` header was refused, including `http://127.0.0.1:<port>` and an unrelated site. Requests without an `Origin` were accepted. `--remote-allow-origins` is the opt-in allow list. |
| Creating targets over HTTP | `GET /json/new` was refused (405); it needs `PUT`. |
| Other local users | Loopback is reachable by every account on a shared host. On such a host the port needs no password to drive the browser. The pipe mode has no such exposure. |
| Default profile | On a stable Google Chrome 136 or newer, `--remote-debugging-port` and `--remote-debugging-pipe` are ignored for the default user data directory, so a custom `--user-data-dir` is required ([Chrome for Developers](https://developer.chrome.com/blog/remote-debugging-port)). The Chromium 156 build used here still honored the flag on a default directory; this was tried only under an empty fake `HOME`, never against a real profile. |

## Firefox streaming and input

Firefox 159 runs the BiDi server behind `--remote-debugging-port`. `firefox --headless --no-remote --profile
<dir> --remote-debugging-port 0 about:blank` printed `WebDriver BiDi listening on ws://127.0.0.1:<port>` and
reached that state in 411 to 412 ms. The Chrome protocol is no longer available in Firefox.

- **No push screencast.** `browsingContext.captureScreenshot` returns one base64 image per call. The BiDi
  specification lists `browsingContext.startScreencast`, and Firefox 159 accepted it, but the specification
  and the probe agree that it records a video file to a folder on the host and returns its path, with no frame
  events. The probe call wrote a WebM file into the user's Downloads folder, which was deleted. It must never be
  called by lazysh: it writes to disk and gives no frames.
- Sequential screenshots (request, wait, request) of the scroll page at JPEG 0.6: 99 per second on loopback and
  149 per second through SSH, 67.8 KB each, of which about 60 per second were different (the page changes 60
  times a second; the rest were repeats). Lower quality 0.3 gave 47.8 KB and PNG 107 KB. On the busy page, 17.1
  KB at 0.6 and 12.8 KB at 0.3.
- Through the simulated links, sequential screenshots are limited to one per round trip:

| Link | Sequential fps, JPEG 0.4, scroll page | Pipelined 3 deep | Pipelined 6 deep |
| --- | --- | --- | --- |
| Wi-Fi-like | 32.9 (14.8 Mbit/s) | not measured | not measured |
| LTE-like | 12.4 (5.6 Mbit/s) | 57 (3.8 Mbit/s) | 115 (7.6 Mbit/s) |
| Poor | 1.8 (0.8 Mbit/s) | not measured | not measured |

  The pipelined figures were taken on a static page, so almost every shot was a repeat and they show only that
  pipelining hides the round trip (one request in flight gave 19 per second there). A relay must pipeline
  requests, compare frames, skip repeats and pace itself to the link.
- Tap to visible change by polling (touch pointer): 9 ms on loopback, 33 ms Wi-Fi-like, 97 ms LTE-like, 389 ms
  poor. Each of the 14 taps per run reached the page exactly once.
- Input through `input.performActions`: touch and mouse pointers, a wheel action and key actions all worked. A
  15-character string went in one call in 12 ms. `hé 世界 😀` was typed key by key, with Backspace as the key
  value U+E003. There is no `insertText` and no composition. A wheel delta of 600 moved the page 444 to 606 px
  depending on smooth scrolling. A mouse right click produced a context menu; a held touch did not. Two touch
  pointers spreading did not change the page scale in the headless probe, so page pinch is not available. A
  headed run was not tried.
- Tabs: `browsingContext.getTree` returns contexts with their URL and no title, so a title takes one
  `script.evaluate` of `document.title` per tab. `create`, `close`, `activate`, `navigate`, `reload` and
  `traverseHistory` worked. A screenshot of a non-active tab succeeded in headless mode.

## Firefox host cost

Same 11-process tree, animated page unless stated:

| State | CPU, share of one core | Memory (PSS) |
| --- | --- | --- |
| Idle static page | 0 percent | 468 MB |
| Static page, screenshots polled at 20 per second | 13 percent | 468 MB |
| Animated page, no capture | 14 percent | 476 MB |
| Animated page, polled at 20 per second | 32 percent | 521 MB |
| Animated page, polled at 60 per second | 73 percent | 522 MB |

## Firefox security observations

| Property | Observed on Firefox 159 |
| --- | --- |
| Listening address | `127.0.0.1` only, random port with port 0. Mozilla's documentation says the server accepts only loopback hosts ([Remote Agent security](https://firefox-source-docs.mozilla.org/remote/Security.html)). |
| Authentication and encryption | None, as documented. |
| Host header | Must be an IP address or loopback name **and carry the real port**. `Host: 127.0.0.1` without a port, with another port, a non-loopback IP and an unrelated name were refused (HTTP 400). Through an SSH forward on a different local port, the client has to send the remote port in `Host` itself. A web view cannot set that header. |
| Origin | Any request with an `Origin` header was refused, including the server's own origin. `--remote-allow-origins` and `--remote-allow-hosts` add exceptions. |
| One session | `session.new` failed with "Maximum number of active sessions" while another session existed. A client that closed its WebSocket without sending `session.end` left the session in place; a second client still failed 1, 5 and 15 seconds later. `session.end` freed it. |
| Reach | A connected client can read every secret the browser holds, including cookies, which Mozilla states plainly. By default commands reach web content only; `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1` removes that limit and must never be set. |
| No socket-free mode | There is none. |

## Attaching to the user's normal profile

Not tried against any real profile, by design. What is known:

- A debug flag is only read at startup. Attaching to a running Chrome or Firefox means closing it and starting
  it again with the flag. All its windows go away, and sessions come back only if the browser restores them.
- Turning the port on gives its holder the profile: cookies, signed-in sessions, saved sites, history, every tab.
  Both Chrome and Firefox state this. Chrome 136 changed the default profile to ignore the flag precisely
  because attackers used the port to steal cookies.
- Chrome 144 added an approval-based mode: the user ticks a box at `chrome://inspect/#remote-debugging` and
  Chrome shows an "Allow remote debugging?" dialog for each new connection
  ([chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md)).
  The dialog is on the host's screen, so a person away from the host cannot approve it. Not verified here.
- Firefox has no equivalent of the approval mode.

## Not verified

- A real phone. Rendering, decode speed, battery and the on-screen keyboard behavior in the app's web view were
  not measured. All client numbers come from a desktop Bun process.
- A real mobile network. The three links are simulated.
- Headed browsers. The host had no display server, so only `--headless=new` was measured. Frame production in a
  headed window that is minimized or covered by another window is untested. `--ozone-platform=headless` gave the
  same 60 fps and is not a headed run.
- macOS and Windows hosts, and other Chromium builds (Google Chrome stable, Edge, Brave).
- Pinch in headed Firefox, and Firefox on Android.
- The user's normal profile, in either browser, and the Chrome 144 approval mode.
- Whether a sign-in flow that rejects automated browsers can be completed.
- A statistical confidence interval for any figure. They are single short runs.

The scripts that produced these figures were kept outside the repository. The repeatable part is the
prototype's CI test described in the [design](../host-browser.md#prototype).
