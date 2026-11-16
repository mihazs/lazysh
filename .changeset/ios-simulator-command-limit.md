---
"@lazysh/agent": patch
"@lazysh/client": patch
---

fix(ios): answer a slow Simulator boot, shutdown or reboot as requested instead of DeviceTimeout

Answer an iOS Simulator boot, shutdown or reboot that `simctl` is still carrying out after ten seconds as requested instead of `DeviceTimeout`, report a reboot whose shutdown is still running as `shutting_down`, report slow iOS discovery as a warning after one retry, and show a note for each answer in the Devices panel. Changed response shape: an iOS reboot can answer `status: "shutting_down"`.
