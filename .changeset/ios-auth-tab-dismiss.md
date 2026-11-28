---
"@lazysh/client": minor
---

feat(auth): close the iOS sign-in tab when the sign-in tunnel ends

On iPhone, the sign-in page lazysh opens now closes by itself when the tunnel ends (callback delivered, timeout or cancel) instead of staying over the app until you tap Done.
