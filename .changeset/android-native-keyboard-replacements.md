---
"@lazysh/client": patch
---

fix(android): keep the keyboard from replacing native terminal commands on Enter

The native terminal now asks Android keyboards to avoid automatically correcting commands. Shell-provided inline history suggestions remain available.
