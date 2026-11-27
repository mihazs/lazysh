---
"@lazysh/client": patch
---

fix(bench): run only the Android terminal benchmark method

The packaged benchmark collects its own AndroidJUnitRunner result when the optional SwiftKey test is present.
