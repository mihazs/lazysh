# Linux desktop runtime measurement

[Issue #20](https://github.com/mihazs/lazysh/issues/20) requires cold start, idle CPU and bounded memory to be measured, not inferred from a green build. This page describes the one measurement that runs on this repository's own hardware, the freshly built Linux desktop app, and records its first results. It covers Linux only: Android, iOS, macOS and Windows keep their own open gates in #20.

The terminal's sustained-output frame latency, scrollback memory and its Android energy and idle-wakeup measurements belong to the terminal programme ([#1303](https://github.com/mihazs/lazysh/issues/1303), [#1338](https://github.com/mihazs/lazysh/issues/1338), [#1340](https://github.com/mihazs/lazysh/issues/1340)) and are not repeated here.

## What it measures

`tests/support/desktopRuntime.ts` starts the built binary on its own private X display (Xvfb), D-Bus session bus and empty profile directories, then reports per run:

| Field | Definition |
| --- | --- |
| `coldStartMs` | From spawning the process to the first visible X window owned by it (polled every 20 ms, so about 25 ms resolution). This is the window appearing, not the interface being ready to use. |
| `settledMs`, `startupCpuSeconds` | Time and total CPU, from spawn, until the app and its WebKit helpers stay below 5 % of one core for three seconds in a row. |
| `idleCpuPercent` | CPU of the whole process tree as a share of one core, over the idle window after startup settled (default 60 s). The app shows its start page; no host is connected. |
| `processes` | Application plus WebKit helper processes. |
| `rssMiB`, `pssMiB`, `swappedMiB` | Resident size, proportional resident size and swapped proportional size of the tree at the end of the idle window. |
| `peakRssMiB` | Sum of each process's own peak resident size (`VmHWM`). It does not drop when the kernel reclaims idle pages. |

CPU includes descendants that already exited. Memory comes from `/proc/<pid>/smaps_rollup` and `/proc/<pid>/status`. Xvfb and the bus daemon are not counted.

## Run it

Needs Linux, Bun, `Xvfb`, `dbus-daemon` and `xdotool`. Build the app first (`bun run build:native`), then:

```sh
bun tests/support/desktopRuntime.ts "$PWD/target/release/lazysh" --runs 5 --idle 60 --out report.json
```

`LAZYSH_NATIVE_GUI_XVFB` selects an Xvfb that is not on `PATH`, as in [native GUI testing](native-gui-testing.md). The report adds the host environment, the binary size and SHA-256, and a min, median and max for every field. Compare runs only on the same host with similar load: the report records the load average at the end of the last run.

`bun test ./tests/desktop-runtime.test.ts` checks the sampler against controlled process trees (descendant and reaped-child CPU, memory fields, summaries, missing tools). It does not start the app, and CI does not run this measurement.

## Measured: v1.62.0, Linux

Source `5030bf49` (v1.62.0), `bun run tauri build --no-bundle` release profile, binary 54,808,056 bytes, SHA-256 `1fce5872f2c5303bdf81556480f0e2185cf53ba985404b2d5a3e11ee3be04b33`. Host: AMD Ryzen 9 5900X (24 threads), 31 GiB, Linux 7.3.3, WebKitGTK 2.54.2, Xvfb 1280x800x24 with software rendering. The host was shared with other builds and agents (load average 5.2, 5.9, 6.4 at the end), and the binary and libraries were already in the page cache, so this is a fresh-profile start, not a cold-disk start. Five runs, 60 s idle window:

| Run | `coldStartMs` | `settledMs` | `startupCpuSeconds` | `idleCpuPercent` | `rssMiB` | `pssMiB` | `swappedMiB` | `peakRssMiB` |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 427 | 4,579 | 0.85 | 0.07 | 29.3 | 5.4 | 118.0 | 518.1 |
| 2 | 672 | 4,848 | 0.85 | 0.13 | 142.3 | 93.9 | 51.0 | 520.9 |
| 3 | 667 | 4,859 | 1.00 | 0.05 | 506.8 | 336.9 | 0 | 527.1 |
| 4 | 317 | 4,492 | 0.78 | 0.02 | 507.2 | 336.8 | 0 | 525.7 |
| 5 | 291 | 4,436 | 0.76 | 0.05 | 507.7 | 337.6 | 0 | 525.5 |
| Median | 427 | 4,579 | 0.85 | 0.05 | 506.8 | 336.8 | 0 | 525.5 |

What the numbers support, on this host and build only:

- The window appears in 0.3 to 0.7 s and the app is quiet after 4.4 to 4.9 s, having used 0.8 to 1.0 CPU seconds.
- With nothing connected, the idle tree used at most 0.13 % of one core over 60 s. No periodic wake-up large enough to show at this resolution was found.
- The tree is the application plus two WebKit helpers and holds about 505 MiB resident (337 MiB proportional), peaking at 518 to 527 MiB. That is the footprint of an empty start page, before any terminal session.
- Runs 1 and 2 report much smaller resident sizes because the kernel swapped idle pages out under memory pressure from other work on the shared host (`swappedMiB`). Resident size at the end of an idle window is therefore not a footprint on a loaded host; use `peakRssMiB`, or `pssMiB` plus `swappedMiB`. An earlier set of five runs without the swap fields showed the same effect (23 to 507 MiB resident) and is why the fields exist.

## Not established

- Cold start with an empty page cache, and the time until the interface is usable. A window can map before the page has rendered.
- Anything on a physical display or GPU: Xvfb renders in software.
- Memory or CPU with connected sessions, long output, large transfers or many workspaces.
- Any other platform. macOS, Windows, iOS and Android need their own sampler and hardware; the Android measurement procedure is in the [terminal benchmarks](architecture/terminal-benchmarks.md#android-procedure-manual-gate-not-run).
- Battery, thermal behaviour, installed size or a regression budget. These figures are a first record, not a gate.
