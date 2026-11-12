---
"@lazysh/client": patch
---

Fix terminal URLs that wrap over several rows: soft-wrapped and conservatively detected hard-wrapped URLs (including inside boxed TUIs) are tapped as one whole address, trailing punctuation and unbalanced closing brackets are trimmed, OSC 8 hyperlinks use the same Open in browser / Copy URL confirmation and win over detection.
