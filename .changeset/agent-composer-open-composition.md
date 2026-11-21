---
"@lazysh/client": patch
---

fix(agent-view): keep Send, Stage and Stop usable while a touch keyboard holds an open composition

Fix the Agent view's Send and Stop buttons staying disabled while a touch keyboard keeps the last word of the draft as an open composition (#1840). Seen on an Android 13 WebView (Waydroid, LatinIME) in 3 of about 12 runs: after a paste the field got `compositionstart` and `compositionupdate` but never `compositionend`, so both buttons were disabled with the draft intact and no message. The buttons now stay enabled; tapping Send, Stage in terminal or Stop first leaves the field, which ends the composition as a tap elsewhere does, then acts on the committed draft once. Enter on a hardware keyboard is still ignored while composing. Not yet checked on a physical phone with Gboard or SwiftKey, so #1840 stays open for that check; no defaults change.
