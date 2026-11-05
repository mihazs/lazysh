---
"@lazysh/client": patch
---

Fully reveal each owned Android native select inside its scroll panel before the unchanged centre hit-test and native tap, so a recorded-source selector left partly clipped under the context navigation by an earlier keyboard scroll is no longer tapped through the navigation. This test-only repair keeps every geometry, ownership and chooser assertion and does not change application behavior.
