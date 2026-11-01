# @lazysh/agent

## 1.7.3

### Patch Changes

- @lazysh/account-usage@1.7.3
  - @lazysh/common@1.7.3
  - @lazysh/notification-client@1.7.3

## 1.7.2

### Patch Changes

- @lazysh/account-usage@1.7.2
  - @lazysh/common@1.7.2
  - @lazysh/notification-client@1.7.2

## 1.7.1

### Patch Changes

- @lazysh/account-usage@1.7.1
  - @lazysh/common@1.7.1
  - @lazysh/notification-client@1.7.1

## 1.7.0

### Minor Changes

- bcc7feb: Add opt-in V3 managed Amp system-plugin setup with protected ownership, shadow-aware removal and bounded V2 metadata compatibility.

### Patch Changes

- @lazysh/account-usage@1.7.0
  - @lazysh/common@1.7.0
  - @lazysh/notification-client@1.7.0

## 1.6.0

### Minor Changes

- aad0990: Add opt-in version-2 hook discovery and inspected, profile-scoped Copilot hook setup while preserving version-1 compatibility, foreign settings and provider trust.

### Patch Changes

- 99d1b8e: Avoid reporting a completed Amp turn from an initially idle thread. The updated manual plugin reports idle only after observing that thread running, and does not treat an error followed by idle as recovery. Replace previously copied Amp plugin files to receive this fix; existing historical reports are unchanged.
- @lazysh/account-usage@1.6.0
  - @lazysh/common@1.6.0
  - @lazysh/notification-client@1.6.0

## 1.5.5

### Patch Changes

- @lazysh/account-usage@1.5.5
  - @lazysh/common@1.5.5
  - @lazysh/notification-client@1.5.5

## 1.5.4

### Patch Changes

- 9bb174c: Finish Copilot child reports with a separate validated session identity while preserving parent state and shared-session completion guards.
- @lazysh/account-usage@1.5.4
  - @lazysh/common@1.5.4
  - @lazysh/notification-client@1.5.4

## 1.5.3

### Patch Changes

- b98d878: Document Linux Copilot CLI 1.0.105 manual-hook qualification for completed root turns and unanswered elicitation attention, including remaining runtime limits.
- @lazysh/account-usage@1.5.3
  - @lazysh/common@1.5.3
  - @lazysh/notification-client@1.5.3

## 1.5.2

### Patch Changes

- dbd55aa: Discover current and legacy Kimi profile metadata while retaining manual-only setup and the legacy 1.52 hook printer contract.
- @lazysh/account-usage@1.5.2
  - @lazysh/common@1.5.2
  - @lazysh/notification-client@1.5.2

## 1.5.1

### Patch Changes

- c630f74: Correct the packaged reporting skill to describe installed-agent discovery and managed Cline setup while preserving explicit selection, inspected plans and plugin policy.
- @lazysh/account-usage@1.5.1
  - @lazysh/common@1.5.1
  - @lazysh/notification-client@1.5.1

## 1.5.0

### Minor Changes

- 8db8a98: Detect installed host agents and known profile locations before explicit hook setup. Let users select a target while preserving inspected installation plans, manual profile selection and provider trust decisions. Discovery never installs hooks or creates missing profiles.
- afc27ec: Add explicit managed Cline root lifecycle plugin setup and profile discovery. Preserve existing plugin restrictions and require inspected install/remove plans; configuration does not establish live reporting.

### Patch Changes

- @lazysh/account-usage@1.5.0
  - @lazysh/common@1.5.0
  - @lazysh/notification-client@1.5.0

## 1.4.2

### Patch Changes

- @lazysh/account-usage@1.4.2
  - @lazysh/common@1.4.2
  - @lazysh/notification-client@1.4.2

## 1.4.1

### Patch Changes

- @lazysh/account-usage@1.4.1
  - @lazysh/common@1.4.1
  - @lazysh/notification-client@1.4.1

## 1.4.0

### Minor Changes

- 3674b0e: Add native Gemini CLI, Droid, Kimi CLI and GitHub Copilot CLI lifecycle reporting with print-only agent-specific configuration fragments.

  Kimi ignores unscoped Stop/StopFailure events to preserve parent state; its hook contract cannot identify per-turn completion.
- 564f7f9: Add a print-only Cline root lifecycle plugin with exact native run identities, bounded companion writes and disposal cleanup. Child runs, permission waits and managed installation remain unsupported; profiles and approval policy are unchanged.
- 54796e0: Browse Herdr spaces and live agent panes from workspace navigation. Reuse or explicitly attach the exact server display, then use stock shared workspace/tab focus or the companion's exact shell/agent pane focus. Disclose shared focus and require fresh Chat confirmation after navigation.
- 0be60d8: Package original host-setup and lifecycle-reporting skills with explicit preview,
  profile status, owned installation/update and removal commands. Preserve agent
  configuration and reject foreign or edited skills; no automatic installation.
