---
name: lazysh-test-routing
description: Choose the existing lazysh test owner before adding or changing a test. Use for implementation, bug fixes, or CI work that needs a regression test; not for a documentation-only edit.
---

# lazysh test routing

Keep a regression test with the code or automation it verifies. Inspect nearby
tests and package scripts before adding a new test or helper.

- Rust crates and Tauri native code use Cargo unit or integration tests owned by
  their manifest.
- React and TypeScript client code use the client Vitest or Playwright suites.
- Repository automation and workflow contracts use Bun tests under `tests/`.
- Android instrumentation belongs to the generated Android Gradle/JUnit project;
  Apple platform behavior belongs to XCTest targets.

Use the smallest existing task that runs the owning suite. Do not add a custom
test runner, an ad-hoc test script, or a `scripts/` directory. A passing build
does not replace behavioral or device acceptance where the change needs it.
