---
"@lazysh/client": patch
---

test(agents): press the real Android Back button from the phone report detail

In the companion board acceptance, a real `UiDevice.pressBack()` from the report detail of a filtered list must return to that list with its search value and the focused row, still on Agents, with `document.hasFocus()` true (#954). Test-only: no behavior change, and the case has not run on an emulator yet.
