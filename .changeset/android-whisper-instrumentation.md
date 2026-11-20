---
"@lazysh/client": patch
---

Prove local Whisper on Android with the real engine: the emulator job imports the pinned English model through the Voice import commands, transcribes the public JFK sample with the bundled whisper.cpp and removes the model again. The Linux runtime job and the Android job now take their speech fixtures from one pinned download script.
