# @lazysh/client

## 0.10.0

### Minor Changes

- 491a8b9: Add uploaded host-local attachment paths explicitly to an existing Chat draft without automatic send or clipboard effects.

### Patch Changes

- @lazysh/common@0.10.0
  - @lazysh/display-idle@0.10.0
  - @lazysh/et-transport@0.10.0
  - @lazysh/mosh-transport@0.10.0

## 0.9.1

### Patch Changes

- 1f4aa2b: Translate retained access-status and unlock failures when the interface language changes without repeating native access work or changing access policy.
- @lazysh/common@0.9.1
  - @lazysh/display-idle@0.9.1
  - @lazysh/et-transport@0.9.1
  - @lazysh/mosh-transport@0.9.1

## 0.9.0

### Minor Changes

- ee9c0a9: Add explicit confirmed Chat input for original guarded Herdr terminals with candidate cleanup, preserved transcript/session authority and manual fallback.

### Patch Changes

- @lazysh/common@0.9.0
  - @lazysh/display-idle@0.9.0
  - @lazysh/et-transport@0.9.0
  - @lazysh/mosh-transport@0.9.0

## 0.8.0

### Minor Changes

- 0a66ded: Add native guarded Herdr attachment and access-bound terminal input prerequisites without enabling frontend controls.

### Patch Changes

- @lazysh/common@0.8.0
  - @lazysh/display-idle@0.8.0
  - @lazysh/et-transport@0.8.0
  - @lazysh/mosh-transport@0.8.0

## 0.7.1

### Patch Changes

- a73287a: Defer iOS status review registration until native plugin initialization completes, preserving existing readiness and privacy behavior.
- @lazysh/common@0.7.1
  - @lazysh/display-idle@0.7.1
  - @lazysh/et-transport@0.7.1
  - @lazysh/mosh-transport@0.7.1

## 0.7.0

### Minor Changes

- f852631: Accept one explicit saved-host or multiplexer request in an already-running desktop app, preserving current dialogs, original access receipts and normal authentication.

### Patch Changes

- @lazysh/common@0.7.0
  - @lazysh/display-idle@0.7.0
  - @lazysh/et-transport@0.7.0
  - @lazysh/mosh-transport@0.7.0

## 0.6.0

### Minor Changes

- 5791a6e: Extend explicitly chosen and confirmed tmux terminal input to all 17 native Chat readers, with immutable Hermes/OpenCode session selectors and unchanged Stage defaults.

### Patch Changes

- @lazysh/common@0.6.0
  - @lazysh/display-idle@0.6.0
  - @lazysh/et-transport@0.6.0
  - @lazysh/mosh-transport@0.6.0

## 0.5.0

### Minor Changes

- 9b9a761: Support explicitly confirmed multiline Chat terminal input and tabs through bounded native tmux paste without newline normalization. Stage remains default; bracketed paste depends on the terminal program, and interrupted input is never automatically resent.

### Patch Changes

- @lazysh/common@0.5.0
  - @lazysh/display-idle@0.5.0
  - @lazysh/et-transport@0.5.0
  - @lazysh/mosh-transport@0.5.0

## 0.4.0

### Minor Changes

- 0232b02: Add explicit Claude Chat Send and Request stop for a confirmed existing tmux
  terminal. Stage remains the default, unsupported drafts keep the terminal
  fallback, and uncertain input is never resent automatically.

### Patch Changes

- @lazysh/common@0.4.0
  - @lazysh/display-idle@0.4.0
  - @lazysh/et-transport@0.4.0
  - @lazysh/mosh-transport@0.4.0

## 0.3.0

### Minor Changes

- c997e5f: Add explicitly opted-in Claude reported-history metadata and a selected-row shortcut into Chat. Source files remain unread until Open transcript; reported history does not verify a running agent or enable direct Send/Stop. Existing capture, image and Follow defaults remain off.

### Patch Changes

- @lazysh/common@0.3.0
  - @lazysh/display-idle@0.3.0
  - @lazysh/et-transport@0.3.0
  - @lazysh/mosh-transport@0.3.0

## 0.2.1

### Patch Changes

- 0e21551: Keep retained transcript validation and read alerts in the current interface language without repeating reads or altering raw host diagnostics.
- @lazysh/common@0.2.1
  - @lazysh/display-idle@0.2.1
  - @lazysh/et-transport@0.2.1
  - @lazysh/mosh-transport@0.2.1

## 0.2.0

### Minor Changes

- 65bb97a: Add explicit bounded previews for recorded Codex user PNG/JPEG data-URL images in Records. Image inclusion remains off by default; file references and unsupported media stay inert.

### Patch Changes

- 3be70f8: Resolve native application versions from the synchronized client manifest so Android and Apple generators receive the product version instead of their missing-version defaults. Application identifiers, stored data and protocol schemas are unchanged.
- 284538b: Keep recorded-usage validation messages in the selected language after a locale change, without repeating requests or altering raw host diagnostics.
- b2600f0: Keep retained transcript-discovery validation alerts in the current language without repeating discovery or changing raw host diagnostics.
- e7c2c75: Track product versions and generated package changelogs through reviewed release pull requests, keeping Bun, Cargo and Tauri versions aligned. This does not publish binaries or packages, create tags, or change application defaults.
- @lazysh/common@0.2.0
  - @lazysh/display-idle@0.2.0
  - @lazysh/et-transport@0.2.0
  - @lazysh/mosh-transport@0.2.0
