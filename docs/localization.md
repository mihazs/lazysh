# Interface localization

The bundled catalogs cover English (`en`), Brazilian Portuguese (`pt-BR`) and
Spanish (`es`) for the shell, host editor and connection dialogs, Preferences
and its theme, font, icon and shortcut controls, and renderer access settings.
Transcript, Usage and the notification inbox also have app-owned labels, controls
and validation in all three catalogs. Remote file browsing, upload consent, Git
working-tree/history review, side-by-side diffs, line-comment controls and syntax
highlighting controls are covered too. File contents, paths, commit subjects,
patches and annotation payloads remain verbatim. Browser preview controls, listener
discovery and port validation, manual notes and DOM-picker captions/statuses also
use these catalogs. Language changes preserve the iframe and picker channel; page
content and staged annotation payloads are never translated. App-owned validation
and persistent picker statuses translate when rendered, including errors already
visible when the language changes. Raw native diagnostics remain verbatim.
Cloud dictation enrollment and quota settings, and dictation history controls and
local errors, are also covered. These changes preserve transcription content,
engine/model identifiers, native diagnostics, capture revisions and storage
epochs. Main Voice engine/model/recording/delivery controls, local validation and
retained download/import/asset/transcription/delivery progress are also covered.
Engine/model names, recognition-language codes and endonyms, and received native
capability reasons remain verbatim. Local initial fallback explanations are
distinguished from received native reasons, including an empty native reason.
Changing interface language does not change recognition language, microphone
ownership, request IDs, cancellation, input claims or direct/Enter opt-in state.
Agent activity columns, explicit one-request approval controls and server companion
settings also use all three catalogs. Agent names, summaries, tool JSON, paths,
session/pane identities and native diagnostics remain verbatim. Language changes
preserve pending decisions, their original hashes and polling interval, and
unsaved companion switches. Keep Awake controls and multiplexer prefix shortcuts
also use the catalogs. Language changes preserve acknowledged display ownership,
release/error identity, explicit opt-in, prefix drafts and exact ASCII input steps.
Native display reasons and terminal diagnostics remain verbatim, including empty
values; localized labels do not establish physical display-timer acceptance.
Host attachment selection, crop/drawing controls, explicit upload/copy/staging
actions and retained local errors/notices also use the catalogs. Language changes
preserve selected file bytes, original crop coordinates, canvas resources,
upload destinations and editable prompts. The initial prompt uses the language
active when the explicit upload completes; later language changes never rewrite
that prompt or user edits. Public sharing enrollment, expiring uploads/history, explicit link copying and
revocation, sanitized thumbnail controls and retained client-owned errors/statuses
also use all three catalogs. Interface changes preserve credentials/file drafts,
TTL values, upload/chunk/cancellation IDs, thumbnail resources and raw share
metadata/addresses. No service, clipboard or revoke action runs because the
language changes. Native diagnostics remain verbatim. Closing-dialog upload warnings retain only
a finite client-created error cause in the existing App event route; raw strings
and ordinary objects preserve the original String conversion.
Host device discovery, screenshots, video preview controls, input/lifecycle
buttons and client-owned validation also use the catalogs. Device names, IDs,
reported SDK states/warnings, socket paths and native errors remain verbatim.
Changing language does not restart a stream, replace its pending pull or frame,
reset input opt-in, refetch inventory or submit a lifecycle action. Reboot and
shutdown retain their explicit confirmation; protocol key names stay unchanged.
tmux Jump To also translates its layout controls, current-window marker and
navigation guidance. Native error text remains a separate raw text node beside
the translated unavailable prefix. Window indexes use locale-aware formatting;
session/window names, native generations and target IDs remain unchanged.
Language changes retain the layout, focused control and in-flight requests.
Remote push registration controls and their
client-owned contact/privacy/error messages now use all three catalogs too.
Changing language preserves checked consent and pending native operation/recovery
identity; it never requests notification permission or registers/revokes a token
by itself. Native status reasons, including empty text, and Apple APNs/Google
Firebase names remain verbatim. Existing generic operation errors continue to
hide provider diagnostics; native permission sheets remain outside this renderer.
SSH identity generation/import controls, in-memory credential explanations and
the local public-key clipboard error also use the catalogs. Language changes
preserve focused key/passphrase drafts, pending request identity and raw public
metadata/native diagnostics; they never generate, inspect, copy, select or save
credentials. Private-key headers and cryptographic identifiers remain literal.
Terminal-owned controls, session-ended guidance, remote clipboard consent, link
confirmation, retained search results, composer actions and D-pad accessibility
labels also use the three catalogs. Search stores its line/empty result rather
than a pretranslated sentence; terminal-created local errors retain finite causes
through the existing App error route. Language changes preserve the xterm/session,
addons and callback registration, query and draft bytes, Control state, explicit
clipboard consent and in-flight clipboard/browser operations. They never copy,
paste, open a URL, reconnect or dispatch input by themselves. Technical keycaps,
user snippet/chord labels and bindings, raw terminal output, URLs, session names
and native error strings remain verbatim. Retained device-font validation errors
and fallback warnings also translate when rendered, including missing font roles
and names in load warnings. Language changes do not repeat IndexedDB transactions,
FontFace loading, import or deletion. Font bytes, IDs, families and persisted names
stay unchanged, and raw browser/storage diagnostics stay literal. Shared advanced
and simple chord-parser validation errors also retain finite causes and literal
key/step data. ChordBuilder and synchronous terminal parser-error paths translate
these causes when rendered, preserving drafts, modifiers, focus, existing raw-error
formatting and exact dispatch bytes. Grammar, aliases, limits and stored bindings
are unchanged; language changes do not save or replay input. This does not claim
a complete audit of all retained messages elsewhere in the application.
This is a partial milestone under issue #79. Other feature panels still require
their own localization and acceptance.
Native lock-cover/biometric-reason resources on
Android, iOS and macOS use the [native language authority](native-ui-locale.md).
Apple permission purposes have separate bundled resources below;
selecting an interface language does not change native OS controls.

