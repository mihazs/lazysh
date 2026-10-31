---
{}
---

Diagnostic-only follow-up for #494: count a finite set of existing English access-check,
locked/error and workspace controls through the same owned-HWND UIA query. Counts are
limited to eligible controls and capped at two; they never make the failed WebDriver
session or GUI acceptance pass. All ownership, physical bounds, timeout and cleanup
fences remain required.

The same single query also exposes an optional, separate bounded owned Document
role count, independent of names and locale. One eligible document does not prove
its URL, JavaScript, IPC, paint, startup cause or frontend acceptance; zero or
multiple documents remain ambiguous. No document name, value, URL or text is exported.

The labels are checked against the current English source. No OS locale is forced or
inferred: zero matches, an unknown locale, inaccessible provider or ambiguous result
cannot establish that the document, JavaScript or React is absent. No raw text/tree,
click/focus action, app IPC, script injection, browser flag or retry is added.
This empty fragment remains an internal follow-up covered by the planned release,
not a separately completed or published milestone.
