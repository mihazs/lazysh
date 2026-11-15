---
"@lazysh/client": patch
---

Run the Agent view's mid-turn Terminal, Agent, Terminal round trip, a prompt sent from its composer, a prompt typed through the Android terminal input and Android Back through the real Android UI against the hook-reporting stand-in agent in a real tmux pane (`native-android-tmux`, `ownedTmuxAgentViewThroughRealUi`). A prompt submitted to the stand-in now also ends a held turn. Test and fixture only: the application is unchanged.
