---
"@lazysh/client": minor
---

Answer the questions Codex asks from the Agent view. When Codex opens a `request_user_input` question on tmux, the dialog card above the message box shows the question, its place among the questions (`Question 1/2`) and the options with Codex's highlight, and a tap moves the highlight with the arrow keys, reads it back and presses Enter, as a person would. Codex then shows its next question as its own card. It works at a phone's width, where Codex wraps the question, both columns of an option and the footer. The card offers no **Cancel the dialog** for a question, because Esc interrupts Codex's turn there; the notes box (Tab) stays in the terminal and shows the banner that the agent waits there.
