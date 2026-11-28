---
"@lazysh/client": patch
---

fix(release): keep a published release from ending red when its assets answer 403 for a moment

The check that downloads the published Herdr assets ran one second after publication and failed the whole publish job on a transient 403. It now retries transient answers with a bounded backoff and sends the workflow token to the GitHub API.
