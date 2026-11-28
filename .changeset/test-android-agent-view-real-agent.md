---
"@lazysh/client": patch
---

test(android): follow a reporting agent pane through the Agent view on the emulator

`ownedTmuxAgentViewThroughRealUi` (`native-android-tmux`) runs the hook-reporting stand-in agent in a real tmux pane and drives only the packaged UI: a mid-turn Terminal, Agent, Terminal round trip, a prompt sent from the Agent view composer, a prompt typed through the Android terminal input and Android Back. A prompt submitted to the stand-in now also ends a held turn. Test and fixture only: the application is unchanged.
