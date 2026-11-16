---
"@lazysh/client": patch
---

Run the Agent view's mid-turn Terminal, Agent, Terminal round trip, a prompt sent from its composer as one bracketed paste and Enter, a prompt typed through the Android terminal input and Android Back through the real Android UI against a stand-in OpenCode agent in a real tmux pane (`native-android-tmux`, `ownedTmuxOpenCodeAgentViewThroughRealUi`). The Android case of the Claude-style stand-in now selects its flavour (`report` or `opencode`) and `native-android-tmux` installs `sqlite3` for the OpenCode one. Test and fixture only: the application is unchanged.
