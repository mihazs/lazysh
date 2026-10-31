# Maintainer configuration checklist

Repository files do not configure GitHub settings. The connected GitHub tools in
this execution provide contents/issues/PR operations, but no repository-settings,
Discussions-category or social-preview write operation. These actions are pending;
admin permission in metadata alone does not prove an available mutation capability.

## Discovery

In the repository's **About** editor, retain accurate target/maturity language.
Suggested description: “Open-source SSH workspace for mobile and desktop, with
host-side persistent sessions and optional coding-agent visibility. Preview.”
Existing topics already include SSH, Android, Tauri, Rust, tmux and remote development.
Consider `codex`, `zellij` and `open-source` only when still descriptive; do not
remove relevant current topics merely to change them. Set a homepage only after
an actually deployed public page is verified. Pages was disabled at audit time.

Use the existing [brand kit](../../brand/lazysh/README.md). A social preview should
show the wordmark and short direct-SSH proposition, not invented screenshots.
Upload a reviewed export through **Settings → General → Social preview**; verify
cropping in GitHub's preview. The launch kit contains [copy](launch-kit/introductions.md).

## Private vulnerability reports

In **Settings → Advanced Security → Private vulnerability reporting**, enable the
feature if absent, then check the public **Security → Advisories** page for
**Report a vulnerability**. Set maintainers' security notifications and test form
availability without filing a fake vulnerability. Record verified date/state in
SECURITY.md; no private contact is assumed beforehand. Establish a separate
private conduct-reporting route and update CODE_OF_CONDUCT.md after verification.

## Discussions and labels

If maintainers can moderate it, enable **Settings → General → Features → Discussions**.
Create Announcements (announcement format), Questions and Support (Q&A), Ideas
and Feature Requests (open-ended), Show and Tell (open-ended), and Contributor Help
(Q&A). Check names/formats in the Discussions category editor before saving.
Preserve existing issue bug tracking. Link Discussions from SUPPORT.md only after
public availability is confirmed; until then questions may use issues.

Check existing labels before adding `good first issue`, `help wanted` or
`documentation`. Apply beginner labels only to the bounded tasks linked from
[starter tasks](starter-tasks.md), after dependency review. Do not tag native
reliability, signing, SSH trust or large parity tasks as beginner-friendly.

## Release and ownership

The release maintainer owns maturity claims, contributor credits and download
links; a reviewer owns privacy review of capture assets; the weekly rotating
triager owns the scorecard and unanswered contributor issues. These are roles,
not invented named volunteers. Agree on assignments before promising response times.
Do not disturb #632's held release source cut. After it resolves, update/review
community branches against current main, run required gates, then include the
patch Changeset in the normal reviewed subsequent release and verify publication.
