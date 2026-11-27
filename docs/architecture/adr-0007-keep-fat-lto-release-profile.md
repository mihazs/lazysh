# ADR 0007: keep fat LTO and one codegen unit for the Rust release profile (thin LTO and more codegen units evaluated and not adopted)

- Status: **Not adopted**, 2026-11-26. The workspace `[profile.release]` stays `lto = true`, `codegen-units = 1`, `strip = true`, `panic = "abort"`.
- Decision makers: repository maintainer. Tracking: [#2737](https://github.com/mihazs/lazysh/issues/2737), a child of the build performance epic [#2736](https://github.com/mihazs/lazysh/issues/2736).
- Related: [what the release profile costs and buys](../explanation/rust-release-profile.md) (all numbers) · [raw results](benchmarks/rust-release-profile-1.txt) · [release artifacts](../release-artifacts.md) · [desktop runtime measurement](../desktop-runtime-measurement.md) · [terminal benchmarks](terminal-benchmarks.md).

## Context

Fat LTO with one codegen unit makes the final optimization single-threaded. The epic asks whether thin LTO or more codegen units cut build time, CPU, memory and disk without changing what the release artifacts do: runtime performance, startup budgets, binary portability, F-Droid compliance, source-built releases, signing and provenance.

## Decision

Change nothing. The criterion was a measured build-cost win that regresses none of those. The win exists and is large on wall time, but it is paid for by the published artifacts:

| | `lazysh-agent` | Desktop binary | Terminal frame path |
| --- | --- | --- | --- |
| Wall time, thin16 or off16, cold | -26 to -34 % | -18 to -38 % | n/a |
| Wall time, warm relink | -51 to -91 % | -56 to -78 % | n/a |
| CPU time, thin | +3 to +81 % | +6 to +37 % | n/a |
| Binary size | +12 to +18 % | +10 to +14 % | n/a |
| Run time | 1 to 7 % slower per command | start-up and idle indistinguishable | thin16 10 to 12 % slower, no LTO 11 to 32 % slower |

Release packages are held to size ceilings (`.changeset/release-artifacts.ts`) and the terminal frame path is the subject of the terminal performance programme ([#1303](https://github.com/mihazs/lazysh/issues/1303)). A change that makes both worse is not a free build-time saving, so it is not made for published artifacts. Portability, F-Droid, signing and provenance were not weighed further because the run-time and size results already decide the question; none of them favours the change.

## Consequences

- Published builds are unchanged byte for byte in their inputs. Nothing in `Cargo.toml`, the workflows or the F-Droid recipe changes.
- Build cost stays. A warm desktop rebuild takes about five minutes on four CPUs, of which about four are the fat link.
- A split, thin or `lto = false` only for CI jobs that ship nothing, remains open. It needs an audit of which `checks.yml` jobs may build different codegen from the one that ships (several build the release binary on purpose, and the APK size gate needs the real library). It is tracked as [#2768](https://github.com/mihazs/lazysh/issues/2768) and is not part of this decision.
- Not covered by the evidence: Android, iOS, macOS and Windows builds, any device, any connected session. A later change to the profile must measure those before it is adopted.
