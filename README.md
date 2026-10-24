# lazysh

A direct SSH terminal and agent workspace for Android, iOS, macOS, Linux, and Windows, built with Tauri 2, Rust, React, and xterm.js.

Implementation is in progress. Moshi parity is a release objective, not a claim about this initial repository. See the GitHub Project and feature evidence for delivery status.

## Development

Requires Node.js 22+, Rust stable, and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```sh
npm ci
npm run tauri dev
```

The browser development server is a UI preview; direct SSH requires the native Tauri application.

## Platforms

Desktop: `npm run tauri build`.

Android: install Android Studio/SDK/NDK, then `npm run tauri android init` and `npm run tauri android dev`.

iOS: on macOS with Xcode, run `npm run tauri ios init` and `npm run tauri ios dev`. Distribution requires your own Apple signing identity.

lazysh is an independent implementation. It does not distribute Moshi code, branding, or assets.
