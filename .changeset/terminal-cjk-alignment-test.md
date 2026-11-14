---
"@lazysh/client": patch
---

Add a Playwright rendering test for mixed Latin and CJK terminal rows: it selects a CJK fallback font through the font store, writes wide characters into a real xterm and checks the buffer cell widths and the rendered glyph columns. Test-only; the terminal itself is unchanged.
