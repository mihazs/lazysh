# Host browser

Status: specification. Tracked by the umbrella [#1250](https://github.com/mihazs/lazysh/issues/1250) and its
slice issues [#1254](https://github.com/mihazs/lazysh/issues/1254) to
[#1259](https://github.com/mihazs/lazysh/issues/1259) on the
[GitHub Project](https://github.com/users/mihazs/projects/2). Nothing here is released until the slice that
implements it ships. Measurements behind every number in this page are in
[Host browser feasibility measurements](reference/host-browser-feasibility.md).

The **Host browser** tool shows a Chrome, Chromium or Firefox that the app starts on the connected host as a
live view on the device, and forwards taps, scrolling, keys and text to it. It is for the pages an agent or a
developer opens on the host that a person must see or drive: an OAuth consent screen, a login page, a
dashboard, a local preview that needs a real browser. It sits beside [Preview](previews.md), which forwards a
dev server's port to the device and renders it there. Preview shows what a service on the host serves; the Host
browser shows what a browser on the host displays.

## Requirements

Functional:

1. **See.** A live view of one page of a browser on the host, usable on a phone, with a visible state
   (connecting, live, paused, closed, failed).
2. **Control.** Tap, long press, scroll, pinch and the phone keyboard act on the page. Control is a separate
   switch, off until the user turns it on.
3. **Navigate.** Address bar, tab list, back, forward, reload, and an **Open on this device** action.
4. **Both families.** Chrome and Chromium first, Firefox second, behind one client contract with a capability
   record so the client hides what an adapter cannot do and says why.
5. **Fit the network.** Adaptive frame rate and quality, and no frames while the view is hidden.

Security and data (each is tested, not only stated):

6. **Opt-in per host.** Off by default. Nothing is spawned and no port is opened until the user turns it on and
   confirms.
7. **Dedicated browser.** The app starts the browser itself with a throwaway profile. It never turns on remote
   debugging in a browser the user already runs, and never restarts or stops one.
8. **No network exposure.** The debug endpoint is reachable only through the SSH connection. Nothing listens on
   a routable address on the host or on the device.
9. **Bounded lifetime.** The browser and its profile end with the session, the SSH channel or the app.
10. **No persistence by the app.** Page content, URLs, titles, cookies and frames are not stored in app
    storage, sync, logs or crash reports.
11. **Off by default: clipboard, file transfer, downloads, permission prompts.**
12. **Honest limits.** The page says what the browser on the host can reach and what the feature will not do.

## Decisions

| Question | Decision | Why |
| --- | --- | --- |
| How is the browser started? | The app starts it, with a dedicated, ephemeral profile and a debug flag. | A debug flag is read only at startup; a browser the user already runs cannot be attached to without restarting it, and the port gives its holder every signed-in session. |
| How does Chrome reach the client? | A host companion relay on one SSH exec channel, talking to Chrome over `--remote-debugging-pipe`. | No listening socket exists on the host at all. The debug port has no authentication and every local account on the host can use it (measured). |
| How does Firefox reach the client? | The same relay, talking BiDi to a loopback port the relay alone uses. | Firefox has no pipe mode. The relay hides its one-session limit, its exact `Host` header rule and its lack of push frames. |
| Does the client open the debug port? | No, in the product. Yes, in the flagged prototype only. | The client is a web view; it cannot set `Host`, and it sends an `Origin` that both browsers refuse unless widened. The prototype widens it for one exact origin to prove the forwarded-loopback path. |
| Frames | JPEG, length-prefixed binary on the channel, acknowledged after decode. | PNG was 340 KB per frame against 15 KB for JPEG (measured). Base64 inside JSON costs 33 percent. |
| Input | A fixed set of relay operations that map onto each browser's input commands. | The phone never sends a raw protocol command. |
| Normal profile | A separate, advanced, warned option, not in the first release. | See "Attaching to the normal profile". |

## Opt-in and launch model

### Switches and confirmation

- A host setting **Host browser** is off by default, beside the three companion switches in
  [Host settings](companion-settings.md). It is the only companion switch that defaults to off, because it is
  the only one that can reach the user's web sessions. While off, every host-browser command fails before it
  starts a process. Slice [#1258](https://github.com/mihazs/lazysh/issues/1258) decides how the settings schema
  gains the field without breaking a released client.
- The first use on a host shows what the browser can reach: the host's network and loopback services, any
  file the browser can open, and every site the user signs in to inside it. The user confirms per host. The
  confirmation is remembered on the device for that host only, never synced.
- **Control** is a second switch per session, off at every start.

### Managed browser (default)

| Property | Value |
| --- | --- |
| Binary | Found on the host's `PATH` or named by an explicit path: Google Chrome, Chromium, Firefox. The version is read from the browser and compared with the supported range; an unsupported version is named, never guessed. |
| Profile | New private directory (mode 0700), no extensions, removed when the browser stops. Removed at the next start if a crash left one, matched by a marker with the owner's pid. |
| Mode | Headless by default: nothing appears on the host's screen. **Headed** is an explicit choice for a host with a display; it shows a window to anyone at the host and switching tabs changes what they see. |
| Flags | Chrome: `--headless=new --remote-debugging-pipe --user-data-dir=<private> --no-first-run --no-default-browser-check`. Firefox: `--headless --no-remote --profile <private> --remote-debugging-port 0`. `--remote-allow-origins=*` and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS` are never used. |
| Lifetime | Starts when the user opens the tool, stops when the user closes it, the SSH channel closes, the session ends or the companion exits. An idle timer stops it after a configurable time. |
| Start cost | 130 ms (Chromium) and 410 ms (Firefox) to a usable endpoint, so on demand is cheap. |

**Keep profile** is an explicit option for flows that need a sign-in to survive (it keeps cookies on the host's
disk until **Clear browser data**). It is off by default and labelled with what it stores.

### Attaching to the normal profile

A separate screen, never the default path, and not part of the first release. It exists for a user who must see
the browser they are already signed in to. It requires, and the page says plainly:

- Restarting the browser with a debug flag. A browser reads the flag only at startup; a running Firefox ignores
  it, and Chrome 136 or newer ignores it on its default profile. The app never restarts or stops a browser; the
  user does that on the host, and the app only connects to a loopback endpoint the user started.
- That whoever can reach the endpoint then holds the profile: cookies, signed-in sessions, history and every
  tab. Both browsers state this in their documentation.
- Chrome 144 or newer has an approval mode (a checkbox in `chrome://inspect` plus an "Allow remote debugging?"
  dialog per connection on the host's screen). It cannot be approved from the phone. It is investigated in
  slice #1258 and not assumed.

## Threat model

Assets, in order of weight: the web sessions in the profile the browser uses; what the host's network lets a
browser on the host reach (loopback admin pages, internal sites, cloud metadata endpoints); local files a
browser can open; the user's phone.

Trust boundaries:

```text
 phone app (trusted) ──SSH, encrypted and host-key pinned──▶ companion relay (trusted, same user as the browser)
                                                                │  pipe (Chrome) or host loopback port (Firefox)
                                                                ▼
                                           managed browser ──▶ web pages and the network (untrusted)
```

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| A page tries to attack the app | The app displays decoded images only. URLs, titles, dialog text and tab names are untrusted text, rendered as text. Frames are bounded in size and rate and decoded off the main flow. No page content reaches a web view as HTML. | A decoder bug in the device's JPEG stack. |
| A remote website attacks the debug endpoint from the host's own browser (DNS rebinding, cross-site request) | Chrome refuses a `Host` that is not an IP address or `localhost` and any `Origin` not in an allow list; Firefox refuses any `Origin` and a `Host` without its port (all measured). The managed browser sits behind the relay, so nothing that is not the relay connects. | None known beyond the next row. |
| Another account on the host drives the browser through the loopback port | Chrome uses the pipe: no socket exists. Firefox has no pipe, so its loopback port is used by the relay for the session's lifetime only, on an unpredictable port. | On a shared host a local user can still reach Firefox's port during a session. The first-use confirmation names this; slice #1258 evaluates refusing Firefox when other interactive accounts are present. |
| The debug endpoint is left open | Bounded lifetime (requirement 9) and tests that kill the SSH channel, the companion and the app and then check for the process, the port and the profile. | A kill of the companion and the browser together leaves a profile for the next start to remove. |
| The phone drives the browser into the host's network (SSRF-like) | The user already has an SSH shell on the host. The risk is a compromised or malicious phone app or a pasted link. Typed navigations are limited to `http`, `https` and `about:blank`; `file:`, `chrome:`, `view-source:`, `javascript:` and `data:` are refused. A confirmation names the host for private ranges, loopback and link-local addresses. | The browser can reach whatever the host can; this is stated in the first-use confirmation. |
| Cookies and sessions are read through the protocol | The relay exposes a closed operation set; the protocol's cookie, storage, evaluate and download-behavior commands are not on it. The profile is ephemeral by default. | Anything on the page itself can be seen in frames, as for a person at the host. |
| Typed secrets are captured | Text goes phone to relay to browser in memory over SSH. It is never logged or stored. The text field sets no-suggestions and no-learning keyboard hints; password fields are detected best-effort. | The phone keyboard's own policies. |
| A site refuses or traps an automated browser | The page sees `navigator.webdriver` true (measured); sign-in providers may refuse it. Not worked around by default. | OAuth flows against such providers can fail. |
| A compromised relay or companion | It runs as the user and could start any process anyway. | Equal to the companion's existing trust. |

Not in scope: defending a browser the user started themselves, and a host an attacker already controls.

## Architecture

```text
 device                                            host
 ┌──────────────────────────┐   SSH exec channel   ┌──────────────────────────────────────────────┐
 │ HostBrowser view         │◀────────────────────▶│ lazysh-agent host-browser serve              │
 │  canvas, controls        │  JSON control +      │  adapter: ChromePipe | FirefoxBidi           │
 │  pointer/keyboard mapper │  binary JPEG frames  │  allow-list · pacing · profile cleanup       │
 └────────────▲─────────────┘                      └───────────────┬──────────────────────────────┘
              │ Tauri IPC (pull, like device streams)             pipe fd 3/4 or 127.0.0.1:<random>
        host_browser_start / next / input / stop                     ▼
                                                      Chrome / Chromium / Firefox, dedicated profile
```

### Reuse of existing machinery

| Existing piece | Used for | Not used for |
| --- | --- | --- |
| Companion command on one SSH exec channel that stops when its input closes (`account-usage --watch-channel`; the planned transcript watch) | The relay's lifetime and the guarantee that a dropped SSH connection stops the browser. | |
| The Devices tool's companion-to-client frame path and `device_stream_*` pull commands, with its input enable switch | The frame pipeline, back-pressure by pull, and the per-session control switch. | |
| Access lease and cleanup on lock, disconnect and session end in `previews.rs` | The same guards and the same per-session and per-app limits (one browser per session, two per app). | |
| Preview's `direct-tcpip` forward to a host loopback port and its sandboxed frame | **Open on this device** for a loopback URL, and the flagged prototype's connection. | The product's browser view. A device loopback listener is reachable by other apps on the device, and a web view cannot set `Host` or hide its `Origin`. |
| Capability and version gate from [Multiplexer compatibility](multiplexer-compatibility.md) | The adapter capability record and its version table. | |

New Tauri commands need entries in the permission manifest (`build.rs`) and the main capability, as every
command does.

### Relay protocol

Client and relay exchange a small, versioned, closed set of messages. A frame is a binary message with a short
header (sequence, width, height, scroll offset, timestamp), so the client never parses a base64 string.

| Direction | Message | Notes |
| --- | --- | --- |
| client to relay | `open {browser, headed, viewport}` | Starts the managed browser; the reply carries the capability record. |
| client to relay | `navigate {url}`, `back`, `forward`, `reload`, `stop` | `url` limited to `http`, `https`, `about:blank`. |
| client to relay | `tabs`, `activateTab {id}`, `newTab`, `closeTab {id}` | Pages only. |
| client to relay | `ack {sequence, decodeMs}` | After the device decoded a frame. |
| client to relay | `quality {rung}`, `pause`, `resume` | Pause when hidden. |
| client to relay | `pointer {kind, x, y, ...}`, `wheel`, `pinch`, `key`, `text` | Accepted only while Control is on. |
| relay to client | `frame`, `state`, `tabs`, `dialog {kind, text}`, `closed {reason}` | Page strings are untrusted text. |

Everything else is dropped with a counter, and the browser's protocol is not otherwise reachable.

### Adapters and capabilities

| Capability | Chrome / Chromium adapter | Firefox adapter |
| --- | --- | --- |
| Frames | `Page.startScreencast`, acknowledged by the relay, on change only | `browsingContext.captureScreenshot` polled, pipelined 2 to 3 deep, repeats skipped |
| Pointer | `Input.dispatchMouseEvent`, `dispatchTouchEvent` | `input.performActions` |
| Scroll | wheel events | wheel action |
| Pinch | two-point touch events or `Emulation.setPageScaleFactor` | local zoom of the frame only |
| Text | `Input.insertText`, key events, IME composition | one key action per character, no composition |
| Tabs | `Target.getTargets`, `createTarget`, `activateTarget`, `closeTarget` | `browsingContext.getTree`, `create`, `activate`, `close`, titles by `document.title` |
| History | `Page.getNavigationHistory`, `navigateToHistoryEntry`, `reload` | `traverseHistory`, `reload` |
| Socket-free | yes (pipe) | no |
| Concurrent clients | several (the relay allows one) | one session, owned and always ended by the relay; a leaked one is cleared by restarting the owned browser |

## Input mapping for a phone

| Phone gesture | Page effect | Detail |
| --- | --- | --- |
| Tap | Click at the mapped point | Position = touch point scaled by the frame's device size and offset by its scroll offset. Press and release are sent back to back, so a tap costs one round trip. A tap within 10 px and 300 ms of the last is a double click. |
| Long press (500 ms) | Right click | A held touch produced no context menu in either browser (measured); a right click did. |
| One-finger drag | Scroll | Wheel events, coalesced to the frame rate. The relay never assumes 1:1 distance; smooth scrolling moved 400 to 500 units into 408 to 606 px (measured). |
| **Select** mode drag | Mouse drag | Text selection and sliders. A toggle, off by default. |
| Two-finger pinch | Local zoom now, page zoom on **Zoom page** | Local zoom is immediate and costs nothing; page zoom uses page scale on Chrome. Firefox offers local zoom only. |
| Phone keyboard text | Insert at the focused element | Chrome: `insertText` for composed and non-Latin text, key events for Enter, Backspace, Tab, arrows, Escape and chords. Firefox: key by key. |
| **Keyboard** button | Raises the phone keyboard | Needed because the view has no native text field. |
| Hover | Not offered | A phone has no hover. A long press then move, or **Select** mode, reaches hover menus. |

While Control is off, none of this is sent; the client proves it in a test.

## Controls

- **Address bar** shows the current URL and takes a new one. A typed string without a scheme becomes `https://`.
  `javascript:`, `data:`, `file:`, `chrome:` and `view-source:` are refused with a reason.
- **Tabs** list the pages the browser has, with title and URL as text, and switch, open and close them. Popups
  a page opens appear as tabs. Only the active tab streams (a background tab produced no frames, measured).
- **Back, forward, reload, stop** from the browser's own history.
- **Open on this device**: a loopback URL on the host opens as a [Preview](previews.md); another URL opens in
  the phone's browser after a confirmation that names the host. A URL is never opened without that tap.
- **Dialogs**: an alert, confirm, prompt or leave-page question appears as a native dialog with the page's text
  marked untrusted. **Downloads**, **permission prompts** and **file choosers** are denied and reported once.
- The browser's own address bar and tab strip are not in the frames (a screencast is the page only), so these
  controls are lazysh's.

## Performance

Measured on this project's development host; see the
[measurements](reference/host-browser-feasibility.md#chrome-streaming) for method and limits.

| Facts | Value |
| --- | --- |
| Scrolling text page, JPEG q60, 412 by 915, 60 fps | 67 KB per frame, 33 Mbit/s |
| Animated page, JPEG q60, 60 fps / 20 fps | 7.2 / 2.4 Mbit/s |
| Idle page | one frame, then nothing |
| Tap to visible change, loopback / Wi-Fi-like / LTE-like / poor | 17 / 50 / 95 / 319 ms |
| Host cost at 60 fps | Chrome 41 percent of a core, Firefox 73 percent |

Design from those facts:

- **Quality ladder.** High, balanced, low and minimal, each a JPEG quality, a frame size and a frame divisor
  (for example q60 full size every frame, q40 every 3rd frame, q35 at 75 percent size every 6th frame). The
  relay measures goodput and the acknowledgement time, steps down within a second and steps up after ten stable
  seconds. A **Data saver** option pins the lowest rung.
- **Acknowledge after decode.** The device's decode time is part of back-pressure, so a slow phone gets fewer
  frames instead of a growing queue.
- **Pacing on the host.** The relay acknowledges the browser at once and holds only the newest frame for the
  device, so the link's round trip never throttles the browser. On Firefox it pipelines polls and drops repeats.
- **Interaction boost.** Full rate for two seconds after input, then back to the ladder.
- **Sharpen when idle.** A single high-quality still when the page stops changing, because a screencast is
  produced at CSS size.
- **Pause when hidden.** No frames when the view is not visible, the app is in the background or the screen is
  off; the browser is released after the idle time.
- **Host budget.** A streaming browser stays under one core at the highest rung, with at most one browser per
  session and two per app.

## Data handling

- Frames live in memory for decoding and are dropped. They are not written to disk, the app database, sync, logs
  or crash reports, and there is no screenshot or recording feature.
- URLs, titles, dialog text and tab names are never written to app storage or logs. Errors name an operation and
  a reason, not a page.
- The only per-host memory is "the user confirmed on this host", on the device, not synced.
- Clipboard in either direction, file upload and download, and the file chooser are off by default. Turning any
  on is a separate decision with its own page, not part of the first release.
- The managed profile is ephemeral. **Keep profile** and **Clear browser data** are the only ways cookies
  outlive a session, and they are explicit.
- Stored credentials in [Credentials](credentials.md) are never typed into the browser by the app.

## Milestones

| Milestone | Delivers | Issue | Ships to users |
| --- | --- | --- | --- |
| 1 | This specification, the feasibility measurements, and a developer-flagged Chrome prototype with a CI test (done) | [#1250](https://github.com/mihazs/lazysh/issues/1250) | No. Prototype off by default and hidden. |
| 2 | Opt-in gate, managed profile, lifecycle, limits | [#1258](https://github.com/mihazs/lazysh/issues/1258) slices A to C | With the viewer below |
| 2 | Chrome relay and viewer, view-only | [#1254](https://github.com/mihazs/lazysh/issues/1254) | Yes, off until enabled |
| 3 | Chrome input | [#1255](https://github.com/mihazs/lazysh/issues/1255) | Yes |
| 4 | Address bar, tabs, navigation, open on device | [#1256](https://github.com/mihazs/lazysh/issues/1256) | Yes |
| 5 | Adaptive rate and quality, pause when hidden | [#1259](https://github.com/mihazs/lazysh/issues/1259) | Yes |
| 6 | Firefox through BiDi | [#1257](https://github.com/mihazs/lazysh/issues/1257) | Yes |
| 7 | Normal-profile attach and the independent review | [#1258](https://github.com/mihazs/lazysh/issues/1258) slices D and E | Only after the review |

The user-facing slices each carry a CHANGELOG entry and a changeset, and each is released when it merges, as the
[contributing guide](../CONTRIBUTING.md#versioning-and-deprecation-policy) requires. Performance (milestone 5)
is scheduled before Firefox so that the ladder is designed once and the Firefox adapter is built to it.

## Prototype

Milestone 1 includes a prototype that proves the architecture and records latency. It is not the product and
ships no user-facing UI. It is in the repository as `apps/agent/src/host_browser.rs`,
`apps/client/src/hostBrowser/` and their tests.

- **Developer flag, off by default.** On the host, the hidden command `lazysh-agent host-browser` (not in
  `--help`) refuses to run unless `LAZYSH_DEV_HOST_BROWSER=1` is set. On the device, the viewer is a page that
  only the Vite development server serves at `/?hostBrowserDev=1`; a production build of the client does not
  contain it (checked by building and searching the output), and the normal app has no menu entry for it.
- **Host side.** `lazysh-agent host-browser [--url URL] [--allow-origin ORIGIN] [--headed] [--no-sandbox]`
  starts a Chrome or Chromium found on `PATH` (or `--binary`) with a private profile directory (mode 0700), a
  random loopback debug port, no sync and no background networking. It prints one JSON line,
  `{"schemaVersion":1,"port":…,"path":"/devtools/browser/…","pid":…,"profile":"…"}`, and waits. When its
  standard input closes, on SIGINT, SIGTERM or SIGHUP, or when the browser exits, it stops the browser's whole
  process group and deletes the profile. It refuses a first page that is not `http`, `https` or `about:blank`,
  and an `--allow-origin` that is not one exact origin (a wildcard or a list would let any page drive the
  browser). `--no-sandbox` exists only for containers and CI runners that cannot create a sandbox. If the launcher
  itself is killed with SIGKILL the browser is left behind: the product relay uses the pipe, which has no such
  gap.
- **Client side.** The viewer reaches `ws://127.0.0.1:<port>/devtools/browser/<id>`, the port forwarded over SSH
  (the Preview tool can forward a host port, or `ssh -L` can), draws screencast frames on a canvas,
  acknowledges each after decoding, and sends a tap (press and release together), typed text (`insertText`,
  so accents, CJK and emoji work) and Enter, Backspace, Tab and arrow keys. It sends only methods on a closed
  allow list and refuses an endpoint that is not a loopback browser path. It reports frames per second and the
  time from a tap to the first frame that changed.
- **Try it.** On the host, `LAZYSH_DEV_HOST_BROWSER=1 lazysh-agent host-browser --allow-origin
  http://127.0.0.1:1420 --url http://127.0.0.1:3000/`. Forward the printed port to the device, run the client
  with `bun run dev`, open `/?hostBrowserDev=1`, paste the `ws://` URL and choose **Connect**. The allowed
  origin is the viewer page's origin; the product needs none because its client is native.
- **Tests.** A launcher test with a fake browser (arguments, private profile, process-group and profile cleanup
  when input closes, refusals before anything starts), the same launcher against a real Chrome or Chromium
  where one is on `PATH` (the Ubuntu 24.04 hosted image has Chrome 156), a protocol-client unit test against an
  in-memory DevTools endpoint, and a Playwright test in which a real headless Chromium plays the host: the
  viewer must draw the fixture page, a tap must turn it blue, and typed accents and CJK must reach its input.
  The Playwright test runs in the existing `client` job on the browser the job already installs, and fails
  rather than skips when no browser is found.
- **What the tests do not cover.** A real SSH hop in CI, a real device, and a headed browser. The measurements
  below were made by hand with a real `ssh -L`.
- **Why a raw forward here, and not in the product.** The prototype uses a forwarded debug port because it
  needs no new relay, and the measurements show why it is not the shipped transport (no authentication on the
  port, exposure to every local account, and a web view that cannot set `Host`).

## What it will not do

- Attach to, restart or stop a browser the user already runs, or turn on remote debugging silently.
- Expose a debug port on the network, on a device listener in the product, or without SSH.
- Store, sync, log or upload cookies, page content, URLs, titles or frames, or record the screen.
- Give the phone raw DevTools, a JavaScript console, cookie or storage access, request interception or the
  DevTools frontend.
- Transfer the clipboard or files, accept downloads, grant permissions or open `file:` pages by default.
- Provide the host browser's own chrome: its address bar, tab strip, bookmarks, extensions, settings pages and
  password manager.
- Defeat sites that refuse automated browsers, or promise that an OAuth flow will complete.
- Stream audio or video calls, or support WebRTC capture, in the first releases.
- Control a desktop that is not a browser (use a remote desktop for that), or a headed window beyond its page
  content.
- Drive more than one page at a time, or share one browser between devices.
- Claim real-device, real-network or normal-profile behavior beyond what the
  [measurements](reference/host-browser-feasibility.md#not-verified) record.

## Open questions

- Whether to refuse Firefox while other interactive accounts exist on the host (slice #1258).
- How the settings file gains the new switch without breaking a released client (slice #1258).
- Whether a hosted-runner headed run (Xvfb) is worth adding once the relay exists.
- Whether Safari's remote automation has a place on macOS hosts. It is not investigated.

## References

- [Chrome DevTools Protocol](https://chromedevtools.github.io/devtools-protocol/): `Page.startScreencast`,
  `Input.dispatch*`, `Input.insertText`, `Target`.
- [WebDriver BiDi](https://w3c.github.io/webdriver-bidi/): `browsingContext`, `input`, `session`.
- [Firefox Remote Agent security](https://firefox-source-docs.mozilla.org/remote/Security.html).
- [Chrome: changes to remote debugging switches](https://developer.chrome.com/blog/remote-debugging-port).
- [Previews](previews.md), [Devices](devices.md), [Host settings](companion-settings.md),
  [Agent view](agent-view.md), [Multiplexer compatibility](multiplexer-compatibility.md).
