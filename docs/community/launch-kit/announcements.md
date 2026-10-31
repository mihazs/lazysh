# Announcement drafts — not submitted

## Show HN

Title: Show HN: lazysh – an open-source SSH workspace for remote development

I'm working on lazysh, a Rust/Tauri SSH client for checking and resuming remote
development from mobile and desktop. It connects to your own SSH host. Persistent
work lives in host-side tmux, Herdr or Zellij sessions; the app does not host agents.
An optional companion exposes supported coding-agent records.

This is a development preview. Android ARM64, Linux x64 and Windows x64 release
assets are listed on GitHub; native acceptance varies, and Apple app distribution
is deferred. Android's recommended path is Obtainium with a fixed APK flavor.

Source and current limits: https://github.com/mihazs/lazysh

I'd value concrete feedback on the first SSH connection and reconnect flow,
including the exact version and platform. Please don't include private host data.

## Reddit technical discussion

Title: Building a mobile SSH workspace: how do you validate reconnect usability?

Disclosure: I maintain lazysh, an open-source Rust/Tauri development preview.
The workflow is direct SSH to your own host, with host-side tmux/Herdr/Zellij
persistence and optional supported agent records. Platform acceptance is still
being qualified; this is not a production-readiness announcement.

I'm looking for technical feedback on making first host-key verification and
explicit reconnection understandable on a phone. What failure cases should a
client make most visible? Source, release limits and reproduction templates:
https://github.com/mihazs/lazysh

Post only where current rules permit project discussion and self-promotion.
Do not cross-post identical messages broadly or request votes/stars.

## Developer-community introduction

I'm maintaining lazysh, a preview SSH workspace built with Rust, Tauri 2 and React.
It uses your own SSH server and host-side sessions; agent visibility is optional.
The public issues include documentation and contributor-onboarding work. If the
workflow is relevant to you, the README links installation, limitations and the
contribution guide: https://github.com/mihazs/lazysh

Before using these drafts, add a real reviewed demo only if available, confirm
all release claims, disclose the posting author's actual relationship, and remove
any invitation the maintainer cannot support. No external posts are automated.
