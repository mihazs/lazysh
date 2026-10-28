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

There are no listing screenshots, promotional graphics or release notes yet.
Only add screenshots from actual reviewed application captures with synthetic
data and verified permission to redistribute. Test image fixtures are not
product screenshots. Existing app icons need a documented provenance/license
basis before being copied into the listing; no vendor artwork is included here.
Create `changelogs/<versionCode>.txt` only for a corresponding reviewed release,
using its literal Android versionCode and at most 500 characters. The presence
of source version metadata alone does not mean a release has been published.

Basic listing text does not meet the separate Latest-tab criteria: graphics,
release notes and translated metadata remain unprovided. F-Droid acceptance,
the Google-free build, source-build scanning, signing/tagging and the first
real build recipe remain separate gates under
[#333](https://github.com/mihazs/lazysh/issues/333). No store submission or
publication is performed by adding these files. The eventual recipe and
source checkout must also pass the supported F-Droid buildserver tools.
