---
"@lazysh/agent": minor
---

feat(notifications): add opt-in switches that keep nested-agent and unlocked-desktop events off the relay

`lazysh-agent settings notifications show|update` keeps events of an agent that another agent started, and events raised while the host's desktop is unlocked, out of the relay notification queue. Both switches default to off and live in their own `notification-policy.json`, so an older companion keeps reading `settings.json`. A nested agent's Claude permission request takes no approval while the first switch is on. Unlocked-desktop detection is Linux only; macOS and Windows always notify.
