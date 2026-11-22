---
"@lazysh/agent": patch
---

feat(browser): keep the host browser relay's profile until Clear browser data

Add `--keep-profile` to the hidden host browser relay (`lazysh-agent host-browser serve --keep-profile`): the session uses the one kept profile, leaves it for `host-browser --clear-data`, and is refused while another browser holds it. Without the option the relay stays ephemeral. Nothing is offered in the app yet; no defaults change.

Updated companions coordinate stale profile recovery and clearing. Stop older companion sessions before using a kept profile or clearing browser data, as older versions do not participate in this coordination.

The browser is now stopped with SIGTERM to its main process first, so what a page stored in the kept profile (`localStorage`) survives a prompt stop (#2045); only a browser that has not exited in three seconds has its whole process group killed.
