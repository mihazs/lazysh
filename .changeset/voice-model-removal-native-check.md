---
"@lazysh/client": patch
---

Cover Whisper model removal with a real-file Rust case: only the named model is deleted, a running transcription, a path outside the model directory and a missing model are refused, and the freed slot accepts a new import under the three-model limit.
