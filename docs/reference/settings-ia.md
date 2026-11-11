# Settings information architecture

Audit date: 2026-11-05. Issue: #1055. This note records how the reference client structures its settings, and how lazysh maps that structure onto its own preferences. It describes patterns only. No reference source, strings or assets are copied into lazysh.

## Method and limits

The evidence comes from the cached Android package split set of the reference client (version 4.2.3, versionCode 311). The package is a React Native/Expo app. Its UI ships as a Hermes bytecode bundle (bytecode version 99), so a JavaScript application graph does not apply. REA's JavaScript analyzer reported zero parseable sources for the bundle. A pinned Hermes parser was used instead to read the string table (76,866 strings) and to disassemble the functions that reference settings translation keys. These were the settings root list, its section-jump index, and the language, notifications and advanced terminal sub-pages, plus the shared row, group, header, segmented-switch and accordion-select components.

The results are static observations of names, keys, component props and layout class names in the order the bytecode uses them. They do not prove runtime behaviour, such as which rows a given account sees or what conditions hide a row. The parser warns that bytecode version 99 is not formally supported.

## Root list

The settings root is one scrolling, grouped list, centered at a reading width on large screens. Sections appear in this order:

1. **Account**: a subscription row with a value preview and a small badge.
2. **Terminal**: Theme, Fonts and size, Advanced.
3. **Agents**: Hooks, Push notifications, Chat view, Sidebar.
4. **Input**: Toolbar, Shortcuts, Gestures, Speech, Hardware keyboard.
5. **Security and sync**: two inline biometric switches (keys, resume), SSH keys, a file-sync switch, a credential-sync switch and a sync-folder row whose value shows "not set" or "connected".
6. **General**: Language (value shows the selected language), App icon, Show on home.
7. **Help**: Docs, Discover, Support, What's new, Recommend, Open-source licenses. External links end in an outbound arrow instead of a disclosure chevron.

A centered version line closes the list.

On wide screens a vertical **jump-to-section index**, a tab list, sits beside the list and scrolls to a section. No settings search was observed.

## Row and group types

| Type | Observed shape |
| --- | --- |
| Section header | Small, muted, uppercase, tracked text above a group. |
| Group | A rounded surface holding consecutive rows. A hairline divider separates rows, and the last row has no divider. |
| Disclosure row | Leading icon, label, optional subtitle, optional value preview, trailing chevron. Opens a stacked sub-page with a native header title and a back control. |
| Inline toggle row | The same row with a trailing switch and no navigation. |
| Segmented picker | A pill-shaped segmented switch for a short enumeration, such as cursor shape (block, underline, bar). |
| Accordion select | A row that expands in place into a list of options with descriptions. Used for notification modes. |
| Picker page | A list with one checked option, an "automatic" first entry, a header and footers. Used for language. |
| Footer and help text | Small, muted text after a group that explains its rows. Switch rows also carry a hint subtitle. |
| Destructive or special action | A separate group, or a button inside a sub-page, rather than a root row. |

## Sub-pages

Each disclosure row opens a full sub-page in the navigation stack. Back returns to the root list. Sub-pages use the same header, group and footer pattern. For example, the advanced terminal page has groups for cursor, input, behaviour, multiplexer, connection, recent directories and environment, and each switch has a hint subtitle. Some pages, such as the sidebar page, show a live preview beside the controls when there is room.

## lazysh mapping

`apps/client/src/SettingsNavigation.tsx` renders the same structure. Each preference key, stored value and editor stays where it was, so existing installs read the same settings.

- **Root sections**, in order: Terminal (Appearance and fonts, Terminal and accessibility), Input (Keyboard and gestures), Agents and notifications (Notifications, Notification inbox, Agents, Dictate), Security and sync (Security and app lock, Encrypted sync), General (Language and region, Connections on native builds, Shareable uploads), Help (About lazysh), then a separate destructive Reset settings row with a footer. A version line closes the list.
- **Value previews** sit under row titles: app theme and font size, cursor shape and history length, language, host count, and snippet and chord counts. The value is the row's accessible description, so the row's accessible name stays its title.
- **Action rows** hand off to existing surfaces (remote push notifications, inbox, encrypted sync, shareable uploads, About, and the session's Agents and Dictate tools) instead of copying them. An unavailable row stays focusable, is marked `aria-disabled`, and shows its reason as the value preview: "Open a session first", "Not available in this session", or "Desktop and mobile apps only" on web builds.
- **Sub-pages** group their rows under section headers, with footers for help text. Switches stay native checkboxes styled as switches. Keyboard and gestures stays a hub for toolbar keys, touch gestures, snippets and chords, so its existing navigation keeps working.
- **Search** is a lazysh addition. It matches page titles, value previews and every setting name rendered inside the mounted pages. Choosing a result opens the page, opens any collapsed group that holds the setting, and focuses its control. Escape and Android Back clear the search before they leave a page or close Preferences. One live region announces the number of results or the empty state, and leaving a page opened from a result refocuses that result.
- **Wide screens** keep the grouped list as a persistent index beside the open page. Phones show the list or one page at a time, with Back.

## Not yet matched

These reference patterns are recorded above but are not used yet. The language sub-page uses a checked list. Other sub-pages still use native selects, checkboxes and text fields under group headers:

- inline switches on the root list;
- the segmented picker for short enumerations such as cursor shape;
- the accordion select for notification modes;
- hint subtitles under each switch.
