---
"@lazysh/client": minor
---

feat(agents): add an opt-in "All hosts" scope to the Agents board

Part of #1743 and #991. With two or more saved hosts connected, a "This host / All hosts" switch appears above the board; "This host" stays the default and the per-connection board is unchanged. "All hosts" reads the reported activity of every connected host and groups it by state, then host, then project. Each host is read through its own connection every five seconds while the board is shown (up to 32 hosts, four reads at a time; sessions of one saved host count once), and a host that cannot answer shows its own error row while the others stay. A row opens that host's connection, like an inbox notification. Archive and Restore stay on each host's own board under its own key: the merged board only hides what that board archived. Nothing changes on the host or on disk and no default changes.
