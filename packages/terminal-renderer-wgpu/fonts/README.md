# The bundled fallback font (#1325)

`DejaVuSansMono.fallback.ttf` is compiled into the crate and registered last by `FontLibrary::system`
(`src/system.rs`), so a machine with no usable font still draws text. It is a subset of DejaVu Sans Mono 2.37
([`LICENSE-DejaVu.txt`](LICENSE-DejaVu.txt): Bitstream Vera and public domain changes), regular only (bold and italic
are synthesized): Basic Latin, Latin-1, Latin Extended-A, combining diacriticals, Greek, Cyrillic, general punctuation,
the euro sign, arrows, mathematical operators, technical symbols, box drawing, block elements, geometric shapes and a
few marks. An app that ships this crate ships this font and must carry its license.

Made with fonttools (`pip install fonttools`):

```sh
pyftsubset DejaVuSansMono.ttf --layout-features='*' --no-hinting --desubroutinize --notdef-outline \
  --unicodes="U+0020-007E,U+00A0-017F,U+0300-036F,U+0370-03FF,U+0400-045F,U+2010-205E,U+20AC,U+2190-21FF,U+2200-22FF,U+2300-23FF,U+2500-259F,U+25A0-25FF,U+2600-2610,U+2713,U+2717,U+2764,U+FFFD" \
  --output-file=DejaVuSansMono.fallback.ttf
```
