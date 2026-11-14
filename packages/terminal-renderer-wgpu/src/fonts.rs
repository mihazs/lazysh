//! The fonts the text path draws with: bytes the host hands over, grouped by family and style.
//!
//! The renderer never looks fonts up by name on the machine. The user's imported fonts live in the
//! WebView's storage ([`apps/client/src/fonts.ts`](../../../apps/client/src/fonts.ts)) and system
//! fonts differ per platform, so the host reads the files it wants drawn (primary, CJK, emoji) and
//! [`FontLibrary::add`]s them. `Appearance::font_families` then orders them: the names it lists
//! come first, in that order (the preferred family, then the fallback list), and the other
//! registered families follow in registration order, so a bundled emoji font stays reachable
//! whatever the user typed.

use std::sync::Arc;
use swash::{tag_from_bytes, CacheKey, FontRef};

/// Why a font was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FontError {
    /// The bytes are not an OpenType or TrueType font, or the index is not in the collection.
    Unreadable,
    /// A font with no em size cannot be scaled.
    NoEmSize,
    /// No family of that name is registered.
    UnknownFamily,
}

impl std::fmt::Display for FontError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Unreadable => "the bytes are not a readable font",
            Self::NoEmSize => "the font has no units per em",
            Self::UnknownFamily => "no font family of that name is registered",
        })
    }
}

impl std::error::Error for FontError {}

/// Font bytes the host owns: a `Vec`, an `Arc<[u8]>`, a memory map of a system font (a CJK
/// collection is tens of megabytes; mapped, it is not copied into the heap).
type Bytes = Arc<dyn AsRef<[u8]> + Send + Sync>;

/// One font file at one style.
#[derive(Clone)]
pub(crate) struct Face {
    data: Bytes,
    offset: u32,
    key: CacheKey,
    pub bold: bool,
    pub italic: bool,
    /// Color bitmaps (CBDT, sbix) or color layers (COLR): drawn as they are, not tinted.
    pub color: bool,
}

impl std::fmt::Debug for Face {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Face")
            .field("bytes", &(*self.data).as_ref().len())
            .field("bold", &self.bold)
            .field("italic", &self.italic)
            .field("color", &self.color)
            .finish()
    }
}

impl Face {
    /// The parsed font; the key is the face's own, so shaping and scaling caches keep their entries.
    pub fn font(&self) -> FontRef<'_> {
        FontRef {
            data: (*self.data).as_ref(),
            offset: self.offset,
            key: self.key,
        }
    }

    pub fn has(&self, ch: char) -> bool {
        self.font().charmap().map(ch) != 0
    }
}

/// The faces of one family and what to do for a style it lacks.
#[derive(Debug, Clone)]
pub(crate) struct Family {
    name: String,
    faces: Vec<Face>,
    /// The scalars this family may draw, inclusive ranges; empty means every scalar it has.
    ranges: Vec<(u32, u32)>,
}

/// A face chosen for a style, and what has to be faked because the family has no such face.
pub(crate) struct Pick<'a> {
    pub face: &'a Face,
    pub synthetic_bold: bool,
    pub synthetic_italic: bool,
}

impl Family {
    /// The face that fits `bold` and `italic` best: the exact style, else the closest one with the
    /// rest synthesized (an oblique slant, a heavier stroke).
    /// Whether this family is allowed to draw `ch` (and not only able to): an imported CJK font is
    /// limited to the CJK ranges so Latin text keeps the primary font, as in the WebView.
    pub fn allows(&self, ch: char) -> bool {
        self.ranges.is_empty()
            || self
                .ranges
                .iter()
                .any(|&(a, b)| (a..=b).contains(&u32::from(ch)))
    }

    /// Whether the family draws every scalar, so it can set the cell's metrics.
    pub fn is_unrestricted(&self) -> bool {
        self.ranges.is_empty()
    }

    pub fn pick(&self, bold: bool, italic: bool) -> Pick<'_> {
        let score = |f: &&Face| u8::from(f.bold != bold) * 2 + u8::from(f.italic != italic);
        let face = self
            .faces
            .iter()
            .min_by_key(score)
            .expect("a family has a face");
        Pick {
            face,
            synthetic_bold: bold && !face.bold,
            synthetic_italic: italic && !face.italic,
        }
    }
}

/// Fonts by family, as the host registered them. Cheap to share: faces hold their bytes in an `Arc`.
#[derive(Debug, Default, Clone)]
pub struct FontLibrary {
    families: Vec<Family>,
}

