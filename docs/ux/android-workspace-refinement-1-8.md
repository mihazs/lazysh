# Android workspace refinement — current-source brief

Baseline: `312acef54213a88eff048908941bd1da0614d399`, 2026-11-02. Synthetic actual-client Playwright captures at 393×852 and 1280×850 are under `/home/mihazs/.cache/tmp/lazysh-ui-refinement/before/`. No owned SSH data was used.

## Observed remaining problems

- Preferences is a stack of eight disclosures, with a second heading splitting the list. Opening Keyboard → Touch gestures puts a long editor below unrelated categories; category context and Back are absent.
- Agents repeats a reported-session disclosure under every live row, making secondary provenance compete with live work. Workspaces/Agents expose healthy server configuration as another disclosure within the reading flow. Existing live sessions above Spaces and separate Live/Activity navigation already work and must remain.
- Navigation chrome and reading surfaces appear nearly identical; existing glass is subtle. Improve separation on chrome only. Current motion does not communicate settings hierarchy.

## Implementation

Replace preferences disclosures with a single grouped list and dedicated category screens, including separate Input subcategories; retain mounted editors/drafts. On desktop retain category navigation beside the selected category. Contextual Back returns to the parent list with focus restored; explicit Close exits preferences. Keep the existing terminal mounted.

Move healthy Herdr server controls into an explicit contextual settings destination with Back, while exposing missing-server and failed states with a relevant setup action. Keep the genuine shared-focus warning visible. Reduce repeated report metadata to an explicit per-row contextual action without claiming recorded state establishes live ownership.

Refine theme-derived glass on headers/navigation and short contextual surfaces; keep terminal, forms and trees on readable surfaces. Add restrained opacity/transform transitions to navigation detail only; reduced-motion, reduced-transparency and forced-color fallbacks remain immediate/solid.

## Primary guidance

[Android settings](https://developer.android.com/design/ui/mobile/guides/patterns/settings) places infrequent settings in secondary destinations and asks for clear grouping. [Android list/detail](https://developer.android.com/develop/adaptive-apps/guides/list-detail) explicitly describes category→preferences detail on narrow screens and simultaneous panes on wide screens. [AOSP settings guidance](https://source.android.com/docs/core/settings/settings-guidelines) warns against overwhelming lists and favors clear current values. [Apple settings](https://developer.apple.com/design/human-interface-guidelines/settings), [materials](https://developer.apple.com/design/human-interface-guidelines/materials), and [motion](https://developer.apple.com/design/human-interface-guidelines/motion) support task-context controls, restrained hierarchy-defining materials, and purposeful accessible transitions. Official Apple Markdown was retrieved when the JS page did not expose article text. Reference visuals establish design patterns, not native reliability.

## Acceptance

Existing sessions/drafts/terminal identities survive navigation. Category/subcategory Back, Escape, native-back event routing, focus restoration, localization, healthy/error server setup and report provenance remain functional. Validate existing React/browser owners, matched before/after screenshots, 393×852 and desktop plus narrow/tablet/enlarged-text/fallback cases. Run type/build/format/zero gates. Browser geometry and blur do not establish native Android Back/IME/performance; those remain explicitly unexecuted without an owned target.

Tracking: Refs #663 (content hierarchy), #588 (settings navigation), #664 (glass), #806 (motion), #668 (epic). All remain In Progress until source review and public release verification.

## Implemented result and reference limits

Preferences now uses an eight-category index, dedicated long Input editors and a 920px desktop list/detail presentation. Category Back restores its source row and scroll position; explicit Close exits. Editors remain mounted, including unsaved snippets and in-flight font/theme work. Healthy server setup is an explicit header action; automatic loading/failure setup retains Return to terminal and cannot consume the enclosing navigation Back. Live agent rows retain their unverified reported-reference details behind a 44px info action. No reported state is promoted to request authority.

The [publisher personalization guidance](https://getmoshi.app/docs/personalization) supports shared accent/theme and a small elevation distinction; [sidebar documentation](https://getmoshi.app/docs/sidebar) distinguishes topology from status-grouped agents. Retained publisher video frames were independently inspected by the reference agent: compact settings summaries and focused detail, not proof of category/back navigation or measured glass/animation settings. Apple/Android category navigation is our adaptation. Current media download attempts returned403; retained visual references are dated October31 and do not establish current Android behavior.

Glass is bounded to control chrome and short sheets. The normal/reduced pair shows the real app's Workspace tools over actual xterm-rendered synthetic ANSI status rows, with solid buttons and theme-derived material; it does not claim native rendering performance. Navigation borders are restrained rather than an always-cyan focus-like outline.

## Evidence and checks

Matching retained PNGs and SHA256 identities are in [the capture manifest](android-workspace-refinement-1-8/captures.json). All ten before/after states and finite edge-state browser traces remain in the private cache listed above; the public set retains mobile settings/index, Input, Workspaces and Agents, desktop settings/Agents, plus normal/reduced glass.

- Integrated base `1ee3857b`: full client unit owner, **1685 passed**, 110 files, bounded two workers; no timeout/oracle relaxation. Earlier unrestricted parallel run retained15 failures: old selectors, two five-second timeouts, and navigation/Back defects repaired before the green run.
- Browser core preferences/workspace/shortcut owners: **45 passed, 3 existing skips**. Revised category flow covers real category/subcategory navigation, synthetic native-Back event, Escape while Close is focused, desktop category-rail focus access, mounted draft identity,320/600/768/1280 widths with20px text, forced colors and reduced motion. Existing workspace owners retain exact session/reader/draft/reading-position, healthy/missing/unhealthy integration and confirmed-action assertions,393px safe-area and short-height cases.
- Font/theme locale owners after the shared explicit-close helper repair: **18 passed**. The earlier16 overlay-interception failures are retained. These checks preserve operation identity, drafts, exact export bytes and locale/pseudolocale rendering.
- Final glass/contrast owner: **3 passed,1 existing desktop skip**; text/control contrast oracle remains≥4.5, short-sheet controls remain touchable, and reduced transparency removes blur and restores a solid background.
- Android source-contract owners: **222 passed**,1609 assertions. Native GUI TypeScript check, frontend build, Cargo formatting and strict zero-clone scan passed; final source/log manifest records exact command receipts.

Local inventory: SDK adb exists; zero attached devices and no `/dev/kvm`. Android Back, IME, touch reliability and rendering performance on the changed UI were **not executed**. Browser synthetic native-back events are frontend routing evidence only. Kotlin/Java compilation and native source adapters are separately recorded, not native runtime acceptance. No version/release delivery is claimed by this source work.

Native selector adapters compiled with the repository toolchain: Kotlin15s and Java12s passed. The initial Kotlin helper referenced an unimported `fail`; its compiler failure36s is retained, and the repair throws `AssertionError` directly. Rust compilation was excluded from these Gradle tasks. No instrumentation/device/runtime acceptance was executed.

The canonical client strict lint command (`bun run --cwd apps/client lint`, shared existing Cargo cache, two jobs) passed all client targets with `-D warnings` in2m37s. No features, profiles, clone thresholds or handwritten-source exclusions were changed. A final review removed accidental blank lines only from PreferencesPanel; handlers and content remain identical. Full workspace Rust tests were not rerun for this UI-only production change.
