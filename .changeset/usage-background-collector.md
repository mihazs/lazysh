---
"@lazysh/agent": minor
---

Add the opt-in usage collector (#1588, slice of #18). `lazysh-agent usage-collector enable [--interval-minutes N]` installs a user-level timer (a systemd user timer, a launchd agent or a Scheduled Task, no sudo) that wakes `usage-collector run` every five minutes, and `disable` removes it. While it is on, a run records one bounded sample of the account quota report per interval (percentages, resets and staleness only: no plan, balance, credential, prompt or path) in `usage-samples.json`, at most 1000 samples, 7 days and 1 MiB. `status [--limit N]` shows the policy, the timer, the last run and the samples with the host's clock. It is off by default, nothing runs or is written while it is off, and it honors the account quota switch.
