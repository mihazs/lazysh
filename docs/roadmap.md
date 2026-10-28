# Roadmap

lazysh is a native SSH terminal and coding-agent client. The [delivery epic](https://github.com/mihazs/lazysh/issues/1) and its linked issues are the source of truth for scope, progress and acceptance. Items below are open as of 2026-10-28; their order groups related work and does not promise a release date.

## Connection and workspace foundation

- Finish resilient transports, bastions and agent forwarding ([#8](https://github.com/mihazs/lazysh/issues/8)); complete multiplexer lifecycle and navigation ([#7](https://github.com/mihazs/lazysh/issues/7)) and desktop launch intents ([#86](https://github.com/mihazs/lazysh/issues/86)).
- Complete credential storage, unlock and key management ([#9](https://github.com/mihazs/lazysh/issues/9)), and optional encrypted sync ([#17](https://github.com/mihazs/lazysh/issues/17)). Changes to storage or authentication need migration and platform acceptance.

## Agent supervision and collaboration

- Extend agent transcript adapters and chat ([#5](https://github.com/mihazs/lazysh/issues/5)), exact-pane approvals ([#6](https://github.com/mihazs/lazysh/issues/6)), and usage and companion settings ([#18](https://github.com/mihazs/lazysh/issues/18)).
- Finish file browsing and review ([#10](https://github.com/mihazs/lazysh/issues/10)), forwarded previews ([#11](https://github.com/mihazs/lazysh/issues/11)), and attachments and optional sharing ([#12](https://github.com/mihazs/lazysh/issues/12)).
- Deliver opt-in display keep-awake for the agent board ([#81](https://github.com/mihazs/lazysh/issues/81)).

## Mobile and accessibility

- Complete gestures, text input, clipboard and appearance ([#16](https://github.com/mihazs/lazysh/issues/16)) and internationalization ([#79](https://github.com/mihazs/lazysh/issues/79)).
- Extend on-device voice ([#13](https://github.com/mihazs/lazysh/issues/13)) and optional self-hosted speech recognition ([#345](https://github.com/mihazs/lazysh/issues/345)).
- Complete notifications ([#14](https://github.com/mihazs/lazysh/issues/14)), self-hosted Android delivery ([#344](https://github.com/mihazs/lazysh/issues/344)), Apple companion surfaces ([#15](https://github.com/mihazs/lazysh/issues/15)) and simulator streaming ([#19](https://github.com/mihazs/lazysh/issues/19)).

## Release gates

Each feature issue defines its own acceptance criteria. Native behavior needs real platform evidence where its issue requires it; unit tests or mocks do not replace device acceptance. Release, accessibility and performance verification across platforms remains open ([#20](https://github.com/mihazs/lazysh/issues/20)). F-Droid delivery and inclusion are tracked separately ([#333](https://github.com/mihazs/lazysh/issues/333), [#424](https://github.com/mihazs/lazysh/issues/424)).
