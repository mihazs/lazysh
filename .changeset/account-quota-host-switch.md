---
"@lazysh/agent": minor
"@lazysh/account-usage": minor
"@lazysh/client": minor
---

feat(usage): let a host forbid account quota reads

Let a host forbid account quota reads (#1588, slice of #18). `lazysh-agent usage-collection show` and `usage-collection update --expected-revision R --account-quota-enabled true|false` read and change a new `usage-collection.json` policy beside `settings.json`. With the switch off, `lazysh-agent account-usage` answers a new `disabled` state with no report before it opens a credential, starts a helper or contacts a provider, and the app shows that the host does not allow account usage reads, in English, Portuguese and Spanish, with no percentage. The default is on, so nothing changes for existing hosts; an unreadable policy fails the read closed.