App language offers **System** (the unchanged default), **English**,
**Português (Brasil)** and **Español**. System uses the first supported language
in the first 16 `navigator.languages` entries on frontend-authority platforms
(browser, Windows and Linux). Android, iOS and macOS use the native choice and OS
resolution described in the native-language document. Portuguese tags use the Brazilian
catalog and `pt-BR` formatting; no Portuguese-from-Portugal catalog is included.
English and Spanish regional tags preserve regional `Intl` number/date
formatting. Other or malformed languages fall back to English. Explicit choices
use `en`, `pt-BR` or `es`. The validated `uiLanguage` preference persists and syncs;
older frontend backups default to System. Native-authority reset/import and
first-upgrade behavior follow the native-language document. Reset preferences
restores System. No language
resources are fetched remotely.

## Adding interface text

Keep app-local English keys in `apps/client/src/i18n/en.ts`. Supply Brazilian
Portuguese and Spanish in `translations.ts`: each key has a required
`[Brazilian Portuguese, Spanish]` pair. TypeScript rejects missing/unknown keys;
the catalog test verifies every placeholder and required CLDR plural category.
Technical terms, key names and commands inside explanations must stay exact.
Use the zero plural override for zero sessions and supply one/many/other forms.
For a formatted quantity, pass its display text as a separate interpolation value
and the original numeric `count` for plural selection (for example `usageMinutes`).
These catalogs are authored interface text, not a machine-translation service.

Import `t` and call
`useUi()` inside rendering components so language changes update existing views.
`t` requires known keys and the interpolation names declared in that key. Use a
complete sentence rather than concatenating fragments, and plural resources with
`count` when the sentence varies by quantity. Render the result as normal React
text; never inject translated HTML. `formatNumber` and `formatDate` use built-in
`Intl` and the resolved interface locale. Raw timestamps and protocol values stay
unchanged.

Only app-owned labels and explanations belong in the catalog. Preserve terminal
output, transcripts, remote diagnostics, native error reasons, commands, shortcut
bytes, host/session names and other user content verbatim. Localizing a display
label must not change an enum, URL route, persistence key, transport selection or
native access lease. Do not use translated labels as CSS or behavior selectors.
Language changes subscribe existing components; they must not remount terminals,
reconnect sessions or refetch credentials.

