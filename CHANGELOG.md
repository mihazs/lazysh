# Changelog

Notable changes to lazysh, newest first. The section of each release is generated from the changeset fragments that
shipped in it when the version is prepared: one line per change, grouped as New, Improved, Fixed, Documentation and Under
the hood, with a link to its pull request. The GitHub release for that version carries the same lines with each change's
details collapsed beneath it. How to write an entry: [CONTRIBUTING.md](CONTRIBUTING.md#changelog-entries).

## [Unreleased]

Pending changes are the `.changeset/*.md` fragments that have not been released yet. Run `bun run changelog:preview` to
print them grouped the way the release notes will show them.

## [1.111.0] - 2026-11-28

### New

- **auth:** ask before a host sign-in tunnels to this device, with a per-host Ask, Always or Never choice ([#2874](https://github.com/mihazs/lazysh/pull/2874))

## [1.110.0] - 2026-11-28

### New

- **agents:** add custom arguments and a YOLO toggle when starting an agent in a folder ([#2955](https://github.com/mihazs/lazysh/pull/2955))
- **auth:** open a sign-in page only for the live tunnel of its own session ([#2858](https://github.com/mihazs/lazysh/pull/2858))
- **agents:** show each session's name first in the Agent view and let you rename it ([#2965](https://github.com/mihazs/lazysh/pull/2965))
- **agents:** say what still runs in the background and never show idle or done while it does ([#2970](https://github.com/mihazs/lazysh/pull/2970))
- **agents:** add New agent to the Agent view to start an agent in a folder, a new folder or a new worktree ([#2898](https://github.com/mihazs/lazysh/pull/2898))
- **agent:** keep a Claude Code session working while it runs background shells, monitors, sub-agents or workflows ([#2969](https://github.com/mihazs/lazysh/pull/2969))
- **agent:** add an optional operating system timer for the companion update check ([#2841](https://github.com/mihazs/lazysh/pull/2841))
- **agent:** check for a newer companion release on a schedule, with channel, interval and window ([#2841](https://github.com/mihazs/lazysh/pull/2841))
- **agent:** hold a Claude Code done push while the session still runs background work ([#3006](https://github.com/mihazs/lazysh/pull/3006))
- **agents:** name each reported session from its first prompt so sessions in one folder are easy to tell apart ([#2954](https://github.com/mihazs/lazysh/pull/2954))

### Fixed

- **agents:** show the rows of a dialog the Agent view cannot answer, instead of a one-line banner or nothing ([#2985](https://github.com/mihazs/lazysh/pull/2985))
- **agents:** show the /model, /theme and /rewind dialogs of Claude Code 2.1.326 as native menus in the Agent view ([#2983](https://github.com/mihazs/lazysh/pull/2983))
- **agents:** show the /model list of Codex 0.172.0 as a native menu in the Agent view ([#2984](https://github.com/mihazs/lazysh/pull/2984))
- **agent:** report and retire a legacy lazysh hook that runs beside the managed one ([#2968](https://github.com/mihazs/lazysh/pull/2968))
- **agent:** give a cold Firefox as long to start as Chrome before the host browser relay gives up ([#2964](https://github.com/mihazs/lazysh/pull/2964))

### Under the hood

- **windows:** reach an owned SSH server from the installed GUI and refuse a rejected or changed key ([#2871](https://github.com/mihazs/lazysh/pull/2871))
- **android:** answer Claude hooks running in real Zellij and Herdr panes from the device ([#2883](https://github.com/mihazs/lazysh/pull/2883))
- **appearance:** verify the theme clipboard import in the Linux GUI ([#2818](https://github.com/mihazs/lazysh/pull/2818))
- **terminal:** verify live Mosh resize on the Android native engine ([#2709](https://github.com/mihazs/lazysh/pull/2709))
- **agent:** hold the storage gate in every test that flushes, so the slow-flush case stops flaking ([#2982](https://github.com/mihazs/lazysh/pull/2982))

## [1.109.0] - 2026-11-28

### New

- **multiplexers:** open the exact tmux, rmux or Herdr pane that raised an agent notification ([#2859](https://github.com/mihazs/lazysh/pull/2859))
- **client:** ask once per host before updating a companion that cannot update itself ([#2833](https://github.com/mihazs/lazysh/pull/2833))

### Fixed

- **agent:** keep hook events the busy store refuses and record them on the next report ([#2967](https://github.com/mihazs/lazysh/pull/2967))

### Under the hood

- **android:** create a Herdr tab through the real Sessions panel in the shared navigation case ([#2819](https://github.com/mihazs/lazysh/pull/2819))

## [1.108.0] - 2026-11-28

### New

- **agents:** show Claude Code records lazysh does not map as a "Not shown natively" line in the Agent view ([#2815](https://github.com/mihazs/lazysh/pull/2815))
- **browser:** fit the host Firefox relay's polling and encoding to the link with the quality ladder ([#2842](https://github.com/mihazs/lazysh/pull/2842))

### Fixed

- **settings:** show Use Option as Meta only on macOS ([#2814](https://github.com/mihazs/lazysh/pull/2814))

### Documentation

- **agents:** list which signals prove an agent's background work, per agent ([#2962](https://github.com/mihazs/lazysh/pull/2962))
- **agents:** describe session names, where each agent's name comes from, what is stored and the per-device rename ([#2966](https://github.com/mihazs/lazysh/pull/2966))

## [1.107.1] - 2026-11-28

### Fixed

- **release:** restore publishing by moving the managed Herdr target directory out of the job-level env ([#2942](https://github.com/mihazs/lazysh/pull/2942))

## [1.107.0] - 2026-11-28

### New

- **browser:** add Keep profile and Clear browser data to the Host browser settings ([#2820](https://github.com/mihazs/lazysh/pull/2820))
- **herdr:** keep the Herdr event stream open for the inbox while no Herdr view is shown ([#2813](https://github.com/mihazs/lazysh/pull/2813))
- **desktop:** find native Zellij and Herdr on Windows through PATHEXT in discovery and actions ([#2835](https://github.com/mihazs/lazysh/pull/2835))

### Fixed

- **agents:** open the Claude Code and OpenCode conversations that hold a large tool result ([#2790](https://github.com/mihazs/lazysh/pull/2790))
- **agent:** start the working clock at the new turn instead of the previous finished prompt ([#2848](https://github.com/mihazs/lazysh/pull/2848))

### Under the hood

- **release:** publish the managed Herdr as verified release assets ([#2831](https://github.com/mihazs/lazysh/pull/2831))
- **e2e:** Appium regression spec for typing and Backspace through the real Android keyboard ([#2843](https://github.com/mihazs/lazysh/pull/2843))

## [1.106.0] - 2026-11-28

### New

- **companion:** run the managed Windows companion before the PATH one on OpenSSH hosts ([#2810](https://github.com/mihazs/lazysh/pull/2810))
- **browser:** navigate, go back and forward, reload and switch tabs in the host Firefox relay ([#2822](https://github.com/mihazs/lazysh/pull/2822))

### Fixed

- **agent:** keep hook setup working after a profile folder is restored, copied or remounted ([#2911](https://github.com/mihazs/lazysh/pull/2911))
- **credentials:** import ECDSA P-256 private keys whose secret starts with a zero byte ([#2827](https://github.com/mihazs/lazysh/pull/2827))

## [1.105.1] - 2026-11-28

### Fixed

- **agent:** stop hook failures after large file reads in Claude ([#2913](https://github.com/mihazs/lazysh/pull/2913))

## [1.105.0] - 2026-11-28

### New

- **agents:** label each file update card as created, edited, deleted or renamed ([#2803](https://github.com/mihazs/lazysh/pull/2803))
- **agents:** always show the agent's reported mode, approval and sandbox in the Agent view header ([#2805](https://github.com/mihazs/lazysh/pull/2805))
- **browser:** let the host browser relay's Firefox take pointer, wheel, key and text input ([#2821](https://github.com/mihazs/lazysh/pull/2821))

### Fixed

- **multiplexers:** show the newest pane history tail when a pane's scrollback exceeds 8 MiB ([#2809](https://github.com/mihazs/lazysh/pull/2809))
- **bench:** match the native and xterm terminal grids in Android stream measurements ([#2754](https://github.com/mihazs/lazysh/pull/2754))
- **android:** keep the Back listener registered so Back never leaves the app while a page opens ([#2791](https://github.com/mihazs/lazysh/pull/2791))
- **ssh:** refresh host-tool views automatically after the command connection recovers ([#2795](https://github.com/mihazs/lazysh/pull/2795))
- **tmux:** start new sessions, windows and panes in directories whose name contains a style marker ([#2800](https://github.com/mihazs/lazysh/pull/2800))
- **agents:** list script-file and resumed dynamic workflows by name with their progress ([#2806](https://github.com/mihazs/lazysh/pull/2806))

### Under the hood

- **fdroid:** add release notes and phone screenshots to the F-Droid listing ([#2928](https://github.com/mihazs/lazysh/pull/2928))
- **windows:** drive theme QR scan and shell link import through the installed GUI ([#2816](https://github.com/mihazs/lazysh/pull/2816))
- **android:** wait for the auth activity to resume before the instrumentation test continues ([#2817](https://github.com/mihazs/lazysh/pull/2817))

## [1.104.2] - 2026-11-27

### Fixed

- **onboarding:** make the gesture tour match the hidden gesture lines ([#2784](https://github.com/mihazs/lazysh/pull/2784))
- **chat:** Send and Stop in the Chat terminal input work from an open touch-keyboard composition ([#2783](https://github.com/mihazs/lazysh/pull/2783))

## [1.104.1] - 2026-11-27

### New

- **notifications:** retain the local source of relay events ([#2789](https://github.com/mihazs/lazysh/pull/2789))

### Fixed

- **release:** declare the Debian protobuf runtime dependency ([#2785](https://github.com/mihazs/lazysh/pull/2785))
- **zellij:** Split right and Split down start in the chosen Directory ([#2793](https://github.com/mihazs/lazysh/pull/2793))
- **ci:** gate the Android emulator on SystemUI readiness before native cases ([#2788](https://github.com/mihazs/lazysh/pull/2788))

## [1.104.0] - 2026-11-27

### New

- **agents:** show running agent processes on Linux hosts ([#2542](https://github.com/mihazs/lazysh/pull/2542))
- **settings:** move agent image previews to Preferences ([#2538](https://github.com/mihazs/lazysh/pull/2538))
- **terminal:** add an opt-in Metal terminal surface on iOS ([#2692](https://github.com/mihazs/lazysh/pull/2692))
- **agents:** attach files directly from the compact prompt composer ([#2775](https://github.com/mihazs/lazysh/pull/2775))

### Improved

- **terminal:** the native renderer repaints only the changed cells of a row ([#2830](https://github.com/mihazs/lazysh/pull/2830))
- **agents:** draw the Agent view's folded tool activity only when it is opened ([#2829](https://github.com/mihazs/lazysh/pull/2829))

### Fixed

- **android:** keep native terminal link taps inside the consent prompt ([#2697](https://github.com/mihazs/lazysh/pull/2697))
- **terminal:** preserve mouse modifiers and report desktop wheel events in native terminals ([#2778](https://github.com/mihazs/lazysh/pull/2778))
- **agent:** soften the focused message composer outline ([#2656](https://github.com/mihazs/lazysh/pull/2656))
- **agents:** open long Claude Code conversations in the Agent view and page back through them ([#2782](https://github.com/mihazs/lazysh/pull/2782))
- **android:** reopen Lazysh when the System WebView renderer exits ([#2763](https://github.com/mihazs/lazysh/pull/2763))
- **ci:** wait for exact Android connection form text in the published APK check ([#2719](https://github.com/mihazs/lazysh/pull/2719))
- **theme:** say the QR image could not be read instead of blaming decoding ([#2774](https://github.com/mihazs/lazysh/pull/2774))
- **terminal:** report incomplete Android frame-pacing counters as unmeasured ([#2713](https://github.com/mihazs/lazysh/pull/2713))

## [1.103.0] - 2026-11-27

### New

- **terminal:** switch a live Mosh session from native to xterm.js ([#2635](https://github.com/mihazs/lazysh/pull/2635))

### Fixed

- **terminal:** keep the native renderer when switching to xterm.js is refused ([#2635](https://github.com/mihazs/lazysh/pull/2635))
- **bench:** run only the Android terminal benchmark method ([#2752](https://github.com/mihazs/lazysh/pull/2752))
- **bench:** retry transient Android display capture misses ([#2758](https://github.com/mihazs/lazysh/pull/2758))
- **agents:** stop a Claude Code row reporting a running turn after you interrupt it with Esc ([#2780](https://github.com/mihazs/lazysh/pull/2780))

## [1.102.5] - 2026-11-27

### Fixed

- **agents:** show unrecognized follow-up questions with a terminal action ([#2777](https://github.com/mihazs/lazysh/pull/2777))
- **chat:** keep every character typed quickly into the transcript path field ([#2905](https://github.com/mihazs/lazysh/pull/2905))

## [1.102.4] - 2026-11-27

### Fixed

- **ci:** allow individual iOS and macOS terminal rehearsals ([#2715](https://github.com/mihazs/lazysh/pull/2715))
- **release:** keep the bundled companion executable in the restored Linux AppImage ([#2867](https://github.com/mihazs/lazysh/pull/2867))

## [1.102.3] - 2026-11-27

### New

- **android:** add the native terminal engine to the GitHub FOSS APK ([#2694](https://github.com/mihazs/lazysh/pull/2694))

### Fixed

- **terminal:** require paired absolute memory for the same Android app ([#2708](https://github.com/mihazs/lazysh/pull/2708))
- **terminal:** include Android session memory and churn in native rollout evidence ([#2710](https://github.com/mihazs/lazysh/pull/2710))
- **terminal:** keep the native editor focused after tapping the terminal ([#2701](https://github.com/mihazs/lazysh/pull/2701))
- **agents:** acknowledge sends promptly and show when the agent queued them ([#2574](https://github.com/mihazs/lazysh/pull/2574))
- **terminal:** start native touch selection at the new word after copying ([#2705](https://github.com/mihazs/lazysh/pull/2705))
- **release:** keep the bundled companion runnable in Linux AppImages ([#2733](https://github.com/mihazs/lazysh/pull/2733))
- **terminal:** release closed session renderers from terminal IPC channels ([#2619](https://github.com/mihazs/lazysh/pull/2619))
- **terminal:** discard canceled native composing text after a focus change ([#2707](https://github.com/mihazs/lazysh/pull/2707))
- **terminal:** report mouse hover in native terminals when applications request it ([#2614](https://github.com/mihazs/lazysh/pull/2614))
- **terminal:** keep the keyboard closed on Herdr navigation taps ([#2534](https://github.com/mihazs/lazysh/pull/2534))
- **android:** preserve typed terminal words when SwiftKey inserts a space ([#2750](https://github.com/mihazs/lazysh/pull/2750))

### Under the hood

- **terminal:** verify saved actions and D-pad holds on the native engine ([#2711](https://github.com/mihazs/lazysh/pull/2711))

## [1.102.2] - 2026-11-27

### New

- **terminal:** include the native Wayland engine in Linux packages ([#2693](https://github.com/mihazs/lazysh/pull/2693))
- **terminal:** include the native terminal engine in Windows installers ([#2693](https://github.com/mihazs/lazysh/pull/2693))
- **terminal:** honor Linux desktop accessibility in the terminal ([#2651](https://github.com/mihazs/lazysh/pull/2651))

### Fixed

- **bench:** compare Android terminal streams only when their grids and bytes match ([#2595](https://github.com/mihazs/lazysh/pull/2595))
- **terminal:** stop display-scale monitoring when an xterm.js session closes ([#2621](https://github.com/mihazs/lazysh/pull/2621))
- **android:** honor Private keyboard in the native terminal ([#2691](https://github.com/mihazs/lazysh/pull/2691))
- **android:** preserve native terminal hardware keyboard right-Alt characters ([#2691](https://github.com/mihazs/lazysh/pull/2691))
- **terminal:** select native terminal words and rows on double and triple click ([#2703](https://github.com/mihazs/lazysh/pull/2703))
- **android:** keep native keyboard commits ahead of toolbar keys ([#2691](https://github.com/mihazs/lazysh/pull/2691))
- **terminal:** respect named keys from remapped and virtual keyboards ([#2717](https://github.com/mihazs/lazysh/pull/2717))
- **bench:** require a render timing for every short-output burst ([#2603](https://github.com/mihazs/lazysh/pull/2603))
- **android:** restore inline shell history suggestions with SwiftKey in native terminals ([#2691](https://github.com/mihazs/lazysh/pull/2691))
- **android:** keep the keyboard from replacing native terminal commands on Enter ([#2691](https://github.com/mihazs/lazysh/pull/2691))
- **notifications:** start the enabled host relay sender automatically ([#2673](https://github.com/mihazs/lazysh/pull/2673))

### Under the hood

- **herdr:** isolate real integration fixtures on private sockets ([#2660](https://github.com/mihazs/lazysh/pull/2660))

## [1.102.1] - 2026-11-26

### Fixed

- **bench:** require complete Android engine comparison measurements ([#2598](https://github.com/mihazs/lazysh/pull/2598))

## [1.102.0] - 2026-11-26

### New

- **usage:** enable agent background quota collection by default ([#2533](https://github.com/mihazs/lazysh/pull/2533))
- **agents:** show the current Claude Code and Codex goals in Agent View ([#2549](https://github.com/mihazs/lazysh/pull/2549))
- **terminal:** apply cursor style and blink from the first native frame ([#2527](https://github.com/mihazs/lazysh/pull/2527))
- **terminal:** add an opt-in Direct3D 12 terminal surface on Windows ([#2650](https://github.com/mihazs/lazysh/pull/2650))
- **terminal:** host native terminal rendering in feature-enabled macOS builds ([#2647](https://github.com/mihazs/lazysh/pull/2647))

### Fixed

- **bench:** measure Android xterm streams through the final render ([#2600](https://github.com/mihazs/lazysh/pull/2600))
- **android:** clear native terminal input after Enter and avoid duplicate preedit text ([#2649](https://github.com/mihazs/lazysh/pull/2649))
- **android:** hide the native terminal keyboard when scrolling down to the live screen ([#2563](https://github.com/mihazs/lazysh/pull/2563))
- **bench:** read Android refresh rate from the active display mode ([#2631](https://github.com/mihazs/lazysh/pull/2631))
- **bench:** exclude interrupted Android counter windows from engine comparisons ([#2586](https://github.com/mihazs/lazysh/pull/2586))
- **terminal:** keep composer actions visible on compact phones ([#2646](https://github.com/mihazs/lazysh/pull/2646))
- **ci:** run Android native tmux acceptance with its SSH fixture ([#2684](https://github.com/mihazs/lazysh/pull/2684))
- **android:** keep native terminal keyboard edits on the active input connection ([#2655](https://github.com/mihazs/lazysh/pull/2655))
- **agent:** read complete browser relay command records ([#2591](https://github.com/mihazs/lazysh/pull/2591))

### Documentation

- **readme:** add a 40-second walk-through of the app with zoom transitions to the top of the README ([#2513](https://github.com/mihazs/lazysh/pull/2513))

### Under the hood

- **android:** allow WebView rounding in keyboard viewport checks ([#2645](https://github.com/mihazs/lazysh/pull/2645))
- **android:** verify native SSH output, input and multi-session lifecycle on the emulator ([#2609](https://github.com/mihazs/lazysh/pull/2609))
- **android:** verify native terminal Unicode glyphs stay in their cells ([#2507](https://github.com/mihazs/lazysh/pull/2507))
- **terminal:** isolate the native scrollback budget checks ([#2658](https://github.com/mihazs/lazysh/pull/2658))
- **terminal:** verify Android returns new sessions to xterm.js with the native engine disabled ([#2641](https://github.com/mihazs/lazysh/pull/2641))
- **android:** verify the native tmux viewport after clipboard consent ([#2684](https://github.com/mihazs/lazysh/pull/2684))
- **desktop:** make the singleton directory smoke test submit the correct shell command ([#2640](https://github.com/mihazs/lazysh/pull/2640))
- **terminal:** verify the Linux native-engine kill switch in the app ([#2648](https://github.com/mihazs/lazysh/pull/2648))
- **android:** verify rmux SSH fixtures alongside tmux ([#2577](https://github.com/mihazs/lazysh/pull/2577))
- **android:** verify the return from system notification settings ([#2642](https://github.com/mihazs/lazysh/pull/2642))

## [1.101.5] - 2026-11-25

### Fixed

- **bench:** connect the terminal benchmark to the Android WebView ([#2593](https://github.com/mihazs/lazysh/pull/2593))
- **terminal:** wake the native renderer for output arriving during attachment ([#2623](https://github.com/mihazs/lazysh/pull/2623))
- **bench:** preserve the Android native idle benchmark result during teardown ([#2632](https://github.com/mihazs/lazysh/pull/2632))

## [1.101.4] - 2026-11-25

### Fixed

- **android:** report Waydroid instrumentation results before app teardown ([#2601](https://github.com/mihazs/lazysh/pull/2601))

### Under the hood

- **android:** verify rendered xterm SSH echoes through the packaged app ([#2608](https://github.com/mihazs/lazysh/pull/2608))

## [1.101.3] - 2026-11-25

### Fixed

- **bench:** verify adapter writes in the Android xterm baseline ([#2589](https://github.com/mihazs/lazysh/pull/2589))
- **terminal:** keep the terminal usable in short landscape windows ([#2551](https://github.com/mihazs/lazysh/pull/2551))
- **android:** apply imported fonts in the native terminal ([#2579](https://github.com/mihazs/lazysh/pull/2579))

## [1.101.2] - 2026-11-25

### Fixed

- **android:** start the Google build on ARM64 translated by the Android emulator ([#2583](https://github.com/mihazs/lazysh/pull/2583))

## [1.101.1] - 2026-11-25

### Fixed

- **android:** keep the native terminal active after reconnecting from a recreated Activity ([#2556](https://github.com/mihazs/lazysh/pull/2556))

## [1.101.0] - 2026-11-24

### New

- **settings:** consolidate workspace settings shortcuts under Preferences
- **agents:** soften the Agent View composer with frosted glass ([#2548](https://github.com/mihazs/lazysh/pull/2548))
- **agents:** read Senpi session records
- **terminal:** report custom bold colour support on the native engine

### Fixed

- **android:** keep native terminal typing working after switching workspace views
- **agents:** keep agent questions in the conversation flow ([#2572](https://github.com/mihazs/lazysh/pull/2572))
- **terminal:** render color emoji from the Android system font in native terminals

## [1.100.3] - 2026-11-24

### Fixed

- **terminal:** open the soft keyboard on the native terminal, let page fields keep it and make the toolbar modifiers work ([#2495](https://github.com/mihazs/lazysh/pull/2495))

## [1.100.2] - 2026-11-24

### New

- **terminal:** the History lines setting reaches a native session that is already open

## [1.100.1] - 2026-11-24

### Documentation

- **terminal:** add the feature parity matrix between the native engine and xterm.js ([#2508](https://github.com/mihazs/lazysh/pull/2508))

## [1.100.0] - 2026-11-24

### New

- **terminal:** Shift-drag selects under mouse tracking and a drag scrolls at the edge on the native engine ([#2510](https://github.com/mihazs/lazysh/pull/2510))

## [1.99.0] - 2026-11-24

### New

- **terminal:** the status bar names the terminal engine in use next to xterm-256color ([#2494](https://github.com/mihazs/lazysh/pull/2494))

### Fixed

- **terminal:** the composer's Send and Insert submit and clear the draft on the native engine ([#2497](https://github.com/mihazs/lazysh/pull/2497))

## [1.98.6] - 2026-11-24

### Fixed

- **agent:** accept Windows profile paths when setting up agent hooks on a Windows device ([#2477](https://github.com/mihazs/lazysh/pull/2477))

## [1.98.5] - 2026-11-24

### Documentation

- **readme:** show real screenshots and demo clips of the app captured on Waydroid ([#2480](https://github.com/mihazs/lazysh/pull/2480))

## [1.98.4] - 2026-11-24

### New

- **terminal:** draw the fonts you imported in Preferences with the native terminal engine ([#2456](https://github.com/mihazs/lazysh/pull/2456))

## [1.98.3] - 2026-11-23

### New

- **terminal:** Size a native terminal's columns and rows to its pane, so the remote program draws for the screen it has ([#2458](https://github.com/mihazs/lazysh/pull/2458))

### Fixed

- **terminal:** say why a native terminal cannot draw and move to xterm.js instead of showing a blank pane ([#2460](https://github.com/mihazs/lazysh/pull/2460))
- **voice:** import a Whisper model on Android, where hard links in app storage are refused ([#2469](https://github.com/mihazs/lazysh/pull/2469))

### Documentation

- **readme:** describe lazysh as a released app with current platforms and features, not a development preview ([#2470](https://github.com/mihazs/lazysh/pull/2470))

## [1.98.2] - 2026-11-23

### New

- **terminal:** send mouse clicks, drags and taps to mouse-tracking programs on the native terminal ([#2447](https://github.com/mihazs/lazysh/pull/2447))

### Fixed

- **companion:** never run a symbolic link in the managed directory as the local companion on macOS ([#2451](https://github.com/mihazs/lazysh/pull/2451))

## [1.98.1] - 2026-11-23

### New

- **terminal:** Draw a native terminal with the user's theme, font, bold colours and cursor, and change them live ([#2395](https://github.com/mihazs/lazysh/pull/2395))

## [1.98.0] - 2026-11-23

### New

- **files:** play video and audio in an isolated frame ([#1892](https://github.com/mihazs/lazysh/pull/1892))
- **rmux:** discover, attach and use rmux sessions with the tmux tools ([#1863](https://github.com/mihazs/lazysh/pull/1863))
- **herdr:** follow a Herdr server live and send blocked or done agents to the inbox ([#1876](https://github.com/mihazs/lazysh/pull/1876))

### Fixed

- **rmux:** start sessions, windows and panes in a directory whose name has format or style markers ([#1863](https://github.com/mihazs/lazysh/pull/1863))

### Under the hood

- **android:** drive the Share dialog against a real share service over TLS ([#1920](https://github.com/mihazs/lazysh/pull/1920))
- **windows:** run the tmux, Zellij and Herdr cases from a Windows client against a Linux host ([#1935](https://github.com/mihazs/lazysh/pull/1935))

## [1.97.11] - 2026-11-23

### New

- **terminal:** paste into a native terminal session on Android from the keyboard or a hardware keyboard ([#2403](https://github.com/mihazs/lazysh/pull/2403))

### Fixed

- **terminal:** redraw a native terminal's surface after a scroll or resize ([#2406](https://github.com/mihazs/lazysh/pull/2406))

## [1.97.10] - 2026-11-23

### New

- **android:** Keep the native terminal engine off while TalkBack or another screen reader is on ([#2392](https://github.com/mihazs/lazysh/pull/2392))

### Fixed

- **tmux:** stop Jump To and Chat input from crashing your tmux server when another client connects ([#2398](https://github.com/mihazs/lazysh/pull/2398))
- **android:** stop the app freezing when the screen is recreated ([#2420](https://github.com/mihazs/lazysh/pull/2420))

## [1.97.9] - 2026-11-23

### New

- **terminal:** open links with a tap on the native terminal engine ([#2393](https://github.com/mihazs/lazysh/pull/2393))
- **terminal:** Start on xterm.js when a native session cannot start, and move a native session to xterm.js ([#2386](https://github.com/mihazs/lazysh/pull/2386))

### Fixed

- **ssh:** recover the host-tools connection of Mosh and Eternal Terminal sessions automatically ([#2013](https://github.com/mihazs/lazysh/pull/2013))

### Under the hood

- **ime:** commit CJK through a real IBus into the WebKitGTK terminal and the Chat composer ([#1919](https://github.com/mihazs/lazysh/pull/1919))

## [1.97.8] - 2026-11-23

### New

- **terminal:** let the Android WebView show a native terminal's surface while one is placed ([#2384](https://github.com/mihazs/lazysh/pull/2384))

## [1.97.7] - 2026-11-23

### New

- **terminal:** Report a terminal problem from Settings, the Workspace tools engine line and the engine notice ([#2389](https://github.com/mihazs/lazysh/pull/2389))
- **browser:** keep the host browser relay's profile until Clear browser data ([#1995](https://github.com/mihazs/lazysh/pull/1995))
- **browser:** fit the host browser relay's stream to the link with a quality ladder ([#1997](https://github.com/mihazs/lazysh/pull/1997))
- **browser:** carry navigation, tabs, dialogs and notices over the host browser relay ([#2001](https://github.com/mihazs/lazysh/pull/2001))

### Fixed

- **voice:** release the local Parakeet cache lock when its owner closes ([#2012](https://github.com/mihazs/lazysh/pull/2012))
- **hooks:** read the companion store for hook readiness without creating, changing or deleting its files ([#1944](https://github.com/mihazs/lazysh/pull/1944))
- **ios:** answer a slow Simulator boot, shutdown or reboot as requested instead of DeviceTimeout ([#2002](https://github.com/mihazs/lazysh/pull/2002))
- **herdr:** on macOS the Herdr event stream ends cleanly when the Herdr server closes its socket ([#2402](https://github.com/mihazs/lazysh/pull/2402))

## [1.97.6] - 2026-11-22

### New

- **terminal:** run a Mosh session on the native terminal engine and let the server decide its size ([#2391](https://github.com/mihazs/lazysh/pull/2391))

## [1.97.5] - 2026-11-22

### New

- **terminal:** clear the selection when you type on the native terminal ([#2375](https://github.com/mihazs/lazysh/pull/2375))

## [1.97.4] - 2026-11-22

### New

- **terminal:** Hand a native terminal session's transport back to the WebView without losing bytes ([#2229](https://github.com/mihazs/lazysh/pull/2229))

## [1.97.3] - 2026-11-22

### Fixed

- **agent:** a loaded machine no longer makes the Agent view fail to read an OpenCode or Hermes conversation ([#2373](https://github.com/mihazs/lazysh/pull/2373))

## [1.97.2] - 2026-11-22

### New

- **terminal:** send wheel reports to mouse-tracking programs on the native terminal ([#2370](https://github.com/mihazs/lazysh/pull/2370))

## [1.97.1] - 2026-11-22

### New

- **terminal:** type into a native terminal session on Android ([#2339](https://github.com/mihazs/lazysh/pull/2339))

### Fixed

- **herdr:** choosing a space, tab or agent waits for a terminal input already in progress ([#2338](https://github.com/mihazs/lazysh/pull/2338))

## [1.97.0] - 2026-11-22

### New

- **usage:** let a host forbid account quota reads ([#1823](https://github.com/mihazs/lazysh/pull/1823))
- **android:** native terminal engine selectable in release builds ([#2353](https://github.com/mihazs/lazysh/pull/2353))
- **notifications:** receive remote agent-attention notifications on the desktop ([#1811](https://github.com/mihazs/lazysh/pull/1811))
- **onboarding:** add an animated tour that explains the session gestures on phones ([#1802](https://github.com/mihazs/lazysh/pull/1802))
- **agents:** answer OpenCode permissions and questions through its local service ([#1841](https://github.com/mihazs/lazysh/pull/1841))
- **devices:** show Devices in a local session for the Android SDK on this computer ([#1858](https://github.com/mihazs/lazysh/pull/1858))
- **usage:** add host switches for simulator streaming and port scanning in their own host-features.json ([#1813](https://github.com/mihazs/lazysh/pull/1813))
- **usage:** show the host usage collector on the usage page ([#1823](https://github.com/mihazs/lazysh/pull/1823))
- **agents:** let the Agent view take the whole window, with one tap back ([#2325](https://github.com/mihazs/lazysh/pull/2325))
- **usage:** record account quota samples on an opt-in user-level timer ([#1823](https://github.com/mihazs/lazysh/pull/1823))

### Under the hood

- **android:** keep the app's thread dump and ANR traces and the tmux server's own log for a failed Android run ([#2346](https://github.com/mihazs/lazysh/pull/2346))
- **android:** wait until the staged QR fixture's MediaStore row stops changing before the picker opens ([#2342](https://github.com/mihazs/lazysh/pull/2342))

## [1.96.0] - 2026-11-22

### New

- **multiplexers:** close, rename and resize tmux panes and close sessions from the Workspaces panel ([#1990](https://github.com/mihazs/lazysh/pull/1990))
- Show Codex's permission requests in the Agent view dock on tmux ([#1965](https://github.com/mihazs/lazysh/pull/1965))
- **zellij:** reattach saved Zellij sessions on reconnect and restore without creating or resurrecting them ([#1978](https://github.com/mihazs/lazysh/pull/1978))
- **zellij:** Jump To lists the tabs of the attached session with one current row ([#1980](https://github.com/mihazs/lazysh/pull/1980))
- **agents:** switch between live agents from the Agent view header in one tap ([#2324](https://github.com/mihazs/lazysh/pull/2324))
- **android:** draw the native session on the surface host through a JNI renderer client ([#2275](https://github.com/mihazs/lazysh/pull/2275))
- **browser:** add the address bar, tab list and navigation controls to the host browser prototype ([#1993](https://github.com/mihazs/lazysh/pull/1993))
- **hooks:** manage OpenCode, Cline and Amp hook plugins on Windows hosts ([#1962](https://github.com/mihazs/lazysh/pull/1962))

### Improved

- **terminal:** reuse one native surface look for the Linux and Android hosts ([#2356](https://github.com/mihazs/lazysh/pull/2356))

### Fixed

- **agents:** stop a Claude Code row waiting for approval after you reject its permission dialog ([#1955](https://github.com/mihazs/lazysh/pull/1955))

### Under the hood

- Build libghostty-vt against the iPhoneOS and iPhoneSimulator SDKs and test the terminal core for iOS in a… ([#2139](https://github.com/mihazs/lazysh/pull/2139))

## [1.95.7] - 2026-11-22

### New

- **terminal:** run a session on the native data path when the registry picks native ([#2274](https://github.com/mihazs/lazysh/pull/2274))

### Under the hood

- **android:** compile and package the native terminal engine in the Google release APK ([#2317](https://github.com/mihazs/lazysh/pull/2317))

## [1.95.6] - 2026-11-21

### Under the hood

- **android:** retry the Zellij fixture's tab readback when the command fails ([#2320](https://github.com/mihazs/lazysh/pull/2320))

## [1.95.5] - 2026-11-21

### Fixed

- **agents:** choosing another agent in the Agent view now focuses its terminal pane and shows its composer ([#2301](https://github.com/mihazs/lazysh/pull/2301))

## [1.95.4] - 2026-11-21

### Under the hood

- **ci:** provision Zig and the Ghostty archives through one composite action ([#2307](https://github.com/mihazs/lazysh/pull/2307))

## [1.95.3] - 2026-11-21

### Under the hood

- **android:** collapse the notification shade and system dialogs before a case and when the window loses focus ([#2310](https://github.com/mihazs/lazysh/pull/2310))

## [1.95.2] - 2026-11-21

### New

- **terminal:** add a build-time kill switch that keeps every session on xterm.js ([#2154](https://github.com/mihazs/lazysh/pull/2154))

## [1.95.1] - 2026-11-21

### Under the hood

- **android:** make the QR fixture the only image the Photo Picker can list ([#2305](https://github.com/mihazs/lazysh/pull/2305))

## [1.95.0] - 2026-11-21

### New

- **terminal:** hide the gesture indicator lines by default and add a setting to show them ([#2303](https://github.com/mihazs/lazysh/pull/2303))

### Fixed

- **terminal:** Long-press a URL selects and copies the whole address, however it wraps ([#2295](https://github.com/mihazs/lazysh/pull/2295))

## [1.94.0] - 2026-11-21

### New

- **multiplexers:** read the pane's scrollback from tmux, Zellij and Herdr in the Sessions panel ([#1994](https://github.com/mihazs/lazysh/pull/1994))

## [1.93.9] - 2026-11-21

### New

- **terminal:** select text with the pointer on the native terminal adapter ([#2291](https://github.com/mihazs/lazysh/pull/2291))

## [1.93.8] - 2026-11-21

### Under the hood

- **android:** pick the QR fixture first in the Photo Picker and tap the Chat composer where it is not covered ([#2286](https://github.com/mihazs/lazysh/pull/2286))

## [1.93.7] - 2026-11-21

### Fixed

- **zellij:** list no sessions as an empty list instead of a command error ([#1979](https://github.com/mihazs/lazysh/pull/1979))

## [1.93.6] - 2026-11-21

### Under the hood

- **android:** read the system clipboard after Copy of a terminal selection ([#1989](https://github.com/mihazs/lazysh/pull/1989))

## [1.93.5] - 2026-11-21

### New

- **terminal:** Take the word under a touch and select all from the native core ([#2287](https://github.com/mihazs/lazysh/pull/2287))

## [1.93.4] - 2026-11-21

### Under the hood

- **android:** prove the stock Herdr display restores only on click after a force-stop and relaunch ([#1976](https://github.com/mihazs/lazysh/pull/1976))
- **android:** prove the tmux pane restores only on click after a force-stop and relaunch ([#1976](https://github.com/mihazs/lazysh/pull/1976))

## [1.93.3] - 2026-11-21

### Fixed

- **agent-view:** keep Send, Stage and Stop usable while a touch keyboard holds an open composition ([#1982](https://github.com/mihazs/lazysh/pull/1982))

## [1.93.2] - 2026-11-21

### New

- **terminal:** Serve selection text, search, word and line lookups from the native core and draw the selection ([#2228](https://github.com/mihazs/lazysh/pull/2228))

## [1.93.1] - 2026-11-21

### Under the hood

- **terminal:** run the native core test on Waydroid with an owned SSH fixture, thaw the guest and record failure details ([#2282](https://github.com/mihazs/lazysh/pull/2282))

## [1.93.0] - 2026-11-21

### New

- **notifications:** add the nested-agent and unlocked-desktop switches to the host settings panel ([#1972](https://github.com/mihazs/lazysh/pull/1972))
- **agents:** send a dialog's keys only after the host reads the pane again and finds that dialog once ([#1968](https://github.com/mihazs/lazysh/pull/1968))
- **agents:** map Grok Build sub-agent, background job and edit records to the work cards ([#1986](https://github.com/mihazs/lazysh/pull/1986))
- **browser:** stream the host's Firefox through WebDriver BiDi in the relay ([#1996](https://github.com/mihazs/lazysh/pull/1996))

### Fixed

- **agent:** start the Android video preview on an idle screen of a guest that prints a warning line ([#1987](https://github.com/mihazs/lazysh/pull/1987))

### Under the hood

- **zellij:** drive the Zellij shortcut panel against a real session in the Linux GUI ([#1991](https://github.com/mihazs/lazysh/pull/1991))
- **android:** choose the QR fixture in the Photo Picker that API 36 opens for image inputs ([#2276](https://github.com/mihazs/lazysh/pull/2276))

## [1.92.3] - 2026-11-21

### Fixed

- **agents:** show what the agent said in a long turn and fill the Agent view with earlier messages ([#2261](https://github.com/mihazs/lazysh/pull/2261))

## [1.92.2] - 2026-11-21

### Under the hood

- **terminal:** record the first Waydroid lane run of the native core, which stops at the missing owned SSH fixture ([#2278](https://github.com/mihazs/lazysh/pull/2278))

## [1.92.1] - 2026-11-21

### New

- **linux:** draw a native terminal session on the Wayland subsurface with wgpu, native builds only ([#2272](https://github.com/mihazs/lazysh/pull/2272))

### Under the hood

- **android:** upload the x86_64 debug and androidTest APKs for the Waydroid lane ([#2277](https://github.com/mihazs/lazysh/pull/2277))

## [1.92.0] - 2026-11-21

### New

- **settings:** add the Terminal engine control with Auto, Native and xterm.js to Settings ([#2197](https://github.com/mihazs/lazysh/pull/2197))
- **terminal:** add the typed-input editor for native terminal sessions on desktop and iOS ([#2161](https://github.com/mihazs/lazysh/pull/2161))
- **terminal:** find web addresses, file paths and hyperlinks in the shared terminal core ([#2198](https://github.com/mihazs/lazysh/pull/2198))
- **terminal:** give the native core the app's colours and the Mosh canonical-frame mode at session open ([#2160](https://github.com/mihazs/lazysh/pull/2160))

### Under the hood

- **android:** run the real terminal core inside the app on the CI emulator ([#2147](https://github.com/mihazs/lazysh/pull/2147))
- **ntfy:** record what the Android app did with each pushed challenge when confirmation times out ([#1966](https://github.com/mihazs/lazysh/pull/1966))

## [1.91.4] - 2026-11-21

### New

- **linux:** place a native terminal surface below the web view on Wayland, in builds with the native terminal only ([#2262](https://github.com/mihazs/lazysh/pull/2262))

### Fixed

- **agent:** keep the transcript-watch heartbeat on time while the stream waits after a slow projection. ([#2248](https://github.com/mihazs/lazysh/pull/2248))

## [1.91.3] - 2026-11-21

### Under the hood

- **terminal:** stop the daemons a program test starts when the test ends ([#2269](https://github.com/mihazs/lazysh/pull/2269))

## [1.91.2] - 2026-11-21

### New

- **accessibility:** mirror a native terminal session's rows for a screen reader while Screen reader mode is on ([#2241](https://github.com/mihazs/lazysh/pull/2241))
- **herdr:** keep the managed Herdr build from replacing itself with a stock release ([#1934](https://github.com/mihazs/lazysh/pull/1934))
- **terminal:** Draw real text in the native terminal renderer, with font fallback and correct cell widths ([#2224](https://github.com/mihazs/lazysh/pull/2224))

### Under the hood

- **checks:** skip the OSC 52 clipboard step when its Playwright install was skipped ([#2247](https://github.com/mihazs/lazysh/pull/2247))
- **android:** choose the theme QR image in the real system file picker and check its decoded preview ([#1931](https://github.com/mihazs/lazysh/pull/1931))
- **herdr:** build the managed Herdr as a release-profile executable and state its libc floor ([#1932](https://github.com/mihazs/lazysh/pull/1932))

## [1.91.1] - 2026-11-20

### Improved

- Probe whether a native surface can sit below the transparent web view on macOS (#1333) ([#2152](https://github.com/mihazs/lazysh/pull/2152))

### Under the hood

- Build and test the shared terminal core and its wgpu renderer on Windows (#1332, part of #1302) ([#2127](https://github.com/mihazs/lazysh/pull/2127))

## [1.91.0] - 2026-11-20

### New

- **hooks:** install, update and remove Kimi Code 2.4 approval hooks from Agent hook setup ([#1947](https://github.com/mihazs/lazysh/pull/1947))
- **herdr:** add the explicit install and removal of the optional managed Herdr over SSH ([#1941](https://github.com/mihazs/lazysh/pull/1941))
- **hooks:** list the seven readiness steps of an agent in the Agent hook setup panel ([#1945](https://github.com/mihazs/lazysh/pull/1945))
- **herdr:** run every native Herdr call on the one Herdr a connection captured, nothing changes for users yet ([#1942](https://github.com/mihazs/lazysh/pull/1942))
- **hooks:** set up agent hooks on macOS hosts from the app ([#1949](https://github.com/mihazs/lazysh/pull/1949))
- **hooks:** report whether the host received an agent's events in `lazysh-agent hooks status` ([#1945](https://github.com/mihazs/lazysh/pull/1945))
- Update the host companion by itself when a newer lazysh app connects ([#1948](https://github.com/mihazs/lazysh/pull/1948))

### Improved

- Refuse a companion release response when its version differs from the requested update version ([#1948](https://github.com/mihazs/lazysh/pull/1948))
- Generate and check the redistribution notice inventory of the optional managed Herdr derivative in the Herdr… ([#1936](https://github.com/mihazs/lazysh/pull/1936))

### Under the hood

- Verify theme import by QR image file and by an OS `lazysh://` link in the Linux native GUI suite ([#1890](https://github.com/mihazs/lazysh/pull/1890))
- **android:** cover pinch zoom and two-finger window swipes on a real tmux session ([#1887](https://github.com/mihazs/lazysh/pull/1887))
- **herdr:** accept the managed Herdr beside a stock server of the same session name ([#1937](https://github.com/mihazs/lazysh/pull/1937))
- **desktop:** verify the Linux keep-awake control through the real app and an owned portal server ([#1958](https://github.com/mihazs/lazysh/pull/1958))
- **android:** deny the Attachment Photo camera permission through the real system sheet ([#1928](https://github.com/mihazs/lazysh/pull/1928))
- **android:** sample the glass chrome material in the Android WebView ([#1893](https://github.com/mihazs/lazysh/pull/1893))

## [1.90.0] - 2026-11-20

### New

- Add the app's bridge to the host browser relay ([#1886](https://github.com/mihazs/lazysh/pull/1886))
- **terminal:** check the device's GPU before the native terminal engine is offered ([#2221](https://github.com/mihazs/lazysh/pull/2221))

### Fixed

- **release:** List changes from every package in the release notes, not only the client's ([#2232](https://github.com/mihazs/lazysh/pull/2232))

## [1.89.1] - 2026-11-20

### Under the hood

- **android:** cover tmux copy mode and copying a line in the Android tmux acceptance case ([#1881](https://github.com/mihazs/lazysh/pull/1881))

## [1.89.0] - 2026-11-20

### New

- **zellij:** open the Zellij pane that raised an agent notification ([#1872](https://github.com/mihazs/lazysh/pull/1872))
- **tmux:** list the panes of every tmux window in Jump To and move to the exact pane you choose. ([#1875](https://github.com/mihazs/lazysh/pull/1875))
- **zellij:** rename and close sessions and panes, and move pane dividers, from the Workspaces panel ([#1870](https://github.com/mihazs/lazysh/pull/1870))

### Under the hood

- **multiplexers:** verify that a copy in tmux, Zellij and Herdr reaches the device clipboard ([#1874](https://github.com/mihazs/lazysh/pull/1874))

## [1.88.0] - 2026-11-20

### New

- **companion:** run the companion on Windows hosts reached over OpenSSH ([#1903](https://github.com/mihazs/lazysh/pull/1903))
- **desktop:** run Files and Diff inside a WSL target on Windows ([#1921](https://github.com/mihazs/lazysh/pull/1921))
- **desktop:** choose PowerShell, Git Bash or a WSL distribution for a local terminal on Windows ([#1921](https://github.com/mihazs/lazysh/pull/1921))
- **agents:** add an opt-in "All hosts" scope to the Agents board ([#1915](https://github.com/mihazs/lazysh/pull/1915))
- **desktop:** attach native Zellij and Herdr sessions on Windows through the ConPTY ([#1926](https://github.com/mihazs/lazysh/pull/1926))
- **multiplexers:** run the guarded Herdr input in local terminals ([#1922](https://github.com/mihazs/lazysh/pull/1922))

### Under the hood

- **android:** cover the Device panel against the owned emulator over owned OpenSSH ([#1895](https://github.com/mihazs/lazysh/pull/1895))
- **share:** verify the share thumbnail fetch against the real share service ([#1918](https://github.com/mihazs/lazysh/pull/1918))
- **android:** record cancelled pointer sequences when diagnosing the native chooser ([#1927](https://github.com/mihazs/lazysh/pull/1927))
- **android:** verify the saved tmux create-if-missing default through the real host editor ([#1927](https://github.com/mihazs/lazysh/pull/1927))

## [1.87.1] - 2026-11-20

### New

- **terminal:** Add the renderer host that draws a native terminal session on a platform surface ([#2219](https://github.com/mihazs/lazysh/pull/2219))

## [1.87.0] - 2026-11-20

### New

- **terminal:** add the one-time notice that the terminal engine changed and where to switch back ([#2211](https://github.com/mihazs/lazysh/pull/2211))

### Fixed

- **release:** publish releases again by admitting the Google Android APK that carries the Parakeet runtime ([#2213](https://github.com/mihazs/lazysh/pull/2213))

## [1.86.0] - 2026-11-20

### New

- **client:** name the companion a local session runs in the Agents setup ([#1852](https://github.com/mihazs/lazysh/pull/1852))
- **agents:** show a Copilot CLI, Kimi CLI or Droid session's records in the Agent view, labelled as partial ([#1846](https://github.com/mihazs/lazysh/pull/1846))
- **herdr:** choose a list, accordion or grid layout for the Herdr Spaces tree ([#1835](https://github.com/mihazs/lazysh/pull/1835))
- **client:** show This device on the Agents board, transcripts, usage reports and inbox ([#1852](https://github.com/mihazs/lazysh/pull/1852))
- **herdr:** close, rename and resize Herdr panes and close Herdr workspaces from the Workspaces panel ([#1869](https://github.com/mihazs/lazysh/pull/1869))
- **agents:** follow a Grok Build session in the Agent view ([#1845](https://github.com/mihazs/lazysh/pull/1845))

### Improved

- Add an Android emulator case on the pinned Zellij 0.45.1… ([#1837](https://github.com/mihazs/lazysh/pull/1837))
- Extend the Android tmux acceptance case ([#1838](https://github.com/mihazs/lazysh/pull/1838))

### Under the hood

- **agents:** run the Agent view native GUI cases against an agent in a real guarded Herdr pane ([#1839](https://github.com/mihazs/lazysh/pull/1839))
- **agents:** run the Agent view native GUI cases against a reporting agent in a real tmux pane ([#1839](https://github.com/mihazs/lazysh/pull/1839))
- **android:** verify the client environment flag sends LC_TERMINAL to an AcceptEnv LC_* host ([#1830](https://github.com/mihazs/lazysh/pull/1830))
- **herdr:** assert live Herdr agent states and the current marker on Android and the Linux GUI ([#1833](https://github.com/mihazs/lazysh/pull/1833))

## [1.85.1] - 2026-11-20

### Under the hood

- **terminal:** Compile the wgpu renderer into the app with the optional native-terminal feature ([#2205](https://github.com/mihazs/lazysh/pull/2205))

## [1.85.0] - 2026-11-20

### New

- **terminal:** show which terminal engine the current session uses and why ([#2202](https://github.com/mihazs/lazysh/pull/2202))

## [1.84.0] - 2026-11-20

### New

- **voice:** offer the local Parakeet engine in the Google build of the Android app ([#1819](https://github.com/mihazs/lazysh/pull/1819))
- **voice:** offer the Parakeet local dictation engine on Windows x86_64 ([#1825](https://github.com/mihazs/lazysh/pull/1825))
- **companion:** explain where the host companion is installed and what is verified before it starts ([#1787](https://github.com/mihazs/lazysh/pull/1787))
- **agent:** add `lazysh-agent review status` and `review diff` to the host companion ([#1803](https://github.com/mihazs/lazysh/pull/1803))

### Improved

- Add an owned Android emulator case for encrypted sync (#1540, child of #17) ([#1804](https://github.com/mihazs/lazysh/pull/1804))
- Add two Linux native GUI cases for the command palette and Files over a real SSH session ([#1788](https://github.com/mihazs/lazysh/pull/1788))
- Add the owned Windows OpenSSH server the Windows GUI SSH case will connect to, and a hosted Windows check… ([#1826](https://github.com/mihazs/lazysh/pull/1826))

### Fixed

- Fix Android Appium CI task selection so the regression suite runs ([#1804](https://github.com/mihazs/lazysh/pull/1804))

### Under the hood

- Prove local Whisper on Android with the real engine ([#1806](https://github.com/mihazs/lazysh/pull/1806))
- **android:** prove upload recovery after the SSH control stream closes on the owned emulator ([#1785](https://github.com/mihazs/lazysh/pull/1785))
- **agents:** stop the dialog picker's digit-key test from timing out at random in CI ([#2207](https://github.com/mihazs/lazysh/pull/2207))

## [1.83.1] - 2026-11-20

### New

- **terminal:** register the native backend behind a probe that no release build passes ([#2164](https://github.com/mihazs/lazysh/pull/2164))

### Under the hood

- **terminal:** Hold Herdr's navigation-cell detection to both terminal backends ([#2189](https://github.com/mihazs/lazysh/pull/2189))

## [1.83.0] - 2026-11-20

### Improved

- Fold the optional hints of the Zellij quick tabs, the Host devices panel, the Preview panel's automatic… ([#1786](https://github.com/mihazs/lazysh/pull/1786))

### Fixed

- Fix the triple tap gesture never running on a touch screen, and execute triple tap and the desktop session… ([#1777](https://github.com/mihazs/lazysh/pull/1777))

## [1.82.1] - 2026-11-20

### Under the hood

- **release:** retry release Android builds when a Gradle dependency download fails ([#2185](https://github.com/mihazs/lazysh/pull/2185))

## [1.82.0] - 2026-11-20

### New

- **herdr:** collapse completed agent groups by default ([#1772](https://github.com/mihazs/lazysh/pull/1772))
- **devices:** touch an Android device on its video preview ([#1773](https://github.com/mihazs/lazysh/pull/1773))
- **desktop:** bundle lazysh-agent with the Linux and Windows packages and prove it in the release ([#1855](https://github.com/mihazs/lazysh/pull/1855))

### Fixed

- **account-usage:** stop a stalled Windows credential store from holding the Cline quota check ([#1778](https://github.com/mihazs/lazysh/pull/1778))

### Under the hood

- **android:** let the owned tmux fixture forward a DCS-wrapped OSC 52 to its attached client ([#1807](https://github.com/mihazs/lazysh/pull/1807))

## [1.81.0] - 2026-11-19

### New

- **herdr:** mark the Spaces row this device's own guarded client shows as current ([#1783](https://github.com/mihazs/lazysh/pull/1783))
- **devices:** inspect and act on an Android device's screen elements from the device controls ([#1774](https://github.com/mihazs/lazysh/pull/1774))

### Fixed

- **client:** show the Herdr New workspace and New worktree flow as a full-screen page on phones ([#1776](https://github.com/mihazs/lazysh/pull/1776))

### Under the hood

- **terminal:** Run the terminal adapter contract suite against the real core in CI and fail on an untested capability ([#2169](https://github.com/mihazs/lazysh/pull/2169))

## [1.80.4] - 2026-11-19

### Documentation

- **changelog:** Write release notes as New, Improved and Fixed lists with one linked line per change ([#2165](https://github.com/mihazs/lazysh/pull/2165))

## Development history before the structured changelog (unversioned)

The unversioned development log that was written by hand is kept as it was written and grouped by each entry's leading
verb: *Fix* is Fixed; *Record*, *Measure*, *State*, *Refresh*, *Align* and *Document* are Documentation; *Build*,
*Run* and *CI* are Under the hood; *Add*, *Show*, *Answer*, *Start*, *Open*, *List*, *Remember*, *Detect* and similar are
New; the rest is Improved. An entry that sat under an Added, Fixed or Changed heading keeps that group.

This is a development preview, not a stable release or a claim of complete reference client
parity. Remaining capability and platform gates are tracked in issue #1.

Existing defaults remain local-first: credentials stay in memory unless explicitly
saved, cloud/external services require configuration, and dictation does not send
prompts automatically. See the linked feature documentation for exact limits.

### New

- Add the client's bridge over the native terminal core's commands (`tauriNativeCoreBridge.ts`, #1321, part of #1302), the TypeScript half of the control plane: it opens a core with `terminal_core_open`, gives the transport the Channel the core's reports (title, bell, directory, clipboard) arrive on, pulls the screen's state at most once per 16 ms however much output arrives, sends typed text and pastes as text, drops input while the app is locked (never queued for later) and wakes the core again after the unlock. Tested over a mocked `invoke`, not against the Rust core or a device. Nothing registers the native engine, so terminal behaviour does not change and no defaults change; xterm.js stays the only engine.
- Add the native terminal core's control-plane commands (`terminal_core_snapshot`, `terminal_core_scroll`, `terminal_core_resize`, `terminal_core_set_active`) and the core's event stream, the Rust half of the native adapter's bridge (#1321, part of #1302): the core answers with sizes, the cursor, modes, the viewport and the text of a bounded window of rows (256 by default, at most 1,024), never cell data, and sends a change doorbell once per read of its state however much output arrives, with the program's title, bell, directory and clipboard reports (decoded and bounded) ahead of it, on the Channel that opened the core. The commands belong to the current renderer's access lease: a locked app is refused and told nothing, not even a title or a clipboard write. The Rust core answers the same 21 control-plane cases as xterm.js, and the commands are tested over a real local PTY; no cost was measured and the client has no bridge over the commands yet. Nothing creates a native session, so terminal behaviour does not change and no defaults change; xterm.js stays the only engine.
- Remember a per-device terminal engine choice (Auto, Native or xterm.js) and record, for every new session, which engine it got and why, with the reasons in English, Brazilian Portuguese and Spanish (#2092, first slice, part of #1302). New sessions ask the registry for the saved choice (the developer override still wins) and the session keeps the registry's record; an open session keeps its engine. The choice is stored on this device only and is never part of encrypted sync. No Settings control exists yet and only xterm.js is registered, so every choice runs xterm.js and a Native choice records that the native engine is not registered: nothing changes for users and no default changes.
- Build and test the shared Rust terminal core and its wgpu renderer on Windows (#1332, part of #1302). A `terminal-windows` CI job on `windows-latest` compiles libghostty-vt with Zig 0.16.0 for `x86_64-pc-windows-msvc` against the runner's Visual Studio C++ tools and Windows SDK (`LIBGHOSTTY_VT_WINDOWS_LIBC`, which Zig writes with `zig libc`), runs the runtime crate's tests, and runs the renderer crate's tests on Direct3D 12 with the WARP software adapter (the runner has no GPU, and the shipping policy still refuses a software adapter). Pull requests that change the terminal crates, the vendored binding or the workflows now run it. Compiling and testing only: the app does not use the core, there is no Windows native surface, and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Teach the shared Rust terminal core to answer the default foreground, background, cursor and palette colour queries (`OSC 10`, `11`, `12` and `4`) from a theme in its configuration, so a program that probes them to pick a light or dark scheme (Codex, Zellij, OpenCode, vim, tmux) gets the reply xterm.js gives (#1314). The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Show an OpenCode compaction in the Agent view. With the updated host companion, the message OpenCode records when it summarizes a session (a `compaction` part in OpenCode 1, a `compaction` message in OpenCode 2) is one muted **Conversation compacted** line, as for Claude Code and Codex, instead of nothing. OpenCode's step markers and its `patch` part (a list of file names) stay hidden, because the tool cards already show what ran. No defaults change.
- Answer the list dialogs of Claude Code and Codex from the Agent view under Herdr, as on tmux (part of #1121 and #1288). For the agent of the focused Herdr pane the Agent view reads the pane's visible screen through the host (`herdr agent read`, display only and bounded, every 3 seconds while the agent is not working), shows an open `/model` or `/resume` picker, the trust prompt, the plan decision or Codex's approval prompt as a card, and answers with the arrows and Enter a person presses, sent through Herdr's own `agent send-keys` after the pane's agent session is checked again, reading the highlight back before Enter. A dialog it cannot read exactly shows the banner that the agent waits in the terminal, and the companion's report of the session names what it waits for, so a permission request or a question keeps its own card and the header of a blocked Herdr agent reads **Waiting for your approval · 5 min. ago** (or answer, plan, menu) instead of only **Needs attention**. Needs the updated app only; no default changes.
- Answer a Claude Code agent's permission requests and questions from the Agent view under Herdr, as on tmux. For the agent of the focused Herdr pane (the conversation Herdr links to it) the approval dock lists that session's requests and sends the hook decision (a Herdr hook has no tmux pane, so the session id is the match, and Herdr's tree is read again before it sends), and the open question shows its options as buttons and answers with the keys a person presses (an option's digit, the Submit row, the review page) through Herdr's own `agent send-keys`, on a stock host and on a guarded one, after the pane and the agent's report are checked again. A typed free-text answer picks the free-text row and goes to the pane as one literal line and its Enter. Needs the updated app only; no default changes.
- Answer the questions and dialogs of the agent followed in a Zellij pane from the Agent view (#1484, part of #1277). The host reads the agent's own pane with `zellij action dump-screen --pane-id` (new read-only command `zellij_agent_screen`, with its ACL entries) because the terminal shows Zellij's composite screen; the dialog card shows the list dialog that is open (`/model`, `/resume`, the trust prompt, the plan decision, Codex's approval prompt), and a tap sends the arrows and Enter a person presses with Zellij's own `send-keys`, which writes an arrow for the cursor-key mode of that pane, after reading the highlight back. A Claude Code question is answered with its option's digit, or a typed line and its Enter. The host lists the panes and proves the pane runs the agent before every key. No default changes: a dialog was shown read-only with **Show terminal** before. A permission request of a Zellij pane is still answered from the Agents board.
- Show the existing conversation-too-large notice when a Herdr-selected agent conversation exceeds the companion's limit, and retain fixed error classifications for other conversation failures (#2069). Remote diagnostic text is not displayed. No defaults change.
- Open larger recorded Codex conversations in the Agent view, including forked histories and older-message paging (#1612). The client opts in to a bounded full-history index; older clients keep the previous limit. The reader still reports `TooLarge` when its explicit source, record or metadata limits are exceeded. No defaults change for existing companion commands.
- Answer Copilot CLI's permission prompts from the app through Copilot's own `permissionRequest` hook decision (#1797, part of #1535 and #6). `lazysh-agent approval-config --agent copilot` prints the opt-in hook file and `approval-request --agent copilot` waits for the exact request: it is the same hash-bound record as Claude Code's and Codex's (agent, session, project, tmux pane, tool name and input, expiry), listed on the Agents board as `copilot`, and an allow or a deny with a message reaches Copilot at the top level of the hook's stdout, never as typed keys; a wrong pane, session or hash, a cancelled hook or an answered request is refused, and a payload that is not Copilot's own `permissionRequest` makes the hook fail with no decision. Copilot runs this hook before its own rules, so every shell command, file edit or other tool call that needs a permission check becomes a request (including ones Copilot would run without asking, and everything under `--allow-all-tools`), an allow skips Copilot's own deny rules such as `--deny-tool`, and Copilot's `matcher` can narrow the hook to some tools. A request nobody answers within its deadline (120 seconds in the fragment) gives no decision and Copilot then asks in the terminal; pressing Esc twice in the terminal interrupts the turn and removes the request. Checked by hand against Copilot CLI 1.0.105 on Linux with a stand-in model server and a private tmux; Copilot requests are answered from the Agents board, not yet from the Agent view dock, and agents other than Claude Code, Codex and Copilot CLI keep their prompt in the terminal. Nothing changes until you save the file in Copilot's hooks directory; no default changes.
- Answer Codex's permission prompts from the app through Codex's own `PermissionRequest` hook decision (#1535, part of #6). `lazysh-agent approval-config --agent codex` prints the opt-in hook entry and `approval-request --agent codex` waits for the exact request: it is the same hash-bound record as Claude Code's (agent, session, project, tmux pane, tool name and input, expiry), listed on the Agents board as `codex`, and an allow or a deny with a message reaches Codex on the hook's stdout, never as typed keys; a wrong pane, session or hash, a cancelled hook or an answered request is refused. Codex draws its own prompt only after the hook returns, so a request nobody answers within its deadline (120 seconds in the fragment) gives no decision and Codex then asks in the terminal (Claude Code's expired requests stay denied), and Esc in the terminal interrupts the turn and removes the request. Checked by hand against Codex 0.167.0 with a stand-in model server; Codex requests are answered from the Agents board, not yet from the Agent view dock, and agents other than Claude Code and Codex keep their prompt in the terminal. Nothing changes until you merge the fragment into Codex's `hooks.json`; no default changes. Requests stored by an older companion keep resolving.
- Add the host browser relay to the host companion (#1254, first slice, part of #1250): `lazysh-agent host-browser serve` starts a private, headless Chrome or Chromium (111 or newer; the version is read from the browser and an older one is named, not guessed) with `--remote-debugging-pipe`, so no debug port exists on the host, and streams its page over one SSH exec channel as length-prefixed JPEG frames, with the page's title and address as bounded text. The device acknowledges each frame after it decodes it (at most two are unacknowledged, so a slow link gets fewer frames and no queue), `pause` stops the screencast at the browser while the view is hidden, and every browser protocol command passes the allow-list, so cookies, script, downloads, permissions, the clipboard and non-web addresses are never reachable; a message outside the relay's closed set is refused and counted. Closing the channel, SIGINT, SIGTERM, SIGHUP, the browser exiting or the page closing ends the browser, its helpers and its profile, and the next start removes the profile of a relay that was killed outright. It refuses to start while the host browser switch is off, which is the default. **Nothing changes for users yet**: the command is hidden and the app has no viewer, switch or confirmation for it (the viewer and the app's bridge are the remaining slices of #1254, gated by the opt-in screen of #1258); there is no Windows relay.
- Add Control to the host browser relay (#1709, part of #1255 and #1250): a `control {on}` message turns Control on or off for the session, and while it is on `lazysh-agent host-browser serve` turns the client's `pointer`, `wheel`, `pinch`, `key` and `text` messages into the browser's mouse, wheel, page-scale, key and insert-text calls, in the order sent and through the allow-list (the mapping is the one in the developer prototype's `inputCommands`, so a tap, a scroll, a pinch, typed accents, CJK and emoji, Enter, Backspace, Tab, arrows and a Control or Meta chord reach the page as in the prototype). **Control is off when a session starts**, and while it is off every input message is refused with `ControlOff`, counted and never forwarded; turning it off stops forwarding at once. A coordinate outside the viewport, a wheel delta beyond 10000, a page scale outside 1 to 5, text over 4 KiB, a key outside the fixed list, an unknown field and a flood of more than 240 messages a second are refused with `InputOutOfRange`, `OperationRefused` or `InputRateLimited`, an editing shortcut that moves the clipboard (Control or Meta with C, X or V, Shift with Delete) with `PermissionRefused`, and each reason is reported to the client at count 1, 2, 4, 8 and so on. The relay's `state` message now says `capabilities.control: true`. The relay never logs a coordinate, a key or a text. **Nothing changes for users yet**: the command is hidden, and the app neither sends these messages nor has a viewer for them (#1710 and the viewer of #1254); no default changes. Checked with a fake DevTools pipe browser for every message and bound, and with a real headless Chromium 157 through the real relay, where a tap, typed accents, CJK and an emoji, Backspace and a scroll reached a fixture page and a tap sent with Control off did not. Not run: macOS hosts, Windows (the relay has none), a headed browser or a real SSH hop.
- Add a desktop keyboard quick reference to [the shortcuts guide](docs/shortcuts.md#desktop-keyboard-quick-reference): Ctrl+K, Ctrl+Shift+P, Ctrl+Shift+A, Ctrl+Shift+W and Ctrl+Shift+Y (Cmd on macOS) with where each works, linked to the key matching in `keyboard.ts` and its tests. It states that no physical keyboard, macOS Cmd or phone hardware keyboard was exercised and that the Ctrl/Cmd+O, N, W and 1 to 9 session shortcuts are tracked in the parity matrix rather than listed. Documentation only; no defaults change.
- Start an agent in a new Git worktree, or in a chosen folder, from the Agent view's empty state (#1220). Under Herdr with the launcher, **Start in a new worktree** opens the existing **New worktree from …** dialog for the focused workspace (or the first one that reported a directory) with **Start an agent in it?** already answered yes; it shows the exact commands and, once created, the Agent view focuses the new workspace. In tmux, Zellij, plain shells and Herdr without the launcher, **Start in a folder** asks for Claude Code or Codex and a host folder (typed, a known folder or browsed), shows the exact `cd '<folder>' && claude` command and stages it in the terminal composer; nothing runs until you send it. Changed default: none. **Start Claude Code** and **Start Codex** still stage the bare command. The Resume action keeps staging its command: no launcher can start a command in a new pane yet.
- Add a performance regression gate for the native terminal core to CI (#1341, part of #1302): a separate `terminal-perf` job (not a required check, so it runs on pushes to `main` only) runs the core's parse-to-frame cost, allocations, scrollback rows, memory per session, memory growth over session churn and renderer upload volume against limits, and fails when one regresses. Timed metrics are ratios inside one process and the rest are counts, so a noisy hosted runner does not decide the result; every run also proves the gate fails on an injected slowdown and on injected allocations. Measured on one desktop host only; the first hosted-runner figures are still to be recorded. Nothing changes in the app: xterm.js stays the only terminal engine and the default, and no setting or default changes.
- Add the page side of the developer-only Android native terminal surface (#1327, part of the terminal engine epic #1302): a tracker that keeps the surface on a DOM element through layout, scroll, zoom and transitions, sends one placement command at a time with the latest rectangle, does no work while the page is idle, and takes the surface down when the element has no box, the shell refuses or tracking stops. Nothing in the app creates a tracker yet and release builds refuse the commands, so xterm.js stays the only engine and the default, terminal behaviour does not change and no defaults change.
- Teach the shared Rust terminal core to apply Mosh display frames as a top-anchored resize without reflow. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Add the host browser switch and a managed browser profile to the host companion (#1258, slices A and B, part of #1250). `lazysh-agent settings host-browser show` and `update --expected-revision R --host-browser-enabled true|false` read and change `hostBrowserEnabled`, which is **off by default** and the only companion switch that is: every host-browser command now fails before it starts a process while it is off, absent or unreadable, and refuses a malformed file instead of resetting it. **Schema:** the switch is not a sixth field of `settings.json` (a strict file that a released companion or client refuses, so a new field would have made it fail on the other three switches); it has its own `host-browser.json` and revision, and `settings show` and `settings update` keep their five fields and three flags, so a released client keeps reading and updating the other three switches. The hidden browser launcher (still behind `LAZYSH_DEV_HOST_BROWSER=1`, no app switch yet) now keeps its profile in a private directory (mode 0700) under the companion state directory beside a pid marker, removes it on a normal stop, a closed channel or SIGINT, SIGTERM and SIGHUP, removes the profile a killed launcher left behind at the next start, and on Linux kills the browser with the launcher. `--keep-profile` keeps one profile for sign-ins that must survive and `host-browser --clear-data` removes it, also while the switch is off. The app's **Host browser** switch and its first-use confirmation are in host settings (#1696); the browser view ships with the Chrome viewer (#1254).
- Teach the shared Rust terminal core to bring a reader who scrolled back to the live screen when typing or pasting is accepted, like xterm.js's `scrollOnUserInput` (#1316, #1043). The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Add the host companion command `lazysh-agent listeners` (#1510, part of #1504). It lists the TCP sockets that listen on a loopback or a wildcard address with the owner's process id, name, user id and start time, as one JSON line (or a stream of `listen` and `close` events with `--watch`), so the app can later confirm that the `http://localhost:PORT` a sign-in command (`aws sso login`, `codex login`, `az login`) printed is served by the host's own process. It reads no command line or environment and forwards nothing; an update of the host companion is needed to have it. No defaults change.
- Add the host browser shim to the companion (#1512, part of #1504). `lazysh-agent browser-shim install` puts `xdg-open`, `sensible-browser`, `x-www-browser` and `lazysh-open` wrappers (`open` on macOS) first on `PATH` and sets `BROWSER=lazysh-open` for your interactive shells, through one marked block in `~/.profile`, `~/.bashrc`, `~/.bash_profile`, `~/.zshrc` and fish's `conf.d`, so a link a host program opens can go to your device over the new `lazysh-agent browser-watch --protocol 1` channel (frames `hello`, `open`, `heartbeat`, `end`; 6 opens a minute, identical links once per 10 seconds). With no device attached the wrappers hand the link to the real opener unchanged, or print `lazysh: open this on your device: URL`. Only `http` and `https` links of at most 4096 printable characters without credentials are sent; the socket is in a private per-user directory and checks the peer's uid; nothing is written to disk and no escape sequence is used, because tmux, Zellij, Herdr and `mosh-server` drop them. `status` and `uninstall` report and remove exactly what install wrote, byte for byte. Off until installed, so no default changes; with the shim installed, tools that fall back to a device code when the host has no browser launcher (`az login`) start their browser flow instead. The app does not read `browser-watch` yet (#1513, #1514). Linux and macOS hosts.
- Add the wgpu renderer of the native terminal engine as its own crate: a glyph atlas of fixed size, dirty-row batching and no frame while the screen is unchanged, checked pixel for pixel against the CPU reference renderer. The renderer is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Detect sign-in callbacks in terminal output (#1510, part of #1504). A native scanner in the SSH, Mosh and ET output path reads what a host command prints and, for an authorize URL whose redirect is `http://localhost:PORT` (`aws sso login`, `aws login`, `codex login`, `gcloud auth login` with a browser, and by their documentation `wrangler`, `firebase`, `terraform`, `vault` and `kubelogin`), announces a sign-in hint with the port, callback path, identity provider host and PKCE flag to the app as a `lazysh-auth-hint` window event. It handles colours, OSC 8 hyperlinks, a URL the program wrapped across lines and any chunking, runs while the WebView is suspended, and ignores dev-server addresses, redirects to public hosts, ports below 1024, URLs over 4096 bytes and the host's SSH port; no `code`, `state` or other query value is kept. Nothing is tunnelled or opened by this change and no screen shows the hint yet. No defaults change.
- Add the engine that will carry the localhost callback of a host sign-in to this device (#1511, part of #1504). It is groundwork: nothing in the app detects a sign-in, asks you or starts a tunnel yet, so no behavior changes today. A sign-in tunnel listens on the same loopback port the host CLI announced, passes one checked browser request per connection to that host port over the session's SSH connection (a client speaking another protocol, a wrong `Host` or path, a cross-origin fetch, an upgrade or an oversized request is answered on the device and never reaches the host) and closes 15 seconds after the callback, after 10 minutes, or when you stop it, the session ends or the app locks. Callback contents are never logged or stored, and a busy port fails instead of moving. No defaults change; previews are unchanged.
- Teach the wgpu renderer of the native terminal engine cursor blink from one timer shared by every session (no timer while blink is off or the cursor is hidden), frame pacing to the display refresh, display scale changes, and recovery from a lost GPU device from the core's state with the same pixels (#1326). The renderer is not wired into the app and xterm.js stays the only engine and the default, so nothing changes for users.
- Show Codex sub-agents in the Agent view's background-work panel. A Codex conversation that spawned sub-agents (`spawn_agent`) now lists each one with its name, its state and its run time: running from the start the rollout records for it, done at its recorded completion or the final answer it sends its parent. Codex background terminals, OpenCode, Grok and Gemini work is not shown yet because their records have no confirmed shape. Needs the updated host companion. No defaults change.
- List OpenCode sub-agents in the Agent view's background-work panel. With the updated host companion, the `task` calls of an OpenCode conversation (V1 and V2, including OpenCode 2.2, which keeps a message's parts inline and has no `session_part` table) appear as sub-agent rows with their type and state: done or failed with the call, and for a background task running until OpenCode records its end. Before, the OpenCode V2 conversation of OpenCode 2.2 could not be read at all. No defaults change.
- Teach the shared Rust terminal core to answer what text is under a selection (a range of cells, a word, a line, the whole buffer or the visible screen), to find text in the screen and scrollback, and to apply the clipboard consent limits (64 KiB, valid UTF-8, never partial) to the clipboard writes a terminal program makes with OSC 52, with the same results as the xterm.js engine on shared fixtures that cover wide and combining characters and wrapped lines (#1320). Five differences in what OSC 52 offers the user (a write to `s`, `cs` or `ccc` is no longer offered, an unknown target letter is, an empty write is not) are recorded next to the fixture and registered as open, and the primary-only write is settled because the existing policy rejects it too. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Teach the shared Rust terminal core to read the text of any rows of its screen and scrollback, optionally one column span, and to report where the visible rows sit in the buffer, with the same results as the xterm.js engine on a shared set of screens (#1318). This is what Herdr's phone navigation needs to find its switch button. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Add `lazysh-agent update`, `update --dry-run` and `update --rollback` to the host companion on Linux and macOS (#1444). `update` downloads the release on the host over its own HTTPS connection, compares the byte count and SHA-256 with the verified release metadata and with an optional caller's pin (`--expect-sha256`, `--expect-bytes`, exit 22 on any difference), runs the new binary once in an empty environment to prove it answers `--version` and the hook protocol (a lifecycle event round-trips through `ingest` and `snapshot`), and only then renames it over the managed `lazysh-agent`; the installed file is checked again and a failed check restores the previous one. The replaced companion is kept as `lazysh-agent.previous`: `update --rollback` reinstalls it through the same verified replace, with no network, and a second rollback undoes the first. `--dry-run` does everything but the replace and leaves no trace. A terminal asks before installing; scripts and `--json` need `--yes`. A release older than the installed one is refused (exit 23) unless `--version X.Y.Z --allow-downgrade` names it, another running update gives exit 26, an unsafe managed directory exits 27, and nothing ever runs `sudo`. Settings, hooks and event state are untouched. The app's **Update companion** still downloads on the device until it adopts this command; installing on Windows and auto-update follow. No defaults change. Reference: `docs/reference/companion-update.md`.
- Add `lazysh-agent update --check` and `--status` to the host companion (#1444). `update --check` asks GitHub's release metadata, from the host and over HTTPS only, whether a newer verified companion exists for this platform and exits 10 when it does (0 when up to date); it checks the release, the tag's commit, `release.json` and the per-target receipt against GitHub's own digest and size, downloads nothing and writes nothing. `--version X.Y.Z` and `--channel stable|prerelease` choose the release, `--json` prints newline-delimited progress and one result object, and failures use the documented exit codes (20 offline, 21 no compatible release, 22 verification failed, 23 downgrade refused). `update --status` reports the installed and previous copy offline. Installing, rollback and auto-update follow in later changes; the app's **Update companion** still downloads on the device until then. The release lookup moved into a shared crate used by the app and the companion without changing the app's behavior. No defaults change. Reference: `docs/reference/companion-update.md`.
- Open the Agent view faster. Opening a conversation made 14 SSH execs, one after another, before the first message showed (each companion command also repeated an unchanged host probe, the pane and the report were read one after the other, and the same report was checked twice around the first read); it now asks the host about its Unix identity once per connection, reads independent things together and checks the report once after the first read. Measured on a modelled link (4 SSH execs in a row for a hook-bound tmux conversation, was 14): the first message shows after 0.5 s instead of 1.2 s on a 30 ms round trip and after 1.0 s instead of 2.8 s on 80 ms; a Herdr conversation after 1.0 s instead of 1.2 s on 80 ms. No setting changes and the host companion needs no update.
- Show the files Codex changed in the Agent view. A Codex edit (a `FileChange` item) is now one **apply_patch** call with its outcome, so it appears as a diff card with the lines added and removed per file, and a failed or declined edit is marked as such; before, Codex edits were left out of the conversation. A new file or a deleted one is shown whole and cut at 32 KiB. Needs the updated host companion. No defaults change.
- Show each tool call of the Agent view as one card with its result, and each file edit as a diff card. A command, read, search, fetch or other tool call is one row with the tool name, a one-line summary (the command, the file and line range, the pattern, the URL), a status (running while the agent works, done, failed with the exit code, or declined when you or a rule refused it) and, when opened, the full input and the last 20 lines of the output with **Show earlier lines** and **Copy output**. An `Edit`, `MultiEdit`, `Write` or `apply_patch` call shows the lines it changed with `+` and `-` counts per file, **Wrap lines** and **Copy diff**. The result no longer appears as a second block, and a call whose result is not loaded yet or was never recorded shows no status. It is built in the app from the recorded calls, so it works with any current host companion and for Claude Code and Codex. No defaults change.
- Set up the OpenCode, Cline and Amp hook plugins on Windows hosts (#1771, part of #1527 and #603). `lazysh-agent hooks status`, `install` and `remove` used to answer `HooksAclUnsupported` on Windows; they now manage those three providers' plugin file, whose hook spawns the companion as an argument vector, so the absolute `lazysh-agent.exe` path (spaces, apostrophes and non-ASCII characters included) needs no shell quoting, and `hooks preview` reports `binaryBinding: currentExecutable` for them. The profile directory is held by a handle that denies rename and deletion; a symbolic link, junction, stream name (`name:stream`), device name, hard link, foreign owner, Everyone-writable file, unreadable ACL or a provider created between inspection and commit is refused or preserved with the fixed class and leaves the provider file unchanged, and an update keeps the replaced file's ACL. **Claude Code, Codex, Droid, Gemini CLI, Cursor CLI and GitHub Copilot CLI stay preview-only on Windows** (their launchers are not qualified yet: #1959, #1960), only local NTFS volumes are admitted, and the app does not discover or offer Windows profiles yet (#1961), so this is available from the command line only. Checked on a hosted Windows runner with the real `lazysh-agent.exe` and the real Bun launcher; the real OpenCode, Cline and Amp CLIs, a non-elevated user, ReFS, network drives and ARM64 were not run. Added only: no defaults change.
- Show Claude Code dynamic workflows as a live progress tree in the Agent view. A workflow (the `Workflow` tool) in the background-work panel above the composer opens into its name, its phases as a stepper, each agent under its phase with state, tool calls, tokens and time, and the totals; it updates in place as the agents start and finish, and an agent's conversation opens with **Open conversation**. The state comes from Claude Code's workflow journal and summary file; an agent with no recorded end is shown as **Not confirmed** once the workflow itself is recorded as finished, never as running. This format is Claude Code's own and not a public contract, so a run whose files are missing shows only its launch. Needs the updated host companion. No defaults change.
- Open a sub-agent's own conversation from the Agent view. A Claude Code sub-agent row in the background-work panel now has **Open conversation** when the session directory holds the sub-agent's own files; it shows that conversation in place of the parent's, with **Back to the conversation** returning to the parent at the scroll position it had. A sub-agent whose files say it finished, with no result recorded in the parent, now shows done, and its row shows the last thing it said. Needs the updated host companion. Stopping a sub-agent is not part of this change. No defaults change.
- Show Claude Code goal, plan-mode, recap and hook-failure records, and Codex goal and compaction records, as compact muted lines in the Agent view: **Goal set**, **Goal reached** (with the reason on tap), **Plan mode on**, **Plan mode off**, **Recap** and **Hook failed** (with the hook's error on tap). The repeated per-turn goal checks, hook successes, skill and tool listings and a sub-agent's own plan-mode reminders stay hidden. Needs the updated host companion; an older one shows none of them. Codex shows **Goal set**, **Goal reached** and **Conversation compacted**. No defaults change.
- Add the host browser's input as client components, driven in the developer-only prototype viewer: a **Control** switch that is off at every start and sends nothing while off, tap, double tap and long press as a left click, a double click and a right click, one-finger drag as page scrolling (wheel events at the frame rate) or, with **Select**, as a mouse drag, a two-finger pinch that zooms the frame at once and **Zoom page** to make it the page's scale, and the phone keyboard with text, IME composition, accents and emoji sent as text and Enter, Backspace, Tab, arrows, Escape and Control or Meta chords sent as keys. The clipboard chords are never sent. Strings are in English, Brazilian Portuguese and Spanish. A real headless Chromium test covers each gesture and typing. Developer-only until the host browser view and the relay's input messages ship (#1254, #1255); nothing reaches the app yet and no defaults change.
- Add the device side of opening a sign-in page (#1513, part of #1504): `open_auth_url` opens a page on the phone or desktop that runs lazysh instead of on the host, and `inspect_auth_url` tells the app which host it would open (never the query) and whether it is plain `http` to another host or an internationalized (`xn--`) name that can imitate another domain. A phone opens the page in an in-app browser tab, Chrome Custom Tabs on Android and `SFSafariViewController` on iOS, so lazysh stays the app in front; a desktop opens the system browser; a `system` choice opens the default browser app on a phone. A page whose redirect (`redirect_uri` and the other names tools use, also when encoded twice) is `http://localhost:PORT`, `127.0.0.1` or `[::1]` on a port from 1024 opens only when something listens on that port on the device, and the check connects to nothing. Android 10 and later cannot start a page from the background, and a foreground service is no exemption, so a request that arrives while another app is in front becomes a notification ("Sign-in is waiting", naming the host and never the query) that opens the page when tapped; a newer request replaces it, it expires after two minutes, and with notifications off the command says so instead of opening nothing. Nothing in the app calls these commands yet, so there is no visible change: detection, the tunnel engine and the consent banner follow in the same epic. iOS is compile-checked only and has not been run on a device. No defaults change.
- Allow the app to run the stock Herdr send command of the Agent view composer. Its permission was missing from the app capability, so on a stock Herdr host the app refused the send before it reached the host. No default changes.
- Show what a Claude Code session has loaded in a read-only **Session info** sheet, opened from the Agent view options (#1289): the MCP servers with their state (connected, starting or failed to connect) and tool count, the skills, the agent types and the instruction files (such as `app/CLAUDE.md`, with their kind). The host companion reads them from the session's attachment records into a new `session.info` object, copying names only (never instruction text, skill descriptions, error messages or full paths); update it to get the sheet, an older companion leaves the entry out. Codex records no equivalent, and the agent's interactive `/mcp`, `/memory` and `/context` screens stay in the terminal, which the sheet says. No defaults change.
- Add **+** and rename to the native tab strip. A **+** at the end of the row creates a tab in the focused Herdr workspace, a Zellij tab or a tmux window through the multiplexer's own command, after a prompt for its name and directory, and switches to it. A long press (or a right click, or the context-menu key) on a Herdr tab, a Herdr workspace in the workspace list or a tmux window asks for a new name and renames it; Zellij tabs cannot be renamed because the command layer has no rename, and close is still not available. The name prompt is the only thing in the strip that opens the soft keyboard, and it drops over the terminal without resizing it. A Herdr tab or workspace that has gone since the strip last read is refused instead of renamed by guess. No defaults change.
- Add a native **tab strip** above the terminal for Herdr, Zellij and tmux sessions: one slim row that mirrors the multiplexer's own tabs, so you can see them and switch with one thumb instead of typing the prefix keys or reaching for Herdr's in-terminal `switch` button. Herdr shows its workspace tabs with a state dot per tab (working, done, needs attention) and a workspace chip that lists every workspace and flags another workspace that needs you; Zellij shows the session and its tabs, and tmux the windows of the attached session. The active chip is kept in view and a tap runs the multiplexer's own guarded command (Herdr focus after a fresh read of its tree, Zellij `go-to-tab`, tmux Jump To), never typed keys, never raising the soft keyboard and never resizing the terminal by more than the strip's own row. New **Preferences > Keyboard and gestures > Show tab strip** setting: Auto, Always or Never, kept on this device. New command `zellij_tabs` (reads `zellij action list-tabs --json`, Zellij 0.45 or newer; older Zellij shows no strip). **Changed default:** on phones, a terminal attached to Herdr, Zellij or tmux with more than one tab now shows the strip while the key toolbar is shown (Auto); switch it off with **Never**. Long-press rename and close, and a **+** for new tabs, are not in this first version.
- Add a native **tab strip** above the terminal for Herdr, Zellij and tmux sessions: one slim row that mirrors the multiplexer's own tabs, so you can see them and switch with one thumb instead of typing the prefix keys or reaching for Herdr's in-terminal `switch` button. Herdr shows its workspace tabs with a state dot per tab (working, done, needs attention) and a workspace chip that lists every workspace and flags another workspace that needs you; Zellij shows the session and its tabs, and tmux the windows of the attached session. The active chip is kept in view and a tap runs the multiplexer's own guarded command (Herdr focus after a fresh read of its tree, Zellij `go-to-tab`, tmux Jump To), never typed keys, never raising the soft keyboard and never resizing the terminal by more than the strip's own row. New **Preferences > Keyboard and gestures > Show tab strip** setting: Auto, Always or Never, kept on this device. New command `zellij_tabs` (reads `zellij action list-tabs --json`, Zellij 0.45 or newer; older Zellij shows no strip). **Changed default:** on phones, a terminal attached to Herdr, Zellij or tmux with more than one tab now shows the strip while the key toolbar is shown (Auto); switch it off with **Never**. A **+** at the end of the row creates a Herdr tab, a Zellij tab or a tmux window through the multiplexer's own command after a prompt for its name and directory, and switches to it; a long press (or a right click, or the context-menu key) on a Herdr tab, a Herdr workspace in the workspace list or a tmux window asks for a new name and renames it. Zellij tabs cannot be renamed and no multiplexer can close a tab from the strip yet, because the command layer has neither. The name prompt is the only thing in the strip that opens the soft keyboard, and it drops over the terminal without resizing it.
- Open or download the selected file from **Files**. Selecting a file keeps the in-app preview (text, code, Markdown, images) and adds **Open with…**, **Download** and, on Android, **Share**. The file is copied over the existing SFTP connection (or the local disk for a local desktop session) into a private staging folder with a progress bar and **Cancel**, which stops the host read and deletes the partial copy. **Download** saves to Android through the system file picker, which asks before replacing a file, and on desktop to the Downloads folder as `name (1).ext` instead of overwriting; **Open with…** hands the copy to the app you choose and **Share** sends it to another app. A symbolic link asks before the file it points to is used, files over 50 MiB ask first, a folder is refused with a message, and programs and scripts (`.exe`, `.sh`, `.jar`, `.app` and similar) can be saved but never opened by the system. Staged copies are private and never executable; a saved copy is deleted at once, the newest three opened or shared copies stay for the other app, and all are deleted at every app start. New commands `host_file_stat`, `host_file_download`, `host_file_cancel` and `host_file_deliver`; no defaults change.
- Add copy, search and a history choice to the Agent view (#1234). Every message has a small **Copy message** button in its corner that puts the original Markdown on the clipboard, and every code block a **Copy code** button that copies exactly the code; both say **Copied**, or that the clipboard is unavailable. A search button in the header opens one compact search row with the match count, **Previous match** and **Next match**; it finds text in the loaded conversation including the tool output inside folded activity rows, opens the row that holds the current match, scrolls to it and highlights the matches where the web view supports it. **Conversation only** in the options sheet hides the tool work and keeps each prompt and its answer; the default is still the full history with folded tool work, and the choice is remembered on this device per terminal. The header does not grow and nothing takes chat space until search is opened. Search covers the loaded window only. No defaults change.
- Show a failed Claude Code API call as an error card in the Agent view and Chat instead of plain assistant text. A usage limit, an unreachable API, a refused request or another recorded API error now reads **The agent could not continue**, keeps the agent's own message (with a reset time when it has one) and says what to do next. Only the four error causes Claude Code records are recognised; anything else stays an ordinary message. The host companion must be updated for the cards. No default changes.
- Answer Codex's dialogs from the Agent view on a tmux session, the same way as Claude Code's list dialogs: its approval prompt (**Yes, proceed**, **Yes, and don't ask again**, **No, and tell Codex what to do differently**, with the command it asks about), `/model` and its reasoning level, `/permissions`, `/review` and the rate-limit prompt. The dialog is read from the rows of the terminal screen; a tap moves Codex's highlight with the arrow keys, reads it back and only then presses Enter, as a person would, and nothing is sent if the screen or the pane changed. The **Yes, and don't ask again** option keeps a permission rule, so a tap first shows its exact text and what it keeps, and **Back** sends nothing. A Codex dialog this version does not recognise (the `/resume` table, a question with notes) still says **The agent is waiting for you in the terminal** with **Show terminal**. Checked against screens captured from Codex 0.167.0; OpenCode, Grok and Gemini dialogs stay in the terminal. No default changes.
- Answer the list dialogs Claude Code opens (`/model`, `/resume`, `/rewind`, the folder trust prompt, the plan decision) from the Agent view on a tmux session. The open dialog shows as a card above the composer with its title, the text that explains it, each option with the highlighted one marked and the footer that says what Enter does; tapping an option moves the highlight with arrow keys, reads the dialog back and presses Enter only once the chosen option is highlighted, as a person would, and **Cancel the dialog** sends Escape (on a desktop keyboard the digits 1 to 9 choose). It is read from the terminal screen of the same pane and fails closed: a dialog it cannot read exactly (tabs, a multi-select, a text field, a footer it does not know, the confirmation page of `/rewind`) shows **The agent is waiting for you in the terminal** with **Show terminal** and sends nothing, and nothing is sent when the screen no longer shows the dialog that was tapped or the pane is not the one the agent's report names. Dialogs of other agents and of Herdr panes stay in the terminal (the Herdr guard rejects the new bounded `pick` input). Changed default: the composer's note for a command that opens a dialog now says to choose in the card here or in the terminal. No settings change.
- Browse earlier sessions from the Agent view (#1291). **Earlier sessions** in the Agent view options (and on the empty state of a Herdr pane) lists the Claude Code and Codex sessions recorded for the folder the pane works in, newest first, with a title and how long ago; opening one reads it in the same reader, read-only, with no composer. **Resume in the terminal** stages the agent's own resume command (`claude --resume <id>` or `codex resume <id>`) in the terminal composer for you to review, the way **Start Claude Code** does, and is not offered over a pane that already runs an agent, so nothing is ever typed into a running agent. The host companion gets a `lazysh-agent history` command (same transcript-discovery setting as `discover`) and the app a new `agent_history` command; update the companion to get the list, an older one says so. Where no folder is known (a tmux terminal with no reported agent) there is no list, and resuming in a new pane waits for the launcher (#1128, #1220). No defaults change.
- Offer more than Allow and Deny on a Claude permission request, in the Agent view and on the Agents board. Each permission update Claude Code suggests for the request (allow and remember a rule, switch to another permission mode, add working folders) is its own button, and **Deny with a message** tells the agent why, so it can change course instead of only being refused. A suggestion is never a default: it opens a confirmation that shows the exact rule and where Claude Code will keep it (this session, the project's local or shared settings, or your user settings), and cancelling sends nothing. lazysh does not write rules or edit settings files: the chosen suggestion goes back to Claude Code through the same approval hook and Claude Code applies it. The bypass-permissions mode, deny rules and anything unrecognised are never offered. The host companion must be updated to list the options; an older companion still shows Allow and Deny only. No default changes.
- Open the pane that raised an agent notification (#14). Opening an inbox row, or tapping a desktop notification or its **Open session** action, for an agent that ran in a tmux pane now also selects that pane in the tmux terminal you are attached to and brings its window forward, so the Agent view follows that agent and not another one in the session. The pane is looked up on the tmux server the terminal is attached to, because the host companion reports the pane id but not its server; a pane that no longer exists, a Zellij or Herdr terminal, and an agent without a pane id still open the session as before. The **Select** button of the Multiplexer panel now also brings the pane's window forward (`select-window` before `select-pane`). No defaults change.
- Add a **Private keyboard in the terminal** setting for Android, as a way around soft keyboards that drop or change characters in the terminal (for example Microsoft SwiftKey, #1208, #1214). It is in **Preferences → Keyboard and gestures → Keyboard**, is shown only in the Android app and is off by default, so no default changes. While it is on and the terminal has focus, the Android keyboard is asked to type in private (incognito) mode and as a plain key source: it does not learn from or remember what you type, shows no suggestions, and is told the field is a visible password, which keyboards answer with ordinary committed characters and key events instead of editing a composing region. The trade-off is stated next to the setting: predictive text, autocorrect and swipe typing stop working in the terminal while it is on, and a keyboard may hide emoji, clipboard or voice buttons that it hides for password fields. Only the terminal is affected: the Chat composer, the Compose text editor and every other field keep the keyboard's normal behavior, and hardware keyboards, Gboard's settings, desktop and iOS are untouched. The change applies at once, without reconnecting, and is saved on this device only (settings sync neither uploads it nor lets a download replace it, and **Reset preferences** turns it off).
- Answer the open Claude Code question from the Agent view on a tmux session. When the agent waits for an answer, its unanswered question stays in view (outside the folded activity) with its options: single or multi-select, several questions in order, or your own typed answer. lazysh types exactly the keys the Claude Code dialog takes (an option's digit, its Submit row, the review page's **Submit answers**) through the composer's already bound pane, and re-reads the pane and the agent's report before every key so nothing is sent if the dialog was answered in the terminal first. Questions of other agents, of Herdr panes and with more than 8 options stay read-only with **Answer in the terminal**. No default changes.
- Answer Claude Code permission requests from the Agent view. A request that waits in the pane's agent now appears above the conversation with the full tool input, and Allow or Deny sends the same hash-bound decision as the Agents board, only if the pane still runs that session and 400 ms after the card appeared. Nothing is typed into the terminal. No default changes.
- Let the Agent view read the whole session from its first message. Scrolling to the top of the loaded messages (or **Load earlier messages**) reads the page before them and keeps the line you were reading where it was, **Jump to start** shows the first message with a **Start of the session** marker, and **Load later messages** (or scrolling down) reads forward again until **Jump to latest** returns to the newest. It works for Claude Code (including across compactions: the conversation before a `/compact` is shown above the compaction notice), Codex and OpenCode conversations, on a phone and on a desktop. The view holds at most 400 messages at a time, so a session of tens of thousands of records stays light, and live updates pause while it is away from the newest messages. This needs the new host companion; with an older one the view keeps showing the latest messages and **Load earlier messages** asks you to update the companion. The companion now also reads Claude Code, Codex and OpenCode sessions of more than 10,000 records. Gemini CLI conversations page the same way, with the companion that reads them. No defaults change.
- Add the background-work panel to the Agent view for Claude Code conversations: the equivalent of the status area under the Claude Code prompt. One compact row above the composer, shown only while background work runs, says how many shells, monitors, sub-agents and workflows are running, with **N shells** and **N monitors** buttons that list each one (label, state, elapsed time), and opens into a tree of sub-agents and workflows (type, state, live elapsed time, and the tokens the sub-agent reported when it finished) with **N more** past three rows. It is derived from the recorded tool calls, their results and the harness's task notifications, so it works with any current companion and needs no terminal input. Not yet in the panel, and listed in the Agent view parity reference: the permission-mode line with tap-to-cycle, an output viewer for a shell or monitor, per-step workflow progress bars, and the footers of Codex, OpenCode and Gemini CLI. No defaults change.
- Show the agent's model, permission mode, context left, git branch and worktree in the Agent view header (#1224, #1292). Claude Code and Codex conversations now carry a `session` object (model, mode, context tokens and window, Claude's session cost, Codex's effort, approval policy, sandbox and rate limits, and the folder name, git branch and worktree name) that the companion reads from the transcript and also sends on the live watch stream. The header draws a model pill, a pill for any mode other than the default (plan mode is highlighted) and the share of context left, which changes colour under 20% and again under 10%; where the window is not recorded (Claude Code) it shows the tokens used instead of inventing a percentage. A branch and a worktree get a small chip in a wide header and, like the folder, always sit in the options sheet along with the rest (effort, approval and sandbox, cost, rate limits). A pill whose value is unknown is not drawn, the model and branch chips hide in a narrow pane, and a host companion without the field shows no pills and no error. The header row keeps its height. No defaults change.
- Show a working line in the Agent view while a turn runs (#1223): **Working** (or what it waits for, for example **Waiting for your approval**), the elapsed time, the output tokens of the turn so far and the tool still running, on one line above the composer. The state comes from the live Herdr status, then a hook report from the last ten minutes, then the state the transcript records; transcript recency never decides it. A turn the transcript has already closed starts the clock when the line first appears instead of counting from the old prompt. The clock ticks inside the line without re-rendering the conversation, the line is gone when the turn ends (the folded turn summary keeps its duration), and no partial text is claimed because Claude Code and Codex record completed items only. While the reply of the running turn is written, the prompt it answers stays pinned at the top of the thread (the rest of #1124). No defaults change.
- Add the shared edge-swipe gesture engine for connected phone sessions and its settings. A swipe that starts in a thin zone at the left, right or bottom edge follows the finger and settles, with distance, direction-lock, velocity and cancel thresholds, and reports no intermediate steps under reduced motion. It never starts or completes while you type, while the soft keyboard is composing, while text is selected or a selection handle is dragged, during a long-press cursor drag, a pinch, a finger scroll or its momentum, or while a text field has focus; a touch that starts in the interior never becomes an edge swipe, and terminal programs that track the mouse keep receiving every touch outside an edge zone. On Android the app now asks gesture navigation to leave a band of each side edge to it (24 dp wide by default, at most 200 dp tall, ending 72 dp above the bottom edge) so the system Back swipe does not take those touches; the bottom swipe starts in the lowest zone above the system gesture bar. **Preferences → Keyboard and gestures → Terminal touch gestures** has new switches for the left edge (side menu), bottom edge (bottom menu) and right edge (view switch) swipes and an **Edge zone width** slider from 16 to 48 dp. Screen reader mode turns the swipes off. Changed defaults: none yet; the swipes are on by default and the menus that use them arrive with their own entries, so nothing visible changes until then.
- Add a developer-only prototype of the host browser: the hidden `lazysh-agent host-browser` command (it refuses to run without `LAZYSH_DEV_HOST_BROWSER=1`) starts a throwaway Chrome-family browser with a private profile and a random loopback debug port and removes both when its input closes, and a viewer page served only by the Vite development server shows the page and sends taps and typed text. It is off by default, absent from release builds and changes no default.
- Show the last response's context in the Usage view for Claude Code, and the context remaining where the window is recorded (#18). With the updated host companion, a Claude Code transcript shows the tokens of its newest response (input, output and cache counters added, as the Agent view counts them) under **Last recorded response context**, with **Recorded context window** and **Recorded context remaining** left Unknown because Claude Code records no window; a response missing a counter or recording only zeros stays Unknown. For Codex, **Recorded context remaining** is the recorded window minus the last response, Unknown when either is missing. Both keep their recording time and stale label, and the live context stays Unknown. Older companions show the same panel without the remaining value. No defaults change.
- Add a bottom menu to phone sessions: swipe up from the bottom edge of the screen and a panel follows your finger up over the terminal, swipe it down (or tap outside, press Back or Escape) to hide it. It has **Show composer / Hide composer**, **Hide toolbar / Show toolbar** and, where the platform has the button, **Show keyboard / Hide keyboard**. Hiding the toolbar gives its rows back to the terminal (34 to 38 rows on a 415×900 phone with two key rows), and a phone remembers the choice for next time; the top-bar button does the same. The terminal does not resize while the menu is open. The swipe never starts while you are typing, composing with the keyboard, have a text field focused or text selected, or are scrolling or pinching, and it starts only at the very bottom edge. A small handle at the bottom shows where. In screen-reader mode, or with the bottom swipe switched off in Preferences, a visible **Open bottom menu** button in the session header opens it instead. Changed defaults: phones in a connected session get a new bottom-edge gesture (on by default, switchable in Preferences), and the toolbar show/hide choice is now remembered on a phone instead of resetting for each session; desktop windows are unchanged.
- Show the usage of the agent in the current pane in the status bar. The usage item (for example "cld 100% used") used to show one fixed account whatever ran in the terminal; it now follows the agent: Claude Code shows the Claude account, Codex the Codex account, and likewise Copilot, Cursor, Droid, Kimi, Cline, Kiro, Devin, Antigravity, Grok (SuperGrok), Hermes (Nous Research), Kilo, Muse and OpenCode (OpenCode Go), each by its provider name. It re-links within about 5 seconds when you focus another Herdr pane or the agent in the attached tmux pane changes (tmux needs the host companion's hook reports). With no agent detected it falls back to your chosen default account, or the host's default account, which is what the item showed before. An agent without a supported account (Gemini CLI, Amp, pi, Qwen Code, Letta and others) says "No usage for <agent>" instead of showing another agent's quota, and an account the host does not report says "<provider>: no account reported"; stale and unavailable states are kept as before. **Preferences → Agents and notifications → AI account usage** now chooses **Follow the current agent**, **Always show a chosen account** with a provider picker, or **Hide the usage item** (the AI account usage page stays reachable from the session tools). The pane is read only while the item is on screen: nothing is read when the item is hidden, when a short phone window hides the status bar, or on plain connections without Herdr or tmux. Changed default: the usage item now follows the agent instead of showing one fixed account. There was no stored account choice to migrate, so nobody's saved setting changes; to keep one account whatever runs, choose **Always show a chosen account**. The two new settings sync with the other preferences.
- Add the Agent view parity reference: every kind of screen element of the Claude Code and Codex terminal UIs, where each is recorded, how Claude, Codex, Perplexity, Grok, GitHub Copilot, Cursor, Happy and the Herdr mobile clients present it, what the Agent view shows today and which issue closes each gap (#1217). Documentation only; no application defaults change.
- Add the host browser specification and its measured feasibility note: how lazysh will show and control a Chrome, Chromium or Firefox that the app starts on the host (dedicated profile, opt-in per host, SSH only), with the threat model, input mapping, performance plan and milestones. Documentation only; no application defaults change.
- Add an **Arrows** terminal toolbar component that draws the four arrow keys as one classic cluster, like other mobile SSH clients such as Haven: Up above Down in the middle, Left and Right on either side of Down (an inverted T), in the same two toolbar rows and at the same toolbar height as before (74 dp at the default 32 px key height, and the cluster follows **Toolbar key height** at every size). In **Preferences → Keyboard and gestures → Toolbar keys and order** it is one chip and one **Add Arrows** palette entry: place it in a row and the whole cluster follows, with Up in its own cell and Left, Down and Right in the row below, or with Up in the row above when it is in the last row; on a one-row toolbar the four arrows sit in a line, and the preview draws the same cluster. Holding an arrow repeats it as before, and Shift, Ctrl and Alt latch for the next arrow like other keys. Arrow keys now also follow the program's **application cursor keys** mode: while a program such as `less`, `vim`, `htop` or a shell prompt has switched it on, Up, Down, Left, Right, Home and End send `ESC O A` to `ESC O F` (what xterm and other terminals send) instead of `ESC [ A` to `ESC [ F`; modified keys such as Ctrl+Left are unchanged. Changed defaults: the default toolbar is the same two rows of nine on screen, `keyboard attach esc tab paste / Home ↑ End` over `Shift ctrl Alt c d enter ← ↓ →`, but the four arrows are now the one Arrows component instead of four separate keys, and a saved toolbar that is still exactly the previous default moves to it. Every other saved toolbar keeps its separate arrow keys and renders them as before; a layout that has Arrows and separate arrow keys draws the cluster once. The Arrows component has no long-press actions of its own.
- Run the companion on Windows hosts reached over OpenSSH (#1725, part of #490). When the POSIX probe exits non-zero (a Windows host has no `sh`), the app now asks one more probe, `powershell.exe -NoProfile -NonInteractive -InputFormat None -EncodedCommand ...`, which answers a fixed marker, the architecture, the user's SID and `%LOCALAPPDATA%`, and remembers the answer for the connection. Every companion command is then sent as one such encoded line that `cmd.exe`, Windows PowerShell and POSIX quoting pass unchanged, instead of POSIX-quoted text that `cmd.exe` does not unquote, so the Agents board, history, usage, transcripts and companion settings can use a `lazysh-agent.exe` that is on the host's `PATH`. An argument Windows PowerShell 5.1 cannot pass faithfully (empty, with a double quote or a control character, or with a blank and a trailing backslash) and a command longer than `cmd.exe`'s line are refused with `companion_command`, never guessed. Hosts that answer the POSIX probe are unchanged. Changed default: a host whose POSIX probe fails now also gets the Windows probe, one more failing exec each time for an exec-only shell that answers neither. Installation, hook setup and the Herdr lookup still need a Unix shell, and installation still reports unsupported for Windows. Not yet: the managed `%LOCALAPPDATA%\lazysh\companion\lazysh-agent.exe` is not looked for before the `PATH`, and no real OpenSSH server for Windows ran (#1726); the adapter ran through real `cmd.exe` and Windows PowerShell on the hosted Windows runner. See [Windows OpenSSH hosts](docs/companion.md#windows-openssh-hosts).
- Let you resize the terminal toolbar. **Preferences → Keyboard and gestures → Toolbar keys and order** has a new **Toolbar key height** slider from 28 to 56 px in steps of 2, with the current size shown, a **Default size** button and a preview that draws the keys at the chosen height. The change applies to the open terminal at once: the keys, their text and icons scale together, and the terminal gives up or takes back the rows. The default stays the compact 32 px, the size is saved on this device only (settings sync neither uploads it nor lets a download replace it), and a value outside the range falls back to 32 px. On a very short window the rows are held to about a third of its height whatever the setting. No other defaults change.
- Add a button to show or hide the soft keyboard in the terminal on phones and tablets. The toolbar's keyboard key is now the toggle, and a **Show keyboard** / **Hide keyboard** button appears in the session header next to Compose whenever that key is out of reach (the toolbar hidden, the docked composer covering it, or the key removed from your layout): one tap focuses the terminal input (or the composer's editor while it is open) and asks Android to show its keyboard, the next tap hides it without sending any input, and the icon follows the real keyboard (the keyboard icon is crossed out while the keyboard is up), including when you close it with the system back gesture, when a hardware keyboard is attached, and after a resize. On Android the show and hide go through the window's IME controller, so the button also works for an input that already had focus; iOS and the browser follow focus and the viewport. Desktop windows have no such button and the toolbar key keeps moving focus. Changed behaviour: the toolbar's keyboard key used to toggle the terminal's focus, so with the keyboard already closed by the back gesture it needed two taps; the header's toolbar toggle now uses a panel icon instead of a keyboard icon, to tell it apart from the new button. Also adds the `soft_keyboard` native command with its access control entry. No defaults change.
- Let you choose, each time, whether the terminal composer sends a draft or only inserts it. The composer now shows two labelled buttons: **Send** puts the draft on the input line and presses Enter, as before, and **Insert** puts the same text on the input line without pressing Enter, so you can edit it in the terminal first. Both use the same delivery as before (one bracketed paste when the program asked for it, multi-line drafts and attachment paths expanded the same way), and the draft and the composer now stay open when the write fails instead of being cleared. Ctrl+Enter (Cmd+Enter on Apple keyboards) runs Send and Ctrl+Shift+Enter runs Insert. Changed default: the former **Send Enter after pasting the draft** preference is now **Ctrl+Enter sends the draft (off: it only inserts it)**: it only picks which action the shortcut and the filled button run, because both buttons are always available; the button formerly named **Paste draft** is now **Insert**. The Agent view's **Stage in terminal** button hands its text to this composer, so it can be inserted the same way.
- Open Android notification settings from Settings or the Agent inbox to restore notification permission after dismissing or denying it. Changed default: on Android 13 and later, lazysh now asks for notification permission once the first session is open instead of while it connects, so the system prompt no longer interrupts a connection in progress.
- Add a floating view for the terminal composer, as in Haven SSH. **Preferences → Keyboard and gestures → Composer view** now offers **Docked**, the existing full-height sheet and still the default, or **Floating**, a compact panel over the terminal that does not resize the terminal grid, keeps the terminal and its toolbar usable around it, sits above the soft keyboard, and keeps Send, Insert, attachments, the draft and the keyboard button. Drag its grip, or focus the grip and use the arrow keys (Shift moves further, Home restores the default place), to move it; it remembers its place on this device and keeps clear of the cursor row when first shown. The minimize button folds it into a small round handle at the same corner, keeping the draft. The setting and the place stay on this device and are not part of settings sync. No defaults change.
- Toggle the current session between Terminal and Agent with Ctrl+Shift+Y (Cmd+Shift+Y on Apple keyboards). The shortcut is available from the terminal, the Agent draft and the session controls. No defaults change.
- Detect live Claude Code and Codex agents from the attached Herdr server in Agent view, including hosts running stock Herdr 0.9.3. Select a live Herdr row to open its reported conversation or enter its exact pane; the conversation’s association with the pane is unverified, and selected conversations cannot stage input into another terminal; Agent view no longer asks you to choose transcript files. On a compatible guarded Herdr host, finger swipes no longer become wheel or arrow input inside Herdr agent questions and scroll the retained pane history directly. Ordinary mouse wheels are unchanged.
- Show app language choices as a checked list, keeping System as the default and retaining the existing locale save and retry behavior.
- Open host file paths printed in the terminal. An absolute, `~/` or `./` path (optionally `:line` or `:line:col`, also across wrapped rows) becomes a link once the host confirms that it is a file, so prose and missing files stay plain text. Tapping it shows the resolved path with **View**, **Open with…**, **Download**, **Share** (Android) and **Copy path**, reusing the Files actions. `~` resolves against the host's home. A relative path is linked only after the shell reports its directory with OSC 7 (`file://host/dir`), never guessed. Nothing is executed, and the line number is shown but the viewer does not scroll to it.
- Add the Agent view: a **Terminal | Agent** switch in the session header shows a running agent's conversation as native messages next to its terminal, without replacing it. The terminal keeps running unchanged in its pane; both views stay mounted, so switching never reconnects, writes to the terminal or trims its scrollback, and a draft or reading position in the Agent view survives the switch. On desktop, **Both** shows the terminal and the Agent view side by side when the session area is at least 1100 px wide. The switch shows icon segments on a phone so the session title stays readable. The choice is remembered on this device per saved host and multiplexer target and restored when the session is reopened or reconnects; a plain shell without a multiplexer keeps its choice only while it is open, so other and new shells on that host still open in Terminal. Android back from the Agent view returns to the same terminal. For a native tmux terminal, the Agent view binds to the Claude Code or Codex conversation that the companion's reported-history hooks tie to that pane, follows it every 2 seconds, and groups it by turn: the prompt and the answer as chat bubbles, with a folded activity row between them that says what the agent did (for example "Ran 3 commands · Made 2 edits · 1:12"). It follows the conversation on its own and offers **Jump to latest** when you scroll up. The header shows the agent and its last-reported state. The existing confirmed terminal input and **Stage in terminal** work inside the Agent view from a one-line composer whose input notes sit behind its info button, so a prompt sent from either view reaches the same session. If a pane's conversation is not reported yet, the Agent view asks again on its next check and binds as soon as it is. Without such a report, Agent view offers **Show terminal** and a list of last-reported sessions, whose current activity is not verified. The companion now accepts `lazysh-agent codex-config --reported-history` and `ingest --agent codex --reported-history`, the same opt-in as Claude's. No defaults change: every session still opens in Terminal, and reported history stays off until you install the flagged hooks.
- Show which multiplexer versions a host has and what they support. Each remote connection reads the installed tools' versions (`tmux -V`, `zellij --version`, `herdr --version`, without starting a server), and the Sessions panel shows each with a **Supported** or **Limited** badge, for example "tmux 3.2a (Limited)". A limited version gets a notice that names what it lacks and the version that adds it: tmux before 3.4 has no Jump To or Chat input, Zellij other than 0.45.1 has no workspace tree, close, resize or agent launch, and Herdr outside 0.9.3 to 0.9.5 has navigation only. Version-dependent actions remain unavailable until discovery succeeds; tmux older than 3.4 no longer offers Jump To or confirmed Chat input. A synced host whose default multiplexer is a kind this version does not know now imports with no default instead of failing, and a separate optional `defaultMultiplexerNext` host field, which released clients ignore, is kept for multiplexer kinds added later. A Windows OpenSSH host whose login shell is PowerShell or cmd now reports that its shell is not POSIX (`unsupported_host_shell`) instead of a generic invalid response. No defaults change.
- Open **Files** and **Diff** in a local desktop terminal on Linux, Windows and macOS. A local session now lists and reads this device's files (relative paths start in your home directory, as on a host) and reviews Git changes, history, historical files and diffs, with the same limits as on an SSH host: 10,000 entries or 2 MiB of names per directory, 1 MiB UTF-8 text previews, 200 KiB historical files and 10,000-line diffs. Local tools run commands as argument lists, never through a shell, with your login shell's `PATH` on Linux and macOS; Windows uses `git.exe` and accepts drive paths such as `C:\Users`. Local file reads do not follow symbolic links. **Diff** appears only when Git is installed. Uploads from **Files**, agents, previews and multiplexer tools remain SSH host tools for now. SSH sessions are unchanged. No defaults change.
- Add the local workspace specification: how desktop local sessions on Linux and Windows will gain the Files, repository, multiplexer, companion, Agents board, Agent view and other features of remote sessions. Documentation only; no application defaults change.
- Add the multiplexer compatibility specification: one capability checklist, supported versions and per-platform targets for tmux, Zellij, Herdr and rmux. Documentation only; no application defaults change.
- Add the Agent view specification: a native, switchable view of a running agent that co-exists with its terminal session. Documentation only; no application defaults change.
- Support Herdr 0.9.3 through 0.9.5. lazysh now builds and tests against Herdr 0.9.5, the current upstream release; hosts still on 0.9.3 keep working because lazysh uses only commands, IDs and error codes both versions share. If a Herdr workspace, tab or pane was closed on the host after the tree loaded, navigating to it now says the destination changed instead of showing Herdr's raw JSON error, in the Workspaces navigation and the Herdr tool panel alike; exact pane navigation needs the companion from this release. The optional guarded Herdr build is re-imported from 0.9.5 with its lazysh changes kept. Herdr 0.9.4 and later keep running after the shell that started them closes, so stop a server with `herdr server stop` or SIGTERM instead of SIGHUP. No defaults changed.
- Add the soft-keyboard and hardware-keyboard side of an Android native terminal surface, as groundwork (#1328, part of the terminal engine epic #1302). `TerminalInputView` is the keyboard's own editor for a surface the page does not draw: a composing word is held on the device and typed once when the keyboard commits it, an autocorrect or a prediction becomes the backspaces and letters that change the word on the host (never over text that is not plain ASCII or lies before what was just typed; such an edit is kept for review instead), Enter, Backspace and arrow keys reach the terminal as keys, and hardware shortcuts such as Shift+Enter and Ctrl+C are forwarded as key identities for the shared core to encode. It is not connected to any surface or to the core and nothing in the app creates it, so xterm.js stays the only engine and the default, terminal behaviour does not change and no defaults change. Checked on Waydroid (Android 13) with the keyboard transactions replayed in the process; Gboard, SwiftKey, a physical device, touch scrolling and selection, and latency are not covered. See `docs/architecture/android-native-input.md`.
- Open Agents and Workspaces from a terminal without the navigation drawer. Ctrl+Shift+A (Cmd+Shift+A on macOS) opens Agents and Ctrl+Shift+W (Cmd+Shift+W) opens Workspaces for the current connection, including from a focused terminal; pressing the chord again returns to the terminal. The shell keeps Ctrl+A and Ctrl+W, and the chords do nothing in other fields or dialogs. The command palette shows both chords and exposes them to screen readers as keyboard shortcuts. In the local terminal, which has no Agents, Ctrl+Shift+A stays an ordinary terminal keypress and an Agents gesture does nothing, matching the disabled Agents toolbar key. New **Open or close Agents** and **Open or close Workspaces** actions are available for every touch gesture, D-pad corner and toolbar long-press, and **Toolbar keys and order** offers **Agents** and **Workspaces** keys, which are not on the default toolbar. Changed default: in a plain terminal (no tmux, Herdr or Zellij), the level-aware two-finger swipe up now opens Agents and swipe down opens Workspaces instead of doing nothing. In multiplexers, vertical swipes still change panes, and horizontal swipes, pinch and header pulls keep their defaults. Saved explicit gesture choices are unchanged. Older clients drop the new toolbar keys and fall back to the default action for the new gesture actions when importing synced settings.
- Show Workspace tools as swipeable pages instead of collapsed sections. Session views, More tools, Connections and Application options are each one page: swipe sideways, tap a page dot or the Previous and Next arrows, drag with a mouse, or use the arrow, Home and End keys on the page dots. Screen readers hear a labelled carousel with the page name and position. The sheet reopens on the page you last turned to, also after reconnecting or restarting the app, and falls back to the first page when that page is not available. Each page sizes the sheet to its own content. Changed default: Workspace tools no longer opens with collapsed More tools, Connections and Application options sections; it opens on Session views until you turn to another page, and every action stays one swipe or tap away. End connection stays below the pages.
- Add the launch primitive for tmux and Zellij (#1141, part of #1138): `multiplexer_launch_plan` shows, and `multiplexer_launch` runs after confirmation, the agent check, an optional `git worktree add` and then `tmux new-window -d -P -F '#{pane_id}' … -- <agent> [<prompt>]` or `zellij run --cwd … -- <agent> [<prompt>]` in the session a terminal is attached to, with the agent's argv sent literally (a prompt with quotes, `$(…)`, a line break or a trailing `;` arrives byte for byte) and the new pane's ID returned. A missing agent or session creates nothing. Tested against a real tmux server and the pinned Zellij 0.45.1 (also 0.46.0) with a stub agent. Nothing in the app calls it yet: the launcher screen (#1128), rmux (#1679, needs #1140) and the native GUI case (#1680) remain, so #1141 stays open. No defaults change.
- Detect lost SSH, Mosh and ET connections and reconnect automatically. When a session's transport drops without the remote ending it, the terminal shows a **Connection lost** banner with the attempt count and countdown, **Retry now** and **Close**. Retries use the host's saved credentials without prompting, start after 1 second and double up to 30 seconds with jitter, for at most 10 attempts; while Android or the desktop reports no network they slow to every 30 seconds and run at once when the network returns. A successful retry replaces the tab in place and reattaches its tmux or Herdr session the way **Restore previous workspace** does; a Zellij session gets its host shell back. Close, or dismissing the banner, ends the session. Hosts without saved credentials show **Sign in** instead, which replaces the lost tab and reattaches its tmux or Herdr session after you sign in. Hosts with biometric unlock never retry on their own: each **Retry now** makes exactly one attempt, so nothing prompts unexpectedly. When the network returns or switches (for example Wi-Fi to cellular), live SSH sessions are asked to answer at once, so a route that died silently shows the banner within seconds instead of after the keepalives. A remote `exit` still just ends the session. Live sessions also show a notice while there is no network that says whether they reconnect on their own; Mosh keeps roaming natively. Screen readers hear each phase change once, not every second of the countdown, and the banner's buttons are at least 48 px tall on touch screens. Changed default: SSH keepalives are now sent every 15 seconds instead of 20, so a dead route is detected after 3 unanswered keepalives (about 45 seconds instead of 60).
- Show an ongoing Android notification while terminal sessions keep running: it reads **lazysh is running** with the number of active sessions, updates as sessions open and close, and disappears after the last one ends. Tapping it returns to the open workspace. It uses the existing low-importance **Terminal connections** channel, so it makes no sound. On Android 13 and later, lazysh asks for notification permission once, when the first session starts; declining keeps sessions running in the background without the notification. Works in the Google and F-Droid builds. Changed default: the notification now appears immediately instead of after Android's ten-second delay, and its text names the session count instead of "Terminal connections are active".
- Show files attached from the terminal composer as inline tokens in the draft, as agent CLIs do. Attach in the composer opens the attachment tool; after the upload, **Add to the terminal draft** returns to the composer and inserts `[Image #1]` for an image or `[File #2]` for another file at the caret, numbered per draft. Each token is highlighted in the editor and listed as a chip above it: tapping a chip (or the token) previews the image with its uploaded path, and its remove button deletes the token. Tokens are atomic: Backspace, Delete or a selection that touches part of a token removes the whole token and releases its attachment, and the caret never lands inside one. Send replaces each token with the shell-quoted path the upload returned, in draft order, then pastes as before. An IME composition that deletes part of a token (as Android keyboards do when Backspace recomposes the previous word) also removes the whole token once it commits. Token text you type yourself, such as a `[Image #1]` copied from an agent CLI, is never taken for an upload: new tokens take the next unused number. A deleted token's attachment stays known until the draft is sent, so restoring its exact text brings the chip back. The composer refuses an upload path that direct paste would refuse (relative, `..`, control characters, over 4096 bytes) with the same error, and adds no token. Ctrl+Enter, Send Enter and the kept draft are unchanged; screen readers hear each chip's label and an announcement when one is added or removed, and on phone widths the chips wrap instead of clipping. Uploads started from the toolbar still offer **Paste uploaded path**. No defaults change.
- Open reported agent activity in a focused mobile detail view with contextual Back and restored list position.
- Add **New workspace** and **New worktree from this workspace** to Herdr Spaces. New workspace takes a label and an absolute directory, typed, chosen from known directories or browsed on the host. New worktree reads the workspace directory's Git repository and suggests a branch, the current HEAD as base and a sibling `<repo>-worktrees/<branch>` path (or the parent shared by existing linked worktrees); all three stay editable. Both dialogs ask whether to start an agent; the default is not to. Choosing yes requires an agent CLI that `command -v` finds on the host, and Codex and Claude Code accept an optional single-line initial prompt. Before anything runs, the dialog shows every exact command (`command -v`, `git -C … worktree add -b … -- …`, `herdr workspace create`, `herdr agent start`). Each command runs under `sh` with exactly the shown arguments, whether the host's login shell is POSIX (sh, dash, bash, zsh, ksh) or fish, so quotes, `;` and `$(…)` in labels, paths, branches, prompts or host directory names are never run as shell syntax. The agent starts only in the new workspace's first pane through Herdr's own `agent start`; existing panes never receive input. A missing agent CLI fails before any worktree or workspace exists. If a later step fails, the dialog says what was already created and removes nothing. Branch names follow Git's ref rules; labels, paths and prompts reject line breaks and backslashes. No defaults change.
- Add multiplexer-aware terminal gestures. In a terminal attached to tmux, Herdr or Zellij, a two-finger pinch zooms the active pane (tmux `resize-pane -Z` through the prefix, Herdr's zoom key, Zellij `toggle-fullscreen`), and **Pinch in tmux, Herdr or Zellij** can instead resize text, run another action or do nothing; plain terminals keep pinch-to-resize text. Zoom is a toggle in all three, so pinching in or out zooms an unzoomed pane and restores a zoomed one. Pull the session header down to run a **Short header pull** (56 px) or **Long header pull** (144 px) action; a label names the action before release, and pulling back cancels it. New gesture actions move to the next or previous multiplexer tab (tmux window) or pane and zoom the pane; tmux and Herdr use the prefix saved in their shortcut panel. Each toolbar key except the modifiers can have a **Long-press** action, set when you select the key in **Toolbar keys and order**: holding the key for half a second (or right-clicking it) runs that action once, while keys without one keep hold-to-repeat. Like toolbar keys, long-press actions and touch gestures that send keys or a multiplexer prefix now return the terminal to the live screen. With both header pulls set to **No action**, lazysh leaves header touches alone. Changed defaults: two-finger swipes, the multiplexer pinch and both header pulls now default to **Level-aware default** instead of no action. In tmux, Herdr and Zellij, two-finger left and right change tabs, up and down change panes, a pinch zooms the pane and a short pull opens the next tab; in a plain terminal, two-finger left and right change lazysh sessions. A long pull opens the next lazysh session. Earlier saved two-finger choices, including **No action**, are kept, and existing pinch-to-resize settings now apply only outside multiplexers. Settings sync accepts the new toolbar long-press field; older clients reject settings imports that contain long-press actions, and snapshots without any still import there.
- Add terminal text selection for copying, including selections longer than the screen. On touch screens, hold a finger still on a word and lift to select it. Then drag the start and end handles across rows; holding a handle past the top or bottom edge scrolls local history, faster the further past the edge. With a mouse, xterm's drag selection keeps scrolling past the edges; when the remote app uses mouse reporting, hold Shift to select locally. A floating bar offers Copy, Select all and Copy screen. Copy keeps the raw buffer rows, line breaks included, and the selection stays put through finger scrolling and streaming output. Moving the finger before lifting still scrolls. Remote clipboard writes (OSC 52), including ones forwarded through tmux or screen passthrough, still need explicit consent.
- Show a live Herdr agent's lifecycle state when Herdr itself reports Unknown, as Herdr 0.9.3 does for an idle Codex prompt. When the pane's Herdr-reported session ID is unique and matches exactly one companion report from the same connection, live Agents and Spaces show Working, Needs attention or Done. Herdr's own states still take precedence, workspace and tab summaries are unchanged, and a pane without an exact match stays Unknown. No defaults change.
- Discover Cline quota credentials from the CLI-selected provider store, data directory or profile instead of always reading the home-directory default. Preserve explicit usage paths and API-key priority; missing or malformed selected stores do not fall back to another login. Follow the CLI-selected Cline account instead of ranking accounts by token expiry; validate every store entry against the pinned structural schema and bound regular-file reads. Other providers and invalid selected auth cannot replace the selected account or its quota cache. Nondefault environment-selected stores are unavailable on Windows; existing explicit auth paths and API keys remain available.
- Add an opt-in per-host **Identify lazysh to this host** option that asks the SSH server to set `LC_TERMINAL=lazysh` for new SSH terminals and tmux, Herdr and Zellij attachments, so remote shells and agents can detect the client. It is off by default and applies only when the server's `AcceptEnv` admits `LC_TERMINAL` (the common default `AcceptEnv LANG LC_*` does); Mosh and ET sessions do not send it.
- Show plan, question and turn-state cards in native Chat for Claude Code, Codex and OpenCode. Plans show each step with its recorded status. Questions list their options and point to the terminal for the answer, since Chat cannot choose options in an agent prompt. Conversation views show whether the agent is working, waiting for an answer, idle or stopped, based on recorded lifecycle records; other cases show an unknown state. Display only: the raw tool cards remain and no defaults change.
- Show the Chat attachment editor as a focused mobile view, preserving the draft and reading position when returning.
- Add support, security and code-of-conduct policies, contributor paths and a first-contribution walkthrough. No application defaults change.
- Show reported prepaid spend-cap percentages in AI usage details and the compact usage button. Keep formatted monetary amounts and over-cap numbers intact; uncapped balances and missing percentages remain unmetered.
- Import SSH private keys from a file in the SSH identities panel on desktop and Android. The file contents stay in memory, are not shown in the paste field, and files over 64 KiB are refused before reading. Imported OpenSSH, PEM and PKCS#8 keys tolerate Windows line endings and a byte-order mark. Connecting with a public key (`.pub`, `authorized_keys` entry, certificate, RFC 4716 or PEM public key) now fails before authentication with a specific error instead of a generic decode error, and an encrypted key without its passphrase reports that a passphrase is needed. Host-key pins stay in `hosts.json`; storage is unchanged.
- Show an idle Android screen in the video preview (#1729, part of #19). `screenrecord` writes nothing while the screen is unchanged and FFmpeg completes a frame only when the next one starts, so an idle device never delivered a first frame (the preview stopped at the ten-second startup limit) and a change showed up one change late. The video stream now also sends a screenshot first, which counts as the first frame, and another whenever no video frame has come for a second (at most one a second, one at a time); a screenshot taken while a video frame arrives is dropped and a failed one is skipped. While the screen changes nothing extra is sent. Measured on a Waydroid Android 13 guest: first frame 2.9 s after start on an idle launcher, about 54 KB per idle screenshot; no Android emulator, physical device or iOS run. Needs the updated host companion. Screenshot frames carry the display's pixel size as `width` and `height`, video frames their decoded size, as before. No defaults change.
- Add an optional gesture to hide the keyboard when scrolling past the bottom of local terminal history. It is off by default; remote mouse scrolling, alternate screens and active text composition keep their existing behavior. Settings snapshots from this version always include the new preference, so older clients reject them until they are updated.
- Add a reference-client parity matrix for Android and desktop that records each sub-behavior as verified, implemented, partial, missing or not applicable, with test and CI evidence and the issue that owns each gap. Documentation only; no application defaults change.
- Add explicitly selected OpenCode recorded Conversation views for V1 and V2 databases, with current tool updates, revert handling and recorded token counters. Records remains the default; recorded history does not establish live agent identity or enable unconfirmed input.
- Show a Grok Build plan as the shared plan card in its conversation view. With the updated host companion, a Grok ACP `plan` update (each one replaces the whole plan) in the **Grok ACP records** conversation view is one plan card with its steps and their state, the same card as the plan of Claude Code, Codex, OpenCode and Gemini CLI, instead of a block of labeled text. A plan with a status the card does not know keeps the labeled text. The plan chip above the composer reads the same card once the Agent view follows a Grok session ([#1125](https://github.com/mihazs/lazysh/issues/1125)); no Grok sub-agent or background-job record shape is verified, so none show. No defaults change.
- Show a Grok Build plan as the shared plan card in its conversation view. With the updated host companion, a Grok ACP `plan` update (each one replaces the whole plan) in the **Grok ACP records** conversation view is one plan card with its steps and their state, the same card as the plan of Claude Code, Codex, OpenCode and Gemini CLI, instead of a block of labeled text. A plan with a status the card does not know keeps the labeled text. The plan chip above the composer reads the same card once the Agent view follows a Grok session ([#1125](https://github.com/mihazs/lazysh/issues/1125)); no Grok sub-agent or background-job record shape is verified, so none show. No defaults change.
- Show a Grok Build plan as the plan chip and card in the Agent view. With the updated host companion, a Grok ACP `plan` update (each one replaces the whole plan) in the conversation view is one plan card with its steps and their state, and the latest one is pinned above the composer like the plan of Claude Code, Codex and OpenCode, instead of a block of labeled text. A plan with a status the card does not know keeps the labeled text. No Grok sub-agent or background-job record shape is verified, so none show. No defaults change.
- Show Codex's permission requests in the Agent view dock on tmux (#1796, part of #1535 and #6). When Codex asks to run a tool and the opt-in `PermissionRequest` hook is installed, the dock above the message box lists the request with its full tool input and answers it with Allow, Deny or Deny with a message, as for Claude Code, so a phone user no longer has to leave the conversation for the Agents board. The dock offers a request only for the agent, session and tmux pane the report names, checks them again right before the hook decision is sent and ignores taps for 400 ms; a Codex request never answers a Claude Code row or the other way round. A Codex request lists no suggested permission updates (Codex takes none). Nothing changes unless you merged the approval hook fragment into Codex's `hooks.json`. Tested with a mocked Agent view and companion, not against a real Codex.
- Show a Grok Build plan as the shared plan card in its conversation view. With the updated host companion, a Grok ACP `plan` update (each one replaces the whole plan) in the **Grok ACP records** conversation view is one plan card with its steps and their state, the same card as the plan of Claude Code, Codex and OpenCode, instead of a block of labeled text. A plan with a status the card does not know is still refused, so that conversation view fails and the Records view stays available. The plan chip above the composer reads the same card once the Agent view follows a Grok session ([#1125](https://github.com/mihazs/lazysh/issues/1125)); no Grok sub-agent or background-job record shape is verified, so none show. No defaults change.
- Show a Grok Build plan as the plan chip and card in the Agent view. With the updated host companion, a Grok ACP `plan` update (each one replaces the whole plan) in the conversation view is one plan card with its steps and their state, and the latest one is pinned above the composer like the plan of Claude Code, Codex and OpenCode, instead of a block of labeled text. A plan with a status the card does not know keeps the labeled text. No Grok sub-agent or background-job record shape is verified, so none show. No defaults change.
- Show a Grok Build plan as the plan chip and card in the Agent view. With the updated host companion, a Grok ACP `plan` update (each one replaces the whole plan) in the conversation view is one plan card with its steps and their state, and the latest one is pinned above the composer like the plan of Claude Code, Codex and OpenCode, instead of a block of labeled text. A plan with a status the card does not know keeps the labeled text. No Grok sub-agent or background-job record shape is verified, so none show. No defaults change.
- Add a fictional, clearly labelled bug report example to the support guide, covering every field of the bug template and showing how to mark a check that was not run. Documentation only; no defaults change.
- Add an explicit recorded Codex Conversation view with turn rollback, canonical item updates and protected fork/revert prefixes; Records remains the default and recorded history does not grant live-agent or approval authority.
- Start mobile Workspaces with compact selected-session context and a session count; expand all connected app sessions on request. Desktop keeps the expanded session list.
- Allow vertical finger scrolling after selecting terminal text, using xterm’s normal wheel selection behavior; horizontal gestures, taps and accessibility safeguards remain unchanged.
- Add Firebase-free UnifiedPush setup to Google Android builds alongside explicit FCM. New/off Google installations select UnifiedPush without registering; existing active FCM registrations remain selected. Provider changes require paused/revoked registration. Add opt-in Gotify relay delivery to the separate Gotify client; encrypted lazysh event display remains behind its original private enrollment and consent gates.
- Answer the questions Codex asks from the Agent view (#1485). When Codex opens a `request_user_input` question on tmux, the dialog card above the message box shows the question, its place among the questions (`Question 1/2`) and the options with Codex's highlight, and a tap moves the highlight with the arrow keys, reads it back and presses Enter, as a person would; Codex then shows its next question as its own card. It also reads Codex at a phone's width, where Codex wraps the question, both columns of an option and the footer. Changed behaviour: none for existing dialogs. A question card has no **Cancel the dialog**, because Esc interrupts Codex's turn there, and the notes box (Tab) stays in the terminal with the banner that the agent waits there.
- Add held-pointer panning to the expanded terminal D-pad, with paced arrow repeats, a pause zone and cancellation when input ownership or session availability changes. Existing arrow taps, keyboard activation, corner shortcuts and toolbar defaults remain unchanged.
- Add explicit V3 discovery and inspected managed Amp system-plugin setup with absolute companion binding. Setup tries V3 metadata with one bounded V2 compatibility fallback; V1/V2 provider mappings stay unchanged. Same-name foreign plugins block installation while fresh exact-owned removal remains available; settings, trust and live reporting are not enabled or verified.
- Add an owned Android manual Mosh attachment checkpoint for a large valid protected-clipboard PNG and exclusive creation against a pre-existing destination. Closed-control recovery and physical-device/file-picker/camera acceptance remain unverified; no upload defaults change.
- Add explicit version-2 hook discovery and inspected managed Copilot setup for selected existing Linux profiles, with shell-free absolute companion handlers and protected file ownership. Default version-1 discovery keeps its seven managed providers and Copilot manual; settings, disabled hooks, trust and live reporting remain unchanged.
- Choose a list, accordion or grid layout for the Herdr Spaces tree (#990). It uses the same remembered preference as tmux Jump To (`lazysh.multiplexer.layout`), so the layout you picked there is the one Spaces now opens in, and a layout you pick in Spaces is the one the tmux panels use next. The list keeps every space open as before, the accordion opens only the focused space (a space can still be opened or closed by hand until you change layout), and the grid sets spaces side by side as cards once the sidebar is wide enough for two. Choosing a space, tab or pane still sends the exact same target. Changed default: none for the list, but a device that had already chosen the accordion or the grid for tmux now sees Spaces in it. Verified in the Vitest and mocked Playwright suites only; the native Android and Linux GUI runs of the layouts are not part of this change.
- Give mobile Agents and Workspaces full-width working views, compact Herdr navigation actions and selectable reported-activity rows with focused details. Reduce repeated navigation chrome while preserving terminal space, session state, setup disclosure and explicit live/reported distinctions. Label recorded attention neutrally instead of implying a valid pending request, and visibly return focus to the selected row when closing its details. No connection, permission or input defaults change.
- Discover separate current Kimi Code and legacy Kimi CLI profile candidates without executing agents or reading configuration. Preserve literal overrides, manual-only setup and legacy hook output; clarify the printer targets Kimi CLI 1.52 and current lifecycle remains unqualified. No setup or trust defaults change.
- Add the native terminal engine's adapter, the piece that lets the terminal state live in the Rust core instead of the WebView: it answers sizes, scrolling, modes, rows of text and selection from the core's control plane (no cell data crosses the bridge), pulls the core's state at most once per 16 ms however much output arrives, and passes the same adapter contract suite as xterm.js, here against a stand-in core on headless xterm.js (the Rust core's commands, the engine setting and a renderer are not in this release). Nothing selects it, so terminal behaviour does not change and no defaults change; xterm.js stays the only engine.
- Add optional Herdr reported-session details for bounded Codex, Claude Code and OpenCode IDs, with same-connection companion report matches, stale-reference labels and selected-server shared-reference counts. These read-only details do not establish pane ownership or enable Chat.
- Add direct Live agents and Activity jump controls at the top of the Agents drawer. Move focus and only the drawer scroll position while preserving mounted readers, drafts, approvals and Back behavior; no agent data or connection settings change.
- Add explicit managed Cline root lifecycle plugin setup for a selected existing profile, with protected absolute companion binding, inspected install/remove plans and profile discovery. Existing plugin restrictions and settings are preserved; a new Cline session must load the profile, and setup does not verify live reporting.
- Detect installed host agents and known profile locations when opening Agent hook setup, with no provider preselected. Select a detected target or enter a manual profile before inspecting and installing hooks; discovery does not install hooks, create profiles or change trust settings. Executable discovery and live activity remain separate.
- Add contextual Back and Return to terminal for workspace tools and AI usage, retaining the opening live session and terminal draft. Keep mobile tools in compact navigation and let Android Back close the current local surface first; connection and transport defaults are unchanged.
- Open Preferences at the top with collapsed categories for appearance, language, terminal behavior, keyboard controls, security and connection settings. Preserve mounted drafts, async operations and safety text; opening settings no longer focuses Font size or requests text input. Saved settings and permission defaults are unchanged.
- Offer Agent hook setup directly from empty Activity, opening the existing inspected setup workflow for the selected host. Hook installation and provider trust remain explicit; an empty list does not establish whether live reporting is configured.
- Add explicit managed Droid hook setup for an existing standalone `.factory/hooks.json`, including the connected Agents selector. Preserve foreign event groups and fallback/settings policy, bind the inspected absolute companion, and refuse missing files rather than shadowing legacy hooks. Fresh-profile migration and native Droid runtime qualification remain unsupported; no defaults or trust settings change.
- Display native terminal failure messages instead of `[object Object]`, preserving localized errors.
- Add a print-only Cline runtime plugin for root run activity, completion/stopped and generic failure attention, using native run identities and a two-second companion writer deadline. Child runs, permission waits and managed Cline installation remain unsupported; existing profiles, approval policy and adapters are unchanged.
- Support OpenCode 2.2 native plugin loading with the same reviewed hook asset used by OpenCode 1.19.5. Serialize companion writes, coalesce pending session states, bound queued sessions, and stop owned ingest processes when the plugin unloads. Hook installation remains explicit and does not alter agent trust or permissions.
- Add explicit managed Claude Code, Codex and OpenCode hook setup from the Agents view or companion CLI on supported Linux filesystems. Inspect a selected existing profile before installing/updating or removing only lazysh-owned entries; preserve foreign values and ordinary permission/group metadata. Persisted executable paths require retained, non-writable, non-symlink namespaces, including support for read-only root-owned binary directories. No hooks or trust settings change automatically. macOS/Windows retain preview-only capability pending filesystem qualification.
- Add a dedicated Herdr Spaces hierarchy and live agent groups to workspace navigation, with one selected-server reader and search. Reuse a matching display or attach the selected server before validating the destination. Workspace and tab jumps use stock Herdr; exact shell and agent pane jumps use the updated companion. Focus is shared with other connections to that server. Navigation retires prior Chat confirmation, and server focus metadata is not presented as this client’s current selection. Connection defaults are unchanged.
- Add native Cursor CLI activity/completion hooks, an Amp thread-state observer plugin and aggregate Aider notification health. Print reviewed configuration/assets without changing profiles or approvals; Aider callbacks have no session identity or lifecycle states and never alter running session rows. Cursor permission waits and Kimi per-turn completion remain unsupported.
- Add native Gemini CLI, Droid, Kimi CLI and GitHub Copilot CLI lifecycle reporting with print-only configuration fragments. Preserve each agent's exact event semantics, hook-file envelope and timeout units; no agent profile or trust settings are changed. Ignore Kimi's unscoped Stop/StopFailure events because child souls share the parent session identity; Kimi turn completion remains unavailable through these callbacks.
- Show the lazysh logo during Android’s initial native access-policy check instead of briefly displaying an Unlock screen. Match the system launch background to the logo; retain the real lock screen, error recovery, secure cover and stale-unlock protections.
- Add native Codex lifecycle ingestion and an OpenCode lifecycle plugin alongside Claude Code hooks. Print configuration/assets without changing agent settings or trust; report working, attention and completed states without recording prompts, tool arguments or approval decisions.
- Detect live Herdr agents and accept exact workspace, tab and pane actions when their public IDs contain Herdr’s encoded letters, such as `wZ` and `w2E:pF`. Preserve target bounds, relationships and command quoting; connection and server-selection defaults are unchanged.
- Open live Agents on the current terminal's attached Herdr session when it is present in discovery, including hosts with several running sessions. An explicit server choice takes precedence; a missing attached session requires choosing a server instead of silently showing another one. Plain terminals retain their existing selection behavior.
- Add compact AI account quota and credit reports for Android remote hosts and desktop remote/local terminals. Prefer a compatible ai-usagebar installation and use built-in companion collectors when it is absent or unsupported; existing provider sign-ins stay on the session machine. Account usage refreshes while the terminal is visible. Standalone companions expose retained collector and adapter license notices through `lazysh-agent licenses`.
- Add explicit Reconnect host tools recovery for a Mosh session whose SSH command connection closed. Saved or manual credentials reauthenticate the original verified host without opening a terminal or changing upload-only recovery. Authentication remains user initiated.
- Open the current saved host’s Default multiplexer setting directly from More, with the selector focused. Save a named Herdr, tmux or Zellij default for future connections without changing the running terminal or its saved transport preference. Connection defaults are unchanged.
- Discover live Codex and other agent panes reported by Herdr independently of companion lifecycle reports. A single running Herdr server is selected automatically; choose a server when several are running. Only that server is refreshed, and its Idle, Working, Needs attention, Done and Unknown statuses remain distinct from companion history. No input, approval or history authority is inferred from discovery.
- Enable direct vertical touch scrolling through the terminal’s wheel handling, including Herdr mouse reporting and alternate-screen applications. Active phone terminals now default to one compact header: single-session tabs, tool navigation and the workspace restore prompt collapse into More, where their actions remain reachable. Multiple-session navigation, desktop/nonterminal layouts, terminal keys above the keyboard and accessibility gestures remain supported.
- Allow the local native app to reach the existing Reconnect uploads action and host companion settings. Keep other windows and remote pages denied, require current unlocked app access, and preserve host verification, authentication and settings revision checks.
- Add explicit same-tab upload recovery for verified direct Mosh connections. Reuse saved or manually entered SSH authentication without starting another terminal or saving credentials; preserve attachment edits and require a separate Upload action afterward. Other SSH tools keep their existing connection, and existing upload limits, path guards and no-overwrite behavior are unchanged.
- Add a manual smoke for public signed ARM64 Android APK installation, native UI startup and same-byte reinstall with preserved synthetic host data on an explicitly admitted ARM translation guest. Physical-device and cross-version acceptance remain separate; application defaults are unchanged.
- Add explicit companion installation inspection and preview-bound local installation for Linux and macOS. The CLI derives one private user-local destination, preserves existing binaries on pre-commit rejection, and distinguishes committed durability uncertainty. Windows installation reports unsupported pending native ownership and SSH verification; existing binary distribution, data, settings, hooks and PATH defaults are unchanged. In-app transfer and installation remain separate work.
- Add persistent Connections, Workspaces and Agents navigation to the existing sidebar/drawer. Connections remains the default; agent drafts persist while hidden owners suspend activity, and Jump To uses one guarded persistent tmux picker.
- Teach the native terminal bridge to receive the text a soft keyboard or an IME committed (#1791, part of #1328): `terminal_core_input` takes a `text` event that reaches the terminal verbatim, whatever keyboard protocol or bracketed paste the program enabled, so a committed CR or an erase unit (DEL) is never rewritten. The core is not wired into the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Add verified companion executable builds to future complete release sets for Linux x64/ARM64, macOS Intel/ARM64 and Windows x64. Candidate checks create no publication receipts; trusted release builds retain exact source/version/hash and staged-byte CLI/storage gates. Existing companion/data defaults and deferred Apple application packages are unchanged; in-app installation remains separate work.
- Add an explicit in-app Install/Update companion action for supported Linux and macOS hosts, including when agent loading fails. It verifies published release bytes, transfers through the current SSH connection, preserves uncertain outcomes and uses the managed executable for subsequent companion commands. Missing managed installations retain legacy PATH behavior. Installation never starts automatically or changes host permissions, agent hooks or PATH; Windows installation remains separate work.
- Add reported-agent search, status filters and selected-report context while preserving explicit refresh, history and approval ownership. Reported pane IDs remain context; application defaults are unchanged.
- Add an optional per-host default multiplexer and named session for direct SSH entry. Existing hosts keep normal connection behavior; the saved transport is preserved, and unavailable targets never select another session automatically.
- Show the canonical lazysh logo on the welcome screen, replacing the unrelated terminal illustration. Application defaults are unchanged.
- Support desktop `--dir` launches while lazysh is running, resolving relative paths against the caller’s working directory and preserving the original access guards. Ambiguous Unicode conversions are refused; no-argument startup is unchanged.
- Add a localized Named key shortcut builder for toolbar and gesture bindings, including F1–F12 and optional modifiers. Drafts remain separate between builder modes; Advanced stays the default, and saving never sends terminal input.
- Add a delivery roadmap linking open feature and platform-verification work, and describe lazysh in its own terms in the README. Application behavior and defaults are unchanged.
- Enable GitHub release publication by default for verified Android, Linux and Windows installers after Changesets version merges. Apple releases and official F-Droid inclusion remain deferred.
- Add separate, default-off native consent for generic private FOSS Android UnifiedPush event notifications. Bound-v2 events require the original confirmed device enrollment, OS permission/channel, absolute freshness and Keystore-protected replay admission; taps only open lazysh. Existing registration/enrollment does not turn display on. Actual distributor event/display acceptance remains pending.
- Add explicit `push-config-generate --event-format bound-v2` for encrypted Web Push events with a frozen device generation and absolute expiry. Legacy Web Push remains the default; webhook and enrollment formats are unchanged. Switching the private target requires deliberate reconfiguration and fresh enrollment. Native event display remains incomplete.
- Add **Check for updates** to the Host companion installation panel and run the host's own `lazysh-agent update` with the verified version, size and SHA-256 pin when supported. Older companions use the existing host-side script (#1445, epic #1441).
- Add explicit Zellij tab 1–20 quick-access buttons using the existing typed native action, without timing-sensitive digit chords or automatic tab discovery. Preserve manual drafts, original session/access ownership and raw host errors; the row does not infer existing or current tabs.
- Add an explicit, integrity-checked Noto Sans Mono CJK SC font download from its pinned official source into existing device-local font storage. Downloads stay off until requested; font selection remains a separate action. Existing font budgets, manual imports and delete controls remain, with bounded transfer/cancellation and no broad network permission. Other downloadable font families and native-device runtime acceptance remain incomplete.
- Add explicit **Paste uploaded path** in standalone Attachments: send only the current upload's validated, quoted host path to its original selected terminal without Enter, honoring public terminal bracketed-paste mode. No automatic write, retry or provider integration is added; copy, editable prompt staging and Chat attachment behavior remain unchanged.
- Add explicit line comments on both sides of staged and unstaged repository diffs. Notes preserve the observed selected path, side, line, diff selection and rename context, remain editable across review changes, and enter the existing prompt draft only when requested. A snapshot warning explains that host files may have changed; no note is sent automatically.
- Add opt-in listener refresh in the visible Preview panel, five seconds after each scan settles. It defaults off per panel/session, preserves preview pages and drafts, and shares the existing explicit port filter and optional HTTP checks. Hiding, closing or disabling the panel stops scheduling and suppresses late results; already-issued native scans may finish under existing bounds.
- Add explicit private F-Droid Android relay enrollment and encrypted challenge confirmation with Keystore-protected state. Registration defaults remain unchanged; event messages and remote notification display remain disconnected.
- Show a server-reported Next.js hint when explicit preview HTTP discovery already has a complete bounded response header available. Probing stays off by default; unknown or incomplete headers preserve ordinary HTTP detection without waiting or issuing another request.
- Let `LAZYSH_BROWSER_ANSWER_MS` raise how long a host browser shim launcher waits for the attached device (#1512, part of #1504). The launcher still stops waiting after 100 ms by default and then hands the link to the next real opener; on a host too loaded to answer that fast it now waits up to the value you set, at most 5000 ms, so a healthy watcher is not mistaken for none. This also fixes the shim's launcher test failing at random on a busy CI runner.
- Add an opt-in authenticated encrypted Web Push server foundation with private single-device enrollment, challenge confirmation and pinned HTTPS delivery. Existing webhook defaults are unchanged; Android enrollment and actual remote notification delivery remain incomplete.
- Add explicit opt-in native acceptance for the self-hosted whisper.cpp relay using pinned public engine/model/audio fixtures. This records bounded Linux interoperability, not general accuracy or physical-device acceptance; application defaults are unchanged.
- Add an explicit self-hosted whisper.cpp Cloud dictation relay option with a fixed operator-configured loopback endpoint and distinct backend identity. OpenAI remains the default; no provider fallback, model download or hosting is bundled.
- Add an initial manual F-Droid source-build recipe and actual metadata/scanner checks. Automatic updates and publishing remain disabled; official inclusion and reproducibility are separate acceptance gates.
- Add opt-in UnifiedPush distributor selection and native registration to the F-Droid build, with consent, stale-callback protection and local registration removal. Registration remains off by default; this slice ignores incoming push messages and does not connect remote delivery.
- Add an explicit F-Droid Android build variant without Google remote push dependencies, retaining local inbox notifications. Normal Android Firebase and iOS APNs defaults remain unchanged; this variant alone does not establish F-Droid listing or release delivery.
- Add truthful English Fastlane-compatible Android listing text for future F-Droid preparation. No store publication, screenshots, application behavior or defaults change.
- Expose checked Android version metadata for source-based update discovery. Release validation now rejects colliding or out-of-range Android versions and version-code overrides; current valid APK codes remain unchanged. Tag publication and F-Droid submission are not enabled.
- Offer opt-in syntax highlighting in Remote Files text previews using the existing safe code renderer. Plain text remains the default, keyboard scrolling stays available, and SFTP paths, read limits and upload consent are unchanged. Keep highlighted previews tied to the current source when file contents refresh.
- Add an explicit attachment editor within Chat. Uploads preserve the existing draft; Add uploaded path appends only the canonical host path without sending, staging or copying automatically. Existing upload/access/cancellation guards and defaults remain unchanged.
- Add explicit confirmed Chat input for original guarded Herdr terminals. Stage remains default; preparation candidates are retired on cancellation or context changes, uncertain input is never retried, and acknowledgements establish queue admission rather than agent execution.
- Add the native guarded-Herdr SSH prerequisite: consume private startup credentials before display output and bind explicit terminal preparations to the original connection and access proof. Frontend Herdr Chat controls remain disabled; unsupported builds keep ordinary attachment, and uncertain guarded starts are not retried automatically.
- Add an optional source-built Herdr guarded-input protocol prerequisite, with exact original-client ownership, explicit expiring bindings and bounded two-stage input admission. Stock attach and lazysh Chat defaults remain unchanged; the native lazysh adapter is separate work.
- Accept explicit saved-host and tmux/Herdr picker launch requests while the desktop app is running. Requests wait for normal unlock and an available connection dialog; pending launches and typed manual credentials are preserved, and Connect remains explicit. Warm directory delivery remains unsupported.
- Add explicit Send and Request stop in Claude Chat after choosing an existing tmux terminal. Stage remains the default; direct Send supports single-line drafts up to 4 KiB. Closing the view does not recall already submitted input, and failed or uncertain sends are never retried automatically.
- Add an opt-in Claude reported-history shortcut that prefills Chat from an exact hook-reported session/path association on the selected SSH connection. Reading still requires Open transcript, with recorded images and Follow off. Existing manual paths and older companions remain usable; reported history never grants live agent input authority.
- Add a dedicated owned Android QR-camera acceptance route through real permission denial/approval, camera frames, native decoded preview and camera release. The emulator uses the reviewed QR image with no webcam; production defaults are unchanged and actual hosted execution is reported separately.
- Add an explicit Mac-host clipboard action for the latest successful attachment. It writes the raw canonical path through the original verified SSH session and fixed `/usr/bin/pbcopy`; uploads still never copy automatically. Cancellation cannot undo a clipboard change already delivered. Linux and Windows host clipboard tools remain unsupported.
- Add an owned Android app SSH acceptance route through explicit fingerprint review, ephemeral identity paste and interactive shell output. Existing workspace/vault/theme tests and runtime defaults remain unchanged; real hosted UI execution is reported separately.
- Add explicit, bounded PNG/JPEG previews for Grok recorded image chunks. Including image bytes and viewing decoded pixels are separate opt-in actions; defaults, transcript files, paging and live terminal controls remain unchanged.
- Add explicitly started offline theme QR camera scanning with a bounded PNG/JPEG image fallback and mandatory preview/Apply. QR camera use stays off by default and QR images stay local. Android's CAMERA declaration can also make the existing explicit Attachment Photo action request camera permission; ordinary file picking is unchanged. Apple camera purpose strings cover both explicit actions. Existing theme validation is unchanged; actual native/physical camera acceptance remains separate.
- Add owned OpenSSH/tmux acceptance for restoring an exact named-server workload through fresh verified SSH after original transport and native handle retirement. GUI cold start, app-process death and physical roaming remain separate acceptance.
- Add explicit Grok recorded-file Follow with verified preparation, append-only paging, hidden-page pause and original source/access ownership. Manual Records remains the default; reconstructed conversation and live prompt targeting are not enabled.
- Add explicit opt-in companion storage failure phase diagnostics and same-worker trace summaries. Default output, SQLite errors, durability and wait budgets remain unchanged; this adds evidence rather than repairing contention.
- Add an explicitly started foreground companion relay sender, pinned to a required local revision, with one dispatcher, a two-second startup quiet period and global failure cooldown. Default-off admission and synchronous hooks remain unchanged; no OS service/schedule or native mobile provider is installed.
- Add explicit checkpointed Grok Records reads on Unix companions, binding continuation to selected file identity and its observed prefix. Manual paging/output stays unchanged; live-agent targeting is not enabled.
- Add default-off companion publishing of new normalized lifecycle transitions to an explicitly bound self-hosted webhook relay. Admission is atomic with local ingest; bounded flush is explicitly invoked, with stable retry identities and persistent disable. No sender schedule, APNs/FCM delivery or deployment is installed.
- Add owned OpenSSH/Herdr 0.9.3 acceptance coverage for explicit session selection,
  separate child PTYs, durable detach and original-lease revocation. GUI startup
  and biometric launch acceptance remain separate; runtime defaults do not change.
- Add an explicit opt-in Grok ACP recorded-conversation view with bounded chunk grouping, tool replacement and proven prompt-index rewinds. Unsupported controls or ambiguous histories fail visibly with Records available. Records remain the default; Claude Follow, media no-fetch and live-session binding restrictions are unchanged.
- Add cold saved-host CLI composition with `--mux tmux`, `tmux:SERVER` or
- Allow active host-local uploads to be cancelled from Attachments and the remote Files browser. New reservation defaults allow two occupied jobs (pending, sending or retiring), each up to 10 MiB (20 MiB total); unused reservations expire after 30 seconds, separately from the existing 30-second transfer deadline. Cancellation never deletes a remote pathname: a partial or completed new file may remain. Existing files remain protected against replacement.
- Add an optional self-hosted authenticated webhook relay with private source capabilities, a durable bounded outbox and one fixed HTTPS destination. Delivery is disabled by default; native APNs/FCM delivery remains unavailable.
- Add cold desktop `--host SAVED_ID` / `-host SAVED_ID` launch into the normal
  saved-host connection dialog, with original unlock ownership across explicit
  credential and key-trust retries. The host editor now offers **Copy host ID**.
  Existing transport preferences remain unchanged; warm host delivery and CLI
  multiplexer composition remain unsupported.
- Add metadata-only discovery of existing Grok ACP `updates.jsonl` candidates in the pinned source store layout, honoring literal nonempty `GROK_HOME` overrides. Selecting and opening a file remains explicit; record-stream, conversation-replay and live-binding restrictions are unchanged.
- Show a host companion updating itself to this app's version, and let you turn that off from the app (#1495). Companion commands on Linux or macOS SSH hosts and local desktop sessions now carry the app's version in `LAZYSH_APP_VERSION`; a companion with `lazysh-agent auto-update` that is older than the app updates itself on the host (**changed default: this is on, policy Update automatically; it needs the companion release that ships `auto-update`**), and the Agents panel shows one non-blocking line, "Updating the host companion to X…", then the new version. A live conversation view that was told the companion was too old asks again at once instead of after a minute. Host companion settings gain **Companion updates** with Update automatically, Only tell me and Never. English, Brazilian Portuguese and Spanish. A Windows SSH host gets no version from the app yet.
- Add explicit named tmux server selection throughout discovery, attachment, controls, Jump To and saved workspace restoration. Commands now explicitly select `-L default` when no named server is chosen; an inherited `TMUX` environment variable no longer redirects legacy/default operations to another server. Client invocations now force UTF-8 (`-u`) so discovery framing and Unicode metadata are independent of the remote locale.
- Add an optional, default-off agent-board display keep-awake control backed by native display-idle ownership. Leaving the board, loss of foreground, app lock and renderer replacement release ownership. Linux now uses bounded asynchronous XDG portal acknowledgements, with exact cancellation, private-connection cleanup and visible owner-loss reporting. Acknowledgement does not establish physical idle-timeout or battery behavior; hardware validation remains pending.
- Add a community glossary of six terms for first-time SSH workspace users (SSH host, host-key fingerprint, terminal, host-side multiplexer, optional companion and recorded agent activity), each defined in at most two sentences and linked to its source guide, and a community guides index in `docs/community/README.md`. Documentation only; no application defaults change.
- Localize SSH identity generation/import controls, in-memory credential
  explanations and public-key clipboard failures in English, Brazilian Portuguese
  and Spanish. Key material, cryptographic parameters and explicit actions are
  unchanged; no defaults or credential storage behavior change.
- Localize tmux Jump To layouts, current-window markers, navigation guidance and
  the unavailable prefix in English, Brazilian Portuguese and Spanish. Language
  changes format displayed window indexes for the selected language and retain
  native target IDs, pending requests and raw host diagnostics; defaults are unchanged.
- Remote push registration controls, contact/privacy disclosures and retained
  operation errors now support English, Brazilian Portuguese and Spanish.
  Language changes preserve consent and pending registration/revocation;
  native reasons and provider names remain verbatim. Defaults are unchanged.
- Desktop `-dir PATH` / `--dir PATH` cold launches open one local terminal after
  normal unlock, using the literal requested directory. Warm directory requests
  show a localized unsupported notice; host/multiplexer CLI targets remain
  unavailable. Explicit missing directories now fail instead of falling back to
  HOME; manual local terminals and restoration retain their HOME default. Windows
  directory launches use a verified compatible drive-path spelling and refuse
  UNC, device and verbatim-only paths instead of letting the shell change cwd.
- Device discovery, screenshot/video controls and client-owned validation now
  support English, Brazilian Portuguese and Spanish. Interface changes preserve
  stream ownership, frame data, socket drafts and explicit device-input choices;
  native SDK warnings and device identities remain verbatim. Defaults are unchanged.
- Localize optional public-sharing configuration, expiring uploads/history,
  thumbnails, copying and revocation in English, Brazilian Portuguese and Spanish.
  Language changes preserve credential/file drafts and in-flight requests; defaults
  and explicit upload/revoke consent are unchanged.
- Localize host attachment selection, crop/annotation controls, upload/copy/staging
  notices and local validation in English, Brazilian Portuguese and Spanish.
  Language changes preserve file bytes, edits, paths and editable prompts; defaults
  are unchanged. Public sharing controls remain separate work.
- Localize agent-board activity, one-request approval controls and companion
  settings in English, Brazilian Portuguese and Spanish. Language changes retain
  reported agent content, pending decisions and unsaved settings; Keep Awake
  controls remain a separate localization task. Defaults are unchanged.
- Main Voice engine/model/recording and direct-delivery controls now support
  English, Brazilian Portuguese and Spanish, including retained download/import,
  asset, transcription, delivery and local-error messages. Language changes keep
  the same recording, request IDs, selected models/languages and editable draft;
  native diagnostics and transcription content remain verbatim. Defaults are
  unchanged, including review-first dictation and opt-in Enter delivery.
- Cloud dictation enrollment/quota settings and dictation history controls now
  support English, Brazilian Portuguese and Spanish, including visible local
  errors. Language changes preserve pending transcription, drafts and history
  consent/entries. The main Voice engine/recording controls remain a follow-up;
  defaults and native diagnostics are unchanged.
- App language choices now also cover native lock screens and newly created
  biometric prompts on Android, iOS and macOS, including cold launch. Native
  preferences own the choice on those platforms; startup never overwrites it
  with a stale browser value. The first upgrade without a native choice uses
  System rather than automatically migrating a browser-only choice. Reset and
  explicit settings imports use the same
  serialized native update. Existing OS permission-language selection and access
  policy are unchanged; Windows, Linux and browser storage keep their defaults.
- Browser preview controls, forwarding/discovery validation and element-picker
  captions/statuses now support English, Brazilian Portuguese and Spanish.
  Language changes preserve the live iframe, selection and editable note; page
  data and staged annotation payloads remain verbatim. Defaults are unchanged.
- Remote file browsing, uploads, repository history, side-by-side diffs and line
  comments now have English, Brazilian Portuguese and Spanish controls. Language
  changes preserve selected files, revisions and editable drafts; file contents
  and staged annotation payloads stay verbatim. Defaults are unchanged.
- English, Brazilian Portuguese and Spanish interface text for Transcript, Usage
  and the notification inbox, including accessibility labels and validation.
  Usage and inbox dates/numbers follow the selected interface locale. Recorded
  messages, tool arguments, provider/agent names, IDs and remote diagnostics stay
  verbatim. Language changes retain drafts and polling/listener lifecycles;
  language preference defaults and native permission behavior are unchanged.
- Brazilian Portuguese and Spanish Apple permission explanations, with English
  fallback. Apple selects permission-sheet localization through the app's OS
  language; the in-app language override does not override system prompts. The
  microphone purpose now describes dictation using the selected engine.
- Brazilian Portuguese (`pt-BR`) and Spanish (`es`) for the existing interface
  catalogs: shell, host forms and Preferences controls. System remains the
  default and now selects these languages when available; English is the fallback.
  Explicit choices persist and sync without reconnecting live terminals or
  changing user text, commands or remote output. Other panels and native
  lock-cover text remain separate localization work.
- An English interface catalog and an App language preference for System or
  English. System is the default and uses supported English regional formatting,
  falling back to English for other system languages. Shell, host forms and
  Preferences update without reconnecting live terminals; remote output and user
  text remain unchanged. Other panels, native permission text and translated
  languages remain follow-up work.
- In-session tmux Jump To session/window trees with saved list, accordion and
  grid layouts and an exact Current marker. Navigation uses a display-owned
  retained control connection, validates its generation and captured PID/TTY,
  and stops on cancellation, server loss or interrupted/ambiguous responses.
  An unavailable binding disables navigation without replacing the terminal.
  The extra control client affects tmux attached counts/hooks; switching a
  window also changes the destination session's shared current window.
  Cancelled attachment setup closes its unpublished SSH display channel. Saved
  restoration uses the exact validated destination name; unsupported names keep
  the live terminal available with a notice and omit its restoration intent.
- Linux x86_64 Parakeet dictation with an explicitly downloaded, hash-pinned
  local model, one reusable recognizer, and model removal. Whisper remains the
  default. Cancel discards the result while native preparation/inference may
  continue; busy capacity and model files remain owned until the worker finishes.
  Other platforms report Parakeet unavailable; language detection is automatic.
- Linux native linking isolates ORT's embedded protobuf namespace so Mosh
  messages use their matching system protobuf implementation. The existing
  archive-specific export guard remains; upstream cached artifacts are unchanged.
- Repository pre-commit duplicate detection with pinned jscpd and Bun now rejects
- Bind local agent hooks to a lasting copy of the bundled companion (#1666, part of #1132). Hook setup in a local session first places an owner-only copy of the `lazysh-agent` beside the app in the managed directory (`<data>/lazysh/companion/`, written to a new file and renamed into place) and runs from there, so the hooks it writes keep working after the app exits; an AppImage runs the bundled companion from a mount that disappears with the app. A managed copy that is the user's own and at least as new as the bundled version is kept, an older or unsafe one is replaced, and the plan a status shows is for the copy the install then uses. Discovery and every other command keep running the bundled companion, a companion at the managed path or on the `PATH` is used as it is, and Windows (template-only hook setup) is unchanged. No defaults change, and no desktop package bundles a companion yet, so nothing changes for an install today.
  every detected clone, including pre-existing duplication; the previous baseline
  allowance is removed. Refactor with DRY until the scan reports zero clones.
  This instruction prints after successful and failed hook runs without changing
  their exit status. `bun run hooks:install` still explicitly enables the hook
  for the repository and linked worktrees, and lint-staged preserves partial
  staging. Dependency installation does not change the hooks configuration.
- Device-local iOS Home Screen icon selection with the original Default and
  new Amber artwork, UIKit support checks and actual selection readback. The
  default icon is unchanged; desktop, Android and browser builds report this
  feature unavailable. Icon selection does not sync or affect terminal themes.
- Claude transcript tool results retain explicit recorded error flags in paging
  and branch-follow views. Failed results show a recorded-error label with the
  original tool ID and output; no live status or retry action is inferred.
  Existing transcript and follow defaults are unchanged.
- Installed-app `lazysh://theme?data=…` links and selectable theme-link export.
  Incoming links remain pending through resume locks and require explicit review
  and apply or discard; manual import drafts and existing theme defaults are kept.
  Desktop launches now share one app instance. QR scanning remains unavailable.
- Advanced chords, compiled modified Simple shortcuts and multiplexer prefix
  shortcuts dispatch as one bounded native queue item with 50 ms between steps.
  The first step is immediate, literal text stays one write, and later input
  cannot interleave. Unsent steps retain their original access lease and are
  discarded on revocation or disconnect; ET also discards timed remainders and
  queued chords after observed connection loss. The interval is a lazysh choice,
  not a verified reference client timing value. Prefix settings now reject comma-separated
  multi-step and `text:` literal bindings because a prefix must be one key.
  No gesture defaults change.
- Grok ACP record cards now preserve explicit recorded tool statuses and tool-ID
  linkage, including status-only updates previously omitted. Missing/unknown
  statuses remain unassigned and original output stays intact. These historical
  labels do not imply live working state, pending approval or new controls.
- Opt-in following for an explicitly opened Claude conversation branch: bounded
  refreshes run two seconds after completion, replace abandoned branches, pause
  on hidden pages and stop on errors/source/session/access changes. Following
  defaults off; record/export views remain manual. Scrolling up preserves reader
  position until Jump to latest. No new agent, provider or prompt is launched.
- Add a developer-only native terminal surface host to the Android app (#1327, part of the terminal engine epic #1302): a `SurfaceView` stacked below the page that a native terminal engine will draw on, placed from a DOM element through three app commands and kept across the window stopping and starting and across Activity recreation (the surface is told when it is ready, resized or lost, in order, and a recreated surface is drawn again from state the process holds). Release builds refuse every command and nothing in the app calls it yet, so xterm.js stays the only engine and the default, terminal behaviour does not change and no defaults change. See `docs/architecture/android-native-surface-host.md`.
- Opt-in native biometric resume protection for supported Android, iOS and macOS
  devices, with native privacy covers, generation-bound command/result access,
  paused terminal delivery and cancellation of pending protected work. Windows
  and Linux report this option unavailable. Physical biometric acceptance remains
  a release gate; existing per-host credential protection stays independent.
  Device-local durable intent preserves the lock on cold launch when its protected
  proof is missing; cancelled enrollment restores off only after confirmed cleanup.
- Four opt-in touch actions for next/previous Zellij tabs and panes. They use
  the existing named-session command interface for terminals attached through
  lazysh; plain, local and other multiplexer terminals are rejected. Existing
  gesture defaults remain unchanged. No session switching or timed key input.
- Simple custom-text builders in custom gesture and D-pad bindings, using the
  existing bounded shortcut compiler. Each editor keeps its own unsaved drafts
  and errors. Advanced remains the default; existing bindings are unchanged.
  Gesture/D-pad chord edits now require their explicit Save button instead of
  saving Advanced text on blur. Building and saving never send terminal input.
- Default-off combined Whisper/Parakeet native acceptance tasks, with fixed
  public speech inputs and separate processes for both initialization orders.
  Linux archive-specific symbol isolation prevents private ORT protobuf symbols
  from overriding Mosh's system protobuf library; no client engine is enabled.
- macOS Parakeet model-storage admission checks actual Darwin ACLs and trusted
  descriptor ancestry, with native filesystem regression fixtures. iOS and Windows
  preparation remain disabled; real recognition and platform acceptance stay open.
- Optional Simple custom-text shortcut builder with Control/Option/Shift,
- Add the **Host browser** switch to host settings (#1696, part of #1258 and #1250). Under the three companion switches, a separate row reads and saves the companion's `settings host-browser` setting over the verified SSH session, with its own revision and its own **Save host browser setting** button, so it never sends the three switches' values. **Changed default called out: it is off, the only host switch that defaults to off.** Turning it on asks first, once per host on this device, and names what the browser can reach (the host's network and loopback services, any file the browser can open, every site you sign in to inside it); the confirmation is remembered for that saved host only, never in the encrypted sync and never with a page address, title or image. A companion without the command shows the row as unavailable with an update message and nothing is written; a stale revision asks you to refresh. If the panel is hidden or remounted while a same-access save is pending, reopening waits for its response and reloads the host setting before allowing another change. The switch only allows a browser: the browser view ships with the Chrome viewer (#1254). Strings are in English, Brazilian Portuguese and Spanish. Also fix the first switch of a host settings group (Transcript discovery) being squeezed to a few pixels beside its heading.
  first-character modifiers, comma-separated groups and escaped commas. Advanced
  remains the default; existing shortcut records are unchanged. Unicode literal
  text and leading/trailing spaces survive save/reload. Modified text remains
  bounded to printable ASCII and eight steps; unsupported input reports errors.
- Opt-in Linux Parakeet inference acceptance with a licensed public speech
  fixture, repeat-recognizer and model-file cleanup checks, and reported timing
  and process peak memory. No client engine, automatic download or changed voice
  default; device and platform acceptance remain pending.
- Standalone Parakeet CPU runtime foundation with pinned native sources, sealed
  model archive validation and native exception/ownership tests. It adds no
  dictation UI or automatic model download; broader model and device validation
  remain pending, and iOS/Windows model loading fails closed pending native
  ACL validation.
- Custom theme bold-color policies: unchanged colors, bright ANSI colors, or a
  hexadecimal default bold foreground, with import/export and settings sync.
  Reviewed v1 themes without `bold` now keep normal colors instead of implicit
  brightening; bundled themes and existing unreviewed palettes retain their
  bright-bold defaults. The adapter preserves inverse, selection and faint text;
  vendor mobile pixel behavior remains unverified.
- Reviewed whole-app custom themes with bounded JSON/share-code import and export,
  light/dark metadata, contrast-safe app chrome, and settings sync validation.
  Existing bundled choices and terminal-only palettes keep their behavior until
  explicitly changed; QR scanning and OS theme links remain unavailable.
- Remembered list or cards layout for the active-session switcher. Existing
- Send what the shared Rust terminal core encodes (keys, mouse reports, bracketed paste, focus events and its answers to terminal queries) to the SSH, Mosh, Eternal Terminal or local terminal as bytes, under the same lock, background and renderer-replacement checks as typed input (#1316). The core is not wired to a renderer and no setting offers it, xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
  installations retain the list default; switching layout never reconnects sessions.
- Explicit-file `antigravity-jsonl` step-record snapshots with append-safe
  checkpoints and restart on changed snapshot bytes, literal source/type/status,
  recorded thinking and compact truncation flags. No automatic discovery,
  conversation reconstruction or live compatibility claim; existing defaults
  and other adapters' cursors are unchanged.
- iOS app integration for the verified-SSH Mosh handoff, with original dependency
  privacy manifests embedded in separate resource bundles. Auto transport
  selection now considers Mosh on iOS, where it previously skipped it; host-key
  verification and explicit fallback rules remain unchanged.
- Explicit-file `grok-acp` transcript records, based on a pinned official Grok
  writer contract. Chunks, tool updates and plans remain separate records;
  automatic discovery, active-branch replay and live Grok control are not enabled.
  Existing defaults are unchanged.
- Explicit Cloud dictation enrollment with origin-bound device tokens in the
  platform vault, authenticated service capabilities/language hints and quota
  totals, bounded in-memory WAV uploads, and exact-recording cancellation.
  Local Whisper and editable review remain the defaults; no automatic cloud
  fallback, provider credentials in clients, deployment, or upload on enrollment.
- Optional Unix-host transcription relay with administrator-issued device tokens,
  revocation, durable audio quotas and cancellable bounded WAV uploads to a fixed
  OpenAI transcription endpoint. No deployment, client enrollment or audio-upload
  default changes.
- Optional direct delivery of completed dictation to the current terminal, with
  a separate Auto-send Enter option, bounded input and stale-session cancellation.
  Both options start off and reset when Voice closes; editable review remains the
  default, history reuse stays draft-only, and failed writes are never retried.
- Optional device-local dictation history with explicit Remember consent,
  seven-day availability, 20-entry/256 KiB bounds, editable reuse and Delete/Clear.
  History remains temporary by default; saved text is not encrypted by lazysh,
  and expired entries are pruned on use rather than while the app is closed.
- Explicit downloads of four pinned Whisper tiny/base models, with bounded
  streaming, cancellation and SHA-256 verification before local publication.
  No automatic download, audio upload or prompt-submission default changes.
- Rust/Tauri SSH and local PTY/ConPTY workspace in the Bun/Turborepo monorepo,
  including host-key verification, session controls and bounded terminal traffic.
- Optional agent companion, supported transcript readers, approval handling,
  multiplexer navigation, file/Git tools, previews and editable dictation.
- Native credential storage, explicit encrypted sync, sharing and platform
  integration foundations, each with its documented opt-in behavior and limits.
- Discovery of existing Devin ATIF exports through absolute `XDG_DATA_HOME`, with
  the standard home fallback. No Devin process or exporter is launched.

### Improved

- Mount a native terminal session through its anchor (#1327, epic #1302). The terminal pane now follows its session's engine: for a native session it gives its container an id, attaches the adapter to it, places the platform surface on it and takes the surface down when the pane is hidden or ends, and while the surface is shown every ancestor of the container stops painting its background so the surface below the page is visible; overlays such as the composer stay above it. An xterm.js pane is unchanged (no id, no marker, no rule matches). No backend registration gives a session a native terminal and release builds refuse the surface commands, so xterm.js stays the only engine and the default and nothing changes for users. Checked in a browser with the native adapter over the stand-in core; not run on Waydroid or a device, and the Android WebView background is not transparent yet.
- Compact the scrollback of native terminal sessions nobody is looking at (#1338, part of #1302): a session with no view attached that has received nothing for two seconds (`HubConfig::compress_after`, `None` turns it off) has its history compressed by libghostty-vt in small steps on an idle worker and restored on access; an attached session is never touched. On one Linux desktop host a full session went from about 4 MiB to about 0.5 MiB resident, ten sessions from about 40 MiB to about 8 MiB with nine idle, the history unchanged, and 40 rounds of session churn stayed flat; Android, iOS and Windows were not measured and the saving may be smaller or zero there. The native core is not the default engine: xterm.js stays the default, and no setting or default changes.
- Settle every open difference between the shared Rust terminal core and xterm.js (#1314, part of #1302). Each entry of the divergence registry has a recorded decision and the test that pins it, and the core's own tests now run tmux, vim, bash, Herdr, Claude Code, Codex and OpenCode on a pty with the core as their terminal, answering their queries and encoding their keys. Approved as intended behaviour for a native engine: Unicode 11 and later widths (emoji, ZWJ and skin-tone sequences take two cells), the standard Alt+arrow encodings (`CSI 1;3`, where xterm.js sent the Ctrl form), the Kitty keyboard reports Codex and Herdr ask for, reflow on resize, and dropping an OSC 52 write that names only the primary selection. Shift+PageUp routing moves to #1334. The core is not wired into the app and xterm.js stays the only engine and the default, so nothing changes for users today; the release notes of the Android default (#2094) must call these differences out.
- Keep each new terminal dialog disabled until its own safety delay has elapsed, reject stale option descriptions or pane checks, and prevent an older answer from re-enabling a newer pending answer (#2021).
- Retry a briefly busy local companion executable when checking its version, allowing setup to recover when another process temporarily holds it open for writing (#1923). Other launch errors still fail; the retry is bounded.
- Prepare the Agent view to follow an agent started in a terminal with no multiplexer (#1867, first slice, part of #1684). The host companion now records `lazysh:<id>` as a hook report's pane identity when the hook runs with `LAZYSH_TERMINAL` set to 32 lowercase hexadecimal characters and neither `TMUX_PANE` nor Zellij's variables are set (a value of another shape is ignored and the hook still succeeds). Nothing exports the variable yet and the Agent view does not bind by it, so no report and no behaviour changes today; an older companion keeps reporting no identity and an older client treats the new form as an unknown identity and keeps the manual picker. No defaults change.
- Prepare keyboard parity for a native terminal engine on macOS, Windows and Linux (#1334, epic #1302). A key typed with Option (macOS) or AltGr (Windows, Linux) reaches a terminal core with Alt and Ctrl still set, and the core answered it with an Alt chord: measured, AltGr+Q on a German layout sent ESC and NUL instead of `@`, and Option+L sent ESC before `¬`. The terminal now has a key mapping that sends those characters as characters, Option as Meta as Meta, and Option+Left and Option+Right as word movement on macOS, as xterm.js does. Each rule is checked against xterm.js 5.5.0 loaded as macOS, Windows and Linux (`navigator.platform` emulated, not a real OS) and the Rust core is held to the same recorded bytes. xterm.js stays the only engine and nothing offers another one yet, so terminal behaviour and defaults do not change; nothing calls the mapping until the native input bridge exists, and no iOS keyboard, IME, mouse, touch, selection or clipboard parity was tested.
- Prepare screen-reader access for a native terminal surface (#1329, epic #1302). A native surface draws no text a screen reader can reach, so the terminal can now mirror its visible rows into a hidden list and speak what changed through a polite log: lines that scrolled in, the characters appended to a row, the row under the cursor when only the cursor moved, and a selection. It never reads the screen again for every byte (one read of the visible rows per 150 ms), speaks at most every second and at most 8 lines (a larger change is one "N lines changed" line), and says nothing while you read history. New terminal sessions now also require an engine that a screen reader can reach while **Screen reader announcements** is on, so a native engine that cannot is never used for them and xterm.js is. xterm.js stays the only engine and nothing offers another one yet, so terminal behaviour and defaults do not change; the mirror has not been tried with TalkBack, VoiceOver, Narrator, NVDA or Orca.
- Close tabs from the native tab strip, and rename Zellij tabs (#1383, part of #1144). A long press (or a right click, or the context-menu key) on a Herdr tab, a Zellij tab or a tmux window now opens a small menu with **Rename** and **Close**; **Close** asks first, names the tab ("Close “logs”? Programs running in it will end.") and sends one typed command by the tab's exact id (`tab close` for Herdr, `kill-window` for tmux, `close-tab-by-id` for Zellij) only on confirmation. The only tab of a Herdr workspace, a Zellij session or a tmux session is never offered for closing. Zellij tabs can now be renamed too (`rename-tab-by-id`); both Zellij commands need a Zellij that reports a stable `tab_id` in `list-tabs` (0.45.1 does) and a Zellij without one keeps selecting only. The menu and the confirmation drop over the terminal without resizing it and never open the soft keyboard; only the name prompt does. A Herdr tab that has gone since the strip last read is refused instead of closed by guess, and a Zellij tab is addressed by its stable id, never by its position. Not in this change: closing a Herdr workspace, a session or a pane from the strip. Changed default: a long press on a tab that can be renamed opens the Rename and Close menu instead of going straight to the rename prompt.
- Route the terminal pane's selection, search, paste, links, Herdr navigation, IME and Mosh resize handling through a terminal-engine adapter, so a second terminal engine can be tried later without touching them. xterm.js stays the only engine and nothing offers another one yet. Terminal behaviour does not change; no defaults change.
- Follow an OpenCode session in the Agent view and send to it, on tmux (#1486, part of #1125). When the OpenCode TUI runs in the pane, the Agent view lists it with the other agents, binds to the session its hook reports (found in OpenCode's database through the host companion), reads its messages and keeps them updated by polling, and the composer sends to that pane through the confirmed terminal input. OpenCode 2.2.7 drops a short prompt written as a burst of keys, so for OpenCode every prompt is written as one paste and Enter, and **Stop** presses Escape twice with a short pause, as OpenCode asks. The slash palette, the `!` and `#` mode names and the `@` file picker stay off for OpenCode, and the permission-mode switch stays Claude Code only. Claude Code and Codex are unchanged: their short prompts are still typed. A shell command OpenCode ran appears as a tool card with its output; the header shows the model, the tokens of the last reply as the context in use and the folder (and the cost in the options sheet), read by the updated host companion from the same database, and the default `build` agent is no pill. Plan cards and live updates (the view polls) are not part of this change. No defaults change.
- Read long Grok Build sessions in the conversation view (#1844, follow-up of #1657, part of #1125). Grok logs one record per streamed chunk, and the reader refused a file of more than 10,000 records, so a long session stopped opening in the Chat tool's **Grok ACP records** and in the Agent view of a Grok Build pane for the rest of the session. The companion now joins the chunks of a streamed message as it reads them and counts them as one record, so the bound is 100,000 records (a message, a tool update or a control record each count once) and 16 MiB; a synthetic log of 52,000 records (13.3 MB, 500 turns of 100 streamed chunks) opens, and one request on it took about 170 ms on the development host (about 13 ms per MB, measured with an optimized build; see [the companion guide](docs/companion.md#optional-grok-recorded-conversation)). Rewinds without a recorded prompt boundary, mixed sessions, repeated message ids and a file that changes while it is read still fail visibly, and a file past 16 MiB is still refused. The file is still read from its start on every request. Needs the new host companion. No defaults change.
- Make `lazysh-agent update`, `update --dry-run` and `update --rollback` work on Windows hosts (#1444). The installed `lazysh-agent.exe` is renamed to `lazysh-agent.exe.previous` while it runs (Windows lets a running image be renamed, not overwritten) and the verified, self-tested file takes its name; a failed second rename or a failed check of the installed file puts the previous one back (exit 25). A kept previous copy that is still the image of a running process stops the update with exit 27 before anything changes. Staging files end in `.exe`, the managed directory is `%LOCALAPPDATA%\lazysh\companion`, and nothing needs administrator rights. The checks, exit codes and JSON result are those of Linux and macOS. No defaults change.
- Update the host companion on the host instead of on the phone (#1445, epic #1441). **Install companion** and **Update companion** no longer download the 9 to 12 MB executable on this device and upload it over SSH: the app verifies the small release metadata and sends the host the version, size and SHA-256 it must install, and the host downloads that file itself over HTTPS (`curl` or GNU `wget`), checks the exact size and digest before anything runs, tests it in a cleared environment, keeps the previous companion and replaces it atomically. A failed test or post-check leaves or restores the previous companion, a newer companion is never replaced, a file that is not the pinned one is discarded and reported as a security failure, and nothing uses `sudo`. The panel shows the host's download progress. It works for every companion that has no `update` command yet (1.28.0 onwards). Changed default: the phone's connection to GitHub is no longer used for the transfer, so the host needs outbound HTTPS to GitHub and `curl` or GNU `wget` plus `sha256sum` or `shasum`. A host without them or without a route to GitHub shows a separate, labelled **Install through this device** button that keeps the previous transfer through this device (about 9 to 12 MB of its data); it is never used unless you press it. Linux and macOS hosts only; the `lazysh-agent update` command and automatic updates are still planned.
- Stop the Agent view message box from typing into a dialog the agent has open. While Claude Code or Codex waits for an approval, a question, a plan decision or a menu (as its report says), or while the terminal screen shows one of its dialogs (`/model`, `/resume`, the folder trust prompt and similar), Send, Enter and Retry hold and the box says **The agent is waiting for your answer. Answer it first: a message sent now would go into its dialog.** Before, the text went into the dialog and its final Enter could take the highlighted choice (for example Yes on a permission prompt) without you meaning to. Your draft is kept and goes out once the dialog is answered. A host that does not report what the agent waits for (no approval hook, no readable dialog) is not covered and still needs you to look at the terminal. Changed default: Send is held while the agent waits for an answer. No setting changes.
- Redesign the frame of the Agent view (#1452, last of four slices). The header is two short lines: the agent and folder, then its state (Working, Waiting for you, Done) in the state's colour with the mode and context chips, and its two buttons are 44 px round. **Jump to latest** is a round arrow button that floats over the end of the timeline, so it no longer pushes the messages down when it appears. The working line shows three dots that rise in turn (still when you reduce motion). A conversation with no message says **No messages yet** instead of showing a blank page. Errors are tinted cards. On a window under 620 px tall (a landscape phone, or the keyboard up) the header, rows and message box shrink and the facts line and the `/` and `@` chips are left out. Changed default: the header has two lines and no bottom border, and Jump to latest is an icon button; its name for screen readers is unchanged.
- Redesign the Agent view message box (#1452, third of four slices). It is one rounded field that grows with what you type, soft-wrapped lines included, in 16 px text in the app font (it was 12 px monospace, which made a phone zoom in on focus). On one line it holds attach, the permission-mode switch, the field, Stop and Send as 44 px circles; once the text needs a second line the field takes the full width and the controls move under it. Send is the one filled button and shows a spinner while the message is being delivered. While the field has the focus, **Commands** and **Files** chips put `/` or `@` in the field and open the command or file palette, for touch keyboards that hide those characters on a second page. The palette, send receipts and notices lose their borders. Changed default: the box is rounded and borderless and its text is larger; nothing about how a message is sent changes.
- Redesign the work the Agent view shows (#1452, second of four slices). A tool call, the thinking, the folded activity of a turn and a sub-agent are one quiet row each: a tonal bar without a border, 44 px tall, with a tool icon, the name, one line of what it did and a chevron that turns when it opens. A call that went well is one check mark (its word, Done, is still read aloud by a screen reader); a running call has a spinner and says Running, a failed one says Failed with its exit code, a declined one says Declined. The plan is a checklist with a mark per step, and the plan chip above the composer fills as steps finish (**1 of 3**). Questions and failures are tonal cards without a box, the running-work chips are borderless, and a plan call no longer leaves a stray *tool result* row. Changed default: rows and cards lose their borders and the status word of a successful call is no longer shown; no setting changes.
- Redesign how the Agent view reads a conversation (#1452, first of four slices). Your message is a compact rounded bubble on the trailing edge and the agent's answer is plain text on the page, in a centred column about 40 rem wide at 15 px with a 1.6 line height, so a phone reads like a chat app instead of a stack of boxes. A fenced code block now shows its language, a **Copy code** button and syntax colours (TypeScript, JavaScript, Python, Rust, Go, shell, JSON, CSS, HTML, YAML, SQL, diff and more), and scrolls sideways instead of wrapping. Markdown tables, strikethrough and task lists render (GitHub-flavoured Markdown; before, a table showed as pipe characters), and tables and quotes are restyled. Tap a message to see when it was sent. The prompt of a running turn no longer sticks to the top of the thread. Colours come from the app theme and reach 4.5:1 contrast in Forest, Midnight and Paper. Changed default: the Agent view conversation looks different, and a message no longer has a border; no setting changes. The remaining slices (work rows, composer, header and states) follow under the same issue.
- Render the HTML that agents write and people paste in the Agent view and Chat (#1450). A `<table>`, `<details>`, `<kbd>`, `<a>` or `<img>` in a message used to appear as escaped text, because the reader's Markdown renderer draws raw HTML as text. Messages now render a strict allow-list of structure and emphasis, with no scripts, event handlers, styles, frames, forms, `id` or `class`; code fences and inline code stay literal, a tag that is not on the list (such as `Vec<String>`) is shown as typed, and a wide table scrolls inside the message. Links ask before they open the system browser; a remote image is never requested and shows a placeholder with **Open image in browser**; a small embedded image shows. A message with rendered HTML has **Show source** and **Show rendered**. Files and repository previews keep their inert renderer. Changed default: links in Agent view messages, which were plain text, are now tappable after a confirmation.
- Fold the agent's thinking into one row per turn in the Agent view: **Thought for 12 s** (the time before each message that carries thinking, summed) expanding to the thinking paragraphs as Markdown, instead of one closed block per message. Without recorded times the row says only **Thinking**, redacted (empty) thinking draws no row, and reasoning tokens are never shown because they are not recorded. No defaults change.
- Read Gemini CLI conversations in the Agent view. With the updated host companion, `lazysh-agent transcript --agent gemini --view conversation` replays a Gemini CLI session file (`chats/session-*.jsonl` under `~/.gemini/tmp/<project>/`, or `$GEMINI_CLI_HOME`) the way the CLI does: a re-appended message replaces the earlier one, `$patch` lines set tool results, `$rewindTo` drops the rewound turns. The Agent view shows the prompt, the answer, thinking, tool calls with their results and errors, the plan of `write_todos` (including **Blocked** steps, a new status in every language), sub-agents (`invoke_agent`) and background shells (`run_shell_command` with `is_background`) in the same cards as for Claude Code, and the model in the header. A tool or shape the mapping does not know stays an ordinary tool block. To follow the Gemini session of the pane, print the opted-in hook fragment with `lazysh-agent gemini-config --reported-history` and add it to Gemini's settings; without it nothing changes, and a session file can still be opened by hand from the transcript panel. Its commands, reads, searches, web fetches and file edits (`replace`, `write_file` as diff cards) use the same tool cards as the other agents. Sending works on tmux only. Added only: no default changes.
- Hide the toolbar page indicator until you change page, and draw it as fading dots. The three small bars under the terminal toolbar (**Keys page**, **Tools page**, **Snippets page**) are now three 5 px dots, the current page a short pill, at reduced opacity. They are invisible by default, fade in (about 0.2 s) when a swipe or a page button moves the toolbar to another page, stay for 2 seconds after it stops moving, and fade out again. They sit in the toolbar's own bottom padding, so they never cover a key, the soft keyboard or the status bar, and the toolbar keeps its height (74 px at the default key height); the top padding gives 2 px to that strip. While hidden the buttons stay in the accessibility tree and the Tab order but take no touches; keyboard focus on one shows the dots at once and keeps them while focused, and screen-reader mode keeps them always shown. With reduced motion they appear and go without a fade, after the same delay. Changed default: the toolbar page indicator is hidden until you change page.
- Change a Claude Code session's model from the Agent view on tmux. **Switch model (/model)** in the Agent view options sends one guarded `/model`, and the agent's own model list opens as the card above the message box (or in the terminal, when that list cannot be shown). Choosing a model stays the agent's own flow, so nothing here guesses the model or saves a default for you. Codex, Herdr, Zellij and a conversation you picked from the list do not show it. No default changes.
- Send from the Agent view to an agent that runs in a Zellij pane (Zellij 0.45.1). With the updated host companion, hooks report the Zellij session and pane they run in; the Agent view of a terminal attached to that session follows the agent that names one of its panes (or lists them when several do), and Send and Stop write to that exact pane through Zellij's own commands, only while it still runs the agent, so a prompt is never typed at a shell. A failure after the first write reads as unconfirmed and is never resent. Prompts are limited to 4,096 bytes and dialog answers stay in the terminal. rmux and plain or local shells still use **Stage in terminal**. No default changes.
- Stop a running background task from the Agent view. A running background command, monitor or sub-agent that has the id Claude Code gave it at launch now has **Stop** in the background-work panel; after a confirmation, lazysh sends the agent one fixed message through the composer's input asking it to end that task with its `TaskStop` tool, and the row changes when the agent records the stop (**Not confirmed** after 90 seconds without one). It is a request to the agent, not a kill, so it queues behind a turn in progress and is not offered while the agent waits for an answer. Claude Code on tmux only. No defaults change.
- Read the Agent view's background work from the host companion. With the updated companion the background-work panel above the composer lists the sub-agents, background commands, monitors and workflows of the whole conversation instead of only the messages loaded in the view, shows a command's text and the lines a shell or monitor reported when you tap it, says **not confirmed** for a launch whose end was never recorded once it is older than it could run (it used to stay running), and keeps a finished sub-agent's tokens and run time. A turn that ended while a background sub-agent still runs now reads **working**. An older companion keeps the panel derived from the loaded messages. Opening a sub-agent's own conversation and stopping a task are not part of this change. No defaults change.
- Order the phone navigation tabs Agents, Workspaces, Connections in a connected remote session, and open it on Agents. Changed default: on a narrow window with a live SSH, Mosh or Eternal Terminal session, the menu used to open on Connections, with the tabs ordered Connections, Workspaces, Agents. It now opens on Agents (the Herdr agents list, or the agents of a tmux or Zellij session) the first time, and later visits keep the tab you left. With no remote connection (the connection list, a local terminal, which has no agents) and on wide layouts, Connections stays first and selected. (#1395)
- Pin the agent's plan or todo list above the composer in the Agent view. The latest plan (Claude Code TodoWrite, Codex update_plan, OpenCode todos) is one chip such as **2 of 3** with the step the agent is on; tapping it opens the full list with pending, in progress and done marks. A later update changes the same chip instead of adding another list inside the turn. A conversation without a plan shows no chip. No defaults change.
- Keep the Android startup cover over a rendering WebView until its first frame is painted, so the screen that follows the cover no longer shows the page's earlier placeholder frame for an instant (#582). While the app does not yet know whether a lock applies, the WebView now renders behind the opaque cover, is inert (no touches, no focus, hidden from accessibility), and the cover leaves only after the WebView reports it has drawn its current state, with a 300 ms limit so a missing report can never leave the app covered. While it waits the cover keeps its logo and never shows the lock controls. A confirmed lock still hides the WebView entirely. Checked with the native cover instrumentation test and with cold start, restore and warm start frame recordings on an Android guest (the cover, then the workspace, with no placeholder or lock screen between them); the reporter's device and the original flash have not been reproduced or confirmed, so the issue stays open. No defaults change.
- Say so in the Agent view when a Claude permission request was answered in the terminal (or on another device) first. The card used to disappear at the next 10-second refresh, and a tap in between failed with a generic error. Before every Allow, Deny or option the view now lists the host's pending requests again; if the request is gone it sends nothing and shows **This request was already answered, in the terminal or on another device. Nothing was sent from here.** for a few seconds. A request you answered here or that expired shows no such note. No default changes.
- Compare the native terminal engine under development with xterm.js: replayable screens, key presses and mouse reports run through both, and the 28 differences found are recorded with reasons. The comparison fixed one defect in the engine's mouse reporting (a resting pointer sent a report for every pointer event in a cell). The engine is not selectable yet, so no behaviour changes: xterm.js remains the terminal engine and no defaults change.
- Replace the top bar and the hamburger with one full-screen side menu on phones in a connected session. The side menu is the navigation page that already listed hosts, Workspaces and Agents: swipe from the left edge to the right (or tap the left handle) to open it; close it with the opposite swipe, Back or its close button. It overlays the terminal without resizing it, and a strip at its top carries what the top bar offered: the session title and switcher, connection state, the Terminal and Agent switch and the terminal controls such as Compose, the keys toggle and the Herdr switch. The other tools moved into its tabs: Files, Usage, Attach, Transcript, Diff, Preview, Apple status, Dictate, Devices and the session manager are rows of **Workspaces**, and Default multiplexer, Preferences, Remote push settings, the notification inbox, encrypted sync, shareable uploads and End connection are rows of **Connections**. The terminal gains the freed 44 px of height (34 to 36 rows at 415x900). Changed default: phones with a touch screen no longer show the top bar in a connected session. **Preferences → Show the top bar on phones** brings it back, and so does turning off the left-edge gesture or screen-reader mode, which keep a visible menu button. Desktop, wide layouts and the connection list keep the top bar. The menu never opens while you type, compose, select text or scroll. (#1262, #1415)
- Say what an agent waits for in the Agent view. A report that needs you now reads **Waiting for your approval**, **Waiting for your answer**, **Waiting for your plan decision** or **Waiting for you**, with how long it has waited, in the Agent view header and its session list, which also counts the waiting sessions and lists the longest-waiting first (live Herdr agents that need attention come first too). Tapping a needs-you notification opens that session's Agent view instead of the agents list. The host companion records the kind and the start of the wait; update it for the exact kind and time, an older companion still shows the kind from the report summary. No default changes.
- Switch between the terminal and the Agent view with a swipe on a phone in a connected session: swipe from the right edge toward the left to show the Agent view, and while the Agent view is shown swipe from the centre toward the right to return to the terminal. Both views are already open, so nothing reconnects; they slide as one page that follows the finger and settles when you lift it (instantly when the system asks to reduce motion), and a swipe that is short, slow or interrupted leaves the view unchanged. The swipe does not start while you are typing or editing text, a text field has the focus, or a text selection or another touch gesture is in progress, and it does not start from inside horizontally scrollable content such as code blocks, diffs and tables, which keep their own scrolling. The Agent view needs no agent in the pane: it then shows its session list or its explanation, as with the button. The **Terminal | Agent** buttons in the session header and **Ctrl+Shift+Y** remain, and the choice is still remembered on this device per saved host and multiplexer target. Phones in a connected session only; desktop windows and the connection list are unchanged. Changed default: a swipe from the right edge of the terminal now opens the Agent view on phones; it can be switched off with the gesture settings of the edge gestures.
- Serve the terminal session that has a view attached ahead of background sessions in the native terminal core's worker queue, with one turn in five left to the background ones so they keep parsing (#1339, part of #1302). With nine other sessions streaming on the same workers, the time from a chunk arriving to its screen update being ready fell, at the median on one desktop host, from 99 to 324 microseconds to about 17 for plain text and from 1.0 to 2.4 milliseconds to about 0.16 for CJK and emoji; a phone was not measured. Nothing in the app uses the native core yet: xterm.js stays the only terminal engine and the default, and no setting or default changes.
- Bring back sliding between toolbar pages in the compact terminal toolbar of 1.32.0, without making it taller. The toolbar is again a row of horizontally swipeable pages: the **Keys** page with the configured key rows, a **Tools** page with **Find** and **Copy**, and a **Snippets** page with your saved snippets and chords (shown only when you have saved some). Swipe the toolbar sideways, or use the page indicator, to switch. The toolbar keeps its compact size: 74 dp (about 192 px on a 1080×2340 phone) at the default 32 px key height, the same as with 1.32.0 and 1.33.0, because every page is as tall as the Keys page and the page indicator is drawn inside the toolbar's bottom padding instead of in a row of its own; at any **Toolbar key height** the pages are as tall as the keys they replace. A drag that starts on a key you are holding down (repeating, or with a long-press action) stays with that key and does not turn the page. The page indicator is three small buttons named **Keys page**, **Tools page** and **Snippets page** (the current one is marked), so it is also the way to switch pages without a gesture: with a screen reader or a keyboard, move to one and activate it. A key row wider than the screen still scrolls sideways first; swipe again from its end to reach the next page. Changed defaults: the **More keys** key (`⋯`) and its list are removed, since Find, Copy, snippets and chords have pages again, and the default toolbar's second row now ends `Shift ctrl Alt c d enter ← ↓ →` with **enter** in the cell that held **More keys**, so the arrows stay under Home, Up and End. A saved toolbar that is still exactly the 1.32.0 default moves to this default; every other saved layout keeps all of its keys, rows and key height, now without the **More keys** key.
- Make the terminal use the whole free screen area instead of leaving margins around it. On a phone the terminal used to start 10 px below the session header and stop 2 px from each side, and xterm.js kept a further 15 px strip on the right for a scrollbar that Android draws over the text and never gives width, so about 18 px of the 415 px screen width held nothing. The terminal now starts directly under the header and runs to both screen edges, keeping only a real system inset (a display cutout or system bar). On a 1080×2340 phone at 2.6 density (415×900 px) the terminal went from 47 to 49 columns, and on a 1280×850 desktop window from 114 to 116 columns and 30 to 31 rows; the PTY, SSH and Mosh sizes follow the new grid. Only less than one text cell remains unused at the right and bottom, which a character grid cannot fill. Changed default: the terminal no longer has a 10 px top margin or a 2 px side margin and no longer reserves 15 px for a scrollbar that takes no width, so the visible text area and the terminal size reported to the host grow. Search highlights and selections in the terminal no longer draw over the toolbar's **More keys** list.
- Make the terminal toolbar compact, following the layout of other mobile SSH clients such as Haven. Every toolbar row is now a fixed grid of equal-width keys that shows all of its keys at once: there are no sliding pages and no page-indicator row, and the keys are 32 px tall instead of 44 px with tighter spacing. On a 1080×2340 phone (about 2.6 density) the toolbar is 74 dp (about 192 px) tall instead of 133 dp (about 346 px) for two saved rows or 85 dp for the old default row with its page indicators, and the status bar (host, connection type, UTF-8, TERM) that sat between the toolbar and the keyboard is hidden on a phone whenever the window is shorter than 700 px (an open soft keyboard or landscape), so the terminal keeps that strip. Icons replace words for keyboard, attach, Home and End, and a locked Ctrl or Alt shows a lock mark. A **More keys** key (`⋯`) closes the last row and opens a list over the terminal with **Find**, **Copy** and your saved snippets and chords, which used to be a second toolbar page or fixed keys at the end of the row. Changed defaults: the default toolbar is now two rows of nine keys, `keyboard attach esc tab paste / Home ↑ End` over `Shift ctrl Alt c d … ← ↓ →`, so the arrows form an inverted T, instead of one scrolling row of 13 keys plus Find and Copy. A saved toolbar that is still exactly the previous default moves to the new default; every other saved layout keeps all of its keys and rows in their order, now drawn in the compact grid with **More keys** added to its last row. A row with more keys than fit the screen still scrolls sideways. The **Toolbar keys and order** preview shows the same grid. Touch targets of the toolbar keys are now at least 28×32 px (previously 44×44 px).
- Resize Mosh sessions when the soft keyboard opens and restore their size when it closes, allowing programs that redraw on resize to show their prompts and options above the keyboard. Changed default: Mosh now sends the smaller size to the remote program; Mosh servers discard the bottom rows when shrinking, so programs that do not redraw may lose those rows. A keyboard that changes only the visual viewport is accommodated at normal page zoom.
- Organize setup guides and service, transfer, theme and notification contracts into task, reference and explanation pages; existing documentation paths and section anchors remain available.
- Use an accessible segmented cursor-shape picker in terminal preferences.
- Check the native terminal engine's data path against real servers in CI (part of #1315). A real OpenSSH server, the official mosh-server and the official Eternal Terminal server each deliver a deterministic workload through a real PTY to a core: byte-exact and in order over SSH and ET, the final screen over Mosh, with at most one credit window queued and no output message on the WebView channel. xterm.js stays the only terminal and nothing offers the native engine yet; terminal behaviour does not change and no defaults change.
- Group the Agents board by project and host, and archive finished or stale reports. Inside **Attention**, **Working** and **Done**, reports from the same project now sit together under a heading with the project folder and the host's name, with the most recently reported project first. Each report has an **Archive** action (also in the selected report's details), which hides it on this device: **Archived N** below the board lists archived reports with **Restore**. An archived report comes back on its own when its agent reports a newer event, and the archive forgets it when the host companion ages the report out (seven days, as before). Archives are kept per saved host on this device and are not synced or sent to the host. No defaults change.
- Include the changes of prepared versions that were never published (for example after a failed or superseded release run) in the next GitHub release notes, under "Also included from X.Y.Z". Previously those changes were missing from every published release's notes.
- Redesign the app chrome to be subtle and borderless. Buttons, inputs, selects, text areas, toolbar keys and toolbar editor chips drop their outlines for tonal fills, selected items use a soft accent fill instead of an accent outline, the current terminal session in the session switcher and live sessions list also keeps a 3:1 accent bar, and every control keeps a clear 2px keyboard focus ring. The terminal toolbar, the floating terminal selection actions and desktop dialogs, including Preferences, join the header, sheets and tab bar as translucent, blurred glass with a soft top highlight; reading surfaces, cards and full-screen phone pages stay opaque. Glass never drops below the opacity at which every theme colour keeps 4.5:1 text contrast over any background, and every glass surface turns opaque with reduced transparency, increased contrast or forced colours. Increased contrast also restores visible control borders. The user's terminal theme colours are unchanged. Changed defaults: the default lazysh app theme's accent is now a restrained periwinkle (`#b4bdf8`) instead of cyan (`#77f3ec`), which also changes the default primary button, links, focus ring, crop outline and the Android dark-mode native accent; the green Language settings icon replaces the teal one; card and fieldset edges are now faint hairlines; the phone Workspace tools sheet is slightly more opaque (83% instead of 78%) to keep that contrast. Imported themes keep their own accent. The lazysh logo artwork is unchanged.
- Deliver notification relay events through an Apprise API server, which forwards them to Telegram, Discord, Slack, Matrix, email, Pushover, ntfy and the other services Apprise supports. Run `lazysh-notifications serve --destination-format apprise` with a URL file holding your stateful key's HTTPS `/notify/<KEY>` endpoint; the Apprise server keeps every downstream secret. An optional `--destination-token-file` is sent as `Authorization: Bearer` for your reverse proxy to check, and running without one needs the explicit `--destination-unauthenticated` flag. `--apprise-tag` (up to eight) selects tagged services. Each event carries only a `lazysh · <alias>` title, a fixed sentence per state and the `info`, `warning` or `success` type. HTTP 424 (some downstream services failed) ends as `partial` and other non-200 client errors as `rejected`, both without retrying, and the host companion's `relay run` records those receipts when it republishes an event after a lost acknowledgement; 408, 429, 5xx and timeouts keep the bounded retry. Stateless Apprise mode is not supported, because it would put downstream secrets into lazysh's files. Push setup help in the client now lists the relay destinations and opens the relay guide. No defaults change: webhook stays the default format, and webhook and Gotify delivery and identities are unchanged.
- Declutter the Herdr Spaces tree on the Workspaces screen. Each space is a compact card with one status summary and its tab count; tabs and panes sit one indentation step in, without guide lines. A tab shows its status only when it differs from its space, and a pane only when it differs from its tab; screen readers still hear every status. Long labels and paths stay on one line and end with an ellipsis, with the full text in the tooltip, and pane paths shorten the login user's home to `~` (another user's home shows as `~name`); search matches the shortened path as well as the full one. Disclosure chevrons now sit on the right and appear only on spaces and on tabs with more than one pane; a collapsed tab shows its pane count. **New worktree from this workspace** moved from an icon on every space into the space's **More actions** menu, which a long press on the space also opens; Escape or Android back closes only that menu, also in the phone sidebar. Search, server, focus note, refresh, **New workspace** and the tree share the same edges and spacing, and the host caption stays on one line. In the narrowest sidebars a space's status shows only its dot, so the name keeps its room. Every navigation target is unchanged. No defaults change.
- Split the terminal toolbar into pages you slide between. The **Tools** page holds the configured key rows with Find and Copy; the **Snippets** page holds saved snippets and chords. Slide sideways (or use a trackpad's sideways scroll) to change page, or tap the page indicators below the keys; with the default single key row, a slide first scrolls the keys and turns the page once the last key shows. The indicators are one tab stop that the arrow keys, Home and End move between. A page shows at most about a quarter of the window height (three rows on a phone without the keyboard, usually two above a docked keyboard) and scrolls the rest; keep swiping or scrolling the wheel past the last row to open the next page, and past the first row to go back. Both pages share the height of the key rows, so changing page never resizes the terminal, and each device remembers the last page. Keys keep hold-to-repeat and long-press actions (a drag after a held key repeats or runs its long-press action never turns the page), modifiers and the D-pad, and choosing a page leaves the keyboard as it was. Changed default: snippets and chords no longer follow the keys on the last toolbar row; they open on their own page. Toolbars without snippets or chords stay a single page with no indicators.
- Rebuild Preferences as a grouped settings list on phones and desktop. Rows sit under section headers (Terminal, Input, Agents and notifications, Security and sync, General, Help), show their current value under the title (theme and font size, cursor and history, language, host, snippet and chord counts), and open sub-pages with Back. Sub-pages group their rows under headers with help text. Notifications now opens the remote push settings directly, and new rows open the notification inbox, encrypted sync, shareable uploads, About and the active session's Agents and Dictate tools. An unavailable row stays focusable and shows why under its title: it needs an open session, the session has no voice tool, or it works only in the desktop and mobile apps. Reset settings is a separate destructive row, and the app version closes the list. A new search field finds any setting by name, including inside collapsed groups, then opens its page and focuses the control. Escape and Android Back clear the search before they leave a page or close Preferences, and the number of results is announced. The search field never takes focus when Preferences opens, so the phone keyboard stays closed. Every preference key and stored value is unchanged. No defaults change.
- Save attachments to a private file under the host's `/tmp` by default, so uploads no longer land in the login directory. Leave **Destination path** empty (the new default) and the host saves the upload as `/tmp/lazysh-<random>-<file name>`, created exclusively with owner-only permissions (`0600`) before any bytes are written (if the host cannot make it owner-only, the upload stops and the empty file is removed); the path inserted into the Chat draft, the terminal paste and the editable prompt is that `/tmp` file. Repeated uploads of the same file get distinct names. Enter a path to save the file there instead, as before. Hosts without `/tmp`, such as Windows OpenSSH, keep the previous login-directory location. This applies to SSH and Mosh sessions; the Files panel upload keeps its chosen folder. Changed default: the attachment destination was `./<file name>` in the login directory.
- Find a safely admitted default Herdr installation under the remote user’s `.local/bin` when it is absent from the command PATH of a positively identified x86_64 or arm64 Linux or macOS host; PATH remains preferred. Other architectures, hosts without `/usr/bin/uname`, `/usr/bin/id` and `/usr/bin/stat`, and homes below a symlinked directory keep PATH-only lookup. Changed default: the Herdr lookup on those hosts now includes this fallback.
- Keep the software keyboard connected when arming the terminal toolbar's ctrl, Alt or Shift key. The terminal editor no longer blurs or becomes read-only for the tap, so SwiftKey, Gboard and other keyboards keep their Shift and suggestion state instead of restarting. Pending composition is still sent first, and the editor is still revoked when it is not focused. No defaults change.
- Keep finger scrolling responsive after a pause in history while the on-screen
  keyboard (SwiftKey, Gboard) holds a word in composition. A drag whose first
  movement was short or sideways was dropped entirely, so a full-screen agent
  with mouse reporting (Claude Code fullscreen, Herdr, tmux mouse mode, Mosh)
  received no scroll and only its Jump to bottom control moved the view. A
  toolbar key that sends the composed word no longer leaves the terminal
  treating later drags and long-presses as part of that composition. No
  defaults change.
- Keep an opened Chat transcript reader when switching to the terminal or another session view and back: its messages, reading position and unsent draft stay as they were instead of resetting to an empty reader. Following pauses while the reader is out of view, a confirmed terminal destination is still released on leaving, and a reader opened from reported agent history still retires when left.
- Redesign the terminal composer as a sheet that replaces the visible terminal output while it is open: a large multi-line editor with character and line counts, a primary **Send** action, **Clear draft**, **Close composer** and Attach. Send pastes the draft exactly as before (bracketed paste when the remote program enables it) and then sends one separate Enter, so a multi-line draft is submitted once. Changed default: the composer's primary action now submits the draft; turn off **Preferences → Keyboard and gestures → Send Enter after pasting the draft** to restore the previous paste-only **Paste draft** action. Send is disabled for empty or whitespace-only drafts. Ctrl+Enter (⌘+Enter on Apple devices) sends from the editor, Enter inserts a newline, and Esc or Close returns to the terminal with the draft kept. The terminal session and its size stay unchanged underneath: opening the composer, showing the keyboard or hiding the key row never resizes the PTY. On touch layouts the sheet sits directly above the on-screen keyboard and the key row returns when the composer closes. Settings sync accepts the new preference.
- Arrange terminal toolbar keys by dragging in **Preferences > Keyboard and gestures > Toolbar keys and order**: drag keys to reorder them, drag from Available keys to add, and drag onto Remove or back to Available keys to remove. Touch screens start a drag with press and hold, so swiping still scrolls the page. A live preview shows the resulting toolbar. Without dragging, select a key for Earlier, Later and Move to row actions, or focus it and press Alt with an arrow key to move it or Delete to remove it; each change is announced to screen readers. The ↑/↓ buttons are replaced by these actions. Add **Toolbar rows** (1–3) so the terminal toolbar can show several horizontal lines of keys, Haven-style; keys move between rows by drag or action. Defaults are unchanged: one row and the same keys. Rows are stored in the existing `toolbar` setting with a `row-break` marker, so existing toolbars load as one row and older versions and sync peers show the same keys on one row.
- Redesign pending agent approvals and the agent inbox. Each approval card shows the agent and tool, the project and how long ago it was requested, the full tool input, a live expiry countdown (Deny and Allow disable when it reaches zero), equal-width Deny/Allow buttons and a project, agent session and pane summary. The inbox groups events into foldable Needs you, Working and Done sections with counts; rows show a status ring, project, host and relative time (absolute time on hover), with icon buttons to archive or open the connected session. Changed default: when monitoring is on and events exist, the monitoring and notification controls start collapsed under Monitoring and notifications; they start open when monitoring is off or the inbox is empty. Approval and inbox data, polling and decisions are unchanged.
- Turn the Ctrl/Cmd+K host picker into a command palette that also finds open sessions, the current connection's tools (Files, Diff, Sessions, Preview, Transcript, Agents and more) and actions such as Preferences, sync, the notification inbox and About, with fuzzy, accent-insensitive matching and arrow/Enter/Esc keyboard control. Files now shows PNG, JPEG, GIF and WebP images up to 2 MiB, shows SVG only as an inert image, and renders Markdown without raw HTML, active links or remote images. Changed defaults: Ctrl/Cmd+Shift+P now opens the palette even from a focused terminal instead of reaching the shell, and Markdown files in Files open rendered, with **Show source** for the text.
- Read theme from clipboard now works on Android: Preferences → Appearance reads the clipboard through the same native path as terminal Paste instead of the WebView clipboard API, validates it like pasted input and always stops at the preview for explicit Apply. Text over 16 KiB or an invalid theme shows the validation error and keeps the current draft.
- Choose the Amber launcher icon on Android from Preferences → App icon, using lazysh's own artwork. Switching keeps the running workspace and its sessions open; the launcher may take a moment to redraw, and a remote-event notification posted before a switch still opens the workspace. Changed default: the launcher entry is now an alias of a small trampoline activity instead of `MainActivity` itself, and the icon choice stays device-local (not synced, exported or reset with preferences). Upgrade note: updating an existing install to this version changes the launcher component from `.MainActivity` to `.LauncherDefault` even if you never open App icon, so some launchers may move, re-map or drop a home-screen icon or shortcut pinned under the previous version; add it again from the app drawer if it is missing.
- Honor host `CODEX_HOME/auth.json` during automatic AI account discovery when no usage profile exists. Invalid nonempty paths report usage unavailable instead of selecting another account; explicit profiles, paths and disabled providers remain authoritative.
- Map the History lines setting to the byte budget of the native terminal core (#1319). The core budgets scrollback in bytes, so a fixed budget kept 5,300 rows at 80 columns and 2,200 at 200; the request is now derived from the setting and the width and keeps at least the requested rows of plain, coloured and syntax-highlighted output from 20 to 279 columns, measured on a Linux host. Content with a style on every cell or a hyperlink on every row keeps fewer rows, and the width is the one at open. The native core is not reachable from the app and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change. Also fixes the optional `native-terminal` build of the app bridge, which no longer compiled after the core gained a field.
- Redesign the main surfaces so the phone UI reads like a modern agent client. Agents use a small Live agents | Activity segmented control, uppercase status sections with counts (Live sections can collapse), and rounded rows with a status ring, bold title, secondary context and coloured project/agent/recency tags; the agent inbox now uses the same status ring and collapsible section headings, and Activity recency uses the inbox's relative times and stays current while the list is open. Live and Activity search, setup and refresh share one row with the host as a caption; setup stays behind one icon unless nothing is configured, and the status filters are compact chips. Saved hosts are compact rows in one group with a letter avatar and transport tag, and the transport is part of the row's accessible description. Connections, Workspaces and Agents switch from a floating glass tab bar on phone and desktop. The welcome screen gains brand light and feature chips. Settings are grouped inset lists with icon tiles, values on the right, switches and a platform back control. Motion is limited to the segmented-control thumb, tab bar and switch transitions, the working-ring spin, a colour-only dialog fade and a short phone drawer settle, and none of it plays when reduced motion is requested; glass keeps its solid reduced-transparency and forced-colour fallbacks. Status and agent tag colours switch to light-tuned values for Paper and imported light themes. Changed default: the bundled lazysh app theme now uses a true-black canvas with brand-ink surfaces instead of the navy background; Midnight and Paper are unchanged, and the browser theme colour and native splash surfaces stay brand navy. Existing controls, accessible names and ownership checks are preserved; the visible Search label is removed and remains the search field's accessible name, and the visible “Reported details ›” row hint is removed while each report row keeps its existing accessible name.
- Compact recorded-conversation drafts into one editor with named attachment, refresh and terminal controls. Changed default: staging guidance opens on request from How staging works; explicit staging and confirmed terminal input remain intact.
- Correct Android UnifiedPush and Firebase-free notification setup guidance, including the separate relay and display consent steps.
- Reduce workspace clutter by removing the redundant explanation beneath the session manager action.
- Keep a terminal reader in history while output streams and across resizes: a finger scroll that starts at the live bottom no longer snaps back to new output, width changes keep the same logical line after reflow, and a taller viewport (for example, closing the on-screen keyboard) no longer moves a Mosh reader or stops a Mosh session at the bottom from following output.
- Preserve terminal Enter delivered as an input-only line break, including an explicitly selected toolbar Shift modifier.
- Preserve owned terminal corrections delivered as paired keyless composition-text input events.
- Never pause terminal typing when a keyboard edit, such as an accepted SwiftKey suggestion, cannot be translated safely into terminal input. Changed default: lazysh now skips that one edit, leaves the terminal unchanged and keeps typing, Compose paste and toolbar keys working; a small "Keyboard edit skipped" notice fades after 8 seconds unless expanded for review. Previously typing stayed paused until the review was dismissed.
- Preserve owned IME corrections across zero-code Process keys and keep subsequent hardware keypresses ordered and sent once; retain focus, access and unsupported-edit protections.
- Keep owned ASCII forward deletions without key229 synchronized with later terminal suggestions and typing; preserve composition fallback and review for edits outside the locally owned input.
- Preserve the visible scrollback line during height-only terminal resizing, including keyboard-sized viewport changes; keep bottom-following and the separate Mosh rendering path.
- Simplify workspace navigation with focused Workspaces and Agents screens, compact session context and clearer work-state rows. Changed default: desktop tools now open from Workspace tools instead of a permanent tab strip; all existing tools remain reachable. Preserve the compact phone terminal, existing sessions and contextual return.
- Keep owned Android IME fallback edits from repeating earlier text or dropping ASCII deletions, while preserving cancellation and explicit review for unsupported edits.
- Keep Mosh repaint geometry synchronized with complete server frames during keyboard, composer and viewport resizes, avoiding duplicated screen rows in scrollback. Existing history cells retain their original width and can be clipped in narrower views until widened.
- Increase custom-theme glass opacity only when its selected chrome colors need more backing for readable text; bundled theme glass and solid accessibility fallbacks remain unchanged.
- Keep Compose and the expanded D-pad mutually exclusive so the draft stays editable above a mobile keyboard; switching tools preserves the unsent draft.
- Compact the terminal draft editor, prioritize uploaded attachment paths and explicit use, and guide push setup through relay enrollment. Agents opens Live by default; recorded Activity and setup stay available separately, with pending approvals reachable in both views. Connected sessions, drafts, upload protections and notification consent remain intact.
- Keep recorded Conversation messages readable in constrained workspaces instead of letting the reading region collapse behind its controls.
- Prevent the browser touch default on owned expanded D-pad direction gestures; ordinary clicks, corner shortcuts and accessibility controls remain available.
- Change toolbar Shift to one-shot: it clears after the next completed key, while a held arrow or D-pad gesture keeps its initial Shift for that hold. Tapping Shift again turns it off without sending pending IME text. Explicit Control and Alt locks are unchanged.
- Preserve fractional scroll distance between short finger drags in the same active terminal, making small gestures responsive without amplifying repeated movement; navigation, cancellation and connection changes retire pending travel.
- Keep unavailable Home Screen icon settings compact without hiding errors or explicit refresh recovery.
- Keep sidebar mode labels whole and reachable across narrow layouts, translations and enlarged text.
- Preserve slow sub-row finger movement in terminal scrollback instead of losing travel between xterm redraws.
- Expanded terminal D-pad controls now suppress their browser context menu by default.
- Keep browser acceptance aligned with dedicated Preferences screens and compare attachment file-picker styling in a settled normal state; application behavior and defaults are unchanged.
- Persist the selected Android push provider before explicit registration or cleanup so late previous-provider token callbacks cannot change it after restart. Status inspection remains read-only, and failed persistence prevents the control action.
- Keep vertically dominant finger drags responsive and preserve complete coalesced scroll motion before finger lift.
- Replace mobile Preferences disclosures with category navigation and contextual Back; simplify workspace and agent controls, refine theme-derived glass navigation chrome, and honor reduced motion for short navigation transitions. Settings values, credentials and transport defaults are unchanged.
- Keep Android autocomplete corrections editable when the keyboard leaves the caret inside an owned composing range.
- Preserve physical and toolbar Shift+Enter as a distinct modified Enter key for agent newline bindings, instead of submitting an ordinary Enter. Plain Enter and other modifier combinations retain their existing behavior.
- Organize documentation by learning, tasks, reference and explanation; add a guided first SSH session and separate companion setup, settings and event-storage contracts. Preserve established links, security limits and platform acceptance boundaries. No application defaults change.
- Prioritize connected app sessions above discovered Herdr spaces and refine compact themed navigation. Healthy Herdr server setup in Workspaces is now collapsed by default. Missing selections and unhealthy readers still reveal setup automatically. Keep shared-focus warnings visible and preserve session identity, reader drafts, contextual return, authentication and transport defaults.
- Keep delayed terminal, composer and search focus inside their pane from taking focus away from an open credential or other modal dialog. Preserve terminal protocol replies, sessions and explicit input after dismissal; no authentication or transport defaults change.
- Keep touch scrolling continuous when terminal output redraws under a held finger on coarse-pointer screens. Preserve screen-reader mode and desktop hit testing; no input, connection or permission defaults change.
- Make touch scrolling in mouse-tracking terminals depend on finger travel rather than touch-event frequency. Accumulate partial movement, keep the original pane and clear pending distance when the gesture ends.
- Keep the terminal canvas anchored when the keyboard resizes the available space and the browser reveals its input. Terminal history continues to scroll inside xterm's viewport.
- Stop the updated Amp plugin from reporting completion for an initially idle thread or treating error-to-idle as recovery. It reports idle only after observing that thread running. Replace previously copied manual Amp plugin files to receive the fix; existing historical reports, legacy ingestion and trust defaults remain unchanged.
- Complete independently identified Copilot child reports while preserving the parent's state and ignoring ambiguous child completion callbacks. No installation, permission or input defaults change.
- Correct packaged agent-reporting guidance for read-only discovery and explicit managed Cline setup. Preserve plugin restrictions and separate installation from loaded reporting; no installation or trust defaults change.
- Correct README download availability and link to the public roadmap and installation guidance.
- Shorten the default Workspace tools sheet to six frequent session actions, with explicit More tools, Connections and Application options disclosures. Keep End session distinct, all actions and capability checks available, and touch targets at least 44 pixels; no connection or permission defaults change.
- Explain the selected-profile startup and verification steps for configured Codex, Claude Code and OpenCode hooks. Provider trust, disabled hooks, server startup and live reporting remain under user control; setup still does not verify event delivery.
- Restore the mobile Agents drawer scroll offset once when returning from a tool to the same session and mode. Discard stale offsets after source, mode, server, access or layout changes; focus, navigation history, provider readers and connection defaults are unchanged.
- Check a sign-in hint against the host's listeners (#1510, part of #1504). A new native command `check_auth_listener` reads which process listens on the port a sign-in command printed, with the host companion's `lazysh-agent listeners` (its start time is compared with the hint on the host's own clock) or, for a companion that predates it, answers exit status 2, fails or is missing, with the `ss` or `lsof` read Previews already uses. It reports `confirmed` (the process started up to 2 minutes before or 30 seconds after the hint), `stale` (older, such as a dev server), `unproven` (age unknown) or `absent`, and says when the listener is another user's. `confirmHint` counts a listener that appeared after the port was empty as confirmed. Nothing is tunnelled, opened or shown yet. No defaults change.
- Collapse the Herdr server chooser for every healthy selected server, including hosts with multiple servers. Missing selections and unhealthy readers still expose setup automatically; alternate servers remain available on demand.
- Distinguish a full terminal input queue from a closed input channel, and record content-free write-caller and ownership diagnostics for investigating Android session navigation failures. Input delivery, queue capacity and error visibility are unchanged.
- Prioritize Connect when opening a saved host: connection options now start collapsed with the effective transport shown. Focus required credentials when needed or Connect when saved credentials are available, without stealing focus from a manual entry. Advanced Mosh/ET settings, saved defaults and validation remain available.
- Keep the native branded startup cover until the current renderer acknowledges its first workspace commit when app lock is disabled, including after renderer recreation. Confirmed locks retain their native unlock controls.
- Refine theme-aware frosted navigation and short action sheets, keeping long forms and terminal output opaque and preserving reduced-transparency and forced-color fallbacks. No theme defaults change.
- Prioritize live agents and reported activity over optional configuration. Healthy Agents setup and single-server Herdr selection now start collapsed; explicit setup preserves mounted drafts and operations, while companion repair and pending approvals remain visible. Connection, permission and collection defaults are unchanged.
- Classify failed companion installer tag rechecks with closed diagnostics while preserving localized errors, provenance verification and installation defaults.
- Keep connected Herdr navigation and agent reports in one scrollable drawer so live rows remain reachable on short phone screens. Preserve the existing navigation, report readers and drafts when switching views.
- Initialize companion database tables and indexes in one deferred transaction, avoiding separate schema commits and rolling back partial initialization on failure. Preserve full synchronization, existing writer coexistence and storage wait budgets.
- Keep Android status and navigation icons light over the fixed navy native window background in both system appearances. Preserve keyboard and system insets and custom app/terminal themes.
- Extend explicit managed hook setup to Gemini CLI and Cursor CLI through the companion and SSH-connected Agents view. Preserve Gemini's 5000 ms deadline and existing disable settings; retain Cursor's version-1 envelope, five-second fail-open observers and permission-hook exclusions. Existing foreign values/policy, filesystem checks and trust defaults remain unchanged; incompatible Cursor versions are refused.
- Honor a saved Mosh preference when entering a default tmux, Herdr or Zellij session. Auto entry tries Mosh and then SSH only for safe failures before entry dispatch; uncertain startup or guard admission never opens a replacement display. Keep the exact transport and attachment together for workspace restore (Zellij restore remains manual). SSH entry stays selectable; saved ET entry continues to use SSH. Native Mosh entry requires its private startup receipt, and tmux additionally requires a verified display binding. Guarded Herdr requires the positively advertised startup-FD extension; stock Herdr keeps ordinary display capabilities.
- Prevent Android and desktop terminal IME composition from replaying after Enter or a canceled input context, and apply owned trailing ASCII corrections as edits. Keep ordinary Unicode composition, hardware keys, paste and virtual modifiers; unsupported committed-text corrections are retained locally for explicit inline review/copy instead of guessed terminal erasure or replay. Pending Enter is not sent for an unapplied edit. Existing Compose drafts are preserved, oversized context cannot be copied, and review state is cleared when leaving the active unlocked session. Flush current preedit before toolbar modifier changes. Android terminals now request browser autocomplete off alongside their existing autocorrect-off policy; Compose hints are unchanged and no private keyboard mode is requested.
- Pipeline companion verification through a fixed window of SFTP reads, preserving ordered full-file hashes, partial reads, EOF and metadata checks, existing time limits and conservative deletion guards. Retain closed cleanup stage/reason observations when completion is not verified; residue remains distinct from installation success.
- Keep continuous terminal touch scrolling targeted at the pane where the drag began, including Herdr. Moving across pane or header boundaries no longer redirects wheel reports mid-gesture; reversals keep scrolling and a new drag can select another pane.
- Move Compose and terminal-key visibility into compact header icon controls, and use accessible icon actions beside the draft composer without overlap. On phones, long settings and forms now fill the screen with a persistent close header; short choices remain sheets and desktop dialogs keep their existing size. Authentication, trust and dismissal behavior are unchanged.
- Package original lazysh host-setup and agent-reporting skills with explicit preview, profile status, install/update and removal commands. Linux/macOS Claude and Codex profile writes require an exact inspected plan and preserve foreign skills, edits and agent configuration. No skills, hooks, services or provider settings change automatically; other platforms retain preview-only capability.
- Fall back to the built-in account-usage collectors when an optional external ai-usagebar returns no accounts, while preserving explicit provider disabling and cached error reports. Show a contextual companion install/update action for missing or outdated Unix companions instead of generic unavailability, and distinguish empty accounts in the compact usage button.
- Bind a remote approval to the exact Zellij or Herdr pane its hook runs in (#6). Until now only a tmux pane (`TMUX_PANE`) was recorded with a Claude permission request; a hook in a Zellij pane or a Herdr pane had none, and a Zellij or Herdr identity would have been refused. With the updated host companion the request carries `zellij:<session>:<pane>` or `herdr:<session>:<pane id>`, covered by the request hash and sent back unchanged with the decision, so a different pane or session, another multiplexer, or no pane cannot answer it; the pane is shown on the approval. A Herdr pane is named only when `herdr session list --json` shows exactly one running session for the pane's socket, and a hook that cannot be named exactly is listed without a pane that no pane id can answer. Needs the updated host companion for the new identities (an older one lists no pane for them). The Agent view dock still shows tmux panes only, so Zellij and Herdr requests are answered from the Agents board; Agents other than Claude Code, Codex and Copilot CLI, a fresh-screen re-capture and a run against real Zellij and Herdr hooks are not part of this change. No defaults change.
- Return momentary terminal keys to their resting appearance after touch release. Preserve intentional modifier locks, held-key feedback, mouse hover, keyboard focus outlines and custom theme colors; key dispatch and repeat behavior are unchanged.
- Shorten common attachment, transcript and preferences guidance while keeping safety limits visible. Show a compact capability notice for unavailable Apple status features; preserve sharing controls and privacy guidance after any sharing request.
- Retain bounded last-poll selector counts and timing when public Android APK workspace readiness fails. Reuse existing accessibility queries without changing actions, readiness checks or deadlines; no cold-start cause or Google runtime qualification is inferred.
- Permit an explicitly acknowledged repair source for unpublished 1.3.0 after its Windows companion acceptance failure. Rebuild every publication gate for that source; never replace a published tag or reuse the failed attempt's partial artifacts. Label the retained development changelog without implying every entry was added after version preparation.
- Preserve upload-specific SSH closure guidance, including partial-file warnings and Reconnect uploads. Distinguish closed host-tools connections so Agents only offers command recovery for that purpose.
- Keep Android terminal connections active while switching apps using a private foreground service and a generic ongoing notification. Backgrounded renderer output pauses without expiring the connection; the last native connection releases the service and wake lock. Held terminal keys stop while the app is hidden. Existing app-lock protections remain in place. Android system battery restrictions, Doze and force-stop can still interrupt connectivity.
- Distinguish Herdr snapshots without live agent metadata from a confirmed empty agent list. Agents shows an explicit capability warning while Sessions keeps legacy tree compatibility; upload-only SSH recovery continues to leave host command access unchanged.
- Keep live Herdr results, companion counts and empty states stable while Agents refreshes. Preserve a failed-read warning until its replacement completes, and remove failed live rows instead of presenting them as a successful empty discovery. Polling frequency, server selection and connection defaults are unchanged.
- Expand the default terminal key row with Alt, Shift and Attach; offer AltGr, navigation, function and symbol keys in preferences. Ctrl and Alt cycle between one-shot, locked and off, and held keys repeat. Preserve custom and empty layouts. Use branded icon buttons for Compose and terminal-key visibility, and reduce terminal side padding to safe-area-aware 2px.
- Select Use saved credentials by default after confirming availability in the native vault. Explicit Password/Private key choices and credentials entered while the availability check is pending keep manual authentication selected. Connect still requires an explicit action and stored secrets stay in the native vault.
- Update installation and release acceptance notes with the explicit in-app Unix companion path, current Android/Linux installer proof and published-APK qualification limits. Keep documentation links usable in the attached guide and release notes.
- Keep Mosh sessions alive when UDP readiness has drained instead of closing with “No packet received: Success”. Later authenticated traffic resumes on the same client; genuine socket/protocol errors, explicit shutdown, output bounds and connection defaults are unchanged.
- Read Android primary clipboard text and PNG/JPEG images through protected foreground native operations when Paste is explicitly requested. Terminal Paste reports busy and temporarily disables repeated requests while its existing owned read settles. Paste stays literal without Enter; images open in attachment preview and still require a separate Upload action. Existing access locks and payload limits remain in place. Platform metadata is checked before Paste so other-platform browser reads start within the click; failed checks offer a metadata-only retry.
- Keep mobile settings, attachment and tool-panel text inside consistent gutters, align wrapped form and transcript checkbox labels beside their controls, and separate workspace restore actions from their explanation. Expose per-host default multiplexer editing from Preferences, including Herdr. Connection and multiplexer defaults are unchanged.
- Preserve only bounded, fully framed Android published-APK driver stage entry/exit observations when the original qualification command fails. Progress remains separate from success, failure cause and owned cleanup; application defaults and public APK bytes are unchanged.
- Style native file-picker buttons with the active lazysh theme and 44px touch targets, including attachment file and camera selection. Native pickers and upload behavior are unchanged.
- Explain when an attachment upload loses its separate SSH file-transfer connection while a Mosh terminal remains open. Reconnect to the saved host from Connections and upload from the new connection; existing Mosh tabs, upload limits, exclusive file creation, and path checks are preserved. This does not automatically reauthenticate a disconnected side channel.
- Keep session toolbar icons and labels inside their buttons on narrow screens and with enlarged text. Scroll horizontally to reach additional views without widening the workspace.
- Remove unused desktop browser archive tooling from the Android source-build input before scanning, and admit an exact-source retry for the unpublished 1.0.0 release. All source/binary scans and tag protections remain required.
- Keep the Android workspace inside system bars and display cutouts, and resize the terminal and special-key row above docked software keyboards. Compose stays in the fixed controls so opening it does not scroll Esc/Tab out of view. The open composer scrolls within its available space and preserves a complete terminal row, including with larger terminal text. Showing and hiding the keyboard restores the available terminal space; terminal input and toolbar preferences are unchanged.
- The visible Agents board now refreshes reported activity every five seconds by default while the app is in the foreground. Hidden boards and background windows pause automatic reads; pending snapshots are not duplicated, and manual Refresh remains available. Transcript discovery and other host permissions are unchanged.
- Reject unsupported tmux client-loop formats before granting navigation or guarded Chat input, and require exactly one matching client for every action. Ordinary terminals remain available on older servers; tmux 3.2a advanced bindings are unavailable.
- Publish the current 0.23.0 version through an explicit source-bound initial release, then preserve every individually merged future Changesets version through the existing verified installer gates. Pending Changesets and application defaults are unchanged; release notes disclose native runtime gaps.
- Require actual Windows NSIS installation, same-version repair with preserved owned data, and uninstall acceptance before staging release bytes. Native Windows PR checks run the same acceptance; application defaults are unchanged.
- Clarify the project agent workflow so continuation requests proceed from recovered history into implementation and keep working across the requested roadmap scope without requiring Codex `/goal`. Application defaults are unchanged.
- Attach files and open previews from a local desktop session on Linux, Windows and macOS (#1134, part of #1129). **Attach** (the workspace tool, the terminal's Attach key and the composer's Attach action) saves the file on this device and pastes or stages its local path: by default a private, uniquely named `lazysh-<random>-<name>` file in `/tmp` (owner-only, `0600`) or the per-user `%TEMP%` folder on Windows, with the same 10 MiB limit, and never over an existing file or link. There is no host clipboard to copy to in a local session, so that action is hidden and **Copy host path** uses this device's clipboard. **Preview** discovers local listeners with `ss` (or `lsof`) on Linux and macOS and `netstat -ano` on Windows, and opens a development server through a fresh `127.0.0.1` port without ever rebinding the server's own; closing the session stops the proxy. Devices and workspace restore for local sessions follow separately. SSH sessions are unchanged. No defaults change.
- Remove reference-vendor names and URLs from the current source and documentation. Theme import now accepts only `lazysh-theme:` share codes and raw JSON; third-party-prefixed share codes must be converted to JSON before import. Stored themes and existing defaults are unchanged.
- Track the delivery roadmap in GitHub Projects using existing issues and their current statuses; the public delivery epic remains available to readers without project access.
- Prepare Android, Linux and Windows release artifacts without requiring Apple packages. Apple releases remain deferred; publication remains gated on verified build and distribution prerequisites.
- Reorganize the README around mobile SSH, persistent sessions, and optional AI-agent workflows, with a source-preview quickstart, clearer release caveats, and contributor calls to action. Documentation only; application behavior and defaults are unchanged.
- Prepare a verified cross-platform release installation pipeline with checksums, changelog and install/update guides. Publication and stable tags remain disabled pending signing credentials and reviewed F-Droid/free-push prerequisites; debug APKs and simulator apps are not advertised as production installers. Existing application defaults are unchanged.
- Render repository side-by-side diff source and hunk headers with the selected terminal font, including already-loaded imported and CJK fallback families. Changing the font preserves the current review and does not refetch repository data; font size and connection behavior are unchanged.
- Remove the twelve-entry cap on custom keyboard chords and text snippets. Existing valid collections now survive normalization and reload without silent truncation; failed snippet saves retain the draft. Per-entry validation, device storage capacity and the existing settings-sync size limit remain unchanged.
- Use the Bed Mode SVG mark in the existing app sidebar, keeping the visible lazysh name and accessible text singular. Connection behavior and responsive drawer controls are unchanged.
- Replace the default lazysh app, browser, Android and iOS launcher artwork with the original Bed Mode sloth-and-mobile-terminal mark, and add transparent SVG brand variants. The default visual identity changes; app features, connection security and the existing Amber alternate icon are unchanged.
- Update the manual F-Droid source recipe for the UnifiedPush registration foundation. Automatic publishing remains disabled; this does not establish distributor delivery or complete free-software remote push.
- Prepare a disabled stable-tag gate for verified main version transitions, requiring current-candidate F-Droid source/binary checks before create-only tags. Automatic tags, signing and publication remain disabled pending free-software push and official submission prerequisites; product defaults are unchanged.
- Compose completed review dictation with the latest editable draft instead of replacing typed text or prior clips. Empty results preserve the draft; overflow keeps it intact without truncation. Review remains default, while direct delivery still queues only the newly recorded clip and history remains per clip.
- Preserve Pi Records' explicit tool-error booleans and label recorded failures while retaining original output and tool IDs. Other adapters, defaults and live terminal behavior are unchanged.
- Keep retained native access-status and unlock errors in the current interface language without repeating authentication checks, ready acknowledgements or protected workspace mounts. Access policy and defaults are unchanged.
- Defer iOS status review-channel startup registration until all native plugins finish initialization, removing a startup ordering hazard observed in a retained second-launch crash. Readiness deadlines and native privacy/authentication behavior are unchanged.
- Extend explicitly chosen and confirmed tmux terminal input to all 17 native Chat readers. Hermes/OpenCode database session selectors are part of immutable authority, and changing a selector requires a new confirmation. Stage remains default; terminal acknowledgement does not establish agent identity, provider receipt or that a process stopped.
- Extend explicitly confirmed Chat terminal input to bounded multiline text and tabs, preserving exact accepted UTF-8 bytes through native tmux paste and one final Enter. Stage remains default. Paste brackets depend on the terminal program; server-global paste buffers may remain after interrupted delivery, and uncertain input is never automatically resent.
- Keep release generation compatible with strict source duplication checks by identifying only the 15 exact Changesets-generated package changelog paths as generated artifacts. Handwritten root history, documentation, source and tests retain the unchanged zero-clone gate.
- Keep retained transcript validation and read alerts in the current interface language without repeating reads. Raw host diagnostics, parser rules, transcript contents, Follow and image behavior remain unchanged.
- Resolve Tauri's native application version from the synchronized client manifest, fixing Android and Apple mobile generators falling back to unrelated version defaults. Application identifiers, stored data, protocols and permissions are unchanged.
- Keep retained transcript-discovery validation alerts in the current interface language without repeating discovery. Raw host diagnostics, transcript validation and request ownership are unchanged.
- Keep retained recorded-usage validation, transcript discovery and continuity errors in the current interface language without repeating requests. Raw host diagnostics, parser rules, metrics and defaults are unchanged.
- Prepare automatic version and package-changelog pull requests with Changesets, keeping private Bun, Cargo and Tauri product versions together. About labels read the client build version. Existing root changelog history is retained. Publishing, tags and application-store release defaults remain disabled; GitHub PR creation and default-token CI approval require explicit repository setup.
- Extend explicit recorded PNG/JPEG previews to Codex user data-URL images in Records. Selecting Codex from a conversation view establishes Records and requires fresh image opt-in; file references and other media stay inert. Defaults, legacy output, paging and transcript bytes are unchanged.
- Keep keyboard focus in the terminal after Paste draft, so the next keyboard Enter reaches the shell. Opening Compose and staging new drafts still focus the editor; paste and command bytes are unchanged.
- Extend explicit recorded PNG/JPEG previews to Claude user images in Records and current branch. Retire selections when their row/image leaves the retained branch, so returning history needs a fresh View action. Image inclusion stays off by default; disk bytes, legacy output and live terminal controls are unchanged.
- Reject replaced transcript and Codex usage sources on Windows using retained file handles and volume/file identity, including same-content, same-size and same-timestamp replacements. Shared snapshot readers fail closed when identity is unavailable; Unix inode checks and append-only Follow behavior are preserved.
- Keep retained app-icon validation and local failure messages in the current interface language without repeating native icon reads or changes. Native diagnostics, device-local settings, defaults and permissions are unchanged.
- Scope failure-only iOS Mosh process inventory to the owned process group and label positively observed launcher/native images. Startup deadlines, sampling limits, failure gates and defaults are unchanged; this does not establish the intermittent stall's cause.
- Keep an already-visible App Lock authentication failure in the current interface language without repeating native configuration or changing opt-in, access authority or defaults.
- Keep retained theme validation, import/share, clipboard and linked-theme result messages in the current interface language without reapplying themes or repeating clipboard/acknowledgement actions. Theme data, export bytes, validation limits and defaults are unchanged.
- Reject observed truncated, replaced or mixed Claude conversation captures while preserving ordinary append-only growth during Follow. Parse an admitted bounded prefix without retries; defaults, polling, raw Records and Grok behavior are unchanged.
- Keep retained shortcut-parser validation errors in the current interface language while preserving literal key/step data, drafts and exact input bytes. Accepted grammar, stored bindings, defaults and native behavior are unchanged.
- Keep a non-interactive outline on a selected preview element until its selection is discarded.
- Keep retained local font errors and fallback warnings in the current interface language without reloading fonts or repeating storage operations. Font data, stored names, raw device diagnostics and defaults are unchanged.
- Localize Keep Awake controls and multiplexer prefix shortcuts in English, Brazilian Portuguese and Spanish while preserving native ownership, opt-in state, retained errors and exact input bytes. Keep the board checkbox within narrow layouts; defaults and permissions are unchanged.
- Localize terminal controls, clipboard consent, link confirmation, search/composer status and terminal-owned local errors in English, Brazilian Portuguese and Spanish. Language changes preserve live terminal handlers, raw content, drafts, explicit consent and input bytes; locale defaults and permissions are unchanged.
- Reject observed file changes during Grok recorded-conversation reads, including concurrent appends, instead of publishing a partial, detached or mixed history. Stable incomplete tails, portable manual reads and existing limits/defaults remain unchanged.
- Keep About source revisions and expanded legal notices within mobile dialog bounds, including clean builds. Long tokens wrap and preserved notice indentation scrolls within keyboard-focusable legal blocks; legal bytes and source links remain unchanged.
- Keep dialog keyboard focus on visible, enabled controls, including expanded/collapsed notice summaries and ordinary links; preserve initial field focus, Escape and opener restoration.
- Disable Turbo caching for client production builds so About/source metadata always embeds the current Git revision and dirty state. Other packages keep their existing cache behavior; source URL and metadata rules are unchanged.
- Localize encrypted Sync interface and client-created validation/status messages in English, Brazilian Portuguese and Spanish, with locale-aware import counts. Recovery data, native diagnostics, scopes, explicit action gates and language-import intent remain unchanged; sync and locale defaults do not change.
- Localize Apple status controls, accessibility labels and privacy/review explanations in English, Brazilian Portuguese and Spanish. Language changes preserve subscription ownership, publication timing, raw native diagnostics and snapshot freshness.
- Localize About interface labels and explanatory text in English, Brazilian Portuguese and Spanish. Imported legal notices, component names, source links and build metadata remain unchanged; locale defaults are unchanged.
- Localize tmux workspace, Herdr and Zellij controls and accessible names in English, Brazilian Portuguese and Spanish; preserve literal remote identities, errors and launch-picker ownership when changing language.
- Shorten the Usage view and fix its recorded token usage panel being squeezed to zero width on a phone. The AI account usage page and the recorded token usage panel sat side by side in one row, and the account panel took the whole width, so the panel that reads token counters from a transcript (the agent choice, **Find usage transcripts**, the transcript path and **Inspect usage**) was off screen and unreachable at 393 px. The two panels now stack in one scrolling column. Their explanatory paragraphs (how the status bar follows the agent, which account collector supplied the data, and what a recorded report can and cannot show) moved behind one closed **About account usage** and one closed **About recorded usage** line each, in English, Brazilian Portuguese and Spanish; the caveats that qualify displayed numbers (unknown live limits, stale reports, the context and provider-window notes) stay visible beside those numbers. No defaults change.
- Return the canonical SFTP destination after host-local uploads instead of echoing a relative input path. Attachments now copy/stage that returned path; Files refreshes its resolved parent. The internal `upload_file` result changes from void to `{path}`. Existing files remain protected by exclusive creation; cancellation never deletes remote paths.
- Report a Kimi Code 2.4 approval request on the Agent board, with a printed opt-in hook fragment (#1635, part of #696). `lazysh-agent kimi-config --dialect kimi-code-2.4` prints `[[hooks]]` entries for `PermissionRequest`, `PermissionResult` and `SessionEnd` (the default `legacy-1.52` output is unchanged byte for byte), and `lazysh-agent ingest --agent kimi-code` shows a root agent's request as "Kimi Code: Approval requested", needing attention. Only the root's approval events count: Kimi's turn, tool and `Stop` events name no agent, so nothing reports working or done, and a sub-agent's approval is ignored. A result removes the report once no request is open, one that arrives before its request leaves a one-hour tombstone, and `SessionEnd` removes the rest. Esc and Ctrl+C at the prompt answer the request, so they remove it; it was run against the official 2.4.1 release in a sandbox with a synthetic endpoint. Needs the updated host companion and a hand-pasted fragment; managed install of Kimi's `config.toml` is still planned (#1636). No defaults change.
  `herdr`. After explicit normal authentication, lazysh opens that fixed picker
  on the new SSH control session; choosing an exact row attaches through the
  existing native child PTY. Mux launches explicitly use SSH without changing
  saved host transport preferences. Warm CLI delivery remains unsupported.
- Companion event storage uses WAL with explicit FULL synchronization, reducing
  rollback-journal sync work while preserving event acknowledgements and the
  three-second ingest wait budget. Existing databases migrate on successful open.
  Bootstrap has one shared three-second native/SQLite wait deadline. Unix state
  ancestors and sidecars now fail closed when unsafe; unsupported/network/FUSE
  storage, parent-traversal paths and custom symlink/reparse routes are rejected
  before mutation. Verified Darwin system aliases remain supported.
  Slow-storage exhaustion remains possible and issue #36 is not declared fixed.
- Paper and explicitly light imported terminal themes now darken bright indexed
- Measure the native terminal core against xterm.js on the exact bytes of the recorded terminal baseline (#1303, part of #1302): `bun bench/dumpWorkloads.ts` writes the baseline's streamed workloads W2, W3 and W4 at its desktop and phone geometries, and `harnessParse.mjs` and the core's `harness_parse` example parse them with xterm.js 5.5.0 headless and with the core, both checking the final screen against the baseline's. On one Linux desktop host the core parsed them 1.6 to 7.7 times faster than `write()`, ANSI-heavy output being the slowest in both; the recorded end-to-end drain of the same workloads in Chromium was far slower than either parser, which puts the time in the renderer and the bridge, not the parse stage. No renderer, bridge or device was involved. Measurement only: xterm.js stays the only terminal engine and the default, and no setting or default changes.
  cube colors and reverse the indexed grayscale ramp using the pinned reference client
  desktop 0.5.28 palette math. This changes their default 256-color rendering;
  base ANSI colors, literal RGB, dark themes and legacy palettes without mode
  metadata keep their behavior. Browser rendering is verified; physical mobile
  WebView and current reference client mobile pixel parity remain unverified.

### Fixed

- Fix a Windows crash in `lazysh-agent update`, `update --dry-run` and `update --rollback`: the update ran its download, verification and replace on the 1 MiB default main-thread stack and the debug build used by the Windows update test (`cargo test --features update-test-endpoint --test update_stub`) overflowed it (exit 0xC00000FD), which failed the 1.63.0 release build. The Windows companion now links with an 8 MiB main-thread stack. Linux and macOS are unchanged; no defaults change. The Windows update test is the regression check; a Windows host outside CI was not exercised.
- Fix a Claude Code conversation that ran a dynamic workflow failing to open in the Agent view with "Invalid recorded background work." when the workflow's summary file was not on disk: the host companion sent the workflow's name as `null` and the app refused the whole page. The app now takes it as no name and shows the workflow under its launch title, and the updated companion leaves the name out. No defaults change.
- Fix a Codex conversation that was compacted failing to open in the Agent view with "Invalid transcript message". The conversation page the host companion sends for a Codex `compacted` record carries a compaction line the app did not accept, so any compacted session (about one in three recorded sessions) was refused; it now shows **Conversation compacted** as one muted line. The app also accepts the same line from OpenCode conversations, for the companion that will send it. No defaults change.
- Fix tapping a host file path in the terminal doing nothing on a touch screen (#1534). A path such as `~/notes/todo.txt` that the host confirms exists opened its file sheet with a mouse click but never with a finger: a tap makes the terminal receive its mouse events and lose the pointer within milliseconds, before the host had answered. A tap now reads the path under the finger, asks the host and opens the sheet itself. Links to web addresses were not affected.
- Fix the toolbar **paste** key doing nothing on the Linux desktop app (#984). WebKitGTK refused the page's clipboard read, so tapping it showed "Clipboard access was unavailable"; the app now builds its window with clipboard access on Linux and **paste** sends the system clipboard text to the terminal (no Enter). Android, macOS and Windows are unchanged.
- Fix Back leaving the app, and the phone gestures losing the system gesture zones, after Android recreates the app's window (for example when the navigation style is switched between three buttons and gesture navigation). Back now closes the open page, menu or Preferences first, as before the change, and the swipe bands and handles are placed from the zones of the window in front instead of treating the navigation as unknown. The launcher icon, soft keyboard, private keyboard, file open and share, and background session controls also act on the window in front instead of refusing (for example "Open lazysh before changing the launcher icon"). No defaults change.
- Fix the Agent view hiding the agent's reply behind your prompt (#1456). While the agent was working, the prompt of the running turn was pinned to the top of the conversation (up to a quarter of the screen high) and drawn over the reply that scrolled beneath it, so on a phone the left part of the answer, its bullets and its commands line were unreadable. Every message is now in normal flow, so nothing is drawn over another message at any width. Text you pasted into a Claude Code prompt (the `<pasted_content id="…">` wrapper, whatever its id) no longer shows its raw tags: it is a compact **Pasted text** block with the first lines, **Show all** / **Show less** and **Copy pasted text**, and the words you typed around it stay as they were. Changed default: the prompt of a running turn is no longer pinned at the top while the reply is written.
- Fix the Agent view claiming **Start of the session** at the top of a long conversation that grew live: when new messages push the oldest ones out of its 400-message window, **Load earlier messages** stays available. Loading an older page keeps the line you are reading where it is while live updates arrive (#1235). No defaults change.
- Fix the phone gestures colliding with Android's own navigation gestures, which swallowed them or sent the phone Back, Home or Recents (reported on Samsung One UI: the bottom-to-top gesture worked once). On Android gesture navigation each gesture now starts from a small visible **handle** instead of the screen edge: the left handle (side menu), the right handle (switch to the Agent view) and the bottom handle (bottom menu) sit just inside the zones the system keeps for Back and Home, and tapping a handle works too. Android's own Back and Home gestures are always detected from the screen edge, so the app's swipes no longer compete for it: on gesture navigation a swipe also starts anywhere in a band that begins just beyond the system's zone (the zone plus 4 dp, `[inset + 4 dp, inset + width]`, so about 36 to 76 dp from the edge with Android's default Back sensitivity and 44 to 84 dp with the widest), at the left and right over the height of the screen above the toolbar and at the bottom above the Home strip; a touch inside the system zone or at the edge is left to the system, a touch beyond the band is left to the terminal, and the swipe still has to travel inward and never starts while you type, select text or scroll. On three-button navigation the band starts at the edge. The zones are read live from the system (`systemGestures()` and `mandatorySystemGestures()`) and follow rotation, the keyboard and navigation settings, so nothing is a fixed width any more. **Changed defaults:** with Android gesture navigation the gestures are handles and bands rather than edge swipes; the **Edge zone width** setting (now the width of that band) defaults to 40 dp instead of 24 dp and goes up to 96 dp instead of 48; with three-button navigation, and everywhere else, edge swipes stay as they were, now with handles drawn too. **Preferences → Keyboard and gestures → Terminal touch gestures** has a new **Gesture style** (Automatic, Handles, Edge swipes (advanced), Off); edge swipes on gesture navigation ask the system to give up Back only on a row of at most 200 dp where the side handles sit, and never over the bottom Home zone. A new **Test gestures** page in the same section draws the live system zones and says whether the system took each of your swipes. Two-finger swipes can now be bound to **Open the bottom menu** and **Switch between the terminal and the Agent view**, with the same typing and selection guard (#1380). Checked on an Android 13 emulator with three-button and gesture navigation (every gesture ten times, in `docs/android-testing.md`), which also fixed three faults found there: a swipe from the left edge on three-button navigation opened the side menu only 4 times in 10 because the swipe was recognised too late; the bottom handle was drawn inside the strip where the launcher starts Home, so dragging it went Home; and the system Back gesture left the app instead of closing an open bottom menu, because tapping the menu's backdrop closed it on touch-down, before Back arrived. The manual Samsung One UI check is in `docs/android-testing.md`; it has not been run on a phone yet.
- Fix the Agent view composer never sending on a stock Herdr host (0.9.3 to 0.9.5), where it showed "Guarded input is unavailable" and "Terminal input is not confirmed" under a Reconnect button. Without the optional guarded Herdr, Send now goes through Herdr's own `agent prompt` command, addressed to the exact pane of the followed Claude Code or Codex session: Herdr wraps the text in bracketed paste (multi-line messages arrive intact), presses Enter, and refuses an agent that is waiting for an answer. Before each send lazysh re-checks that the pane still shows that agent session, and Stop sends Escape the same way. The conversation confirms the message as before; a failure that may have written bytes is never resent. A failed send now shows one compact notice above the composer (what happened in plain language, one main action such as Retry, Stage in terminal or Open terminal, technical details behind **Details**, dismissible, announced to screen readers) and keeps your draft, instead of two long paragraphs. Guarded input is still used where the guarded Herdr exists. No companion update is needed. No default changes.
- Fix a `lazysh://theme?data=...` link that opened from Windows or a browser doing nothing (#1896, part of #995). Windows adds a slash after the host when it hands a link to the installed app (`lazysh://theme/?data=...`), and the app rejected that spelling, so "Review linked theme" never appeared; the link is now offered for review whichever way it arrives. Anything else in the link is still rejected (another host, a port, a path, a fragment, repeated or extra parameters, escapes, padding, an oversized payload), and the theme still changes only after you apply it. No defaults change.
- Fix terminal URLs that wrap over several rows. A tapped URL is now the whole address: rows the terminal wrapped itself are joined, and so are URLs a program or multiplexer broke at the last column or at the border of a box (Claude Code and Herdr panes, list indentation, padding), under conservative rules that never join two URLs, a bullet or a following sentence. Trailing punctuation and a closing bracket the URL never opened are no longer part of the link, while parentheses inside it (such as Wikipedia pages) stay. Hyperlinks an application prints with OSC 8 now use the same confirmation as detected URLs, with **Open in browser** and **Copy URL**, instead of a browser prompt, and win over a URL guessed from the same text. Changed default: terminal URL detection now comes from lazysh itself instead of the xterm web-links add-on, so addresses with parentheses are no longer cut at the first one. No settings change.
- Fix the Files view not resolving paths that start with `~`. Typing `~`, `~/dev/project`, `$HOME/x` or `${HOME}/x` in the directory field now opens that folder of the SSH user's home and shows the resolved absolute path; the home is the one the host's SFTP server reports for the account (a local desktop session uses this device's home), looked up once per connection, and the upload destination field expands it the same way. Paths with spaces and non-ASCII names work, `~otheruser` is refused with a message that asks for an absolute path, and a missing folder shows the host's own error. The new `host_home` command is the one place home is resolved, so terminal file-path actions reuse it. No defaults change.
- Fix the Herdr switch button disappearing while you scroll or with the keyboard open. That button is drawn by Herdr's own phone layout inside the terminal, so scrolling the terminal's history moved it out of view with the screen it belongs to, and a keyboard that resized the screen could leave it behind. A terminal where Herdr runs now also shows a switch button in the session header, next to Compose and the toolbar toggle, which no terminal scrolling can move and which stays above the keyboard and the toolbar without covering any terminal row. It appears for sessions attached to Herdr through lazysh and for any terminal whose screen shows Herdr's phone layout, such as `herdr` started by hand in an SSH or Mosh shell, and goes when Herdr leaves the screen. It opens the same Spaces list as the Workspaces toolbar key; the button inside the terminal is unchanged. No defaults change.
- Fix moving between Herdr terminals opening the Android soft keyboard and shrinking the terminal. On a touch screen no navigation focuses a terminal's input any more: switching Herdr workspace, tab or pane, choosing another session from the session switcher or the Workspaces drawer, swiping or pulling to another session, returning from another view, restoring a workspace and reconnecting a lost session leave the keyboard as it was, so the terminal keeps its size and Mosh sends no resize. Tapping Herdr's own `switch` button or its switcher inside the terminal reaches Herdr as a click without opening the keyboard either. Tapping elsewhere in the terminal or the keyboard key still opens it, and a keyboard that is already open passes to the terminal you move to without closing in between; on wide layouts, pressing a Herdr Spaces row no longer takes focus from the terminal, so it stays open there too. Changed default: on touch screens only a terminal you just connected to or attached from the Sessions panel is focused when it opens; every other activation of a terminal, which used to open the keyboard, now leaves it closed. With a mouse and physical keyboard a switched-to terminal still takes keyboard focus.
- Fix the Agent view spending the top of the screen on chrome and showing harness records as raw markup. The header, the **Back to sessions** and **Enter session** buttons, and the notices that a conversation is not verified as belonging to this terminal are now one compact row: the agent and its folder, its state, an options button and a **Terminal** shortcut. Back, Enter, the same input caveat (a shown conversation still grants no terminal input beyond the confirmed-input flow) and the token counters of the latest response moved behind the options button. On a 1080x2340 phone at 2.6 density a selected Herdr conversation now starts 85 css px (221 px) from the top of the screen instead of 253 css px (658 px), and the message list is 770 css px high instead of 463. The token counters are no longer printed under every answer, and a harness-injected user record such as a background-task `<task-notification>`, command or shell output, an interruption or a context compaction is one muted event line instead of a user bubble with its tags; slash commands read as typed, system reminders and redacted empty thinking are hidden. A conversation that cannot send input, such as one picked by hand under Herdr, no longer shows an input box. The composer is one line that grows with its text, with the Stage in terminal button beside it and Refresh hidden while the conversation is followed. No defaults change.
- Fix the Agent view on a Herdr session showing a long list of last-reported session IDs whose rows did nothing useful. Under Herdr the view now lists only the live agents of the attached server, each with its agent kind, status, project folder and the workspace and tab names, and no longer lists hook reports, which have no pane identity there. Selecting a live row opens that agent's conversation as native chat messages and tool activity inside the view, with **Enter session** and **Back to sessions** above it; the association with the pane stays labelled unverified and a selected conversation still cannot stage or send input. A row for which Herdr reports no single Claude Code or Codex conversation says so and still offers **Enter session**. When the host companion predates conversation reading (it needs the release that added `lazysh-agent herdr-conversation`), the view now says to update it and offers **Host companion installation**, instead of showing the host's raw usage error. Outside Herdr, a failed attempt to open a last-reported session is shown above the list instead of below it, and the list shows how long ago each session reported instead of its ID. No defaults change.
- Fix finger scrolling in Herdr sessions whose host cannot serve guarded history, which showed the error **Unavailable** on every swipe and scrolled nothing since 1.29.1. This covers stock Herdr 0.9.3 to 0.9.5 without the optional guarded build, and an older guarded server that is still running. The first swipe of such a session still scrolls nothing; after that swipes take the wheel path used before 1.29.1, with no error. On those hosts a swipe over an open agent question can still move its selected option, which only a current guarded host prevents. Guarded hosts that answer are unchanged, and a failed or busy guarded request still reports **Unavailable**. No defaults change.
- Fix typing stopping in the terminal with the SwiftKey keyboard until Backspace was pressed (#1505). When a keyboard erased a word it held as pending text (SwiftKey does this to rewrite or remove a word, and before a dot), Android's WebView dropped that pending composition without telling the page. The terminal waited for an end that never came and held back every key after it, the dot included, until a Backspace key press released the held text and erased part of it. The terminal now recognises that the next key or insertion is outside any composition and sends what the keyboard typed, once and in order. Gboard and the AOSP keyboard behave as before and no default changes. Confirmed on an Android 13 WebView with a scripted keyboard replaying the calls and in 1000 fuzzed keyboard sessions; the real-phone check with SwiftKey is still the owner's.
- Fix downloading the local Parakeet speech model on Linux. On 2026-11-07 the publisher replaced the model archive lazysh pinned with a new conversion of the same Parakeet TDT 0.6B v3 INT8 model, so every download failed its integrity check and nothing was installed. lazysh now pins the new archive (487,211,443 bytes) and checks the size and SHA-256 of all four extracted model files, including the vocabulary. If a download does not match the pinned archive, for example because the publisher replaced it again, lazysh says so and installs nothing, and an HTTP error now shows its status code instead of a generic verification failure. A Parakeet model installed by an earlier version is the old conversion: lazysh reports it is not the pinned archive, so choose **Remove** and then **Download** to install the new one. The download is 41,388 bytes larger and the peak disk space is now 1,644,999,670 bytes. No defaults change.
- Fix browser preview discovery marking HTTP servers as not HTTP, and forwarded pages missing some of their files, when many connections start at once. An SSH session confirms at most four channel openings at a time, but discovery probes up to sixteen listeners together and a page can request many files at once, so the extra connections failed straight away: discovery showed those listeners as plain ports and the browser saw failed requests. Each preview connection and discovery probe now waits for a free opening within its own deadline (1.5 seconds for a probe, 15 seconds for a page connection). No defaults change.
- Fix Chat's **View** choice snapping back to **Recorded messages** in the Linux desktop app. Choosing Codex as the Agent switches View to Recorded messages; picking **Latest conversation branch** again, when it was the last View you had picked, showed it for a moment and then went back to Recorded messages, so the transcript opened in the wrong view. WebKit, the engine of the Linux, macOS and iOS apps, sent no change for that pick. Each Agent now gets a fresh View list. Android and Windows were not affected. No defaults change.
- Fix wheel and trackpad scrolls being ignored while a terminal streams output, for example a working agent. A scroll that arrived in the same frame as new output was dropped: the scroll position moved up, but the terminal kept showing the live screen, so scrolling looked like it did nothing. The terminal now moves to the history the scroll reached and keeps the reader there as more output arrives. Finger scrolling already took a different path and is unchanged. No defaults change.
- Fix tmux control clients and tmux servers left running on the remote host after lazysh disconnects. On tmux older than 3.8, closing an SSH or Mosh session while tmux still had output queued for lazysh's navigation control client (`tmux -C attach-session`) left that client stuck forever, so the tmux server could not exit either (tmux/tmux#5444). lazysh now ends control mode with an empty line, waits up to 500 ms for tmux's `%exit`, and only then closes the channel; renderer replacement waits for that before it disconnects the transport. No defaults change.
- Fix Backspace and word corrections being dropped on the phone keyboard (found while investigating SwiftKey typing reports on a Mosh session) after a toolbar key, a mouse report or a scroll in a mouse-tracking program such as Herdr. The terminal keeps a short record of what the keyboard typed so that its replacements and deletions can be sent as terminal edits; any other input to the session (Esc, an arrow, Tab, a tap or a paste) ended that record, so the next Backspace on text typed before it was skipped: nothing reached the program, a "Keyboard edit skipped" notice appeared, and the keyboard then retyped the word, which could repeat it. Backspace over typed ASCII text now always sends the matching Delete bytes, typing continues from the shortened text, and reopening the word before the caret to extend it works again. Wheel scrolling in a mouse-tracking program no longer ends the record. A correction that replaces earlier text after a key, a tap or a cursor move is still held for review rather than guessed, and Unicode text is unchanged. The Android emulator keyboard test now also types SwiftKey-shaped sequences (predictive word, gesture word, Backspace in a composing word, autocorrect by erase and commit, Backspace after Esc, and a word of letter commits rewritten through a composing region) and checks the exact bytes the terminal receives. No defaults change.
- Fix intermittent companion release and CI failures where sixteen-writer storage contention cases returned `StorageError` with SQLite code 5 (`ingest_begin`) on Windows. The cases ran at the same time as other companion runs in one test process, and their durable flushes slowed each other until a burst of sixteen serialized commits no longer fit the three-second wait budget. Each burst now runs alone, and a new Linux check replays the whole CLI suite beside a simulated slow shared volume. Companion storage, FULL durability and the 3-second wait budget are unchanged. No defaults change.
- Fix the phone Preferences page sliding up after adding a toolbar key from Available keys, which pushed its title and Close button off the top of the screen where they could not be scrolled back. Hidden screen-reader labels in the page now stay inside its scrolling body, so moving focus to the next available key scrolls only the settings list. No defaults change.
- Fix the Android soft keyboard opening after a Herdr switch. Tapping a workspace, tab or pane in Herdr Spaces or Agents now switches without focusing the terminal input, including a switch that opens another Herdr display and on wide layouts such as a phone in landscape or a tablet, so the keyboard no longer covers the Herdr screen. Tapping the terminal or the keyboard toolbar key still opens the keyboard, and with a mouse and physical keyboard a switch to another display still gives its terminal keyboard focus. Changed default: on touch screens a Herdr switch no longer opens the soft keyboard.
- Fix Auto transport on ordinary sessions refusing to connect with "Mosh connection ended before startup completed" instead of continuing its fallback sequence (#1916, follow-up of #1737). When the Mosh worker failed during startup, the classified error it reported (`mosh_bootstrap`, `mosh_udp_unreachable`, `mosh_closed`) could be lost to the session cancel that follows the failure, so the connect failed with `cancelled`, which Auto does not fall back on. For ordinary sessions the startup error is now reported first, so Auto tries the remaining eligible transports and can return to SSH, and a Mosh or Eternal Terminal connect you pick yourself shows the real reason instead of a cancellation. Once a Mosh multiplexer entry has been started, a failed startup retains its explicit non-fallback error; the original failure was intermittent. Checked by Rust tests that fail a native worker at startup, with the cancel seen before and while the connect waits, and not yet by a repeated run on a real Android emulator. No defaults change.
- Fix toolbar keys leaving the terminal scrolled into history. Toolbar keys, chord buttons, custom gesture and D-pad corner chords, the D-pad and modified keyboard shortcuts now return the terminal to the live screen after sending, as keyboard typing already did. A reader left looking at an earlier copy of an agent menu, for example after the agent redrew it, now sees the agent's answer after toolbar Enter instead of an unchanged menu. The bytes sent are unchanged. No defaults change.
- Fix Android biometric-protected credentials failing to save or unlock after a successful fingerprint: the Keystore operation received its associated data before authentication and refused the request. Enabling the biometric resume lock no longer stalls on its second fingerprint prompt, a late prompt result can no longer be applied to a different credential operation, and a prompt that cannot start because the previous one is still closing now fails with a retryable error instead of showing a prompt whose result is lost. No defaults change.
- Fix companion hook events failing on Windows with `StorageError: operation failed (sqlite_code=5)` when many agent hooks open the companion store at once, including the first run that creates it. Opening a store that is already set up no longer waits behind other openers or their durable commits; only creating or upgrading the store is exclusive. WAL mode, full commit durability, private sidecar checks and the 3-second wait budget are unchanged. No defaults change.
- Fix Windows release packaging validation of workspace path separators without changing application defaults.
- Fix the host companion rejecting a real Android device that `adb` 1.0.41 and an Android 13 guest describe in their own way (#1857, found while checking #1669 on Waydroid). `lazysh-agent devices android --id=ID probe` read the feature list as comma-separated only, so the **Verify Android video tools** step failed with `AndroidShellV2Unavailable` although `shell_v2` was listed one feature per line; it now reads either form, and still refuses a list without `shell_v2`. `lazysh-agent devices screenshot` failed with `InvalidDeviceImage` when the guest printed a warning line before the PNG (the Waydroid guest names a missing GPU-library file); it now starts the image at its PNG signature when that is within the first 1 KiB, and any other prefix is still an invalid image. The decoded video range is converted to full range before the JPEG encoder (`-vf fps=8,format=yuvj420p`), because ffmpeg 9's MJPEG encoder refused the limited-range video this guest's AVC encoder tags (`Non full-range YUV is non-standard`), which ended the stream before its first frame. Checked on that Waydroid guest through a real local session: a screenshot, the probe and three streamed frames while the screen changed; a screen that does not change still delivers no first frame within ten seconds, as before. No defaults change.
- Changed companion SQLite close behavior: successful Store connections retain
  private WAL/SHM files after clean exit instead of checkpointing/deleting them
  for each short-lived hook. FULL commit synchronization and normal automatic
  checkpoints remain enabled. A database-only copy can now miss acknowledged
  events even after CLI exit; use a consistent SQLite backup or verified checkpoint.
- Companion initialization checks temporary SQLite journal/WAL/SHM paths while
  holding its existing bootstrap lock, avoiding inspections racing another
  initializer's journal removal. Ownership, permissions, no-follow checks and
  the shared three-second bootstrap budget are unchanged.
- The dictation-history opt-in checkbox uses bounded sizing and a wrapping label
  instead of inheriting full-width text-input sizing, keeping history controls
  within the panel at desktop and phone widths.
- Visible file-size and repository validation errors now follow interface language
  changes, including history errors with local causes. Host diagnostics remain
  verbatim, and changing language does not refetch files or change selections.
- Keep Android `lazysh://` link routing in the canonical manifest so cached
  incremental APK builds retain cold and warm theme-link delivery.
- Cancelled exec, SFTP, preview/probe, bastion, Mosh/ET bootstrap and device-stream
  channel openings retain ownership until peer confirmation and close late results
  without tearing down the parent SSH connection. They now share the existing
  four-pending-open limit per verified transport; a peer that never confirms can
  occupy those slots until it responds or the last local transport owner closes.
- Concurrent companion initialization rechecks a removed SQLite journal, WAL or
- Let the host companion focus a Herdr pane on a Windows host (#1663, part of #1131). `lazysh-agent herdr-focus-pane` used to fail with `HerdrFocusPlatformUnsupported` on Windows; it now sends the same single `pane.focus` request over the named pipe Herdr 0.8.2 or newer listens on there (`\\.\pipe\<session socket path>`, the path `herdr session list --json` reports for the running session). The companion refuses a reported path that is not a drive path or a `\\.\pipe\` name, or that has an empty, `.` or `..` component, and keeps the same 3 second budget, size limit and error classes (`HerdrFocusMissing`, `HerdrFocusInvalid`, `HerdrFocusCancelled`) as on Linux and macOS. Unix hosts are unchanged. The Windows path is exercised against an owned named pipe in the `native-desktop` Windows job, not yet against a real Windows Herdr; the app does not call it for local Windows sessions yet. No defaults change.
  shared-memory entry instead of rejecting its stale zero-link metadata. Rechecks
  are bounded, replacements must pass the original file protections, and bootstrap
  locks still fail closed. Separate SQLite contention failures remain under review.
- Saving an Advanced `text:` shortcut now preserves trailing spaces instead of
  trimming the literal payload.
- Linux Parakeet runtime startup now matches each pinned static ONNX Runtime
  artifact's libstdc++ ABI. A real no-model ORT/regex regression catches the
  invalid-free abort found by public-speech acceptance before model loading.
- Retain bounded syscall excerpts from the actual concurrent companion hook test
  in Linux CI, without changing storage durability or its wait budget.
- Bound native iOS CI startup and test execution, and retain raw Mosh diagnostics
  before hosted app checks, while preserving failure gates and no-retry behavior.
- Mobile workspace navigation reserves the full top safe area, keeping the
  Hosts menu below the iOS status bar and its controls inside the toolbar.
- Phone dialog inputs use readable text sizing to avoid WebKit focus zoom
  cropping the host form, while preserving user-controlled pinch zoom.
- Opening another companion event store no longer closes a separate database
  file descriptor that could release an existing SQLite writer's POSIX lock.
- Concurrent companion event writes preserve durable storage within bounded
  lock waits and report numeric SQLite diagnostics without database contents.
- Add the host companion command `lazysh-agent transcript-watch`, the host half of live updates in the Agent view (#1124). One command channel stays open and prints a JSON line for each change of a Claude Code or Codex conversation: a snapshot of the last 1 to 100 messages first, then only the entries that changed or arrived, each with a revision, and a new generation when the transcript was replaced or shortened. The host checks the file every 250 ms and re-reads it only when it changed, so an idle conversation costs one `open` and `fstat` per check instead of one command and a full read every 2 seconds. On a 2.4 MB fixture, 10 polls cost 103 ms of CPU and a 20 s watch with an append every second cost 143 ms, and over 40 appends the stream carried each one after 129 ms at the median and 239 ms at worst. It resolves a transcript by file, or by session id inside the agent's own data root, and stops when its input closes. Nothing in the app uses it yet and no defaults change; a companion that predates it rejects the subcommand with a usage error, which the app will treat as a reason to keep polling and suggest updating the companion.
- Update the Agent view in real time (#1124). A Claude Code or Codex conversation bound to the terminal, or selected under Herdr, now streams from the host over one `lazysh-agent transcript-watch` channel instead of a full page read every 2 seconds: a new message, a reply that grows and a tool result that lands on an older turn change their card in place, with no page replace and no jump of the reading position (the turn at the top of the view stays where it is, **Jump to latest** and follow-the-tail work as before). The end of the thread shows **Agent is working** or **Agent is waiting for your answer** from the recorded turn state. Over a real OpenSSH hop an append on the host reached the client in 114 ms at the median and 253 ms at most over 10 appends, and a frame became a rendered card in 17 to 19 ms in the browser fixture. A tmux-bound conversation cost about 215 host commands a minute while polling (each its own SSH command: the pane check, the report check and the read, before and after each page) and none while streaming. The channel closes when the Agent view is hidden, the session ends or the app locks; a Herdr-selected conversation is re-checked against the live Herdr tree every 10 seconds. When the channel cannot open or is lost the view keeps polling every 2 seconds and says **Live updates are unavailable** or **Connection lost. Showing the last update**, then tries again; a host companion from before the release that adds `transcript-watch` makes it say that live updates need a newer companion and offer **Host companion installation**. Changed defaults: a bound conversation keeps following after a failed read and shows the error until the next read or frame succeeds, instead of stopping the follow; polling runs only while no stream is live. Not included: partial text (Claude Code and Codex record completed messages only), model, mode and context usage in the header (#1224), the Codex app-server daemon and the pinned prompt.
- Make the Agent view follow the agent of the pane you are in. Under Herdr it now reads the focused pane of the attached server every 3 seconds while it is shown and opens that pane's Claude Code or Codex conversation by itself, with no list and no pick, named by agent and folder in the header (the workspace and tab are in the options button). When you focus another pane, tab or workspace, or the agent in the pane changes, it re-links within one read, and a conversation you picked by hand from the list (marked **Not this pane**) is dropped. If the focused pane runs no agent while others do, it lists the server's live agents and says why; if none runs, it shows **Start Claude Code** and **Start Codex**, which stage `claude` or `codex` in the terminal composer for you to review and send (also offered when a tmux terminal has no agent), and, where lazysh has full Herdr support, **Start an agent**, which opens the Herdr workspace launcher with "start an agent" already chosen. A conversation linked this way can use **Stage in terminal** but still never sends input by itself, and a host companion too old to read conversations still gets the update message and **Host companion installation**. Changed default: the Agent view under Herdr opens the current pane's chat instead of the last agent you picked, and no longer shows the live list first when the pane has an agent. The remembered Terminal, Agent or Both choice per host is unchanged. tmux keeps binding from the companion's reported-history hooks.
- Bring the message box back to the Agent view as an always-present composer under the conversation. On a tmux terminal whose pane a hook report ties to the followed agent, the composer binds itself to exactly that pane (the pane of the destination must equal the pane the report names, otherwise nothing is sent and the reason is shown), so a prompt is sent with **Send to the agent** without the **Choose terminal destination** and **Confirm this destination** steps. Enter sends on a keyboard and Shift+Enter adds a line; a touch keyboard keeps Enter as a new line and sends with the button. **Stop** requests the guarded Escape. The unsent draft is kept per conversation while you switch to the terminal and back. A conversation you pick by hand from the list keeps the explicit destination confirmation, and a session that cannot take confirmed input keeps **Stage in terminal** with the reason. The same holds for a guarded Herdr terminal when the conversation is the one Herdr links to the focused pane: the prepared destination must carry that exact pane and terminal. Nothing changes for the Terminal view. Not yet in this change: receipts, queueing, slash commands, `@` files and pasted images (tracked in #1123, #1280 and #1283).
- Show the messages you typed while Claude Code was busy in the Agent view. Each waiting message appears as a dashed **Queued** card, oldest first, with its age, below the latest turn and above the message box, and goes away when the agent takes it (it then appears once as your message). It is read-only for now: removing or promoting a queued message needs the guarded input of #1123. The data comes from the new `queued` list of the companion's Claude conversation page and `transcript-watch` frames, so update the host companion; an older companion shows no cards. Codex records no queue.
- Make the Agent view message box a real prompt box. Typing `/` first opens a palette of the agent's common slash commands that you can filter, walk with the arrows and pick with a tap; picking inserts the command, and one that opens a dialog in the terminal (`/model`, `/resume`, `/rewind`) says so. A leading `!` or `#` shows a **Shell command** or **Memory note** chip. Up and Down in an empty box bring back the prompts you sent. Every sent message shows a receipt (**Sending**, **Sent**, **Not in the conversation yet**, **Not sent** with **Retry**, **Delivery is unknown**) settled from the conversation itself, and **Request stop** now needs a second press so a stray tap cannot interrupt the agent. Retry only appears when nothing reached the terminal. Queue or steer choice, removing a queued message, pasted images and `@` files are separate changes (#1123, #1283, #1280).
- Complete `@` file mentions in the Agent view message box. Typing `@` opens a list of the files and folders of the folder the agent works in, filtered as you type; picking a file inserts `@path` and picking a folder opens it one level deeper. Only paths below the agent's folder are offered: `..`, absolute paths and a path with a backslash are never listed. Hidden files appear only when you type a dot, and a host that cannot be listed simply shows no list. The message is still sent as you typed it. `!` and `#` chips and the slash palette arrived earlier; pasted images and prompts over 4,096 bytes are separate changes (#1283).
- Show the images you attached in the Agent view. A prompt with a PNG or JPEG now shows an **Image W × H · View** control in your bubble that opens the same bounded viewer as the Chat view; an image that is too large, not PNG or JPEG, a link or a local file keeps a placeholder that says why. Previews are on for Claude Code and switchable under the Agent view options (**Show image previews**, off by default for Codex), because they cost bytes on a mobile link. The companion now also answers `lazysh-agent transcript --agent codex --view conversation --inline-images`, so update the host companion to see Codex previews; an older companion keeps the placeholder. Nothing is fetched from a link or read from a local path.
- Attach files to a message in the Agent view the way the terminal composer does. The paperclip, a paste of an image or file, or a drop on the message box uploads it to the host's `/tmp` (up to 10 MiB, the same path the terminal composer uses) and inserts a numbered `[Image #1]` or `[File #1]` token with a chip to remove it. A token is never split by an edit, and on send each one becomes the quoted path of its uploaded file, so the agent reads it from there (it is typed text, not a drop into the agent's own attachment area). Send waits while an upload runs and the expanded text must still fit the 4,096 byte guarded input. Pasting plain text is unchanged. Prompts over 4,096 bytes are a separate change (#1283).
- Send long prompts from the Agent view message box. On a tmux terminal a message of up to 65,536 bytes (it used to stop at 4,096) is stored in a private tmux paste buffer in 4 KiB steps and pasted with one Enter, so it stays one message and never several turns; every step re-checks that the terminal is still the confirmed destination and a changed destination deletes the buffer and sends nothing. A longer message, and any message over 4,096 bytes on a guarded Herdr pane, is refused with its limit shown. Ordinary messages are unchanged.
- Switch Claude Code's permission mode from the Agent view message box on a tmux terminal. A new shield button next to the paperclip sends one Shift+Tab to the agent's pane per tap (through the same guarded, one-at-a-time input as Send) and then reads the mode back off the agent's own status line, so the note says **Permission mode: Plan** only when the terminal showed it; a screen it does not recognise says so and claims nothing. Claude Code cycles default, accept edits, plan and auto (and bypass when it was started with it), so a tap moves to the next one. The profile was verified on Claude Code 2.1.318; other agents, guarded Herdr and Zellij hide the button. Model switching is not part of this change: `/model` opens a picker in the terminal (#1288).
- Open the Codex conversations the companion used to refuse in the Agent view (#1572). About a third of the real rollouts sampled on a developer host (59 of 200) failed with an invalid event because Codex writes one line of up to 13 MiB for a long command, its output or a compaction, and the reader took no line over 256 KiB. The reader now takes a record as long as the file allows and cuts a block's text at 256 KiB, or less when the message would not fit one page, with a note of how many bytes were left out. A conversation over 16 MiB or 100,000 records is reported as too large instead of as an invalid event, and the Agent view says so and stops retrying it. Needs the updated host companion. No defaults change.
- Update an OpenCode session in the Agent view as it is written instead of every 2 seconds (part of #1125 and #1124). With the updated host companion, the Agent view of an OpenCode pane opens the same live channel as Claude Code and Codex: the companion watches OpenCode's database and its write-ahead log (where the newest rows wait until a checkpoint, so the database file itself may not change for minutes) and sends only the messages that changed, so a reply that grows, a tool result that lands and the model, context and cost of the header update in place without moving the reading position. A host companion without it, or a channel that cannot open, keeps the 2-second polling and says so, as before. An OpenCode session picked from a Herdr pane has no database session to name and still polls. No defaults change.

### Documentation

- Record whether a native terminal surface can sit next to the app's web view on Linux, as evidence for the terminal engine decision (#1331, part of #1302). On a virtual KWin session and on niri nested in it, a Wayland subsurface placed below a transparent window and web view stays at its page anchor through anchor changes, window resizes, removal and re-creation (at scale 1 and 2, with exact pixels), keeps DOM overlays on top and takes a wgpu Vulkan swapchain on an AMD GPU; an X11 child window does the same except that it covers DOM overlays, so X11 sessions are to keep xterm.js. Only a prototype under `packages/terminal-runtime/prototypes` and its measurements: the app is unchanged, xterm.js stays the only engine and no setting or default changes.
- Record which native terminal surface strategy the Windows, macOS and iOS windowing stack allows, as evidence for the terminal engine decision (#1330, #1332, #1333, part of #1302): a desk study of the shipped wry and tao sources, with what each platform's probe must measure. Nothing was run on those platforms, xterm.js stays the only engine on all of them, and no setting or default changes.
- Record what a running Chrome does when it is asked to be controlled, and specify the separate screen that would attach to a user's normal browser (#1697, part of #1258). On Chromium 157, headed, on a virtual display and throwaway profiles, ticking "Allow remote debugging for this browser instance" at `chrome://inspect` opens a loopback WebSocket that answers every HTTP discovery request with 404 and holds each connection, including one to a wrong browser id, until the user answers an "Allow remote debugging?" dialog on the host's screen; no timeout showed in 95 seconds, every new connection needs its own click, and the phone cannot answer it (the dialog is not a protocol target, not in a screenshot and takes no protocol input). The setting survives a browser restart, and an approved connection reaches every tab and the cookies, so the relay's closed list refuses them. The specification now says what the Attach screen requires (warning, waiting state, one approved connection per view, the same allow-list, nothing stored). Google Chrome 144, Google Chrome's refusal of the debug flag on its default profile and a real display were not tried. Documentation only; the Attach screen is not built (it needs the Chrome viewer, #1254) and no defaults change.
- State in the agent-hook guide, per provider CLI and version, what an unchanged official CLI was observed to deliver to the companion, what no run has established yet (Gemini CLI interactive and child attribution, Droid prompt-start, Amp plugin loading, Cursor authenticated execution), the new Claude Code 2.1.322 and Codex 0.167.0 interactive tool, permission and child observations, and that a rejected Claude Code permission leaves the row in `needs_attention` (#1795) and which cases are blocked on a vendor account (#1527). Documentation only; no defaults change.
- Refresh the Agent view parity reference and the specification's per-agent table with what has shipped, naming the pull request that shipped each element (working line, plan chip, tool and diff cards, background work, sub-agents, thinking, error cards, header pills, event lines, reading tools, Codex dialogs) and what stays in the terminal per agent, including why OpenCode's dialogs cannot be answered from a screen read: it draws the highlighted choice by colour only. Documentation only; no defaults change.
- Measure the terminal adapter's write path against writing to xterm.js directly: the terminal benchmark can send every byte through `XtermTerminalAdapter.write` and compares the two stream by stream. On one desktop host no cost was found beyond run-to-run noise (about 5 percent for plain text and redraws, about 20 percent for colour output); Android and real devices were not measured. The terminal migration plan now lists which terminal slices have shipped. xterm.js stays the only engine users can run. No defaults change.
- Measure the wgpu terminal renderer prototype on its OpenGL and OpenGL ES backends against Vulkan on the same GPU, as evidence for the terminal engine decision (#1323, part of #1302). It renders the same pixels on all three; at the phone-sized grid a frame cost the same within the host noise, at a larger grid 1.2 to 1.4 times more at the median, and the tail (p99) was worse through OpenGL, so the OpenGL ES fallback is viable on one desktop driver and unmeasured on Android. Raw result files and an ADR 0001 amendment only: the terminal engine is unchanged, xterm.js stays the only engine, and no setting or default changes.
- Align the Firebase-free push guidance with the shipped Android UnifiedPush support (#964). The registration, UnifiedPush acceptance, Android testing, architecture and notification-delivery pages now describe Google and FOSS enrollment, separately consented event display and the scoped owned-emulator evidence, keep FCM and Gotify as separate paths, and state that physical-device, OEM Doze and signed-release delivery remain unverified. Documentation only; no defaults change.
- Record the first runtime capture of the Android native launch (#582), in [the benchmark study](docs/ux/android-workspace-benchmark.md#native-launch-capture-waydroid-2026-11-13). On a Waydroid guest, a cold start and a restore after process death show a text placeholder for 33–75 ms between the branded cover and the workspace, with no button or Unlock screen in any frame; warm start is clean. Documentation only: nothing changes in the app, and the Galaxy S23+ sequence is still unverified.
- Measure the xterm.js WebGL renderer addon at the phone grid, under a scripted WebGL context loss and in an Android System WebView, as evidence for the terminal engine decision (#1323, part of #1302). In headless desktop Chromium on a hardware GPU, the first ANSI-heavy burst after a page load stalled for 6.7 to 7.7 s (0.26 to 0.30 MiB/s, then 66 to 82 ms for the same bytes), so the WebGL addon does not ship yet; the DOM renderer stays the default and the fallback. Benchmark harness, raw result files and the ADR 0001 amendment only: the terminal engine is unchanged, xterm.js stays the only engine, and no setting or default changes.
- Record which tmux or rmux server a hook's pane belongs to (#1146, part of #1138). A pane id such as `%7` is unique only inside one server, so a report from `tmux -L work` and one from the default server could carry the same id. The host companion now adds an optional `paneServer` to each report (`tmux:work`, `rmux:default`), read from the `TMUX` or `RMUX` socket path of the pane the hook runs in (rmux only when `RMUX` and `RMUX_PANE` agree with `TMUX` and `TMUX_PANE`); a `-S` socket outside the server's own directory has no label and records none. The Agents panel shows it under **Report details** as **Reported multiplexer server**, in English, Portuguese and Spanish. An older companion or client works unchanged, and no defaults change. Using the label to open the exact pane from a notification, tmux and rmux Jump To pane rows and Herdr `events.subscribe` stay open in #1146.
- Document Linux Copilot CLI 1.0.105 manual-hook completion and unanswered elicitation attention qualification, with explicit runtime limits (#704).
- Document Obtainium as the preferred Android installation/update method, with explicit APK flavor filters, signature-channel caveats and manual SHA256 verification. No application default changes.
- Align the workspace restore action with accessible 44px details and dismiss icons in one compact row. Keep the saved-credential and multiplexer restoration explanation available on demand; restore, dismissal and connection defaults are unchanged.
- Refresh the default app appearance with the lazysh logo palette, frosted navigation and dialogs, and consistent buttons and selectors. The default app preset is now labelled lazysh; saved preset identifiers, terminal colors, and custom themes are preserved. Reduced-transparency and reduced-motion preferences are respected.
- Refresh agent-board display readiness on native main-window focus as well as browser focus, so an opted-in board can resume after an earlier unavailable observation. Original access/visibility gates and the explicit re-enable requirement after failed acquisition remain unchanged; this does not establish the cause of the separately tracked Android readiness failures.
- Catalogue the Next.js preview hint label in all interface locales, preserving the brand and existing discovery behavior while restoring the localization coverage gate.
- Measure the cold start of the WebAssembly build of the terminal core (libghostty-vt) against xterm.js in Node, as evidence for the terminal engine decision (#1323, part of #1302). From a fresh process the module compiled, instantiated and parsed a 14,800-byte sample in about 8 ms against about 21 ms for xterm.js headless, and held about 4.7 to 4.9 MiB more resident memory. Benchmark script and raw result files only: the terminal engine is unchanged, xterm.js stays the only engine, and no setting or default changes.
- Catalogue the Cloud speech-engine option prefix in all interface locales while retaining the validated backend label, draft and explicit selection behavior. No defaults change.
- Record the design for opt-in background usage collection and a host switch for account quota reads as [ADR 0005](docs/architecture/adr-0005-background-usage-collection.md) (#1588, slice 4 of #18): one new `usage-collection.json` policy file, a bounded sample file, a user-level timer on Linux, macOS and Windows, and a `disabled` quota state that carries no number. Documentation only: nothing is collected, no command exists yet and no defaults change.
- Record the design for opt-in background usage collection and a host switch for account quota reads as [ADR 0005](docs/architecture/adr-0005-background-usage-collection.md) (#1588, slice 4 of #18): one new `usage-collection.json` policy file, a bounded sample file, a user-level timer on Linux, macOS and Windows, and a `disabled` quota state that carries no number. Documentation only: the behavior itself ships in a separate change, and no defaults change.
- Document why a Kimi Code prompt stays in the terminal (#1797, part of #1535): in a network-less run of the official 2.4.1 release, hooks on `PermissionRequest` and `PreToolUse` that printed an allow (in the spelling of Claude Code, Codex, Copilot CLI and Kimi itself) left the prompt waiting for the person, `PermissionRequest` is a fire-and-forget observer, and `PreToolUse` can only block a tool before any approval is asked. Nothing changes in the app and no default changes; the Kimi "Approval requested" notification stays a notification without Allow or Deny. The qualification run gained two scenarios for this.

### Under the hood

- Build the shared Rust terminal core and its libghostty-vt for Android arm64 (`aarch64-linux-android`, the release ABI) and x86_64 (`x86_64-linux-android`, what Waydroid and the CI emulator run) (#2098, part of #1312 and #1302). The Herdr binding's build script had no mapping for Android triples and stopped with "unsupported target"; it now maps both to the Zig targets (a documented local modification in `packages/herdr-upstream/PROVENANCE.md`; the source manifest and the source integrity checks are unchanged), and the `herdr-native` CI job checks and links `lazysh-terminal-runtime` for both ABIs against the pinned NDK r29 at the app's minimum API 24. Compiling and linking only: nothing was run on Android, the app does not use the core yet, and xterm.js stays the only engine and the default, so terminal behaviour does not change and no defaults change.
- Build the Windows companion again: the host browser relay's stand-in for Windows (which has no pipe transport) returned a tuple while its caller expected the relay's pipe struct, so `lazysh-agent` did not compile for Windows and no release could be verified. One function signature now serves every platform. Windows hosts still report the host browser as unsupported (#1884).
- Run each Google/FOSS ntfy acceptance branch as a complete emulator-runner shell command, preserving the existing native checks and deadlines.
