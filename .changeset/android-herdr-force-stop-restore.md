---
"@lazysh/client": patch
---
test(android): prove the stock Herdr display restores only on click after a force-stop and relaunch


Verify through the real Android app that a force-stopped and relaunched app offers "Restore previous workspace" only on click and then reattaches the same stock Herdr display with the saved credential. The owned stock Herdr job runs it as two instrumentation processes with a host force-stop between them and checks the receiver's bytes are the ones typed before it.
