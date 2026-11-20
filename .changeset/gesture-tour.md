---
"@lazysh/client": minor
---

feat(onboarding): add an animated tour that explains the session gestures on phones

The first time you open a connected session on a phone, a short tour opens with one step for each edge swipe (the left edge opens the side menu, the bottom edge opens the bottom menu, the right edge switches to the Agent view of a remote session and back) and one for the rule that swipes stay off while you type or edit text, with **Skip**, **Next**, **Done** and progress dots. It is drawn with CSS and SVG, with no video or image file, and loads on first use.

It opens once per device and again only when a later version changes a gesture, waits while you type, never delays connecting, and never opens on desktop, on the connection list, over another dialog, in screen-reader mode or when every swipe is switched off. A step for a swipe you switched off, or for the side menu while the top bar is on, says where to change that. The steps describe the shipped gestures: the side menu is the full-screen page that does not resize the terminal, Back closes it and the bottom menu, and each working step says how deep the strip is that the swipe starts in (**Swipe zone width**, 40 dp by default, 16 to 96 dp).

Replay it from **Preferences → Gestures** (under Help, with the same text as plain captions) or **Gesture tour** on the **Connections** tab of the side menu. With reduce motion on, it shows still pictures with an arrow for each swipe. It follows your **Gesture style**: with the handles of Android gesture navigation the finger starts at the handle, and **Gesture style: Off** counts as every swipe switched off. Available in English, Brazilian Portuguese and Spanish. No defaults change.