- 730cb2a: Add explicit inspected-plan lifecycle hook setup for Claude Code, Codex and OpenCode, with an SSH-connected Agents setup flow and companion CLI.

  Preserve foreign profile values and ordinary file mode/group metadata, refuse unhandled ACLs or ownership conflicts, and keep configured state distinct from trust and live reporting. Managed writes initially support qualified Linux filesystems; other platforms retain preview-only capability.
- 7218f34: Add inspected-profile managed Droid hooks for an already-existing standalone hooks.json, including the connected Agents selector.

  Preserve foreign groups and fallback policy; refuse absent configuration rather than shadowing settings/legacy declarations. No automatic trust changes, fresh-profile migration or native Droid lifecycle claim.
- 7477209: Extend explicit inspected-profile lifecycle hook setup to Gemini CLI and Cursor CLI, including the SSH-connected Agents setup selector.

  Preserve Gemini millisecond deadlines and disable flags, Cursor version-1/fail-open observer semantics, foreign policy and the existing retained filesystem transaction. Other managed providers, macOS writes and actual provider-trusted reporting remain separate gaps.
- 672b24b: Add native Codex lifecycle ingestion and a bounded OpenCode lifecycle plugin with print-only configuration assets.
- e542d41: Add native Cursor activity/completion reporting, an Amp thread-state observer
  plugin and truthful host-wide Aider notification health. Print reviewed assets
  and arguments without changing profiles or permission policy. Aider callbacks
  have no session attribution or lifecycle states and never create session rows.

### Patch Changes

- bc6c84d: Recover built-in account quotas from empty external reports and offer companion setup when a remote usage command is missing or outdated.
- 4f4d872: Initialize companion schema tables and indexes in one deferred transaction, retaining full durability and existing storage wait budgets while rolling back partial schema creation on failure.
- 1cddb34: Support native OpenCode 2.2 and 1.19.5 loading from one reviewed lifecycle plugin asset, with bounded ordered delivery and cleanup on unload. Hook installation and trust remain explicit.
- Updated dependencies [bc6c84d]
  - @lazysh/account-usage@1.4.0
  - @lazysh/common@1.4.0
  - @lazysh/notification-client@1.4.0

## 1.3.3

### Patch Changes

- @lazysh/account-usage@1.3.3
  - @lazysh/common@1.3.3
  - @lazysh/notification-client@1.3.3

## 1.3.2

### Patch Changes

- @lazysh/account-usage@1.3.2
  - @lazysh/common@1.3.2
  - @lazysh/notification-client@1.3.2

## 1.3.1

### Patch Changes

- @lazysh/account-usage@1.3.1
  - @lazysh/common@1.3.1
  - @lazysh/notification-client@1.3.1

## 1.3.0

### Minor Changes

- 9565f8a: Add compact AI account quotas and built-in host collectors when ai-usagebar is unavailable, keeping credentials on the session machine.

### Patch Changes

- Updated dependencies [9565f8a]
  - @lazysh/account-usage@1.3.0
  - @lazysh/common@1.3.0
  - @lazysh/notification-client@1.3.0

## 1.2.0

### Patch Changes

- @lazysh/common@1.2.0
  - @lazysh/notification-client@1.2.0

## 1.1.7

### Patch Changes

- @lazysh/common@1.1.7
  - @lazysh/notification-client@1.1.7

## 1.1.6

### Patch Changes

- @lazysh/common@1.1.6
  - @lazysh/notification-client@1.1.6

## 1.1.5

### Patch Changes

- @lazysh/common@1.1.5
  - @lazysh/notification-client@1.1.5

## 1.1.4

### Patch Changes

- @lazysh/common@1.1.4
  - @lazysh/notification-client@1.1.4

## 1.1.3

### Patch Changes

- @lazysh/common@1.1.3
  - @lazysh/notification-client@1.1.3

## 1.1.2

### Patch Changes

- @lazysh/common@1.1.2
  - @lazysh/notification-client@1.1.2

## 1.1.1

### Patch Changes

- @lazysh/common@1.1.1
  - @lazysh/notification-client@1.1.1

## 1.1.0

### Patch Changes

- @lazysh/common@1.1.0
  - @lazysh/notification-client@1.1.0

## 1.0.2

### Patch Changes

- @lazysh/common@1.0.2
  - @lazysh/notification-client@1.0.2

## 1.0.1

### Patch Changes

- @lazysh/common@1.0.1
  - @lazysh/notification-client@1.0.1

## 1.0.0

### Minor Changes

