---
"@lazysh/client": patch
---

Add the keyboard side of an Android native terminal surface for developer builds: an app-owned `InputConnection` that holds composing text on the device, turns autocorrect and prediction edits into the shortest edit on the host and never replays an edit it cannot follow, and forwards hardware keys as key identities for the shared core to encode. Nothing in the app creates it yet, so xterm.js stays the only engine and the default and nothing changes for users; this is groundwork for the Android native-engine opt-in.
