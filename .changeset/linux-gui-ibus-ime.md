---
"@lazysh/client": patch
---

test(ime): commit CJK through a real IBus into the WebKitGTK terminal and Chat composer

Add a Linux native GUI case for desktop input methods (#1734, slice 3 of #982): an owned IBus daemon with its Pinyin engine runs under the owned Xvfb display, real X key events type `nihao` and Space into the WebKitGTK terminal, and the owned SSH receiver must hold exactly the committed `你好` bytes once. The same input method then fills the Chat composer draft. The Linux GUI job installs `ibus`, `ibus-gtk3`, `ibus-libpinyin` and `xdotool`. Test infrastructure only; the app is unchanged.
