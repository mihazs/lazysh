# Owned whisper.cpp relay acceptance

This opt-in Linux Cargo test runs the compiled lazysh relay against a separately
source-built, owned whisper.cpp process. It never contacts an inference provider,
reads personal audio or downloads anything during a test. It does not deploy a
service or change application defaults. Ordinary service tests leave it ignored;
explicit invocation without the required fixture fails instead of silently skipping.

## Prepare public inputs

Use a dedicated owner-only directory (mode 0700). This example names
`/tmp/lazysh-real-whisper-acceptance`; do not reuse a personal service directory.
Download these public HTTPS inputs into it using a bounded tool such as
`curl --fail --location --max-time 180 --output <file> <url>`:

- `source.tar.gz`: `https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/d1be6fde11ac6e0407606b4e42fe72d34add8037`
- `ggml-base.bin`: `https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-base.bin`

The engine is official v1.9.5. Its code and the original Whisper weights are
MIT-licensed; see the upstream links in [the relay documentation](cloud-transcription.md#self-hosted-whispercpp).
The model's SHA-1 also matches the pinned upstream model table:
`465707469ff3a37a2b9b8d8f89f2f99de7299dac`. Verify all SHA-256 receipts below
before extraction/build, and keep the downloaded files owner-only. No artifact
or audio file is committed to lazysh.

Extract the archive in that private directory with `tar -xzf source.tar.gz`.
The JFK sample comes from that exact source archive, not a microphone recording.
Build only the upstream `whisper-server` target using its native CMake structure:

```sh
cmake -S whisper.cpp-d1be6fde11ac6e0407606b4e42fe72d34add8037 -B build \
  -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=OFF \
  -DGGML_AVX=OFF -DGGML_AVX2=OFF -DGGML_FMA=OFF -DGGML_F16C=OFF \
  -DGGML_OPENMP=OFF -DGGML_VULKAN=OFF -DGGML_CUDA=OFF \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON
cmake --build build --target whisper-server --parallel 2
```

This is fixture preparation, not an installer or a model download performed by
the application. The operator supplies the trusted source-built executable;
input hashes do not attest that a substituted executable was built from them.

## Execute the native test

From the lazysh repository:

```sh
LAZYSH_TEST_WHISPER_FIXTURE=/tmp/lazysh-real-whisper-acceptance \
  cargo test -p lazysh-transcription --test cli \
  real_whisper::compiled_relay_transcribes_with_the_real_owned_whisper_engine \
  --locked -- --ignored --nocapture
```

The test verifies input hashes before launching anything, normalizes only the
pinned sample's PCM into the existing canonical WAV header, and runs both
processes without an OpenAI key file. The engine uses two CPU threads, no GPU,
no converter, and no transcript printing; stdout/stderr are discarded. The
upstream's default `no_context=true` is retained (there is no `--no-context`
CLI option in this pinned server).

The engine binds loopback port zero. The fixture finds its listener by matching
only that owned, unreaped child's socket descriptor inode to its network table;
it does not release and rebind a guessed port or signal an unrelated process.
Readiness has a 20-second deadline, actual child reaping a three-second deadline,
the whole async acceptance a 180-second deadline, and the production relay's
45-second provider deadline remains unchanged. Hash input sizes, descriptor
count and network-table reads are bounded. Normal panic cleanup retains owned
child handles. These are foreground fixture processes, not a generic daemon
supervisor or a guarantee that an uninterruptible OS process can be retired.

## Recorded evidence and limits

The first successful Linux x86_64 run used CMake 4.4.4 and GCC 16.2.1, with the
portable CPU flags above. Source `examples/server/server.cpp` had Git blob
`b745f4d7b093ae597048ef6c1e824ad5230cd336`, independently matching the official
commit API and the extracted file. Observed SHA-256 values:

| Input | SHA-256 |
| --- | --- |
| Source archive | `645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4` |
| Multilingual base weights (147,951,465 bytes) | `60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe` |
| Upstream `samples/jfk.wav` | `59dfb9a4acb36fe2a2affc14bacbee2920ff435cb13cc314a08c13f66ba7860e` |
| Locally built server (that build only) | `853bf641ea863f6186e979d7c2bae801f51f5b06e156a3be14da642883883e6c` |

That initial run used relay source at `59252bd` (version 0.13.0) and passed in
38.44 seconds including hashing; its post-hash observation was
34,861 milliseconds. Both explicit `en` and `auto` requests transcribed the
176,000-sample (11-second) public clip and contained the expected known phrase.
The relay reported the distinct backend, required no provider key, cancelled an
admitted long upload with 204/409 while retaining quota, and returned the finite
redacted `provider_unavailable` error after its owned engine stopped. Those
times are one observation, not a performance guarantee or relaxed timeout.

After normal integration of version-only main `6d07e19` (0.14.0), the final
full service run passed all 14 library and four CLI cases, including this actual
engine case in 38.22 seconds (post-hash 34,697 milliseconds). Service/common
production source was unchanged by that integration. Final fixtures explicitly
confirm both owned children are reaped before returning.

Cancellation is observed after the relay debit; it does not prove inference had
started or the exact instant engine computation stopped. One English clip does
not establish general accuracy, other languages, hardware throughput, mobile
operation, public TLS deployment or engine-side cancellation. Editable-draft UI
has separate component coverage; this native test does not drive the UI. Broader
acceptance remains tracked in [#345](https://github.com/mihazs/lazysh/issues/345).
