---
"@lazysh/client": patch
---

Add three owned Android real-UI cases for SSH key management (#986): a private key file chosen through the system file chooser is inspected, matched against the fingerprint `ssh-keygen -l` reports and logs in; a public key is refused in the identity panel and in the connection form before any authentication request; and a generated key is copied to the OS clipboard, authorized on the owned sshd and logs in. Test-only; no behavior change.
