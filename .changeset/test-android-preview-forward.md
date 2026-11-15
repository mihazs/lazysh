---
"@lazysh/client": patch
---

Add an owned Android runtime case for browser previews over OpenSSH (#994, #1736): through the real UI it discovers an owned host listener with a one-port allowlist, opens it, checks that the WebView's iframe and a device loopback request both reach the host listener through the forward and that sshd opened a direct-tcpip channel to it, then closes the preview and ends the session and checks that the device loopback port refuses each time. Test infrastructure only; the app is unchanged.
