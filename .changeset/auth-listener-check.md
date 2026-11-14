---
"@lazysh/client": minor
---

Check a sign-in hint against the host's listeners. A new native command asks the host which process listens on the port a sign-in command printed (the host companion's `lazysh-agent listeners`, or `ss` and `lsof` for a companion that predates it) and tells whether the listener started within two minutes before or half a minute after the hint, is older, is another user's, or is not there; `confirmHint` turns a series of answers into one confirmation, counting a listener that appeared after the port was empty. Nothing is tunnelled and no screen uses it yet.
