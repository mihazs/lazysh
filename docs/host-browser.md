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

A different, planned feature opens a page that a host program requested in the browser **on the device** and tunnels a sign-in's `localhost` callback to the host; it does not view the host's browser. See [ADR 0004](architecture/adr-0004-sso-localhost-tunnel-and-guest-browser.md).

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
   debugging in a browser the user already runs, and never restarts or stops one. The separate, later Attach
   screen only connects to an endpoint the user turned on.
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
| Does the client open the debug port? | No, in the product. Yes, in the flagged prototype only. | The client is a web view; it cannot set `Host`, it sends an `Origin` that both browsers refuse unless widened, and the app's Content Security Policy (`connect-src`) allows no loopback WebSocket. The prototype widens the origin for one exact origin and runs only in the Vite dev server, where no such policy applies, to prove the forwarded-loopback path. |
| Frames | JPEG, length-prefixed binary on the channel, acknowledged after decode. | PNG was 340 KB per frame against 15 KB for JPEG (measured). Base64 inside JSON costs 33 percent. |
| Input | A fixed set of relay operations that map onto each browser's input commands. | The phone never sends a raw protocol command. |
| Normal profile | A separate, advanced, warned screen that connects to an endpoint the user turned on, not in the first release. | A running browser reads its debug flag only at startup, so the app can never turn it on; Chrome 144 or newer lets the user do it with a box and a dialog on the host's screen that the phone cannot answer (measured). See "Attaching to the normal profile". |

## Opt-in and launch model

### Switches and confirmation

