# Parakeet dictation on Linux, Windows and Android

Whisper remains the default. Linux x86_64, Windows x86_64 and the Google build of
the Android app (arm64-v8a, plus x86_64 for the owned emulator) additionally offer
Parakeet TDT 0.6B v3 INT8 on the CPU. Other platforms and the F-Droid build report
it unavailable. Standalone runtime builds do not establish product support.
Language detection is automatic: this runtime has no forced-language option.

Select Parakeet and explicitly download its model. Viewing status or selecting
the engine never downloads weights. The sole archive is 487,211,443 bytes, from
the sherpa-onnx publisher, with the runtime's fixed SHA-256. No caller-selected
URL, filesystem path, ONNX file, or checksum is accepted. Archive verification
and extraction validate the pinned files before publishing without replacement.
To download again, explicitly Remove then Download. Whisper's three-model and
160 MiB limits remain unchanged.

Allow **1,644,999,670 bytes** of peak disk space: the installed download, private
verification snapshot, and four extracted files can coexist. The manager checks
the free space of the model's filesystem before it downloads, and again before it
prepares an archive stored by an earlier run (which needs the peak minus the
487,211,443 bytes already stored). It refuses with "Parakeet needs about 1.6 GB of
free storage to prepare its model" instead of starting; disk-full errors during a
transfer still fail explicitly. One private native cache lock prevents another app process from
modifying live model storage. On Linux the cache is private by owner and mode
bits. On Windows it is private by owner SID and access control list: the cache
folder, every folder the model is extracted into and every file in them must be
owned by you, the administrators or the system, and must grant no access to any
other account, and no folder above the cache may let another account delete,
rename or re-protect it (adding a sibling beside it is fine, as on a drive
root). Each object is read back after it is created and before a model byte is
written to it. A profile or data folder whose inherited permissions give another
account access therefore reports the model storage unavailable, with the same
message as a second app process, instead of installing; Whisper is unaffected.
Windows installs the downloaded archive with a write-through rename that fails
when the destination exists, so a crash leaves the partial download or the
installed archive, never both under the final name. Startup cleanup requires that lock and removes only
known private partial/workspace names. An idle model can be removed explicitly.

The app retains one warm recognizer and its extracted files across dictations.
Installation prepares it once. After restarting, the first recording prepares the
saved archive again; later recordings reuse it. Removal destroys the idle native
recognizer before deleting the archive. Native work shares capacity with Whisper.

**Cancel discards delivery.** Preparation, loading, and inference are synchronous
and cannot be forcibly interrupted through this API. The worker retains its audio,
model, files, process lock, and capacity until it returns. The UI reports finishing
and keeps controls unavailable during that interval, including after reopening
Voice. Lock and policy changes invalidate the original lease. Stale output cannot
become a draft, history entry, or terminal write. There is no CPU cancellation
deadline, strict RAM cap, or promise of immediate memory release after removal.
Existing native measurements show substantial allocator/runtime retention.

Recordings use finite mono 16 kHz PCM lasting 0.1–30 seconds. UTF-8 results are
limited to 64 KiB and stay editable by default. Existing explicit direct-input,
Enter, and opt-in history choices apply. Audio remains local; there is no cloud
fallback or new automatic-send behavior. The native wrapper does not log text or
audio; upstream runtime error diagnostics retain the limitations documented in
the [runtime README](../packages/parakeet-runtime/README.md).

Native Cargo tests hold synthetic workers across cancellation and lease changes,
check process/cache ownership and exact-ID cleanup, and stream small local HTTP
fixtures for truncation, oversize, hash mismatch, a mismatched Content-Length,
an HTTP error status, and body-wait cancellation.
An uncached real-manager acceptance task uses an explicitly supplied public model:

```sh
LAZYSH_PARAKEET_TEST_ARCHIVE=/private/cache/parakeet-v3-int8.tar.bz2 \
  bunx moon run client-native:test-parakeet-product
```

