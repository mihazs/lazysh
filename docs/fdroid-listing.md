# Android listing preparation

The English fallback listing lives at
`fastlane/metadata/android/en-US/`. Its title follows the application name;
the short and full descriptions describe the development preview, optional
host dependencies and deliberately limited agent integration claims. These
are ordinary source files, not Fastlane executable configuration.

The listing states that lazysh is free and open-source and all app features
are free to use. This does not promise completed feature parity or free
external hosts, AI providers or services.

Maintain UTF-8, LF line endings and a final newline. The project's listing is
plain text. F-Droid permits at most 50 characters for the title, 80 for the
summary and 4000 for the full description. The summary and full description
are required; the English locale is its fallback. See the official
[listing specification](https://f-droid.org/docs/All_About_Descriptions_Graphics_and_Screenshots/).

Run the existing native test entry with
`bun test tests/release-version.test.ts -t 'English Fastlane listing'`.
The existing `bun run test:release` workflow also executes these checks.
They validate the actual committed files, text encoding, character bounds and
application-name agreement. They do not replace F-Droid metadata/build checks.

The listing now includes the project's original, GPL-licensed 512px icon
(`brand/lazysh/platform/play-store-512.png`) and three existing 393x852
mobile-width application frontend captures from the reviewed 1.4.0 UX study:
Home, Hosts, and Terminal. Those screenshots use **synthetic host/session
data and a synthetic native bridge in Playwright**, not an actual Android
device. Their exact sources and limitations are documented in
`docs/ux/android-workspace-benchmark.md`. Do not treat these captures as
native execution, live SSH or current full product acceptance. Replace them
with separately reviewed native Android screenshots if F-Droid maintainers
require device-native evidence.

An English and Brazilian Portuguese release note was added for the published
`v1.4.0` Android `versionCode=1004000`; both are bounded to 500 characters.
The listing descriptions and notes should reflect only verified product
capabilities and make clear that third-party hosts/services can incur
independent costs.

The graphics, translations and notes support the listing; they do not prove
F-Droid policy compliance or release readiness. The source-build toolchain,
transitive dependency licensing, pinned Bun bootstrap, review of optional
external services, source/binary scanning, approval and publishing remain
separate gates in [#333](https://github.com/mihazs/lazysh/issues/333).
