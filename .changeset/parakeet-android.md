---
"@lazysh/client": minor
---

feat(voice): offer the local Parakeet engine in the Google build of the Android app

Voice on a phone can now select Parakeet next to Whisper, for arm64-v8a and x86_64: pinned ONNX Runtime and sherpa-onnx, the model in the app's private storage, and a free-space check (about 1.6 GB) before it is downloaded or prepared. The F-Droid build does not include it. No defaults change: Whisper stays the default and nothing downloads Parakeet until you choose it.
