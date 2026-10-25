# Interface localization

The first localization milestone bundles English for the shell, host editor and
connection dialogs, Preferences and its theme, font, icon and shortcut controls,
and the app access cover/settings. It does not complete issue #79. Other feature
panels, native platform permission explanations and additional translated
languages still require their own coverage and acceptance.

App language offers **System** (the default) and **English**. System selects a
supported English language tag from `navigator.languages`, preserving regional
`Intl` number/date formatting. Other or malformed languages fall back to English.
Explicit English uses `en`. The validated `uiLanguage` setting persists with
preferences and is accepted by settings sync; older backups default to System.
Reset preferences restores System. No language resources are fetched remotely.

## Adding interface text

Keep app-local English keys in `apps/client/src/i18n/en.ts`. Import `t` and call
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
by this TypeScript catalog. A new supported translation must include English
fallback, interpolation/plural validation, native permission-label coverage and
platform acceptance before being advertised.

## Verification

Run the existing project tasks from `apps/client`:

- `bun run test src/i18n` covers negotiation, typed interpolation, missing-key
  fallback, safe text, pluralization, formatting and preference persistence.
- `bun run test:e2e e2e/i18n.spec.ts` checks desktop and phone widths, a live
  synthetic terminal, preserved host drafts, diagnostics, keyboard focus and
  expanded labels.
- `bun run check` checks catalog keys and required interpolation arguments.

`src/test/pseudoLocale.ts` is a test fixture, not a supported language or a
persisted preference. Browser tests load it explicitly to expand labels while
preserving interpolation. The coverage test audits static text in the covered
workflow; it does not claim all application strings are localized. Synthetic
browser tests do not establish physical-device permission or system-language
behavior.