The catalog deliberately stays app-local until a real native consumer requires a
shared contract. Native permission text and OS language selection are not governed
by this TypeScript catalog. English fallback and interpolation/plural validation are required for every
catalog. Native permission-label coverage and platform acceptance are required
before claiming end-to-end language support. Notification action titles use the
active interface language when the existing listener registration runs; changing
language does not restart polling/listeners or request OS permission again.
Native notification body/permission text remains outside this renderer catalog.

## Apple permission explanations

The main Apple app bundles English, Brazilian Portuguese and Spanish
`InfoPlist.strings` tables from `src-tauri/apple/Localizations`. They localize the
existing Face ID and microphone purposes; the base `Info.plist` supplies English
fallback. The microphone text covers the selected dictation engine. This adds no
new permission request or change to the selected engine.

Apple resolves these resources using its app/OS language selection. The in-app
language preference does not force system permission sheets into another
language. See Apple's [localized property-list guidance](https://developer.apple.com/library/archive/documentation/General/Reference/InfoPlistKeyReference/Articles/AboutInformationPropertyListFiles.html)
and Tauri's [macOS localization packaging](https://v2.tauri.app/distribute/macos-application-bundle/#infoplist-localization).
XcodeGen includes the localization group in the iOS app; the macOS-specific Tauri
resource map preserves each `.lproj` directory at the bundle resource root.

The existing actual-app XCTest target checks the installed iOS host's three
literal resource paths, purpose keys, fallback values and Foundation lookups. It
does not display a permission prompt or verify physical-device OS language
behavior. The macOS hosted gate runs Tauri's app bundler and Apple's `plutil` on
the three packaged tables; compilation without bundling does not verify resources.
Native lock-cover and biometric-reason localization remain separate issue #79 work.

## Verification

Run the existing project tasks from `apps/client`:

- `bun run test src/i18n` covers negotiation, typed interpolation, missing-key
  fallback, safe text, pluralization, formatting and preference persistence.
- `bun run test:e2e e2e/i18n.spec.ts` checks desktop and phone widths, a live
  synthetic terminal, preserved host drafts, diagnostics, keyboard focus and
  expanded labels, plus actual Brazilian Portuguese and Spanish UI workflows.
- `bun run test src/i18n/recordedPanels.test.tsx` exercises translated staging,
  usage inspection and explicit inbox actions with synthetic native responses,
  unchanged original access headers and preserved renderer identities.
- `bun run test:e2e e2e/recorded-panel-locales.spec.ts` checks real panel rendering
  and long labels at desktop/phone widths, raw records and exact action targets.
- `bun run test src/i18n/fileReview.test.tsx` verifies original file/revision
  targets, request headers, pending labels and editable annotation identity.
- `bun run test:e2e e2e/file-review-locales.spec.ts` checks all three locales at
  desktop/phone widths, explicit upload consent, syntax highlighting, comment
  focus, historical selection and verbatim diff contents across language changes.
- `bun run test src/i18n/previewLocales.test.tsx` exercises held preview operations,
  retained validation/raw errors, authenticated picker transitions and original
  access headers without extra requests on a language change.
- `bun run test:e2e e2e/preview-locales.spec.ts e2e/previews.spec.ts` checks actual
  cross-origin selection, iframe/focus/channel identity, security-policy fallback,
  and unchanged annotation payloads at desktop/phone widths.
- `bun run test src/i18n/cloudHistoryLocales.test.tsx` checks held enrollment and
  transcription, original protected request headers, retained errors and history
  entry/capture identity across all three locales.
- `bun run test:e2e e2e/cloud-history-locales.spec.ts e2e/cloud-voice.spec.ts e2e/voice-history.spec.ts`
  checks translated actions in the real Voice view, in-flight transcription and
  draft continuity, saved-history consent/retry and no IndexedDB transactions
  caused by language changes.
- `bun run test src/i18n/voiceLocales.test.tsx` checks original recording and
  channel ownership, request headers, recognition language, native reason text,
  retained progress/local errors and one-shot Enter claims across locales.
