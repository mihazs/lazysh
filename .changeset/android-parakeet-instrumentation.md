---
"@lazysh/client": patch
---

test(voice): run the local Parakeet engine on Android in the instrumentation job

The emulator job installs the pinned model through the app's own download, transcribes the public LibriSpeech sample at a word error rate of at most 0.10 and removes the model again, next to the local Whisper case.
