# Recorded conversation draft: implementation brief

Current baseline: `523e4177` (1.10.3), captured with the real React workspace and a synthetic SSH/transcript bridge at 393×852 and 1280×850. The saved private capture set is named `lazysh-conversation-composer-ux/before`; it contains no real host or transcript data.

1. Open a saved fixture host and Transcript → Codex → Conversation.
2. Open a recorded conversation, enter a draft, and scroll the draft into view.
3. At phone width, separate full-width Refresh and Add attachment rows occupy 88 px before the text field. The field is readable, but the action group, explanatory text and two large rows leave little room for messages. Desktop repeats the same full-width rows.

Keep transcript content on the existing solid theme surfaces. Place the visible draft label and named refresh, attachment, and staging-help icons together in one header. Keep the field and explicit Stage action in the same container, with terminal and clear actions as named icons. Show the existing explanation in an inline disclosure when requested, preserving all confirmation and recipient checks. Use the application's themed panel and glass fallback conventions for compact chrome; avoid stacking translucent layers over readable text.

[Moshi Chat View](https://getmoshi.app/docs/chat-view) places the composer with the active conversation and keeps supported approvals near input. [Termish](https://termish.dev/) uses focused phone conversations and attachment affordances. These are visual/workflow references, not proof of Android keyboard behavior. [Android's layout guidance](https://developer.android.com/design/ui/mobile/guides/layout-and-content/layout-basics) calls for reachable input, safe-area accommodation and consistent spacing.

Acceptance: matching before/after captures; no horizontal overflow at phone, tablet and desktop sizes or enlarged text; 44 px touch targets; keyboard, localized accessible names and focus retention for icon actions and help; preserved attachment upload/explicit path insertion, draft during refresh, session identity, explicit staging and confirmed input; existing reduced-transparency/forced-color behavior; no native acceptance claim from Chromium.
