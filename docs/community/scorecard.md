# Weekly adoption scorecard

The triaging maintainer records one snapshot every Monday, using UTC cutoffs,
and chooses one documented friction point to improve. No application telemetry
is introduced. Use aggregate GitHub data and voluntary, sanitized feedback only.
Store weekly public summaries in `docs/community/metrics/YYYY-MM-DD.md` through
review; keep raw identifiable feedback out of the repository.

| Metric | Source and counting rule | Baseline |
| --- | --- | --- |
| Visitors, views and full clones | GitHub Insights → Traffic; preserve daily UTC buckets and capture date | Unavailable |
| Referring sites | Traffic top referrers, aggregated; excludes some sources | Unavailable |
| Stars/forks | Repository totals at each snapshot, net change from prior snapshot | 1 / 0 observed 2026-10-31; not adoption |
| Release downloads | Releases API asset `download_count`, by version/platform/flavor; delta between snapshots | Not collected |
| External issues and meaningful feedback | Review created issues in the week; exclude maintainer/bot-created backlog and spam; link useful reports | Not collected |
| External PRs received/merged | Paginated PR history, authored outside current maintainers and bots; separate opened and merged timestamps | Not collected |
| First-time / returning contributors | Actual merged PR authors across full public history, not GitHub's abbreviated contributors list | Not collected |
| First maintainer response | Median hours from external issue creation to first human maintainer reply; exclude bot/self replies; report sample size and unanswered separately | Unavailable |
| First successful SSH connection | Voluntary version/platform-specific report, with consent to publish summary and no host information | Unavailable |
| Installations / active users / retention | Not measurable from downloads or stars | Unavailable |

For authenticated CLI collection, run `gh api repos/mihazs/lazysh`, then
`gh api --paginate repos/mihazs/lazysh/releases` and
`gh api --paginate 'repos/mihazs/lazysh/pulls?state=all&per_page=100'`.
Use `gh api --paginate 'repos/mihazs/lazysh/issues?state=all&per_page=100'` for
issues, remembering that the endpoint also includes PRs. Retrieve issue comments
when measuring response time. These are maintainer collection instructions, not
claims that authenticated CLI collection ran in this assignment.

[Traffic API](https://docs.github.com/en/rest/metrics/traffic) paths are
`repos/mihazs/lazysh/traffic/views?per=day`, `traffic/clones?per=day` and
`traffic/popular/referrers` under the same repository prefix. Traffic access
requires sufficient permissions; a 403 means unavailable, not zero. Do not
broaden repository tokens merely for a report; the Insights UI is a fallback.

GitHub retains a limited **14-day** Traffic window. Collect weekly to avoid
history gaps. Merge daily buckets by timestamp when windows overlap; do not sum
overlapping 14-day totals or daily unique visitors into “weekly unique users.”
Net stars can be negative; download deltas can reset when assets are replaced.
Annotate replacement/republication and preserve missing data instead of guessing.

## Weekly entry template

Record week start/end, collection timestamp, source endpoints/UI, access gaps,
metric value and denominator/sample size, linked feedback, one observed obstacle,
one next action and its owner role. Start with “No baseline” where necessary.
Do not set percentage growth targets before a reliable baseline exists. Ask
whether a documented improvement reduced a reported obstacle; do not infer
causality from a change in stars or a single week's downloads.

References: [GitHub Traffic retention and UTC behavior](https://docs.github.com/en/repositories/viewing-activity-and-data-for-your-repository/viewing-traffic-to-a-repository),
[release assets API](https://docs.github.com/en/rest/releases/assets).
