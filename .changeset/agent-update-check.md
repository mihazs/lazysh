---
"@lazysh/agent": minor
---

Add `lazysh-agent update --check` and `--status`: the host companion asks GitHub's release metadata over HTTPS, verified against the release's own digests, whether a newer companion exists, with a JSON result and documented exit codes.
