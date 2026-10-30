# AI account usage

The compact terminal status button opens live provider quotas, balances, reset times and banked reset credits. Recorded transcript token counters remain in the separate transcript usage inspector. Account selection is explicit: the account shown is not inferred from a running agent.

The query runs on the session machine. Android and desktop remote terminals require a current lazysh companion on the connected host (install or update it from Agents); desktop local terminals use the same built-in collectors locally. A compatible `ai-usagebar usage --json` installation is preferred only when its selected reporting configuration disables context monitoring and explicitly disables notifications, and inline credentials already have safe ownership and permissions. The exact preflighted configuration is passed with `--config`; other profiles use the built-in fallback without changing settings. If the executable is missing, fails, times out or produces an unsupported report, built-in collectors provide the fallback. Installing ai-usagebar is optional.

Credentials remain on the host. The app receives a bounded report with provider labels, quota percentages, balance values, reset timestamps and freshness. It does not receive OAuth credentials, API keys, transcript context, live-session titles, arbitrary report blocks or raw provider error bodies.

## Configuration

Sign in with the provider's existing CLI or configure its host-side API key. Without a usage configuration file, the companion enables providers with locally available credentials in memory. It does not change provider settings, install hooks, log in, scan transcripts, send desktop notifications or create a configuration file.

To choose providers explicitly, create `account-usage.toml` in the host's platform `lazysh` config directory: `$XDG_CONFIG_HOME/lazysh/` or `~/.config/lazysh/` on Linux, `~/Library/Application Support/lazysh/` on macOS, or `%APPDATA%\\lazysh\\config\\` on Windows. Existing ai-usagebar configuration is read when no lazysh usage configuration exists. Explicit disabled providers stay disabled. On Unix hosts, configuration containing inline credentials must be private to its owner; the companion refuses unsafe ownership/permissions and never changes them. External-CLI profiles containing inline keys are not used on Windows because that preflight does not establish Windows ACL privacy; built-in host collectors remain available.

Configuration follows the pinned [ai-usagebar schema](https://github.com/akitaonrails/ai-usagebar/blob/7b0da9a774358283328850620509404e29262431/docs/configuration.md). For example:

```toml
[anthropic]
enabled = true
[openai]
enabled = true
[copilot]
enabled = false
```

The built-in collector code is derived from MIT-licensed ai-usagebar 1.46.0, source `7b0da9a774358283328850620509404e29262431`. Its license and extraction patches are recorded in `packages/ai-usagebar-vendor/`.

## Provider authentication

| Provider | Existing authentication used on the host |
| --- | --- |
| Claude | Claude CLI OAuth file; macOS login Keychain; configured named accounts |
| Anthropic API | Organization Admin key, not an inference key |
| Codex | Official Codex CLI OAuth file and configured named accounts |
| GitHub Copilot | GitHub CLI OAuth or explicit token override |
| Z.AI, OpenRouter, DeepSeek, DeepInfra | Host API key; configured accounts where supported |
| Kimi | Kimi CLI login or API key |
| Kilo, Novita, Synthetic, Lyceum, OrcaRouter | Host API key |
| Moonshot | Host API key and configured region |
| Grok API | Management key, not an inference key |
| SuperGrok | Existing Grok CLI sign-in |
| Grok Bot | Existing desktop sign-in on Linux/macOS |
| MiniMax | Token Plan subscription key and region |
| Antigravity | Existing local service, CLI, saved Google session or status-line data |
| Cursor | Existing Cursor IDE or cursor-agent sign-in |
| Kiro | Existing kiro-cli sign-in |
| Nous Research | Existing saved OAuth credential |
| OpenCode Go | Existing OpenCode sign-in or API key |
| Command Code | Existing Command Code or pi sign-in, or API key |
| Model Studio | Existing Alibaba `bl auth login --console` sign-in |
| Devin | Existing official Devin CLI sign-in |
| Droid / Factory | Existing Linux Droid keyring and Secret Service |
| Cline / ClinePass | Existing Cline sign-in or API key |
| Muse Code | Existing file-based Muse CLI OAuth sign-in |
| Ollama | Ollama Cloud API key (local daemon and registry sign-ins do not expose quota) |
| Custom providers | Explicit host configuration and static token |

Platform-specific authentication keeps its upstream limitations: a Linux-only Secret Service credential cannot be read on Windows, and macOS-only Claude Desktop profiles require macOS. Missing or expired credentials are unavailable states, never zero usage. API keys and sign-ins do not establish that a subscription exposes a quota API.

## Refresh and freshness

The selected terminal refreshes while the app is visible, normally every five minutes. Refresh is single-flight. Account switches and closed sessions cannot publish another host's results. A failed refresh retains the last successful snapshot with a stale indication. Every provider can report unavailable data independently; an inaccessible provider does not imply that other accounts have zero remaining quota.

Collection is bounded. An external CLI has six seconds; the built-in worker has eighteen seconds, including a sixteen-second collection budget, with at most four provider groups running concurrently and accounts within a provider serialized. A provider that exceeds the deadline remains visible as unavailable. Native access revocation or local session closure retires a read. Remote requests use a private channel mode: stdin EOF and HUP/TERM/INT stop the supervisor read and its owned worker/helper processes. A closed Mosh SSH control connection needs explicit host-tools recovery; account usage never silently reconnects.

A percentage reported above 100 remains above 100 in text; only the meter fill is capped. Refill gauges retain their “left” meaning. Value headlines and balance-only providers remain amounts; no percentage or reset date is invented.

## Retained notices and packaged validation

Standalone companions retain the collector MIT license, adapter attribution and
Herdr Apache 2.0 license in `lazysh-agent licenses` JSON output. Release validation
compares those bodies exactly on all five companion targets.

On Linux and macOS, packaged validation also executes `account-usage` with an
owned explicit profile disabling every provider, isolated HOME/config paths and
an empty tool search path; it requires a built-in empty report and unchanged
configuration. This checks the real worker without provider authentication. That
packaged worker check does not run on Windows: its known-folder API ignores
HOME/APPDATA overrides. Windows process ownership is covered separately by the
actual suspended-start/job-cancellation test; compilation and retained notices
do not establish provider authentication or live quota acceptance.
