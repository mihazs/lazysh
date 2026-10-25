# Parakeet dictation on Linux

Whisper remains the default. Linux x86_64 additionally offers Parakeet TDT 0.6B
v3 INT8 on the CPU. Other platforms report it unavailable. Standalone runtime
builds do not establish product support. Language detection is automatic: this
runtime has no forced-language option.

Select Parakeet and explicitly download its model. Viewing status or selecting
the engine never downloads weights. The sole archive is 487,170,055 bytes, from
the sherpa-onnx publisher, with the runtime's fixed SHA-256. No caller-selected
URL, filesystem path, ONNX file, or checksum is accepted. Archive verification
and extraction validate the pinned files before publishing without replacement.
To download again, explicitly Remove then Download. Whisper's three-model and
160 MiB limits remain unchanged.

Allow **1,644,818,882 bytes** of peak disk space: the installed download, private
verification snapshot, and four extracted files can coexist. Disk-full errors
fail explicitly. One private native cache lock prevents another app process from
modifying live model storage. Startup cleanup requires that lock and removes only
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
fixtures for truncation, oversize, hash mismatch, and body-wait cancellation.
An uncached real-manager acceptance task uses an explicitly supplied public model:

```sh
LAZYSH_PARAKEET_TEST_ARCHIVE=/private/cache/parakeet-v3-int8.tar.bz2 \
  bunx turbo run test:parakeet-product --filter=@lazysh/client
```

It downloads nothing, installs through the manager's verified preparation and
publication path, transcribes the licensed public speech sample twice with the
same extracted workspace, and removes the model before requiring a clean process
exit. The implementing PR records actual results. This does not establish mobile,
multilingual accuracy, thermal/battery, long-duration, or power-loss acceptance.
