---
"@lazysh/agent": patch
---

Add the closed list of browser protocol methods and page addresses that the host browser relay may send (`host_browser::allow`): cookies and storage, script and DOM access, downloads and file choosers, permissions and the clipboard, and every address but `http`, `https` and `about:blank` are refused, as is any method that is not named. The hidden developer launcher applies the same address rule to its first page. Nothing changes for users: the relay that uses the list ships with the Chrome viewer.
