---
"@lazysh/client": patch
---

Fold the optional hints of the Zellij quick tabs, the Host devices panel, the Preview panel's automatic refresh and the Dictation panel behind one closed 44 px line each: **About tab shortcuts**, **About device tools**, **About automatic refresh**, **About dictation**, **About Whisper models** and **About Parakeet**, in English, Brazilian Portuguese and Spanish. The always-visible explanatory text drops from 151, 152, 242 and 135 characters to 19, 18, 23 and 15, and from 212 and 146 characters to 116 and 64 for the Whisper and Parakeet engines. What stays visible: the Preview note that a preview uses the SSH connection, each on-device engine's "audio stays on this device" line (with the Hugging Face download source and the trusted-file advice for Whisper) and the Dictation delivery warning that Auto-send presses Enter and can run commands. No settings or defaults change.
