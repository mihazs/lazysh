# Installable product skills

The companion packages two original Markdown skills: `lazysh-host-setup` for
host/transport/companion readiness, and `lazysh-agent-reporting` for the existing
Claude/Codex configuration fragments, OpenCode plugin and explicit generic
lifecycle protocol. Its guidance preserves the selected profile and normal
Codex hook trust review. Installing a skill
does not install hooks, change provider settings, start a service or make a
recorded transcript into a live terminal association.

Preview the packaged content without reading or writing an agent profile:

```sh
lazysh-agent skills preview --skill host-setup
lazysh-agent skills preview --skill agent-reporting
```

Explicit profile installation is supported on Linux and macOS for Claude and
Codex. The profile directory must already exist. `--profile-root` selects that
agent's configuration directory, not its `skills` subdirectory. Without it,
Claude uses `CLAUDE_CONFIG_DIR` or `~/.claude`; Codex uses `CODEX_HOME` or
`~/.codex`. Empty, relative, linked or unsafe routes fail instead of falling
back to another profile. Other platforms can preview content but report profile
installation as unsupported before accessing a profile.

Inspect the exact destination and its preimage before installation:

```sh
lazysh-agent skills status --agent codex --skill host-setup \
  --profile-root /absolute/path/to/existing/codex-profile
```

The JSON includes the packaged version/hash, current owned-file identity and
separate `installPlanSha256` and `removePlanSha256` values. Status is read-only,
including when the profile has no skills directory. Use the appropriate hash
from that inspection for the requested action:

```sh
lazysh-agent skills install --agent codex --skill host-setup \
  --profile-root /absolute/path/to/existing/codex-profile --expected-plan HASH
lazysh-agent skills remove --agent codex --skill host-setup \
  --profile-root /absolute/path/to/existing/codex-profile --expected-plan HASH
```

`install` also updates an older owned skill. A changed source, destination or
preimage invalidates a plan; inspect again and review the change before using a
new hash. Identical content is reused, and removing an absent skill writes
nothing. No command bootstraps an agent profile or changes its permissions.

Each managed skill has one private `SKILL.md` with a trailing ownership receipt
binding its product, name, version and body hash. Existing folders without that
valid receipt, edited content, extra files, links, hard links, wrong ownership,
unsafe permissions and oversized files are refused for both update and removal.
Do not remove the receipt or hand-edit the managed file; keep personal guidance
in a separate skill. A receipt is local ownership bookkeeping, not a signature
or authentication boundary against another process running as the same user.

Writes use retained directory descriptors, a per-profile
`.lazysh-product-skills.lock`, staged private content and atomic publication.
Existing agent configuration and other skills remain untouched. A successful
operation reports `installed`, `reused`, `removed` or `absent`.
`committedDurabilityUnknown` with `committed: true` means the namespace operation
happened but final sync/verification or directory cleanup could not be confirmed;
inspect the result before attempting another mutation. Removal leaves the shared
skills root and per-profile lock in place.

The installation commands are explicit user actions. Merely shipping or
previewing these assets does not install them into this repository's active
agent environment. No inline-visual skill is provided because these workflows
do not implement a renderer.
