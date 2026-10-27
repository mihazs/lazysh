# @lazysh/client

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
