---
"@lazysh/client": minor
---

Fix the phone gestures colliding with Android and Samsung One UI navigation gestures. On Android gesture navigation each gesture now starts from a visible handle placed from the live system gesture zones instead of the screen edge, edge swipes remain as an optional Gesture style (and as the default with three-button navigation), and a Test gestures page shows the zones. A swipe also starts in a band just beyond the system's Back and Home zones (inset + 4 dp up to inset + the zone width), so it does not compete with the system's edge gestures. Changed defaults: handles and bands instead of edge swipes on gesture navigation, and the edge zone width defaults to 40 dp (was 24) with a 96 dp maximum (was 48).
