---
"@lazysh/client": patch
---

Add an owned Android runtime case for Files and repository review over OpenSSH (#994, #1737): through the real UI it browses a host directory over SFTP, reads a text file and meets the not-UTF-8 and over-1-MiB refusals, then opens a Git repository and checks modified, staged and untracked entries, their diffs, a binary diff refusal, the history list, a historical commit's tree and file, and that leaving the review and returning reopens the remembered revision and file. The owned sshd gains an opt-in SFTP subsystem for this. Test infrastructure only; the app is unchanged.
