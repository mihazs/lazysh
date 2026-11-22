---
"@lazysh/client": patch
---

test(android): drive the Share dialog against a real share service over TLS

An owned Android runtime case for the optional sharing service (#994, #1738): through the real Share dialog it saves the service origin and management token, uploads an image, lists it in the history, loads and decodes its thumbnail, copies its expiring link and deletes it behind the native confirmation, while the host serves the repository's own `lazysh-share` binary over TLS behind a throwaway root and checks the service's stored bytes, the link and the deletion after each step. Debug builds of the app gain one test-only trust anchor, read from the `LAZYSH_TEST_SHARE_ROOT_PEM` environment variable; release builds compile it out and trust the public roots only, so shipped behaviour is unchanged.
