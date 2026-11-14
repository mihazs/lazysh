---
"@lazysh/client": minor
---

Open a sign-in page on the device that runs lazysh: new `open_auth_url` and `inspect_auth_url` commands. A phone opens the page in an in-app browser tab (Chrome Custom Tabs on Android, `SFSafariViewController` on iOS) so lazysh stays in front; a desktop opens the system browser. A page whose redirect points at the device's own `localhost:PORT` opens only after something listens on that port. Android 10 and later cannot start a page from the background, so a request that arrives while another app is in front becomes a notification that opens the page when tapped. Nothing calls the commands yet: the consent banner and the tunnel engine arrive in later changes of the sign-in tunnel work (#1504).
