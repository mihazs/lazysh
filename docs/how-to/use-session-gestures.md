# Use the session gestures on a phone

On a phone, a connected session puts its controls behind edge swipes so the terminal keeps the whole screen. This guide covers the three swipes, when they switch themselves off, how to turn them off, and the animated tour that explains them.

Desktop and the connection list keep their existing controls.

## The swipes

| Start at | Swipe | Result |
| --- | --- | --- |
| The left edge | Toward the middle | Opens the side menu, a full-screen page over the terminal: the session strip, and the **Agents**, **Workspaces** and **Connections** tabs with the tools and settings. Swipe it back to the left, use its close button or press Back to close it. |
| The bottom edge, where the small bar (the bottom handle) sits | Up | Opens the bottom menu, where you show or hide the composer, the toolbar and the keyboard. Swipe down on the menu, or use its handle, to close it. |
| The right edge | Toward the middle | Switches from the terminal to the Agent view of a remote session. In the Agent view, swipe right to return to the terminal. |

Each swipe starts in a strip along the screen edge, 40 dp wide by default; change the width in **Preferences → Keyboard and gestures → Terminal touch gestures** (16 to 96 dp). The panel follows your finger and settles when you let go. A short or slow swipe puts it back.

On Android with gesture navigation the system keeps the very edge for Back and Home. By default (**Gesture style: Automatic**) each gesture then starts from a small visible handle just inside the system's zones, or from the band beside it, and a tap on a handle works too; with three-button navigation and everywhere else the swipes start at the edge. Choose **Edge swipes (advanced)** in **Gesture style** to start from the edge on gesture navigation as well: lazysh then claims a row of the left and right edges where the side handles sit, so start the side swipes there and the bottom swipe just above the Home bar. **Test gestures** in the same section draws the zones and says whether the system took a swipe.

## When the swipes stay off

An edge swipe never starts, and never completes, while you type or edit text. That covers a keystroke in the last moments, a composing soft keyboard, a focused text field (the composer and Preferences included), a text selection or a dragged selection handle, a long press still held, a pinch, and a scroll or fling still moving. Touches that begin inside the screen never turn into edge swipes, and neither do touches on a slider or a horizontally scrollable area. A moment after you stop, the swipes work again.

## Turn a swipe off or use buttons

In **Preferences → Keyboard and gestures → Terminal touch gestures**, switch off the side menu, bottom menu or Agent view swipe, or set **Gesture style** to **Off**. Each has a visible control instead: turn the left-edge swipe off, or turn on **Show the top bar on phones**, and the top bar and its menu button return. With **Screen reader** on, or **Gesture style** set to **Off**, every swipe is off and visible buttons stand in for them.

## The gesture tour

The first time you open a connected session on a phone, a short animated tour opens with one step for each swipe and one for the typing rule. Choose **Next** for the following step, **Skip** to leave early or **Done** on the last step. Any way of closing it, including Back and Escape, marks it as seen on this device, so it does not open again. The mark is kept on the device and is not part of the settings that sync. When a later version adds or changes a gesture, the tour opens once more.

The tour never starts or delays a connection. It opens only after the session is connected, waits while you type, and never opens on desktop, on the connection list, over another dialog, in screen-reader mode, or when every swipe is switched off. A step for a swipe you switched off, or for the side menu while the top bar is on, says where to change that.

To see it again, choose **Preferences → Gestures** (under Help) and **Play the animated tour**, or **Gesture tour** on the **Connections** tab of the side menu. The Help page holds the same text without animation. With reduce motion set on the device, the tour shows still pictures with an arrow for each swipe instead of the moving finger; the captions are the same. The pictures follow your **Gesture style**: with handles (Android gesture navigation) the finger starts at the handle and a note says so, with edge swipes it starts at the edge.

## Related

- [Terminal shortcuts](../shortcuts.md) for the other terminal touch gestures.
- [Agent view](../agent-view.md) for what the right-edge swipe opens.
