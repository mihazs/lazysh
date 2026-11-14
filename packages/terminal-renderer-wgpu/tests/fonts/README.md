# Font fixtures of the text tests (#1325)

Subsets of three open fonts, so the text tests and goldens draw the same glyphs on every machine and
do not depend on what is installed. They are test data only and never ship in an app.

| File | Source | License |
| --- | --- | --- |
| `DejaVuSansMono.subset.ttf`, `-Bold`, `-Oblique` | DejaVu Sans Mono 2.37 | [`LICENSE-DejaVu.txt`](LICENSE-DejaVu.txt) (Bitstream Vera and public domain changes) |
| `NotoSansMonoCJKjp.subset.otf` | Noto Sans Mono CJK JP (font 5 of `NotoSansCJK-Regular.ttc`) | [`LICENSE-Noto-CJK-OFL.txt`](LICENSE-Noto-CJK-OFL.txt) (SIL OFL 1.1) |
| `NotoColorEmoji.subset.ttf` | Noto Color Emoji (CBDT) | [`LICENSE-Noto-Emoji-OFL.txt`](LICENSE-Noto-Emoji-OFL.txt) (SIL OFL 1.1) |

What they hold: Basic Latin, Latin-1, combining diacriticals U+0300-036F, Greek and Cyrillic letters,
a star, a heart and an arrow in DejaVu; the Japanese and Hangul text of the goldens and Latin letters
in the CJK font; and in the emoji font a smiley, a heart, a ZWJ family, the Brazilian flag, a thumbs
up with a skin tone, a keycap and a high voltage sign, with the GSUB ligatures that join them.
`.notdef` keeps its outline so a missing glyph draws a box.

Made with fonttools (`pip install fonttools brotli`):

```sh
LATIN="U+0020-007E,U+00A0-00FF,U+0300-036F,U+0391-03C9,U+0410-044F,U+2605,U+2764,U+2192"
pyftsubset DejaVuSansMono.ttf --unicodes="$LATIN" --layout-features='*' --no-hinting --desubroutinize --notdef-outline --output-file=DejaVuSansMono.subset.ttf
pyftsubset NotoSansMonoCJKjp.otf --text="日本語漢字한국어ひらがなカタカナＡ１ABCabc0 " --layout-features='*' --notdef-outline --output-file=NotoSansMonoCJKjp.subset.otf
pyftsubset NotoColorEmoji.ttf --text="😀❤️👨‍👩‍👧🇧🇷👍🏽1️⃣⚡" --layout-features='*' --notdef-outline --output-file=NotoColorEmoji.subset.ttf
```
