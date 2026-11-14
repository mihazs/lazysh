# Open a sign-in page on your device

When a command on a host starts a browser sign-in (`aws sso login`, `codex login`, `gh auth login --web`), the page has to open on the device that runs lazysh, not on the host. This page describes the device half: `open_auth_url` and `inspect_auth_url`. They are part of the sign-in tunnel work ([epic #1504](https://github.com/mihazs/lazysh/issues/1504), issue [#1513](https://github.com/mihazs/lazysh/issues/1513)). Nothing in the app calls them yet: detecting the sign-in, tunnelling its `localhost` callback and asking you first arrive in the sibling issues, so there is no visible change today.

## What opens where

| Device | The page opens in | Why |
| --- | --- | --- |
| Android | An in-app browser tab (Chrome Custom Tabs, a tab of your browser shown over lazysh); the default browser app when the choice is `system` | lazysh stays the app in front, so its sessions and any loopback listener keep running |
| iOS | An in-app tab (`SFSafariViewController`); the Safari app when the choice is `system` | iOS suspends an app that is not in front and lazysh declares no background mode |
| Linux, macOS, Windows | The system default browser | The browser runs on the same machine, so the callback reaches the same loopback |

The opener is `tauri-plugin-opener`'s `inAppBrowser` mode on iOS, and a small Android plugin (`AuthBrowserPlugin`) on Android: the opener plugin keeps the activity it was built with, which Android replaces when it recreates the window ([#1462](https://github.com/mihazs/lazysh/issues/1462)), and it cannot tell whether lazysh is in front.

## Android with another app in front

Android 10 and later refuse to start an activity from the background. A foreground service, which lazysh runs while a session is connected, is not an exemption ([background starts](https://developer.android.com/guide/components/activities/background-starts)). When a request arrives while lazysh has no visible window, the plugin posts a notification instead: **Sign-in is waiting**, with the host being opened ("Open the idp.example sign-in page on this device"). Tapping it opens the page, which the system allows from a notification. The notification never contains the query, which carries the sign-in `state`; it is replaced by a newer request, dismissed by the tap and removed after two minutes. With notifications off for lazysh, the command fails with a message saying so, rather than opening nothing.

## Commands

`open_auth_url(url, browser?)` returns `opened` or `notified`. `browser` is `inApp` (default) or `system`; a desktop ignores it.

- The URL must pass the same checks as links in the terminal: `http` or `https`, at most 4096 bytes, no credentials, no control characters or backslashes. The Android plugin checks the scheme again before it starts anything.
- A redirect to the device's own loopback needs a listener first. The page's query is read for `redirect_uri`, `redirect_url`, `redirectUri`, `callback`, `callback_url` and `redirect` (also when encoded twice). If one is `http://localhost:PORT`, `http://127.0.0.1:PORT` or `http://[::1]:PORT` with PORT from 1024 to 65535 (the page's own address counts too), the page opens only when something already listens on that device port, and `[::1]` needs the IPv6 listener. The check binds the port and closes it again, so it never connects and the listener receives no byte. Otherwise the command fails with the port in the message and nothing opens. A loopback address a tunnel cannot serve (https, a port below 1024, `127.0.0.2`) does not gate the page.
- Which program holds that port is the tunnel engine's job ([#1511](https://github.com/mihazs/lazysh/issues/1511)): it binds before anything opens and refuses a busy port. This check only guarantees the order.

`inspect_auth_url(url)` returns `{host, warnings, callbackPorts}` for the banner that asks you first. `host` is the host being opened, never the query. `warnings` holds `insecure` (plain `http` to a host that is not this device) and `punycode` (a host label starting `xn--`, how an internationalized name that can imitate another domain is written). `callbackPorts` are the device ports the page needs listening.

Neither command logs or stores a URL, and an error never repeats one: the query carries the OAuth `state` and a PKCE challenge.

## Limits and what is not checked

- The in-app tab is not dismissed when the sign-in ends. Android offers no way to close another app's tab, and the opener plugin on iOS does not return the view controller to dismiss. The app shows the outcome of the sign-in itself.
- iOS is compile-checked by the CI build only. Whether the app stays active while the tab is shown, whether the tab loads `http://127.0.0.1:PORT`, and how it treats cookies and password managers are unverified; they need a real iPhone. `ASWebAuthenticationSession` is the documented alternative if the tab blocks sign-in.
- Android was run on Waydroid (Android 13, x86_64, LineageOS `org.lineageos.jelly` as the only browser) with the `AuthBrowserTest` instrumented class: a fake identity provider and its callback listener on the device loopback, the page opened through the plugin with lazysh in front and with lazysh stopped (notification, tapped through the notification shade, with the session foreground service running), and in both cases the browser followed the redirect to the loopback listener. Waydroid has no Custom Tabs provider, so `launchUrl` fell back to a plain `VIEW` of the same URL into Jelly, with the Custom Tab extras in the intent; how a Chrome Custom Tab renders it is unverified, and so are vendor background killers on real phones. The test process outlives the app being in the background anyway, so the run shows the combination works, not that the foreground service is what keeps a listener alive; that is the existing session service's job.
- The tap on the notification starts the browser as its own task (`FLAG_ACTIVITY_NEW_TASK`, observed on Waydroid), so after signing in switch back to lazysh from the app switcher.
