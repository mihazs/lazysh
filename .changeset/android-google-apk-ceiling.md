---
"@lazysh/client": patch
---

fix(release): publish releases again by admitting the Google Android APK that carries the Parakeet runtime

Every release after 1.83.1 stopped in the Android packaging step: the Google APK, which
now links the Parakeet speech runtime, is 51.6 MiB and the release size guard allowed
47 MiB. Its ceiling is now 78 MiB, 1.5 times the measured size. The FOSS APK keeps its
47 MiB ceiling, and the guard still refuses a missing, linked, empty or oversized
package. Changed defaults: none.
