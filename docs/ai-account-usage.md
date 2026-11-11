# AI account usage

The compact terminal status button opens live provider quotas, balances, reset times and banked reset credits. Recorded transcript token counters remain in the separate transcript usage inspector.

## The status bar follows the current agent

By default the status-bar usage item shows the account of the agent running in the pane you are looking at. One host report holds every enabled account, so following costs no extra account query: the item only picks the matching entry.

How the pane's agent is found, while the item is on screen:

- **Herdr:** the agent Herdr reports for the focused pane of the attached server (`panes[].focused` of the same snapshot the Agent view reads), every 5 seconds.
- **tmux:** the newest companion hook report whose `TMUX_PANE` is the attached pane (reports from before the agent's `Session ended` event are ignored), every 5 seconds. This needs a companion that records hook reports; an older companion shows no agent.
- **Anything else** (a plain shell connection, Zellij, a local terminal): no pane identity exists, so no agent is detected and the default account shows.

| Agent (Herdr label or hook-report name) | Account (report entry id) |
| --- | --- |
| Claude Code (`claude`) | Claude (`anthropic`, or its first named account `anthropic@name`) |
| Codex (`codex`) | Codex (`openai`) |
| GitHub Copilot CLI (`copilot`) | GitHub Copilot (`copilot`) |
| Cursor CLI (`cursor`) | Cursor (`cursor`) |
| Droid (`droid`) | Droid (`droid`) |
| Kimi CLI (`kimi`) | Kimi (`kimi`) |
| Cline (`cline`) | Cline (`cline`) |
| Kiro (`kiro`) | Kiro (`kiro`) |
| Devin (`devin`) | Devin (`devin`) |
| Antigravity (`agy`) | Antigravity (`antigravity`) |
| Grok (`grok`) | SuperGrok (`supergrok`) |
| Hermes (`hermes`) | Nous Research (`nous`) |
| Kilo (`kilo`) | Kilo (`kilo`) |
| Muse (`muse`) | Muse Code (`muse-code`) |
| OpenCode (`opencode`) | OpenCode Go (`opencode-go`) |
| Command Code | Command Code (`commandcode`) |

Agents without a supported account collector (Gemini CLI, Amp, pi, omp, Mastra Code, Qoder CLI, Qwen Code, Letta, Maki, Aider) show "No usage for <agent>"; they never show another agent's quota. A mapped agent whose account the host did not report shows "<provider>: no account reported". The remaining built-in providers (Anthropic API, Z.AI, OpenRouter, DeepSeek, DeepInfra, Novita, Synthetic, Moonshot, Grok API, Grok Bot, MiniMax, Ollama Cloud, OrcaRouter, Model Studio, Lyceum) are inference APIs or aggregators with no agent of their own; choose them, or a custom provider the host reports, under **Always show a chosen account**.

Preferences → Agents and notifications → AI account usage: **Follow the current agent** (the default), **Always show a chosen account**, or **Hide the usage item**. The provider picker names the account shown in the second mode and when no agent is detected in the first; empty means the host's default account (the report's `primary`). Earlier versions kept no account choice of their own (they showed the host's default account), so there was nothing to migrate. The settings sync as `usageItem` and `usageProvider`, which are omitted at their defaults so older peers accept the snapshot.

The AI account usage page always opens on the account the item follows, with its own account picker for browsing others; a pick there lasts only until the followed agent changes.

The query runs on the session machine. Android and desktop remote terminals require a current lazysh companion on the connected host (install or update it from Agents); desktop local terminals use the same built-in collectors locally. A compatible `ai-usagebar usage --json` installation is preferred only when its selected reporting configuration disables context monitoring and explicitly disables notifications, and inline credentials already have safe ownership and permissions. The exact preflighted configuration is passed with `--config`; other profiles use the built-in fallback without changing settings. If the executable is missing, fails, times out or produces an unsupported report, built-in collectors provide the fallback. Installing ai-usagebar is optional.

Credentials remain on the host. The app receives a bounded report with provider labels, quota percentages, balance values, reset timestamps and freshness. It does not receive OAuth credentials, API keys, transcript context, live-session titles, arbitrary report blocks or raw provider error bodies.

## Configuration

Sign in with the provider's existing CLI or configure its host-side API key. Without a usage configuration file, the companion enables providers with locally available credentials in memory. For automatic [Codex discovery](https://learn.chatgpt.com/docs/auth), a nonempty host `CODEX_HOME` selects its `auth.json`; otherwise the normal home-directory default applies. Whitespace-only values use that default. Nonempty overrides must be absolute, bounded paths without control or dot/parent components; invalid overrides report usage as unavailable instead of silently choosing another account. Explicit usage profiles retain their configured paths, accounts and disabled providers; set `openai.codex_auth_path` there for a nonstandard Codex home. No login or quota success is inferred just from finding a file.

It does not change provider settings, install hooks, log in, scan transcripts, send desktop notifications or create a configuration file.

To choose providers explicitly, create `account-usage.toml` in the host's platform `lazysh` config directory: `$XDG_CONFIG_HOME/lazysh/` or `~/.config/lazysh/` on Linux, `~/Library/Application Support/lazysh/` on macOS, or `%APPDATA%\\lazysh\\config\\` on Windows. Existing ai-usagebar configuration is read when no lazysh usage configuration exists. Explicit disabled providers stay disabled. On Unix hosts, configuration containing inline credentials must be private to its owner; the companion refuses unsafe ownership/permissions and never changes them. External-CLI profiles containing inline keys are not used on Windows because that preflight does not establish Windows ACL privacy; built-in host collectors remain available.

Cline CLI 3.0.74 store selection follows `CLINE_PROVIDER_SETTINGS_PATH`, then
`CLINE_DATA_DIR/settings/providers.json`, then
`CLINE_DIR/data/settings/providers.json`, otherwise
`~/.cline/data/settings/providers.json`. Overrides use Cline's JavaScript trim
rules, including relative paths against the companion's working directory.
Explicit `[cline].auth_paths` and API keys take precedence. A missing or malformed
selected store never silently reads another default login. The saved Cline-family
`lastUsedProvider` selects `cline` or `cline-pass`; other selections or an absent
selection use canonical `cline`. A selected pass entry inherits canonical auth
only when its own auth property is absent. Expiry never ranks different accounts,
and invalid selected auth never falls through to another account.

The reader validates all provider entries against the pinned Cline 3.0.74
structural store schema, including required version, provider and timestamps;
unknown fields remain compatible. A store that a later Cline release writes with
values outside that pinned schema, such as a new enum value in any provider
entry, is treated as unavailable rather than partially read, including through
`auth_paths`; an explicit API key still works until the pinned schema is updated.
Stores must resolve to regular files and fit within 1 MiB. Ordinary symlinks to regular stores are supported. Unix opens are
nonblocking to reject a FIFO replacement without hanging. Nondefault environment
store overrides are unavailable on Windows until a bounded Windows reader is
qualified; existing explicit `auth_paths`, canonical store and API keys retain
precedence. Windows explicit/default paths keep their prior synchronous-open race
limitation and have not received native acceptance in this change. OAuth store tokens and
explicit usage/environment API keys are supported; stored manual `settings.apiKey`
or `auth.apiKey` credentials are not discovered. This does not establish a valid
subscription or successful quota request. An owned 892-case differential corpus
matches the pinned schema under Zod 4.4.3 on Node and Bun; it does not prove every
JavaScript/Rust URL-parser edge or CLI runtime behavior. Primary contracts:
[Cline storage paths](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/sdk/packages/shared/src/storage/paths.ts),
[CLI selection](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/apps/cli/src/main.ts),
[store schema](https://github.com/cline/cline/blob/071e1b25b48f9ef5dff7fc32085e6a16f02bf02e/sdk/packages/core/src/types/provider-settings.ts).

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
