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
disk until **Clear browser data**). It is off by default and labelled with what it stores. In the launcher and in the
relay (`host-browser serve --keep-profile`) it is `--keep-profile` (one kept profile, refused as `BrowserProfileInUse`
while a browser uses it, which the relay reports as its `closed` reason) and `host-browser --clear-data` removes it. A
relay that is not asked to keep the profile stays ephemeral and leaves the kept one as it is. An older companion
answers `--keep-profile` with a usage error and starts nothing, so a session never silently runs without the profile
the user asked to keep.
When upgrading, stop older companion sessions before starting a kept session or clearing browser data. Older
companions do not use the profile coordination lock, so concurrent recovery of stale profiles across versions is not protected.

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
| client to relay | `answerDialog {accept, text?}` | The answer to the page's open dialog; `text` is a prompt's answer. |
| client to relay | `ack {sequence, decodeMs}` | After the device decoded a frame. |
| client to relay | `quality {rung}`, `pause`, `resume` | `rung` is `auto`, `high`, `balanced`, `low` or `minimal`: a named rung holds it (Data saver sends `minimal`), `auto` lets the relay choose. Pause when hidden. |
| client to relay | `control {on}` | Turns Control on or off for the session. Off when a session starts. |
| client to relay | `pointer {kind, x, y, button, clickCount}`, `wheel {x, y, deltaX, deltaY}`, `pinch {scale}`, `key {key, modifiers}`, `text {text}` | Accepted only while Control is on; see "Relay wire format". |
| relay to client | `frame`, `state`, `quality {rung, pinned}`, `tabs`, `dialog {kind, message, defaultPrompt}`, `dialogClosed`, `notice {kind, count}`, `closed {reason}` | Page strings are untrusted text. |

Everything else is dropped with a counter, and the browser's protocol is not otherwise reachable.

### Relay wire format

`lazysh-agent host-browser serve [--binary PATH] [--no-sandbox] [--keep-profile]` is the relay. It is hidden from `--help`, fails
before it starts anything while the host browser switch is off, and speaks one format in both directions on its
standard input and output (the SSH exec channel): `length:u32be tag:u8 body`, where `length` counts the tag and
the body.

| Tag | Direction | Body |
| --- | --- | --- |
| 1 | both | A UTF-8 JSON object. |
| 2 | relay to client | A frame: `sequence:u32be width:u16be height:u16be scrollY:f32be timestampMs:u64be`, then the JPEG bytes as they are. `width` and `height` are the page's viewport in CSS pixels, the space a tap is mapped into. |

Client messages are a closed set, `deny_unknown_fields`: `open {browser?: "chrome" | "firefox", headed?, viewport: {width,
height, scale?}, url?}` (first, once; viewport 100 to 2048 CSS pixels, scale 1 to 3, at most 8 million pixels
scaled; `url` limited like any address), `ack {sequence, decodeMs?}`, `quality {rung}`, `pause`, `resume`, `control {on}`, the
input messages below and the navigation messages of "Navigation, tabs and dialogs". Anything else, including a second `open`, is refused and counted, never forwarded; a length of zero, above 64 KiB, or a tag other
than 1 ends the session with `ProtocolViolation`. Relay messages are `state {state: "running" | "paused",
browser, viewport, capabilities}`, `quality {rung, pinned}` (the rung the stream is at, sent when the stream starts and
whenever the rung or the pin changes) (the version comes from `Browser.getVersion` and must be Chrome or Chromium
111 or newer, or, for Firefox, from `session.new` and must be Firefox 159 or newer, otherwise the session ends with `BrowserVersionUnsupported` and `detail` names the version),
`page {title, url}` (untrusted text, bounded to 512 and 2048 characters), `refused {reason, count}` (one count
per reason, sent at count 1, 2, 4, 8 and so on; the reasons are `OperationRefused`, `ControlOff`,
`InputOutOfRange`, `PermissionRefused`, `AddressRefused` and `InputRateLimited`), the messages of "Navigation, tabs
and dialogs" below, and `closed {reason, detail?}` as the last message: `ClientClosed`, `PageClosed` (the browser has no
page left),
`BrowserExited`, `PageCrashed`, `ProtocolViolation`, `IdleReleased` (the view was hidden for the idle time, below), or the class of a failure before the stream started
(`HostBrowserDisabled`, `BrowserNotFound`, `AddressRefused`, `ViewportInvalid`, and so on).

