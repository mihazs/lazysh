---
"@lazysh/client": patch
---

fix(release): restore publishing by moving the managed Herdr target directory out of the job-level env

The release workflow was rejected by GitHub because a job-level env value read the runner context, so no version could be published after the managed Herdr job was added. The target directory is now exported from a step.
