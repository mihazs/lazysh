---
"@lazysh/agent": patch
---

Avoid reporting a completed Amp turn from an initially idle thread. The updated manual plugin reports idle only after observing that thread running, and does not treat an error followed by idle as recovery. Replace previously copied Amp plugin files to receive this fix; existing historical reports are unchanged.