It downloads nothing, installs through the manager's verified preparation and
publication path, transcribes the licensed public speech sample twice with the
same extracted workspace, and removes the model before requiring a clean process
exit. The implementing PR records actual results. On Windows the
`native-desktop` job runs the same real-manager case against the pinned archive
(downloaded and verified by `.github/actions/windows-parakeet`), the manager cases
that need no model (including a cache or parent folder other accounts can modify
being refused), and `test:voice-interop:smoke`, which links and starts Whisper and
Parakeet in one client process without a model; the runtime's native exception
and ownership fixtures run there too. Those jobs run on pushes to `main`, not on
pull requests. This does not establish mobile,
multilingual accuracy, thermal/battery, long-duration, or power-loss acceptance.

## Android

The Google build links the pinned prebuilt static ONNX Runtime and the pinned
sherpa-onnx source from `packages/parakeet-runtime` for `arm64-v8a` and
`x86_64` (API 24, the NDK's `libc++_shared.so` that Mosh already ships). They are
opted in with the Cargo feature `parakeet-android`, which `build:android`,
`build:android:emulator` and the Google release flavor pass. The F-Droid recipe
does not, so the FOSS flavor keeps its Whisper-only native graph (every native
library compiled from source: ONNX Runtime ships only as a publisher binary)
and its Parakeet status reads "Parakeet is available only on Linux and Windows x86_64 and in
the Google build of the Android app."

- **Storage.** The archive and the extracted workspace live under the app's
  private data directory (`voice-models/parakeet`, mode 0700), so they leave with
  app data or an uninstall. The ancestor check accepts Android's `root` and
  `system` owners and directories group-writable (typically mode 0771) by the
  app's own group; any other app's identity is refused.
- **Publication.** Android publishes the verified archive with an atomic
  same-directory rename after checking that the destination is absent, because
  bionic only exports `renameat2` from API 30 and the app supports API 24. The
  process-wide cache lock already excludes another writer.
- **Owned-emulator acceptance (2026-11-14, by hand).** On the Waydroid guest
  (Android 13, x86_64) the runtime's ignored inference test ran as a native
  `x86_64-linux-android` release executable: word error rate 0 on the public
  LibriSpeech sample, ten stable calls of 418–439 ms, peak 826 MB resident, and
  53 MiB resident after the model was destroyed (see the
  [runtime README](../packages/parakeet-runtime/README.md#observed-android-emulator-results)).
  The debug x86_64 app then ran the product path through its own `voice_parakeet_*`
  commands: install (download, verification, extraction, load) in 116–128 s,
  three transcriptions of the same sample returning exactly the reference text
  (about 0.5–0.9 s each), a restart that reported the model installed but not
  ready and re-prepared it from the stored archive on the first transcription
  (107 s in a debug build), and removal. The app process held 1.0–1.15 GB resident
  with the model loaded. The same path is now an instrumentation case,
  `NativeWorkspaceTest#ownedParakeetInstallsTranscribesAndRemovesThroughTheBundledWebView`
  (`bun run test:android-voice`, job `native-android-auxiliary`, see
  [Android testing](android-testing.md#local-voice-acceptance)): it expects
  `voice_parakeet_status` to report available and not installed, installs the
  pinned archive through the app's own download, transcribes the LibriSpeech
  sample with a normalized word error rate of at most 0.10 and removes the model.
  On the Waydroid guest (Android 13, x86_64) it passed on 2026-11-16 with a word
  error rate of 0 (install, transcription and removal in about two minutes with
  the whisper case alongside; the Linux host has 24 threads and a fast link, so
  the 4 vCPU runners are untimed). It runs on an x86_64 emulator only; the
  Android parity cell stays `implemented` until the job is green on `main`
  (#1815).
- **Not measured.** Peak and retained memory, latency, thermals and battery on a
  phone-class device, and the cost on a low-memory phone, where Android may end
  the app while the model is loaded. The emulator shares a 24-thread desktop CPU,
  so its latency does not predict a phone. Parakeet is never selected,
  downloaded or loaded by default.
- **ONNX Runtime and Mosh.** ONNX Runtime embeds its own protobuf. The native
  build renames that copy's `google::protobuf` symbols into a private namespace
  (the Linux technique, see [native interop](voice-native-interop.md)) so Mosh's
  pinned protobuf-lite, linked into the same shared object, keeps binding to
  its own definitions.
