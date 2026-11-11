---
"@lazysh/client": patch
"@lazysh/agent": patch
---

Add a developer-only prototype of the host browser: a hidden companion command that starts a throwaway Chrome-family browser on the host and a viewer page that only the Vite development server serves, with a real-browser CI test and a protocol-client unit test. It is off by default, absent from release builds and changes no default.