- 58b3c9f: Add explicit preview-bound Unix companion installation with verified source bytes, a fixed private user namespace and kernel-locked atomic replacement. Windows installation remains explicitly unsupported; existing runtime and data defaults are unchanged.
- e61e477: Publish verified companion executables for Linux x64/ARM64, macOS Intel/ARM64 and Windows x64 in future complete releases, with native staged-byte CLI/storage acceptance and existing source-bound receipts. Existing companion behavior and storage defaults are unchanged.

### Patch Changes

- @lazysh/common@1.0.0
  - @lazysh/notification-client@1.0.0

## 0.23.0

### Patch Changes

- @lazysh/common@0.23.0
  - @lazysh/notification-client@0.23.0

## 0.22.0

### Patch Changes

- @lazysh/common@0.22.0
  - @lazysh/notification-client@0.22.0

## 0.21.0

### Patch Changes

- @lazysh/common@0.21.0
  - @lazysh/notification-client@0.21.0

## 0.20.0

### Patch Changes

- @lazysh/common@0.20.0
  - @lazysh/notification-client@0.20.0

## 0.19.0

### Patch Changes

- @lazysh/common@0.19.0
  - @lazysh/notification-client@0.19.0

## 0.18.0

### Patch Changes

- @lazysh/common@0.18.0
  - @lazysh/notification-client@0.18.0

## 0.17.2

### Patch Changes

- @lazysh/common@0.17.2
  - @lazysh/notification-client@0.17.2

## 0.17.1

### Patch Changes

- @lazysh/common@0.17.1
  - @lazysh/notification-client@0.17.1

## 0.17.0

### Patch Changes

- @lazysh/common@0.17.0
  - @lazysh/notification-client@0.17.0

## 0.16.0

### Patch Changes

- @lazysh/common@0.16.0
  - @lazysh/notification-client@0.16.0

## 0.15.0

### Patch Changes

- @lazysh/common@0.15.0
  - @lazysh/notification-client@0.15.0

## 0.14.0

### Patch Changes

- @lazysh/common@0.14.0
  - @lazysh/notification-client@0.14.0

## 0.13.0

### Patch Changes

- @lazysh/common@0.13.0
  - @lazysh/notification-client@0.13.0

## 0.12.2

### Patch Changes

- @lazysh/common@0.12.2
  - @lazysh/notification-client@0.12.2

## 0.12.1

### Patch Changes

- @lazysh/common@0.12.1
  - @lazysh/notification-client@0.12.1

## 0.12.0

### Patch Changes

- @lazysh/common@0.12.0
  - @lazysh/notification-client@0.12.0

## 0.11.0

### Patch Changes

- @lazysh/common@0.11.0
  - @lazysh/notification-client@0.11.0

## 0.10.1

### Patch Changes

- 3ec508c: Preserve explicit Pi tool-result error booleans in recorded chat and reuse the recorded-error badge without inferring live state or changing other adapters.
- @lazysh/common@0.10.1
  - @lazysh/notification-client@0.10.1

## 0.10.0

### Patch Changes

- @lazysh/common@0.10.0
  - @lazysh/notification-client@0.10.0

## 0.9.1

### Patch Changes

- @lazysh/common@0.9.1
  - @lazysh/notification-client@0.9.1

## 0.9.0

### Patch Changes

- @lazysh/common@0.9.0
  - @lazysh/notification-client@0.9.0

## 0.8.0

### Patch Changes

- @lazysh/common@0.8.0
  - @lazysh/notification-client@0.8.0

## 0.7.1

### Patch Changes

- @lazysh/common@0.7.1
  - @lazysh/notification-client@0.7.1

## 0.7.0

### Patch Changes

- @lazysh/common@0.7.0
  - @lazysh/notification-client@0.7.0

## 0.6.0

### Patch Changes

- @lazysh/common@0.6.0
  - @lazysh/notification-client@0.6.0

## 0.5.0

### Patch Changes

- @lazysh/common@0.5.0
  - @lazysh/notification-client@0.5.0

## 0.4.0

### Patch Changes

- @lazysh/common@0.4.0
  - @lazysh/notification-client@0.4.0

## 0.3.0

### Minor Changes

- c997e5f: Add explicitly opted-in Claude reported-history metadata and a selected-row shortcut into Chat. Source files remain unread until Open transcript; reported history does not verify a running agent or enable direct Send/Stop. Existing capture, image and Follow defaults remain off.

### Patch Changes

- @lazysh/common@0.3.0
  - @lazysh/notification-client@0.3.0

## 0.2.1

### Patch Changes

- @lazysh/common@0.2.1
  - @lazysh/notification-client@0.2.1

## 0.2.0

### Patch Changes

- @lazysh/common@0.2.0
  - @lazysh/notification-client@0.2.0
