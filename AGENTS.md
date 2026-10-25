# Development workflow

Use trunk-based development.

- Fetch the latest `main` before starting work. Create every work branch and worktree from `main` or `origin/main`.
- Never branch from another feature, fix, or documentation branch. Do not create stacked pull requests.
- Target `main` for every pull request and merge completed work into `main`.
- If a change depends on another change, merge that prerequisite into `main` first, then start the dependent branch from updated `main`.
- Keep branches short-lived. Track work with GitHub issues, the project board, and pull requests.
- Review changes, address findings, and run relevant checks. Once ready, merge autonomously; do not leave a ready pull request open awaiting user confirmation.
- Create every Git worktree under `~/dev/.worktrees/`.