- A host setting **Host browser** is off by default, beside the three companion switches in
  [Host settings](companion-settings.md). It is the only companion switch that defaults to off, because it is
  the only one that can reach the user's web sessions. While off, every host-browser command fails before it
  starts a process. The field is not in `settings.json` (a strict file that a released companion or client would
  refuse): it has its own file, `host-browser.json`, and `settings host-browser show|update`, as the planned
  update policy does. See [the reference](reference/companion-settings.md). Shipped in the companion by slice A
  of [#1258](https://github.com/mihazs/lazysh/issues/1258); the app's switch and first-use confirmation are in host
  settings ([#1696](https://github.com/mihazs/lazysh/issues/1696)), and the viewer that uses them comes later.
- The first use on a host shows what the browser can reach: the host's network and loopback services, any
  file the browser can open, and every site the user signs in to inside it. The user confirms per host. The
  confirmation is remembered on the device for that host only, never synced.
- **Control** is a second switch per session, off at every start. The relay enforces it: while it is off every input
  message is refused and counted, whatever the client is, and it is off again when a session starts afresh.

### Managed browser (default)

| Property | Value |
| --- | --- |
| Binary | Found on the host's `PATH` or named by an explicit path: Google Chrome, Chromium, Firefox. The version is read from the browser and compared with the supported range; an unsupported version is named, never guessed. |
| Profile | New private directory (mode 0700) under the companion state directory, no extensions, removed when the browser stops. Removed at the next start if a crash left one, matched by a marker with the owner's pid. Shipped in the launcher by slice B of [#1258](https://github.com/mihazs/lazysh/issues/1258). |
| Mode | Headless by default: nothing appears on the host's screen. **Headed** is an explicit choice for a host with a display; it shows a window to anyone at the host and switching tabs changes what they see. |
| Flags | Chrome: `--headless=new --remote-debugging-pipe --user-data-dir=<private> --no-first-run --no-default-browser-check`. Firefox: `--headless --no-remote --profile <private> --remote-debugging-port 0`. `--remote-allow-origins=*` and `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS` are never used. |
| Lifetime | Starts when the user opens the tool, stops when the user closes it, the SSH channel closes, the session ends or the companion exits. An idle timer stops it after a configurable time. |
| Start cost | 130 ms (Chromium) and 410 ms (Firefox) to a usable endpoint, so on demand is cheap. |

**Keep profile** is an explicit option for flows that need a sign-in to survive (it keeps cookies on the host's
disk until **Clear browser data**). It is off by default and labelled with what it stores. In the launcher it is
`--keep-profile` (one kept profile, refused while a browser uses it) and `host-browser --clear-data`.

### Attaching to the normal profile

A separate screen, **Attach to your browser**, never the default path and not part of the first release. It exists
for a user who must see the browser they are already signed in to. The app never starts, restarts, stops or
reconfigures that browser, and never writes its settings or profile: the user gives the browser a loopback debug
endpoint on the host, and the screen only connects to it. What a real Chrome does when asked is recorded, with the
build and the commands, in the
[feasibility note](reference/host-browser-feasibility.md#attaching-to-a-running-chrome-approval-mode).

**Two ways for the user to get an endpoint**, both done by the user on the host:

| Way | What the user does | What the app can rely on |
| --- | --- | --- |
| Approval mode, Chrome 144 or newer | Ticks "Allow remote debugging for this browser instance" at `chrome://inspect/#remote-debugging`. | A WebSocket on `127.0.0.1` whose every connection waits for **Allow** on the host's screen. The setting then outlives the browser: it comes back at the next start until the user unticks it. |
| A debug flag the user started the browser with | Closes the browser and starts it again with `--remote-debugging-port`. All its windows go away. | An endpoint with no approval at all: whoever reaches the port holds the profile. Chrome 136 or newer ignores the flag on its default profile, so this is for a custom profile, other Chromium builds and, once Firefox ships, Firefox. |

**What the screen requires.**

- It is reachable only with the host browser switch on and the first-use confirmation given, and it opens on a
  warning that lists what the endpoint gives its holder: cookies and signed-in sessions, history, and every open
  tab with its title and address. **Attach** stays disabled until the warning is acknowledged. The text states
  that the approval dialog names no app and that a wrong browser id raises it too, so the user should approve only
  a dialog they just caused.
- The companion, not the phone, connects. It is a WebSocket client on the host's loopback, inside the same relay,
  so the phone never sees the port or the browser id. It finds the endpoint from the browser's
  `DevToolsActivePort` file or a port the user types, and uses it only when something is listening there that a
  browser of the same user owns: the file is left stale by unticking and by quitting (measured).
- **Waiting for the host is a state, not a failure.** The screen says that the browser is asking on the host's
  screen, offers **Cancel**, and gives up on its own after a limit the relay sets (the browser sets none). A
  refusal (HTTP 403 "Connection rejected") is shown as "Refused on the host" and ends the attempt. It never
  retries by itself, because each attempt raises another dialog on the user's screen, and it never answers the
  dialog: no automation of the browser's window.
- **One connection per view.** Every connection needs its own approval, so the relay opens exactly one and keeps
  it until the view closes. A dropped SSH channel or a closed browser ends the view; attaching again needs a new
  approval. The screen says this, and that approval cannot be given from the phone, so it needs someone at the
  host's display. A host without a display cannot use it.
- **The same closed list.** The relay's allow-list (`host_browser::allow`) is asked before every command and
  address whatever the transport: the attached browser answers `Storage.getCookies` and the whole browser
  protocol once approved (measured), and the list is what refuses it. Downloads, the file chooser, permission
  prompts, the clipboard and non-web addresses are denied exactly as for a managed browser, and nothing about
  URLs, titles or frames is stored or logged.
- **Pages the user opened stay theirs.** The viewer lists the browser's tabs and shows one at a time; switching
  activates that tab on the host's screen too. The screen never closes a tab it did not open, and a tab it opened
  is closed when the view ends. Closing the view closes the relay's connection and leaves the browser, its tabs
  and the user's setting as they were; the screen tells the user how to untick the box and that it stays ticked
  across restarts.
- It ships only after the independent review ([#1258](https://github.com/mihazs/lazysh/issues/1258), slice E).

**Not decided here.** Whether to read the browser's data directories by name or only accept a typed port, and
whether to detect and refuse a browser that another local account owns, are decided in the build issue with the
real browser at hand. Firefox has no approval mode and keeps one session, so it is out of this screen until the
Firefox adapter exists ([#1257](https://github.com/mihazs/lazysh/issues/1257)).

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
| The user attaches to their normal browser | The separate screen's warning, one approved connection per view, the same closed list as a managed browser, no stored cookies, URLs, titles or frames, and no action on the browser's own settings or dialog ("Attaching to the normal profile"). | While approval mode is ticked, any process of any local account can raise the host's dialog, and a flag-started endpoint has no approval at all. The profile is the user's real one, so a bug in the list is a leak of real sessions: the screen waits for the review. |

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
| client to relay | `quality {rung}`, `pause`, `resume` | `rung` is `auto`, `high`, `balanced`, `low` or `minimal`: a named rung holds it (Data saver sends `minimal`), `auto` lets the relay choose. Pause when hidden. |
| client to relay | `control {on}` | Turns Control on or off for the session. Off when a session starts. |
| client to relay | `pointer {kind, x, y, button, clickCount}`, `wheel {x, y, deltaX, deltaY}`, `pinch {scale}`, `key {key, modifiers}`, `text {text}` | Accepted only while Control is on; see "Relay wire format". |
| relay to client | `frame`, `state`, `quality {rung, pinned}`, `tabs`, `dialog {kind, text}`, `closed {reason}` | Page strings are untrusted text. |

Everything else is dropped with a counter, and the browser's protocol is not otherwise reachable.

### Relay wire format

`lazysh-agent host-browser serve [--binary PATH] [--no-sandbox]` is the relay. It is hidden from `--help`, fails
before it starts anything while the host browser switch is off, and speaks one format in both directions on its
standard input and output (the SSH exec channel): `length:u32be tag:u8 body`, where `length` counts the tag and
the body.

| Tag | Direction | Body |
| --- | --- | --- |
| 1 | both | A UTF-8 JSON object. |
| 2 | relay to client | A frame: `sequence:u32be width:u16be height:u16be scrollY:f32be timestampMs:u64be`, then the JPEG bytes as they are. `width` and `height` are the page's viewport in CSS pixels, the space a tap is mapped into. |

Client messages are a closed set, `deny_unknown_fields`: `open {browser?: "chrome", headed?, viewport: {width,
height, scale?}, url?}` (first, once; viewport 100 to 2048 CSS pixels, scale 1 to 3, at most 8 million pixels
scaled; `url` limited like any address), `ack {sequence, decodeMs?}`, `quality {rung}`, `pause`, `resume`,
`control {on}` and the input messages below. Anything else, including a second `open`, is refused and counted, never forwarded; a length of zero, above 64 KiB, or a tag other
than 1 ends the session with `ProtocolViolation`. Relay messages are `state {state: "running" | "paused",
browser, viewport, capabilities}`, `quality {rung, pinned}` (the rung the stream is at, sent when the stream starts and
whenever the rung or the pin changes) (the version comes from `Browser.getVersion` and must be Chrome or Chromium
111 or newer, otherwise the session ends with `BrowserVersionUnsupported` and `detail` names the version),
`page {title, url}` (untrusted text, bounded to 512 and 2048 characters), `refused {reason, count}` (one count
per reason, sent at count 1, 2, 4, 8 and so on; the reasons are `OperationRefused`, `ControlOff`,
`InputOutOfRange`, `PermissionRefused` and `InputRateLimited`), and `closed {reason, detail?}` as the last message: `ClientClosed`, `PageClosed`,
`BrowserExited`, `PageCrashed`, `ProtocolViolation`, `IdleReleased` (the view was hidden for the idle time, below),
or the class of a failure before the stream started
(`HostBrowserDisabled`, `BrowserNotFound`, `AddressRefused`, `ViewportInvalid`, and so on).

`control {on}` turns Control on or off, and `capabilities.control` in `state` says the relay accepts it. Control is
off when a session starts, and the relay never turns it on. While it is off, each input message is refused with
`ControlOff` and never forwarded; turning it off stops forwarding at once. Input messages are in the page's CSS
pixels, the space of a frame's `width` and `height`, and have no other fields:

| Message | Fields and bounds | Browser call |
| --- | --- | --- |
| `pointer` | `kind`: `move`, `press` or `release`; `x`, `y` inside the viewport; `button`: `none`, `left` or `right` (a press and a release need a button); `clickCount` 0 to 3 | `Input.dispatchMouseEvent` (`mouseMoved`, `mousePressed`, `mouseReleased`, with the held `buttons`) |
| `wheel` | `x`, `y` inside the viewport; `deltaX`, `deltaY` within 10000 | `Input.dispatchMouseEvent` (`mouseWheel`) |
| `pinch` | `scale` from 1 to 5 | `Emulation.setPageScaleFactor` |
| `key` | `key`: Backspace, Tab, Enter, Escape, PageUp, PageDown, End, Home, an arrow or Delete, or one ASCII letter or digit with Control or Meta in `modifiers` (Alt 1, Control 2, Meta 4, Shift 8) | `Input.dispatchKeyEvent`, a down and an up; only an Enter without Alt, Control or Meta types a line break |
| `text` | `text` of at most 4 KiB, inserted as typed (accents, CJK, emoji) | `Input.insertText` |

The mapping is `inputCommands` in `apps/client/src/hostBrowser/cdp.ts`, so the prototype and the relay stay equal,
and every call still passes the allow-list. A value outside a bound is refused with `InputOutOfRange`. An editing
shortcut that moves the clipboard (Control or Meta with C, X or V, and Shift with Delete) is refused with
`PermissionRefused`, and a key event never carries editing commands. A flood is refused with `InputRateLimited`:
the relay forwards at most 240 input messages a second, with a burst of the same size, which a hand on a phone
does not reach (a drag is one `wheel` per frame). The relay does not log or keep a coordinate, a key or a text.

Pacing is the relay's job. It acknowledges the browser's screencast frame at once and keeps only the newest
frame for the device; at most two frames are unacknowledged, and the client sends `ack` after it decoded a frame,
so a slow device sees fewer frames, not a queue. `pause` stops the screencast at the browser and holds nothing;
`resume` starts it again. A view hidden for the idle time, `--idle-release SECONDS` (1 to 86400, default 600), ends
the session with `IdleReleased`, which stops the browser and removes its profile; a shown view is never released.
How much the relay asks of the browser is the [quality ladder](#performance). The browser's title and address are read when they change and once a second while the
view is shown, because Chrome announces an address change but not a title that the page sets later.

The browser is started with `--remote-debugging-pipe`, a private profile and `--headless=new` (so no port exists
on the host), and its standard output and error are discarded because they can name pages. It ends, with its
helpers and its profile, when standard input closes, on SIGINT, SIGTERM or SIGHUP, when the browser exits and
when the page closes; on Linux the kernel also stops it if the relay is killed outright, and the next start
removes the profile that a killed relay left. `--no-sandbox` is for containers and CI runners that cannot create a
sandbox. There is no Windows relay: a Windows host is refused with `HostBrowserUnsupported`.

### What the relay may send to the browser

The relay maps its own fixed messages onto a closed list of protocol methods and asks the list before it sends
each one (`apps/agent/src/host_browser/allow.rs`, slice C of [#1258](https://github.com/mihazs/lazysh/issues/1258)).
A method that is not on the list is refused, so a method that a later browser version adds is never reachable by
accident. A refusal names a class, never the page, and is counted; it is not written with a URL, a title or text.

| Refused class | Examples (not exhaustive) |
| --- | --- |
| Cookies and page storage | `Network.getCookies`, `Network.setCookie`, `Storage.*`, `DOMStorage.*`, `IndexedDB.*`, `Fetch.*` |
| Script and DOM from the phone | `Runtime.evaluate`, `Runtime.callFunctionOn`, `Page.addScriptToEvaluateOnNewDocument`, `Debugger.*`, `DOM.*` |
| Downloads and files | `Browser.setDownloadBehavior` with anything but `deny`, `Page.setInterceptFileChooserDialog` that is not `enabled: true`, `DOM.setFileInputFiles` |
| Permissions and clipboard | `Browser.grantPermissions`, `Browser.setPermission`, geolocation overrides, a key event that carries a `copy`, `cut` or `paste` editing command |
| Addresses | `file:`, `chrome:`, `view-source:`, `javascript:`, `data:`, `blob:` and any scheme but `http`, `https` and `about:blank`, in `Page.navigate` and `Target.createTarget`, and a first URL |
| Everything else | `Browser.close`, `Target.setAutoAttach`, `Security.*`, `Page.setBypassCSP`, any unknown method |

The relay ([#1254](https://github.com/mihazs/lazysh/issues/1254)) sets the download behavior to `deny` and
intercepts the file chooser (the browser reports it, no file is supplied) when it starts a browser, which is how
those two are "denied and reported once", and it sends every command through the list; the hidden developer
launcher applies the address rule to its first page.

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

While Control is off, none of this is sent; the client proves it in a test, and the relay refuses it anyway
(see "Relay wire format").

Status: the mapping, the **Control**, **Select**, **Keyboard** and **Zoom page** buttons and the keyboard field exist
as client components (`input.ts` and `HostBrowserInput.tsx` in `apps/client/src/hostBrowser/`) and are driven in the
developer prototype against a real headless Chromium. They are not in the app yet: the relay's input messages and the
product view ([#1254](https://github.com/mihazs/lazysh/issues/1254)) carry them to users, and the relay must refuse
the same messages while Control is off ([#1255](https://github.com/mihazs/lazysh/issues/1255), host side). What the
client decides:

- **Control** is a switch, off at every start and whenever the view stops being live. The one place input leaves the
  component checks it, so a touch, a key or a composed character is dropped while it is off, and turning it off ends
  a gesture under way. A **Select**, **Keyboard** and **Zoom page** button is disabled while it is off. The local zoom
  of a pinch sends nothing, so it works while Control is off.
- **Tap** sends `pointer` move, press and release with button `left` and click count 1; the second of two taps within
  300 ms and 10 displayed pixels has click count 2, and a third tap starts over. A held touch that stays within 10
  pixels for 500 ms sends the same three with button `right`, and lifting it sends nothing more. Points are the
  touch point scaled by the frame's device size and offset by the frame's `offsetTop`, through the local zoom.
- **One-finger drag** sends `wheel` at the first touch point with the finger's travel in page pixels, at most once
  every 16 ms, and the rest when the finger lifts. A touch that has moved 10 pixels is a drag and cannot become a tap
  or a long press. The deltas are never summed into a scroll position: where the page is comes from the frame's
  `scrollOffsetY`, because smooth scrolling does not move 1:1 (measured). The client does not correct the travel from
  that offset while a drag is under way, so a page that scrolls by more or less than the finger moved lags or leads
  it. **Select** turns the drag into `pointer` move (button `left`), press at the touch point and release where it ends.
- **Pinch** zooms the displayed frame locally at once (up to what the page scale allows: 1 to 5 times the page scale
  the frame reports in `pageScaleFactor`), keeps the part of the frame under the fingers under them, and sends
  nothing. While it is zoomed in, a one-finger drag pans the zoomed frame instead of scrolling, and a tap still lands
  on the point under the finger. **Zoom page** sends `pinch {scale}`, the product of the page scale and the local zoom,
  and shows the frame unzoomed; the browser applies it with `Emulation.setPageScaleFactor` (measured with the
  screencast running and no mobile emulation: the frame metadata reported 3 after a request for 3). The frame
  returns at the new scale a moment later; until then the unzoomed old frame shows.
- **Text** from the keyboard field is sent as `text` and goes to the focused element with `Input.insertText`, so accents,
  emoji and non-Latin text arrive as typed. A composition (an IME) sends nothing until it ends, then the composed text
  once; the keys of an IME, such as an Enter that picks a candidate, are not sent. The field holds nothing: every
  character is sent and cleared.
- **Keys** are `key {key, modifiers}`: Enter, Backspace, Tab, Escape, the arrows, Home, End, Page Up, Page Down and
  Delete, and a Control or Meta chord of a letter or digit (modifier bits Alt 1, Control 2, Meta 4, Shift 8). Each
  is a key down and a key up. The clipboard stays off, so Control or Meta with C, X or V and Shift with Delete are
  never sent (the relay refuses a key event that carries a clipboard command too). AltGr, which a keyboard reports as
  Control and Alt, is text, and a chord with Alt alone is left to the keyboard.
- The keyboard field turns off automatic capitals, correction, completion and spell checking. Detecting that the page
  focused a password field, to also ask the phone keyboard for no suggestions and no learning, needs the focused
  element, which the closed relay list does not expose; it is not done, and the stricter hints apply to every field.

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

- **Quality ladder** (`apps/agent/src/host_browser/ladder.rs`). Four rungs, each a JPEG quality, a frame size
  and a frame divisor:

  | Rung | JPEG quality | Size | Every nth frame (60 fps page) |
  | --- | --- | --- | --- |
  | High | 60 | 100 percent | 1 (60) |
  | Balanced | 50 | 100 percent | 2 (30) |
  | Low | 40 | 100 percent | 3 (20) |
  | Minimal | 35 | 75 percent | 6 (10) |

  A stream starts at High. The relay counts the frames the browser produces and the frames the device acknowledges
  after decoding them. At most two frames are unacknowledged, so the acknowledgement rate is two frames over the
  acknowledgement time: it holds the link's goodput and round trip and the phone's decode time, and the relay
  does not estimate them separately. A rung **fits** while, over a window of 0.8 seconds, the device acknowledges
  at least 80 percent of the lesser of the produced rate and 15 frames a second; a window with fewer than four
  produced frames (an unchanged page) is not judged. A window that does not fit steps down one rung, so the first
  step comes within a second and the lowest rung from High within about three. A rung that fit for ten seconds
  steps up one rung, and if that one does not fit it is left again within a window. The relay tells the client the
  rung and whether it is pinned with `quality {rung, pinned}`. A **Data saver** option sends `quality {rung:
  "minimal"}`, which pins the lowest rung: the ladder neither judges nor boosts, until `quality {rung: "auto"}`
  starts again from High.
  A screencast sends a frame when the page changes (measured with Chromium 156), so after a step on a page that
  does not change the picture keeps the previous rung's size until the page next changes.
- **Acknowledge after decode.** The device's decode time is part of back-pressure, so a slow phone gets fewer
  frames instead of a growing queue.
- **Pacing on the host.** The relay acknowledges the browser at once and holds only the newest frame for the
  device, so the link's round trip never throttles the browser. On Firefox it pipelines polls and drops repeats.
- **Interaction boost.** Every frame (divisor 1) for two seconds after input the relay forwarded, at the rung's
  own quality and size, then back to the rung. The boosted rate is not judged, because the link cannot be
  expected to carry it, and a pinned rung is never boosted.
- **Sharpen when idle.** A single high-quality still when the page stops changing, because a screencast is
  produced at CSS size.
- **Pause when hidden.** No frames when the view is not visible, the app is in the background or the screen is
  off (the viewer sends `pause`); the browser is released after the idle time (`--idle-release`).
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
| 2 | Chrome relay and viewer, view-only. The host relay (`host-browser serve`) is done; the app's bridge and viewer are the remaining slices. | [#1254](https://github.com/mihazs/lazysh/issues/1254) | Yes, off until enabled |
| 3 | Chrome input. The relay's `control` and input messages are done ([#1709](https://github.com/mihazs/lazysh/issues/1709)); the app's wiring of them is the remaining slice ([#1710](https://github.com/mihazs/lazysh/issues/1710)). | [#1255](https://github.com/mihazs/lazysh/issues/1255) | Yes |
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

- **Developer flag and switch, both off by default.** On the host, the hidden command `lazysh-agent host-browser`
  (not in `--help`) refuses to run unless the host browser switch is on (`settings host-browser update`) and
  `LAZYSH_DEV_HOST_BROWSER=1` is set. On the device, the viewer is a page that
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
  acknowledges each after decoding, and, while Control is on, sends the input of [Input mapping](#input-mapping-for-a-phone):
  taps, double taps, long presses, drags, pinches, typed text (`insertText`, so accents, CJK and emoji work) and keys. It sends only methods on a closed
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
  viewer must draw the fixture page, a tap must turn it blue, and typed accents and CJK must reach its input. A second test
  with Control off, then on, taps, double taps and long presses a fixture button, drags a long page until the frames show
  its scroll offset and a different part of it, types accents and an emoji, a composed character, Backspace and a
  Control chord into its input, and pinches and commits a page zoom, each checked from the frames the viewer draws or
  from the page's own state. It drives the viewer with a mouse and with DevTools touch events, not a real finger or
  a phone keyboard.
  The Playwright test runs in the existing `client` job on the browser the job already installs, and fails
  rather than skips when no browser is found.
- **What the tests do not cover.** A real SSH hop in CI, a real device, and a headed browser. The measurements
  below were made by hand with a real `ssh -L`.
- **Why a raw forward here, and not in the product.** The prototype uses a forwarded debug port because it
  needs no new relay, and the measurements show why it is not the shipped transport (no authentication on the
  port, exposure to every local account, a web view that cannot set `Host`, and a Content Security Policy that
  allows no loopback WebSocket in the app).

## What it will not do

- Restart or stop a browser the user already runs, turn on remote debugging in it, answer its approval dialog, or
  attach to it outside the separate, warned screen that is not in the first release.
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
- Whether Google Chrome 144 or newer behaves like the Chromium 157 that was measured, including its refusal of the
  debug flag on the default profile ([#1697](https://github.com/mihazs/lazysh/issues/1697) records what was not
  tried).
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
