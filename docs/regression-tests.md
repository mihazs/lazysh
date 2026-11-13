# Regression test index

Every bug fix lands a regression test that fails on the parent commit, at the lowest layer that can reproduce the defect, and a
row here in the same pull request ([ADR 0002](architecture/adr-0002-appium-webdriverio-android-e2e.md#decision), item 14;
steps in [Write and run Appium tests](how-to/write-and-run-appium-tests.md#add-a-regression-test-for-a-bug)). A defect that only
exists on a device also gets an Appium test; it may follow in a linked pull request, and the bug issue stays open until the
Appium column reads `active`.

How to read the table: **Layers** name where a test exists today (`unit` Vitest or `cargo test`, `web` Playwright, `native`
Android instrumented, `desktop` `tauri-driver`). **Appium** is `planned #N` (child issue of
[epic #1396](https://github.com/mihazs/lazysh/issues/1396)), `pending #N` (test written, fixtures missing), `active` (runs in CI)
or `n/a` with a reason. Rows below were read from the fixing commits; a test not listed is not claimed.

## Index

| Bug | Symptom | Fix | Layers and tests | Appium |
| --- | --- | --- | --- | --- |
| [#1164](https://github.com/mihazs/lazysh/pull/1164), [#1185](https://github.com/mihazs/lazysh/pull/1185), [#1193](https://github.com/mihazs/lazysh/pull/1193) | Every Herdr finger swipe showed the error "Unavailable" and scrolled nothing on hosts without the guarded build (since 1.29.1) | `0b0f52e7`, `933719e2`, `4c075b51` | unit `apps/client/src/TerminalPane.test.tsx`, `AgentView.test.tsx`, `herdr_guard_tests.rs`; web `e2e/agent-view.spec.ts`; native `NativeWorkspaceTest.kt` | planned [#1402](https://github.com/mihazs/lazysh/issues/1402) |
| [#1198](https://github.com/mihazs/lazysh/issues/1198), [#1178](https://github.com/mihazs/lazysh/pull/1178), [#1096](https://github.com/mihazs/lazysh/pull/1096) | Soft keyboard hides the bottom of the Mosh terminal | `59b5cf0c`, `0ebee54f` | unit `TerminalPane.test.tsx`; web `e2e/mosh-keyboard.spec.ts`, `terminal-history.spec.ts`; native `NativeWorkspaceTest.kt` | planned [#1403](https://github.com/mihazs/lazysh/issues/1403) |
| [#1207](https://github.com/mihazs/lazysh/issues/1207) | Terminal no longer fills the free area; margins and chrome waste space | `f8c530b8` (#1212) | web `e2e/terminal-fills-pane.spec.ts` | planned [#1403](https://github.com/mihazs/lazysh/issues/1403) |
| [#1269](https://github.com/mihazs/lazysh/pull/1269), [#1352](https://github.com/mihazs/lazysh/pull/1352) | Keyboard reopens when navigating Herdr terminals; Herdr switch unreachable with the keyboard open | `f37cb2dc`, `e98336bc` | unit `TerminalPane.test.tsx`, `herdrNavigationCells.test.ts`; web `e2e/terminal-navigation-keyboard.spec.ts`, `herdr-switch-tap.spec.ts`, `herdr-switch-handle.spec.ts` | planned [#1403](https://github.com/mihazs/lazysh/issues/1403) |
| [#1208](https://github.com/mihazs/lazysh/issues/1208), [#1213](https://github.com/mihazs/lazysh/pull/1213) | SwiftKey typing loses characters; Backspace and corrections fail after a toolbar key or scroll | `2870a04e` (#1213) | web `e2e/terminal-swiftkey.spec.ts`; native `NativeWorkspaceTest.kt`, `OwnedImeService.java`; host `tests/android-ssh.test.ts` | planned [#1404](https://github.com/mihazs/lazysh/issues/1404) |
| [#1214](https://github.com/mihazs/lazysh/issues/1214) | Keyboards that lose or corrupt terminal input | `68631cf0` (#1221) | web `e2e/private-keyboard.spec.ts` | planned [#1405](https://github.com/mihazs/lazysh/issues/1405) |
| [#1380](https://github.com/mihazs/lazysh/issues/1380) | Edge gestures conflict with Android and One UI navigation gestures (open) | not fixed | web `e2e/edge-gestures.spec.ts`, `bottom-menu.spec.ts`; native `NativeEdgeGestureExclusionTest.kt` | planned [#1406](https://github.com/mihazs/lazysh/issues/1406), red first |
| [#1248](https://github.com/mihazs/lazysh/issues/1248) | No sliding between the snippets and tools pages in the compact toolbar | `d455f373` (#1253) | web `e2e/toolbar-pages.spec.ts`, `toolbar-compact.spec.ts`, `toolbar-layout.spec.ts` | planned [#1407](https://github.com/mihazs/lazysh/issues/1407) |
| [#1393](https://github.com/mihazs/lazysh/issues/1393) | Toolbar page indicator should be hidden, shown as fading dots on a page change (open) | in review, [#1414](https://github.com/mihazs/lazysh/pull/1414) | web `e2e/toolbar-pages.spec.ts` (indicator) | planned [#1407](https://github.com/mihazs/lazysh/issues/1407), red first |
| [#1395](https://github.com/mihazs/lazysh/issues/1395) | Connected phone side menu must list Agents, Workspaces, Connections (open) | not fixed | web `e2e/side-menu.spec.ts` | planned [#1408](https://github.com/mihazs/lazysh/issues/1408), red first |
| [#1374](https://github.com/mihazs/lazysh/issues/1374) | Agent view composer could not send on a stock Herdr host | `c191de9a` (#1378) | unit `AgentComposer.test.tsx`; web `e2e/agent-view.spec.ts` (stock Herdr composer); desktop `native-e2e/agentViewHerdrSession.spec.ts` | planned [#1408](https://github.com/mihazs/lazysh/issues/1408) |
| [#1240](https://github.com/mihazs/lazysh/issues/1240) | Files explorer does not resolve `~/` paths | `a653d765` (#1251) | unit `FilesPanel.home.test.tsx`, `hostPath.test.ts`, `host_tests.rs`; web `e2e/files-home.spec.ts` | planned [#1409](https://github.com/mihazs/lazysh/issues/1409) |
| [#1266](https://github.com/mihazs/lazysh/issues/1266) | Bottom bar usage item must follow the agent in the current pane | `268c2dad` (#1272) | unit `AccountUsageFollow.test.tsx`; web `e2e/usage-follows-agent.spec.ts` | planned [#1410](https://github.com/mihazs/lazysh/issues/1410) |
| [#1074](https://github.com/mihazs/lazysh/issues/1074) | Users could not grant the background notification permission again | implemented before this index | native `NativeWorkspaceTest.kt` (permission grant at first connection) | planned [#1411](https://github.com/mihazs/lazysh/issues/1411) |
| [#1449](https://github.com/mihazs/lazysh/issues/1449), observation 1 of [#1435](https://github.com/mihazs/lazysh/issues/1435) | After Android recreates the activity (a navigation-overlay switch) Back left the app instead of closing the open page, and the shell reported no gesture zones (`navigation: unknown`) and claimed the bands on the destroyed WebView | this change | native `NativeGestureNavigationTest.kt` (`backClosesAnOpenPageAfterEveryRecreationHundredCycles`: 100 open and Back cycles, the activity recreated every tenth; `theClaimedBandsAndTheInsetsFollowTheActivityAcrossRecreations`: claims and insets across three recreations; `insetsAndBandsFollowEveryNavigationOverlay`, `theBandsFollowALayoutChange`, `theShellRefusesRowsAndZonesAndroidCouldNotHonour`) | planned [#1406](https://github.com/mihazs/lazysh/issues/1406) |

## Adding a row

Copy the closest row and fill the five columns. Link the bug issue and the fixing pull request, list each test by path (and
the title when a file holds several bugs), and say `n/a` plus the reason only where no test layer can reproduce the defect and
a follow-up issue is linked. A quarantined test keeps its row with `quarantined`, its issue and its expiry date
([policy](reference/mobile-e2e-conventions.md#flake-quarantine)).

## Rules the index enforces

- A `fix(...)` pull request without a row, or without a ticked regression box in the template, is not ready to merge (the
  process issue [#1413](https://github.com/mihazs/lazysh/issues/1413) adds the template box and the check).
- The test fails on the parent commit. Put the failing output in the pull request, or the reason it cannot be shown.
- Regression tests assert observable behaviour, never source text ([AGENTS.md](../AGENTS.md)).
- Do not weaken or delete an existing regression test to make a change pass; change the row and explain why.
