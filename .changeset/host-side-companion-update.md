---
"@lazysh/client": minor
---

Update the host companion on the host instead of downloading it on the phone. **Install companion** and **Update companion** now send the host a pin (version, size and SHA-256 verified from the release metadata) and the host downloads, verifies, self-tests and installs the companion itself; the phone fetches only the small metadata. Changed default: the phone's connection to GitHub is no longer used for the transfer.
