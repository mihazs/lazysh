# Optional pinned Noto CJK font

Open Preferences → Imported fonts → **Download Noto Sans Mono CJK SC** to fetch
one unmodified font from the official Noto GitHub source. Nothing downloads when
settings opens, and downloading never selects a font automatically. After the
local import completes, choose its entry in **Imported CJK fallback**. The existing
font manager limits that face to CJK Unicode ranges so Latin text retains the
primary font. Select the installed entry again without downloading; delete it
through the existing local font controls.

The download uses the existing four-entry, 24-MiB-per-font and 48-MiB-total budgets.
It creates an ordinary device-local font entry, so repeated explicit downloads
can create additional entries and consume those budgets. There is no background
fetch, arbitrary URL, automatic retry or settings-sync transfer of font bytes.
Source-host/network availability and mobile data costs still apply.

## Provenance and license

| Field | Pinned value |
| --- | --- |
| Publisher | official `notofonts/noto-cjk` repository |
| Commit | `f8d157532fbfaeda587e826d4cd5b21a49186f7c` |
| File | `Sans/Mono/NotoSansMonoCJKsc-Regular.otf` |
| Exact bytes | `16393784` (about 15.63 MiB) |
| Git blob | `5ff7011ee3c76bb800e3c7ed0ed496427c3477de` |
| SHA-256 | `ec04cc376b34887cedbdf84074e2e226ed2761eeabdcb9173fc1dd7bfd153ef7` |

A controlled public download was checked against the independent pinned GitHub
file size/blob metadata before computing the SHA-256 used by the client. The font
binary is not bundled in the application or committed as a test fixture. Its
unmodified [upstream SIL Open Font License 1.1](https://github.com/notofonts/noto-cjk/blob/f8d157532fbfaeda587e826d4cd5b21a49186f7c/Sans/LICENSE)
is retained verbatim in `apps/client/src/font-licenses/NotoSansMonoCJK-OFL.txt`
and available within settings. That exact third-party legal notice is explicitly
outside duplication scanning; all handwritten downloader, UI and test code remains
scanned. The license notice is bundled; the optional OTF is not.

## Bounds and ownership

The production request is a literal commit-pinned HTTPS GET, with credentials and
referrer omitted, redirects rejected, no-store caching and a two-minute network
transfer deadline. CSP admits that exact asset path and existing IPC sources;
other external font paths are not permitted. CSP matching follows browser policy
semantics; the downloader itself never accepts a caller URL or adds a query.
The bounded reader allocates only the known asset size, requires exact EOF/length
and SHA-256 before parsing, and throttles byte progress. Verified owned bytes go
straight into the existing importer without intermediate Blob/File copies.

One download/import job remains owned until its browser work settles, including
a cancelled decoder. Closing settings (unmounting its owner) or revoking its original access aborts the
request; there is no authority refresh or new download from an old callback.
Cancel stops future admission and selection remains unchanged. Browser hashing or
font parsing may finish after cancel; a transaction already admitted can leave a
completed local cache entry. This is not rollback or a hard cancellation deadline
for native browser font parsing. Remove any retained entry through the existing
font controls. Storage budgets and original permission are checked again before
store admission; failures preserve the selected font.

## Validation and remaining scope

Project Vitest exercises fixed request options, status/length/hash rejection,
network deadline, incomplete EOF, cancellation, original-owner revocation,
concurrency retained through import, capability and storage-budget failures, UI
language changes, and actual importer admission after delayed decoding/DB reads.
Playwright uses the actual native CSP response header on a pure-module fixture,
proving the fixed path is admitted and an unrelated font path is blocked.

The explicitly enabled public-asset acceptance is:

```sh
CI=true LAZYSH_NOTO_LIVE=1 bun run --cwd apps/client test:e2e e2e/font-download.spec.ts
```

Its two Chromium viewport cases fetch and verify the real upstream font, decode
and store it, keep selection explicit, select the CJK face, check Latin metrics,
reselect while offline, and delete the local entry. Default suites skip those two
network cases; controlled negative UI/CSP cases do not fetch an actual font.
Offline reselection is not an offline cold-app-launch test. Browser/font API
behavior, CORS, memory pressure and glyph/grid fidelity on actual Android/iOS
WebViews and physical devices remain acceptance work under #16. Native builds
alone are not runtime font proof.

This is one documented [Moshi on-demand CJK workflow](https://getmoshi.app/docs/personalization#cjk-fonts),
not complete font parity. Iosevka, Ioskeley, DejaVu and other Noto JP/TC/KR download
entries remain incomplete. Existing manual imports remain available.
