---
"@lazysh/client": patch
---

Open the Agent view faster: ask the host for its Unix identity once per connection instead of before every companion command, read independent things together (the host's reports and the pane; the Herdr pane check and the conversation), and check the bound report once after the first read instead of before and after it. For a hook-bound tmux conversation the first message needs 4 SSH execs in a row instead of 14.
