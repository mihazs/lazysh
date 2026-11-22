---
"@lazysh/client": patch
---

fix(tmux): stop Jump To and Chat input from crashing your tmux server when another client connects

tmux 3.4 to 3.7c kill the whole server (SIGSEGV, every session lost) when a format walks the clients while a new client has connected but not yet sent its terminal name, and the guards behind Jump To, the display admission and Chat input walked them. The guards now read a client's terminal only after tmux reports that client's session and process, so a command run from another terminal at the same moment no longer takes the server down.
