---
"@lazysh/client": patch
---

test(agents): run the Agent view switch against a stand-in OpenCode agent in a real tmux pane

Run the Agent view's mid-turn Terminal, Agent, Terminal round trip, a prompt sent from the Agent view and a prompt typed in the terminal through the real native GUI against a stand-in OpenCode agent in a real tmux pane. The stand-in writes OpenCode 2.2's database and reports `session.status` through the real companion, and its sent prompt must arrive as one bracketed paste and Enter. The tmux cases now start with scrollback in the pane, so the round trip proves it is kept. Test and fixture only: the application is unchanged.