/// A family name as `Appearance::font_families` and `add` compare it: no quotes or outer spaces,
/// and no case.
fn normal(name: &str) -> String {
    name.trim()
        .trim_matches(|c| c == '"' || c == '\'')
        .trim()
        .to_lowercase()
}

impl FontLibrary {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register `data` (a font file, or a collection whose font number `index` is meant; any owner of
    /// bytes, so a memory-mapped system font is not copied) as the
    /// `bold` and `italic` face of `family`. A second face of the same style replaces the first.
    /// Fails, leaving the library unchanged, when the bytes are not a usable font: they come from
    /// the user's imports.
    pub fn add(
        &mut self,
        family: &str,
        bold: bool,
        italic: bool,
        data: impl AsRef<[u8]> + Send + Sync + 'static,
        index: u32,
    ) -> Result<(), FontError> {
        let data: Bytes = Arc::new(data);
        let font =
            FontRef::from_index((*data).as_ref(), index as usize).ok_or(FontError::Unreadable)?;
        // The header of a truncated or foreign file can parse: the tables the text path reads
        // must be there.
        if [b"head", b"cmap", b"maxp", b"hhea", b"hmtx"]
            .iter()
            .any(|t| font.table(tag_from_bytes(t)).is_none())
        {
            return Err(FontError::Unreadable);
        }
        if font.metrics(&[]).units_per_em == 0 {
            return Err(FontError::NoEmSize);
        }
        let color = font.color_palettes().len() > 0 || font.color_strikes().next().is_some();
        let face = Face {
            offset: font.offset,
            key: font.key,
            data: data.clone(),
            bold,
            italic,
            color,
        };
        let name = normal(family);
        match self.families.iter_mut().find(|f| f.name == name) {
            Some(known) => {
                known.faces.retain(|f| (f.bold, f.italic) != (bold, italic));
                known.faces.push(face);
            }
            None => self.families.push(Family {
                name,
                faces: vec![face],
                ranges: Vec::new(),
            }),
        }
        Ok(())
    }

    /// Limit `family` to the scalars in `ranges` (inclusive): outside them it is skipped even when
    /// its font has the glyph. This is the `unicode-range` the client gives an imported CJK font
    /// (`apps/client/src/fonts.ts`), so it never takes Latin text from the primary font. An empty
    /// list lifts the limit.
    pub fn restrict(
        &mut self,
        family: &str,
        ranges: impl IntoIterator<Item = std::ops::RangeInclusive<u32>>,
    ) -> Result<(), FontError> {
        let name = normal(family);
        let known = self
            .families
            .iter_mut()
            .find(|f| f.name == name)
            .ok_or(FontError::UnknownFamily)?;
        known.ranges = ranges.into_iter().map(|r| (*r.start(), *r.end())).collect();
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self.families.is_empty()
    }

    /// The registered family names, lower-cased, in registration order.
    pub fn families(&self) -> impl Iterator<Item = &str> {
        self.families.iter().map(|f| f.name.as_str())
    }

    /// The families in drawing order for `wanted`: the registered ones it names, in its order, then
    /// every other registered family in registration order. Unknown names are skipped, so the
    /// stack is never empty while the library is not.
    pub(crate) fn stack(&self, wanted: &[String]) -> Vec<Family> {
        let mut order: Vec<&Family> = Vec::new();
        for name in wanted.iter().map(|n| normal(n)) {
            if let Some(f) = self.families.iter().find(|f| f.name == name) {
                if !order.iter().any(|o| o.name == f.name) {
                    order.push(f);
                }
            }
        }
        for f in &self.families {
            if !order.iter().any(|o| o.name == f.name) {
                order.push(f);
            }
        }
        order.into_iter().cloned().collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_that_are_not_a_font_are_refused_and_change_nothing() {
        let mut lib = FontLibrary::new();
        assert_eq!(
            lib.add("Mono", false, false, vec![0u8; 64], 0),
            Err(FontError::Unreadable)
        );
        assert_eq!(
            lib.add("Mono", false, false, Vec::new(), 0),
            Err(FontError::Unreadable)
        );
        assert!(lib.is_empty());
    }

    #[test]
    fn names_ignore_case_quotes_and_spaces() {
        assert_eq!(normal(" \"JetBrains Mono\" "), "jetbrains mono");
        assert_eq!(normal("'Fira Code'"), "fira code");
    }
}
