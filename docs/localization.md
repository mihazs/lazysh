# Interface localization

The bundled catalogs cover English (`en`), Brazilian Portuguese (`pt-BR`) and
Spanish (`es`) for the shell, host editor and connection dialogs, Preferences
and its theme, font, icon and shortcut controls, and renderer access settings. Transcript, Usage and the notification inbox
also have app-owned labels, controls and validation in all three catalogs.
This is a partial milestone under issue #79. Other feature panels and native
platform permission/lock-cover text still require their own localization and
acceptance. Selecting an interface language does not change native OS controls.

App language offers **System** (the unchanged default), **English**,
**Português (Brasil)** and **Español**. System uses the first supported language
in the first 16 `navigator.languages` entries. Portuguese tags use the Brazilian
catalog and `pt-BR` formatting; no Portuguese-from-Portugal catalog is included.
English and Spanish regional tags preserve regional `Intl` number/date
formatting. Other or malformed languages fall back to English. Explicit choices
use `en`, `pt-BR` or `es`. The validated `uiLanguage` preference persists and syncs;
older backups default to System. Reset preferences restores System. No language
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
- `bun run check` checks catalog keys and required interpolation arguments.

`src/test/pseudoLocale.ts` is a test fixture, not a supported language or a
persisted preference. Browser tests load it explicitly to expand labels while
preserving interpolation. The coverage test audits static text in the covered
workflow; it does not claim all application strings are localized. Synthetic
browser tests do not establish physical-device permission or system-language
behavior.
