---
"@lazysh/client": patch
---

Add a native Android case for the phone's focused agent report (#954). In the companion board acceptance, a real `UiDevice.pressBack()` from the report detail of a filtered list must return to that list with its search value and the focused row, still on Agents, with `document.hasFocus()` true. Test-only: no behavior change, and the case has not run on an emulator yet.