- `bun run test:e2e e2e/voice-locales.spec.ts e2e/direct-dictation.spec.ts` checks
  actual App/Voice/bridge recording and direct-delivery state at desktop/phone
  widths, unchanged drafts and one queued final payload across language changes.
- `bun run test src/i18n/agentBoardLocales.test.tsx` checks held allow/deny
  decisions, original access headers and target hashes, polling continuity,
  expired and stale-session actions, settings revisions and visible errors.
- `bun run test:e2e e2e/agent-board-locales.spec.ts` checks the actual board at
  desktop/phone widths, unchanged raw records, focused unsaved switches and
  one held approval across all three locales.
- `bun run test src/i18n/attachmentLocales.test.tsx` checks held uploads, exact
  bytes/path/session/access headers, stale results, clipboard consent/failures,
  retained local/raw errors, editable prompts and canvas resource continuity.
- `bun run test:e2e e2e/attachment-locales.spec.ts` checks real browser image
  decode/crop/drawing at desktop/phone widths in all three locales, held upload
  targets and explicit clipboard/staging actions without rewriting draft content.
- `bun run test src/i18n/shareLocales.test.tsx` checks original credentials/chunk
  bytes/offsets/TTL/access headers, held cancellation/thumbnail state and explicit
  copy/delete/forget actions, with live finite errors and raw diagnostics.
- `bun run test:e2e e2e/share-locales.spec.ts` checks Share in all three locales at
  desktop/phone widths, focused credential/file drafts, real sanitized thumbnail
  identity, cancellation followed by acceptance and explicit link copy/revocation.
- `bun run test src/i18n/credentialsLocales.test.tsx src/CredentialsPanel.test.tsx`
  checks the UTF-8 passphrase boundary, original protected arguments, held and stale
  results, private-result visibility, raw errors and explicit clipboard/use actions.
- `bun run test:e2e e2e/credentials-locales.spec.ts` checks all three locales at
  desktop/phone widths, focused secret drafts, unchanged synthetic key material,
  public-key copying, explicit use and retained clipboard errors. No real key
  generation, native vault access or OS clipboard permission is exercised.
- `bun run test src/TerminalPane.test.tsx src/i18n/catalogs.test.ts src/i18n/coverage.test.ts`
  checks actual Portuguese/Spanish controls, stable editor/terminal/handler identity,
  retained search/modifier state, held clipboard/link ownership and live local
  error causes while preserving native text and exact key/paste bytes.
- `bun run test:e2e e2e/i18n.spec.ts --grep terminal-owned` checks the real xterm
  renderer at desktop/phone widths in English, Brazilian Portuguese and Spanish,
  explicit OSC clipboard consent, raw content, draft/focus continuity and Control
  bytes through a synthetic native bridge/clipboard. No OS permission is requested.
- `bun run check` checks catalog keys and required interpolation arguments.
- `bun run test src/i18n/pushLocales.test.tsx src/PushSettingsPanel.test.tsx`
  checks consent, held register/revoke, original access headers, one recovery read,
  stale-result rejection and retained failure messages across all three catalogs.
- `bun run test:e2e e2e/push-locales.spec.ts` checks actual registration controls
  at desktop/phone widths with synthetic FCM/APNs metadata, preserved focused
  consent and explicit revocation/retry, without native permission/provider calls.
- `bun run test src/i18n/deviceLocales.test.tsx src/DevicePanel.test.tsx src/useDeviceStream.test.tsx`
  checks held stream startup/pulls, idle/sequence/identity validation, original
  request headers, screenshot timers, Android pixels and verified iOS point coordinates.
- `bun run test:e2e e2e/device-locales.spec.ts` checks real JPEG image decoding and
  stable frame DOM/source, video ownership, input opt-in, explicit confirmation
  and focused iOS socket drafts at desktop/phone widths in all three catalogs.

`src/test/pseudoLocale.ts` is a test fixture, not a supported language or a
persisted preference. Browser tests load it explicitly to expand labels while
preserving interpolation. The coverage test audits static text in the covered
workflow; it does not claim all application strings are localized. Synthetic
browser tests do not establish physical-device permission or system-language
behavior.
