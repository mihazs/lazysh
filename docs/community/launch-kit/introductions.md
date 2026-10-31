# Project introduction drafts

## Short introduction

lazysh is an open-source SSH workspace for mobile and desktop. Connect directly
to your own development machine, return to host-side tmux, Herdr or Zellij
sessions, and optionally inspect supported coding-agent records. It is a
development preview; check current platform and signing limits before installing.

## Technical introduction

lazysh combines Rust, Tauri 2, React and xterm.js in a client for remote development.
Ordinary SSH connects directly to servers you control, with explicit host-key
verification. Long-running work persists according to the host-side multiplexer's
configuration. An optional companion provides supported agent records over the
existing SSH connection; records do not prove an agent is currently running.

Preview artifacts and source builds have different platform acceptance limits.
Android installation is preferably managed with Obtainium using the project's
GitHub releases and an explicit APK flavor filter. Apple application distribution
is deferred. See the release-specific installation guidance before relying on
any workflow. Contributions to documentation, translations and small verified
improvements are welcome through the public issues and normal reviewed PRs.

## GitHub social preview copy

lazysh
SSH into your own development workspace.
Host-side sessions. Optional coding-agent visibility.
Open source · Development preview

Use this text beside the existing wordmark. It describes the project; it is not
a screenshot, testimonial, platform-certification badge or adoption statistic.