`control {on}` turns Control on or off, and `capabilities.control` in `state` says the relay accepts it. A
capability the browser lacks is `false`, and `capabilities.unavailable` names why for each one that the viewer
should hide (Firefox: `pinch: "NoPagePinch"`, `composition: "NoTextInsertion"`). Control is
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
and every call still passes the allow-list. Firefox takes the same messages, the same bounds and the same refusal
classes and counts (see "The Firefox adapter"). A value outside a bound is refused with `InputOutOfRange`. An editing
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
removes the profile that a killed relay left. The browser is stopped with SIGTERM to its main process alone, so it
writes what a page stored (`localStorage` included) before its helpers go; only when it has not exited within three
seconds is its whole process group killed. Its process id stays reserved until then (`waitid` with `WNOWAIT`), and
if the relay cannot observe it, it sends no signal at all. With `--keep-profile` the relay uses the one kept profile instead
(`host-browser/kept`, mode 0700) and leaves it, with what the browser wrote, for `host-browser --clear-data`. `--no-sandbox` is for containers and CI runners that cannot create a
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

### The Firefox adapter

Slice 1 of [#1257](https://github.com/mihazs/lazysh/issues/1257): the view of a Firefox, with the same relay, wire
format and client messages as Chrome (`apps/agent/src/host_browser/firefox.rs`, `bidi.rs`), and slice 2,
[#1715](https://github.com/mihazs/lazysh/issues/1715): its input. The capability record still says `navigation` and
`tabs` are false, because their client messages are the Chrome slices
[#1256](https://github.com/mihazs/lazysh/issues/1256) and [#1259](https://github.com/mihazs/lazysh/issues/1259),
and the Firefox adapter follows each of them.

- **Start.** `open {"browser": "firefox"}` runs `firefox --headless --no-remote --profile <private>
  --remote-debugging-port 0 <url>` (`firefox` or `firefox-esr` on `PATH`, or `--binary`; `--headless` is left out
  for a headed session). The profile is the private, ephemeral one of every managed browser. The environment
  loses `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS`, so a page's script can never reach the browser itself, and
  `--remote-allow-origins` and `--remote-allow-hosts` are never passed. Firefox's output is discarded.
- **Endpoint.** Firefox writes its port to `WebDriverBiDiServer.json` in the profile. The relay uses it only when
  the host is `127.0.0.1` (otherwise `BrowserEndpointInvalid`) and connects to `/session` with a WebSocket client of
  its own, because Firefox refuses a `Host` that lacks the port and any `Origin`, which no library or web view
  guarantees. A relay that cannot connect ends with `BrowserEndpointUnreachable`. The connection is never offered
  to the phone.
- **Version.** The product and version come from `session.new` (`Firefox/160.0`); Firefox 159 is the oldest the
  measurements used, and an older one is named and refused. A browser that is not Firefox is refused the same way.
- **One session, always ended.** Firefox allows one BiDi session and keeps one that was never ended until it
  exits. The relay creates its session with `unhandledPromptBehavior: dismiss` (a page's dialog cannot hang it
  until the dialog slice answers it) and ends it on every way out: the channel closing, a signal, the page or the
  browser going away, an error. A Firefox that already holds a session cannot serve the relay and cannot be told
  to let go, so the relay stops it, removes its profile and starts a new one, once; if that one is busy too the
  session ends with `BrowserSessionBusy`. A second client that connects to the port while the relay's session is
  open is refused by Firefox (`session not created`); that is a property of Firefox, tested on the host's own.
- **Frames.** `browsingContext.captureScreenshot` of the viewport as JPEG quality 0.6, two requests in flight, one
  every 50 ms at most (20 a second), and one every 250 ms once eight in a row matched the last frame. A frame
  equal to the last one is not sent, and the outbox keeps the newest one for the device exactly as for Chrome.
  `pause` stops every request and `resume` sends a frame even if the page did not change. The pacing is fixed and
  chosen from the [measurements](reference/host-browser-feasibility.md#firefox-host-cost); the adaptive ladder of
  [#1259](https://github.com/mihazs/lazysh/issues/1259) replaces it. The frame header's scroll offset is 0:
  the capture is the viewport, and a pointer is mapped into the viewport.
- **Title and address.** Once a second, `browsingContext.getTree` gives the address and one `script.evaluate` of
  `document.title`, in a sandbox realm of the relay's own (`lazysh`) that the page's script cannot see or replace,
  gives the title. That evaluation is the only script the relay ever runs, and the allow-list refuses it with any
  other expression.
- **Input.** `control {on}` and the input messages of the Chrome relay, with the same bounds
  (`input::check`), the same refusal classes and counts, the same token bucket and Control off at the start. Each
  message is one `input.performActions` in the page's context (`input::bidi_commands`), written without waiting
  for the reply: a `pointer` is a mouse (a held touch gave no context menu in Firefox, a right click did) that
  moves to the point and presses or releases `left` or `right`, the input state of the session keeping the
  position and the pressed button between messages, so a tap is the three messages the client already sends; a
  `wheel` is one `scroll` action in whole pixels (a drag is not assumed to move the page 1:1); a `key` is a key
  down and a key up of the key's WebDriver value (Enter is U+E006, Backspace U+E003), held modifiers pressed
  before it and released after it; `text` is one key down and up per character, because BiDi has no
  `insertText` and no composition (accents, CJK and an emoji were typed this way, and one Backspace deletes an
  emoji). A character of the private-use block U+E000 to U+E0FF is not text, it is a key (U+E009 holds Control
  down), so a `text` that has one is refused with `InputOutOfRange`. After a tap, a drag or a key the capture
  returns to the 50 ms interval at once instead of waiting out the idle interval. When Firefox rejects a
  sequence the relay sends `input.releaseActions` so that nothing it pressed stays held, and that is not counted
  as the browser failing. `pinch` is refused with `OperationRefused` and counted: the capability record says
  `pinch: false` and `composition: false`, and `unavailable` gives the reasons (`NoPagePinch`: two touch pointers
  spreading did not scale the page in the headless probe, so pinch is the viewer's local zoom of the frame
  only; `NoTextInsertion`: no `insertText` and no composition in BiDi), so that a viewer can hide the control
  and say why. Turning Control off while a button is held leaves it held until the next click, as in Chrome.
- **What the phone cannot reach.** Every command passes `allow::bidi` before it is written: only
  `session.new`, `session.end`, `browsingContext.getTree`, `setViewport` and `captureScreenshot`, the title
  evaluation, and `input.performActions` and `input.releaseActions` inside bounds (at most three action sources,
  mouse pointers only, coordinates inside the 2048 pixel viewport and relative to it, wheel deltas within 10000,
  a tick of at most a second, one key per value, no key of the private-use block but the named keys and
  modifiers, at most 8200 actions, and no Control or Meta chord of C, X or V and no Shift with Delete, which
  would reach the host's clipboard). Refused by class: `storage.*` and `network.*` (cookies and interception), the rest of `script.*`
  and `webExtension.*`, `input.setFiles` and `browsingContext.startScreencast` (which writes a video file to the
  host and returns no frames), `permissions.*` and geolocation overrides; anything else is `OperationRefused`.
- **Profile preferences.** The relay writes `user.js` in the private profile. A download goes nowhere: the profile
  asks where to save, a headless Firefox has no dialog to answer and saves nothing, where by default a page's
  download was written to the host user's `~/Downloads` (both checked on Firefox 160). A headed session shows
  that dialog on the host's screen, to whoever is there, and offers a folder inside the profile. The camera,
  microphone, location, notification and XR permissions are blocked, and telemetry, update and default-browser
  checks are off; these were set, and their effect on the network was not observed. Firefox keeps its crash
  reports and a few cache files in the host user's own directories (`~/.config/mozilla`, `~/.cache/mozilla`),
  outside the profile; the crash reporter is turned off for the relay's Firefox.
- **Not yet.** Page pinch and composition (not available), tabs, navigation, history, dialogs, the file chooser report and the
  quality ladder for Firefox, a reconnect after the WebSocket drops (a Firefox whose connection dropped holds a
  leaked session, so the relay ends the session instead), a Firefox older than 159, Firefox from a snap or a
  Flatpak (its profile and port may sit behind the sandbox), Windows and macOS hosts, and a headed Firefox were not
  tried.

### Navigation, tabs and dialogs

Status: the relay carries these messages; the app does not send or show them yet
([#1998](https://github.com/mihazs/lazysh/issues/1998), second slice of
[#1706](https://github.com/mihazs/lazysh/issues/1706)). They are **not input**, so Control does not gate them: a
session that is view-only can still navigate, switch tabs and answer a page's dialog. They are bounded by the
switch, by the closed message set and by the allow-list like everything else, and `state` says
`capabilities.navigation: true` and `capabilities.tabs: true`.

| Client message | Relay's calls (each one passes the allow-list first) |
| --- | --- |
| `navigate {url}` | `Page.navigate`; an address that is not `http`, `https` or `about:blank` (printable ASCII, at most 2048 bytes) is refused with `AddressRefused` and dropped. |
| `back`, `forward` | `Page.navigateToHistoryEntry` for the entry one step back or forward in the history the relay last read (`Page.getNavigationHistory`); nothing at either end of the history. |
| `reload`, `stop` | `Page.reload`, `Page.stopLoading`. |
| `tabs` | None: the relay sends the tab list again. |
| `activateTab {id}` | Attach to that page, `Target.activateTarget`, then leave the shown page (see below). A page that is not in the list is refused with `OperationRefused`. |
| `newTab` | `Target.createTarget` with `about:blank`, then show it; refused with `OperationRefused` at 16 pages. |
| `closeTab {id}` | `Target.closeTarget`. A browser keeps a page: closing the last one makes a blank one first. |
| `answerDialog {accept, text?}` | `Page.handleJavaScriptDialog`; refused with `OperationRefused` while no dialog is open and with `InputOutOfRange` when `text` is over 4 KiB. |

The relay sends:

- `tabs {tabs: [{id, title, url}], activeId, canGoBack, canGoForward, loading}`: the browser's pages (type `page`
  only, in the order it first reported them, at most 16; titles at most 200 characters, addresses at most 2048) and
  what the controls show about the shown one. It is sent again only when it changes. A list that would not fit one
  JSON message (64 KiB) loses its last pages, never the shown one. Titles are read from `Target.getTargets` again
  every second and whenever a page settles, because Chromium announces a title through a target change for the
  first page only (measured). `loading` is the main frame's loading state (the main frame has the id of its
  target, measured).
- `dialog {kind, message, defaultPrompt}` when the shown page opens an alert, a confirm, a prompt or a
  before-unload question (text bounded to 1000 characters), and `dialogClosed` when it closes. Showing another page
  while a dialog is open dismisses it first (`accept: false`), so that its page is not left blocked.
- `notice {kind: "download" | "fileChooser", count}` when the browser denied a download or a file chooser, at count
  1, 2, 4, 8 and so on. The download behavior is set to `deny` with `eventsEnabled` before any page is attached, and the
  file chooser is intercepted on every page the relay attaches to. **Permission prompts have no notice**: the
  protocol typings of Playwright 1.64.1 (Chromium 157 era) have `Browser.setPermission`, `grantPermissions` and
  `resetPermissions`, which the allow-list refuses on purpose, and no event for a request, and headless Chromium
  denies the request without a prompt (`Notification.requestPermission()` resolved `denied`, measured in #1256).

Only one page streams at a time (a background page produces no frames, measured). Showing another page attaches to it
first and leaves the shown one only once that worked; a page the browser listed that is gone by then is dropped from
the list and the shown page stays. A page that opens another (a link with `target="_blank"`, `window.open`)
takes the view, like in a browser. A page that is closed (by a tab close, by itself) hands the view to the last page of
the list; the session ends with `PageClosed` only when the browser has none left. A page beyond sixteen is closed
again as soon as the browser creates it, so a page that opens windows in a loop cannot grow the list.

Known limit: while the relay switches pages it waits for each answer of the browser, up to 90 seconds, and the
client's messages wait in line meanwhile; a page that hangs while it is being attached would stall the session until
that timeout ends it with `BrowserStartTimeout`. Everything else on the shown page (navigation, history, dialog
answers, input) is sent without waiting.

### Adapters and capabilities

| Capability | Chrome / Chromium adapter | Firefox adapter |
| --- | --- | --- |
| Frames | `Page.startScreencast`, acknowledged by the relay, on change only | `browsingContext.captureScreenshot` polled, pipelined 2 to 3 deep, repeats skipped |
| Pointer | `Input.dispatchMouseEvent`, `dispatchTouchEvent` | `input.performActions`, a mouse pointer |
| Scroll | wheel events | wheel action |
| Pinch | two-point touch events or `Emulation.setPageScaleFactor` | local zoom of the frame only |
| Text | `Input.insertText`, key events, IME composition | one key action per character, no composition |
| Tabs | `Target.getTargets`, `createTarget`, `activateTarget`, `closeTarget` | `browsingContext.getTree`, `create`, `activate`, `close`, titles by `document.title` |
| History | `Page.getNavigationHistory`, `navigateToHistoryEntry`, `reload` | `traverseHistory`, `reload` |
| Socket-free | yes (pipe) | no |
| Concurrent clients | several (the relay allows one) | one session, owned and always ended by the relay; a leaked one is cleared by restarting the owned browser |

### Keep profile and Clear browser data in the app

Both live in the **Host browser** part of the host settings panel ([#1885](https://github.com/mihazs/lazysh/issues/1885)).

- **Keep profile** is a checkbox that is **off for every host** until chosen. The choice is remembered on this device for
  that saved host only, in its own storage key (`lazysh.hostBrowserKeepProfile.v1`) as the list of host ids, so it is
  not part of the encrypted sync and no address, title or frame is stored with it. It is offered while the host browser
  settings can be read, like the switch. A browser session started from this device with the option passes
  `--keep-profile` to the relay (`host_browser_start(..., keepProfile: true)`); a relay that does not know the option
  fails with a usage error, which the session reports as `CompanionRequired`, so a session never silently runs
  without the profile the user asked to keep. The viewer's session bar does not show a kept profile yet: the viewer
  ([#1705](https://github.com/mihazs/lazysh/issues/1705)) is not built, so no session starts from the app yet.
- **Clear browser data** is a button, offered with the switch on or off. It first asks, naming what it deletes (the kept
  browser profile directory on that host: the cookies, sign-ins and site data that Keep profile saved) and that it
  cannot be undone, and then runs `host_browser_clear_data`. The answer is "cleared" or "nothing to clear"; a profile that
  a running browser holds is named, and an old companion gets an update message.

### App bridge

The app runs the relay over the verified SSH session with six Tauri commands in `apps/client/src-tauri/src/host_browser.rs`
([#1704](https://github.com/mihazs/lazysh/issues/1704), slice 2 of [#1254](https://github.com/mihazs/lazysh/issues/1254)),
shaped like the Devices tool's `device_stream_*`. They are in the permission manifest (`build.rs`) and the main capability.
The viewer that uses them is the next slice ([#1705](https://github.com/mihazs/lazysh/issues/1705)); nothing in the app calls
the six relay commands yet. `host_browser_clear_data` is the seventh command and the one the host settings panel calls today.

| Command | Does |
| --- | --- |
| `host_browser_start(sessionId, viewport {width, height, scale?}, url?, keepProfile?)` | Opens one SSH exec channel that runs `lazysh-agent host-browser serve` (with `--keep-profile` when `keepProfile` is true, see "Keep profile and Clear browser data in the app"), sends `open` and returns a token at once. How the start went arrives as messages. The size and the address are checked first, with the relay's limits (100 to 2048 CSS pixels, scale 1 to 3, at most 8 million pixels scaled; `http`, `https` or `about:blank`). |
| `host_browser_next(sessionId, browserId)` | One message as bytes, one pull at a time (a second is refused as `busy`). Waits up to 15 s and then answers one `0` byte. After the closing message was read, a pull fails. |
| `host_browser_ack(sessionId, browserId, sequence, decodeMs?)` | Sends `ack` after the device decoded a frame, which lets the relay send another. |
| `host_browser_pause`, `host_browser_resume` | Send `pause` and `resume`. A frame queued before a pause is dropped. |
| `host_browser_stop(sessionId, browserId)` | Ends the channel's input, so the relay ends its browser and removes its profile (a kept one stays), closes the channel and waits (up to 8 s) for that to finish. It works while the app is locked. |
| `host_browser_clear_data(sessionId)` | **Clear browser data**: runs `lazysh-agent host-browser --clear-data` over the session and answers `{schemaVersion, cleared}`, where `cleared` is whether a kept profile existed and was removed. It works with the host browser switch off and needs an unlocked app; the companion refuses it with `BrowserProfileInUse` while a browser uses the profile, and a companion that predates the command (a usage error) answers `host_browser_companion_required` without writing anything. |

**What a pull answers.** Bytes, never base64 and never a JSON string of an image: the relay's tag and then its message
without the length. A first byte of `1` is a JSON object, `2` is a frame (`sequence:u32be width:u16be height:u16be
scrollY:f32be timestampMs:u64be`, then the JPEG as the relay sent it), `0` alone means nothing came. The JSON objects are
the relay's `state`, `page` and `refused` and a final `closed {reason, detail?}`, re-serialized from what the app
validated, so a field the relay did not promise never reaches the web view. The relay's first `state` carries the browser, the page size and the capabilities; its answers to `pause` and `resume` name only `state`, and the app passes that on as it is. Page strings are untrusted text. The app
also ends a session with a `closed` of its own, whose `reason` is one of `Stopped`, `Disconnected`, `ConnectFailed`,
`ChannelFailed`, `StartTimeout` (nothing came for 120 s after the channel started), `HostCommandFailed`, `ChannelEnded`,
`CompanionRequired` and `ProtocolViolation`.

**The same bounds as the relay.** A length of zero or above the largest message (a frame is at most 20 header bytes and
4 MiB of JPEG), a tag other than 1 and 2, a JSON object over 64 KiB, a frame without its header, a page of no size or a
JPEG that does not start with `FF D8 FF`, a `state`, `page`, `refused` or `closed` that is not what it says or is over
its bound (title 512, address 2048, reason 64 letters or digits, detail 256) ends the session with `ProtocolViolation`
and closes the channel. A message type the app does not know is skipped, so a later relay can add messages.

**Back pressure.** The app keeps the newest frame and the newest message of each kind, never a queue, and the relay keeps
at most two frames unacknowledged, so a slow device sees fewer frames.

**Fail closed.** A companion that predates `host-browser serve` exits with a usage error, which a wrapper turns into a
marker line: the session ends with `CompanionRequired`. A companion with the switch off sends `closed
{reason: "HostBrowserDisabled"}`. Either way nothing is started or retried; the viewer names the class.

**Lifetime.** One browser runs per session and two per app (a third is refused as `busy`). Stopping, a lock, the end of the
SSH connection and the end of the session each end the channel's input and close it, which ends the relay's browser, its
helpers and its profile. A browser whose channel ended holds no slot.

**Data.** The app keeps no page text or frame outside memory and writes none to a log, to its storage or to a crash
report. An error names an operation and a reason; the text of a message that fails to parse is dropped, because
serde's own message quotes the value.

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

Status: the address bar, tab list, navigation, dialogs and notices below exist as client components
(`apps/client/src/hostBrowser/`) and are exercised against a real Chromium through the developer prototype. They
are not in the app yet: the relay does not carry the navigation, tab, dialog and notice messages and the app has no
Host browser view
([#1706](https://github.com/mihazs/lazysh/issues/1706)), and **Open on this device** needs the app to supply how a
Preview and the device's browser are opened. What each part decides:

- **Address bar** shows the current URL and takes a new one. Only `http`, `https` and `about:blank` open.
  A typed string without a scheme becomes `https://`, except a loopback host (`localhost`, `127.0.0.1`, `[::1]`),
  which becomes `http://` because a development server rarely speaks TLS. `host:port` is read as an address, not a
  scheme. Everything else is refused with a reason that names the scheme: `javascript:`, `data:`, `file:`,
  `chrome:`, `view-source:`, `blob:`, `ftp:`, `about:` pages other than `about:blank`, and an address that is empty,
  not a web address, or longer than 2048 characters. The accepted address is the URL as the parser serializes it
  (internationalized names in their ASCII form), so it is also what the relay's own rule accepts. A refusal stays
  on screen until the address is edited or the page changes, so that a tap on another control is never moved away
  by it disappearing.
- **Tabs** list the pages the browser has (`Target.getTargets`, type `page` only), with title and URL as text, and
  switch, open and close them. A page the shown page opens (a link with `target="_blank"`, `window.open`) appears as
  a tab and takes the view, like in a browser; a page nothing in this browser opened does not. Closing the last
  tab opens a blank one first, so the browser never has no page. Only the shown tab streams (a background tab
  produced no frames, measured), so switching activates the tab, stops the old frames and starts the new ones.
  Titles are read again from `Target.getTargets` whenever a page settles: Chromium 157 announces a page's title
  through `Target.targetInfoChanged` for the first page only, not after a later navigation (measured).
- **Back, forward, reload, stop** from the browser's own history (`Page.getNavigationHistory`); stop replaces
  reload while the main frame loads.
- **Open on this device**: a loopback URL on the host opens as a [Preview](previews.md) (`localhost` is forwarded
  as IPv4; type `[::1]` for a server bound to IPv6 only; Preview serves plain HTTP, so an `https://` loopback page is
  never downgraded to it: the action is shown disabled with the reason, until an HTTPS-capable Preview exists, #2068); another URL opens in the phone's browser after a confirmation that
  names the host (its ASCII form, so a look-alike name shows as `xn--…`). A URL is never opened without that tap.
- **Dialogs**: an alert, confirm, prompt or leave-page question appears as a native dialog headed "Text from the
  page, not from lazysh". Its text is bounded to 1000 characters and shown as text, without control or
  text-reordering characters; Escape picks the safe answer (OK for an alert, Cancel or Stay otherwise). A dialog the
  person walks away from by switching tabs is dismissed so that its page is not left blocked.
- **Downloads** and **file choosers** are denied before any page can use them (`Browser.setDownloadBehavior` with
  `deny`, `Page.setInterceptFileChooserDialog`), and each attempt is reported once as a notice until it is
  dismissed, however many times the page tries. Nothing is written on the host or the device (checked by looking
  for the file under the browser's home and profile). **Permission prompts**: the headless browser has no user
  interface and answers them itself (a notification request resolved `denied`), but the protocol has no event for
  them, so they are denied without a notice; reporting them needs a different mechanism and is not done.
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
- **Controls in the prototype.** The viewer shows the address bar, tab list, navigation buttons, dialogs and notices
  of [Controls](#controls) above its canvas, driven by the same session. The session sends only the methods in its
  allow list and applies the relay's parameter rules itself (an address must be one the address bar accepts,
  downloads are only denied, the file chooser is only intercepted). The Playwright test drives a real headless
  Chromium through a link, a typed address, a second tab opened by a link, switching, back, forward and reload, the
  refused schemes, a confirm dialog, a denied download (one notice, no file under the browser's home and profile)
  and a denied file chooser. It does not cover a real SSH hop, a real device, or the native dialog on a phone.

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
