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

The listing also has a pt-BR translation, the brand icon
(`brand/lazysh/platform/play-store-512.png`) and six phone screenshots. The
screenshots are the README captures in `docs/assets/readme/`: the real app on
the Waydroid guest, connected to the owned demo host with harmless files (see
`docs/how-to/capture-readme-media.md`). When those captures are refreshed, copy
`terminal`, `agent-chat`, `agent-approval`, `sessions`, `files` and `hosts`
to `images/phoneScreenshots/1.png` through `6.png`, in that order.

`bun run release:version` writes `en-US/changelogs/<versionCode>.txt` for each
release. It lists the release's user-facing headlines (feat, perf, fix), cut to
F-Droid's 500-character limit, and ends with a link to the full GitHub release
notes.

F-Droid acceptance is tracked in the inclusion merge request
[fdroiddata!59438](https://gitlab.com/fdroid/fdroiddata/-/merge_requests/59438)
and under
[#333](https://github.com/mihazs/lazysh/issues/333). F-Droid reads these files
from the source tag it builds.
