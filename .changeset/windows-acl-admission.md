---
"@lazysh/common": patch
---

Add the Windows SID and DACL check that native Windows companion installation will rely on (#490): from an object's owner and access entries it decides whether the object is private to the current user or only unchangeable by others, and refuses links and junctions. No command uses it yet and Windows installation stays unsupported.
