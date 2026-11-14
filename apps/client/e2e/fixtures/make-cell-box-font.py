"""Regenerates CellBoxCjk.ttf: a CJK fallback font whose glyphs are solid boxes exactly two cells wide.

Rendering tests need a wide-glyph face whose ink is the same on every machine, so the ink of one glyph can be
compared with the grid column it must sit in. Each glyph advances 1200 units, which is two cells of Liberation Mono
(1229/2048 em = 0.6 em), and its box leaves 100 units of margin on each side.

    python3 -m venv /tmp/fv && /tmp/fv/bin/pip install fonttools
    /tmp/fv/bin/python make-cell-box-font.py CellBoxCjk.ttf

Dedicated to the public domain (CC0).
"""
import sys
from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen

# Hiragana, a Han pair, Hangul and a fullwidth Latin letter: one code point from each range the app's CJK face covers.
CODE_POINTS = {0x3042: "hiragana_a", 0x6F22: "han_kan", 0x5B57: "han_ji", 0xD55C: "hangul_han", 0xFF21: "fullwidth_a"}
ADVANCE, EM = 1200, 1000


def box():
    pen = TTGlyphPen(None)
    pen.moveTo((100, -100)); pen.lineTo((100, 800)); pen.lineTo((1100, 800)); pen.lineTo((1100, -100)); pen.closePath()
    return pen.glyph()


def build(path):
    names = [".notdef", *CODE_POINTS.values()]
    builder = FontBuilder(EM, isTTF=True)
    builder.setupGlyphOrder(names)
    builder.setupCharacterMap(CODE_POINTS)
    builder.setupGlyf({name: box() if name != ".notdef" else TTGlyphPen(None).glyph() for name in names})
    builder.setupHorizontalMetrics({name: (ADVANCE, 100 if name != ".notdef" else 0) for name in names})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Lazysh Cell Box CJK", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.font["head"].created = builder.font["head"].modified = 0
    builder.save(path)


if __name__ == "__main__":
    build(sys.argv[1])
