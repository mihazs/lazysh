---
"@lazysh/client": patch
---

test(agents): stop the dialog picker's digit-key test from timing out at random in CI

The test pressed the digit as soon as the option was enabled, which could be
before the picker began listening for keys on a busy runner; the key was then
lost and the test waited out its 5 s limit. It now runs the 400 ms safety delay
on fake timers inside `act()`, so the listener is attached before the key is
pressed. Its assertions are unchanged, and the app's behaviour does not change.
