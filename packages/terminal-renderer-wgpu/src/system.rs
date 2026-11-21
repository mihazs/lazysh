//! The fonts of the machine, and the one this crate carries for a machine that has none (#1325).
//!
//! [`FontLibrary::system`] is what a host that has no font bytes of its own registers: the
//! families the preferences name, the platform's monospace font for the generic names, a CJK and
//! an emoji font, and last the bundled [`FALLBACK`], so text is drawn whatever is installed.
//!
//! Finding a family reads only each file's table directory, `name` table and `head.macStyle`; the
//! bytes of a font are read when it is chosen.

use crate::fonts::FontLibrary;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

/// A subset of DejaVu Sans Mono (Latin, Greek, Cyrillic, punctuation, arrows, mathematical and
/// technical symbols, box drawing, blocks and shapes; `fonts/README.md`), registered last under
/// this name.
pub const FALLBACK_FAMILY: &str = "lazysh fallback";
const FALLBACK: &[u8] = include_bytes!("../fonts/DejaVuSansMono.fallback.ttf");

/// The CSS generic names a terminal font list ends with.
const GENERIC: &[&str] = &["monospace", "ui-monospace"];
/// What a generic name means, first one installed: Android's, then the usual Linux ones.
const MONOSPACE: &[&str] = &[
    "Droid Sans Mono",
    "Cutive Mono",
    "DejaVu Sans Mono",
    "Noto Sans Mono",
    "Liberation Mono",
];
/// Fallbacks registered after the named families, first one installed of each list.
const CJK: &[&str] = &[
    "Noto Sans Mono CJK SC",
    "Noto Sans CJK SC",
    "Noto Sans Mono CJK JP",
    "Noto Sans CJK JP",
    "WenQuanYi Zen Hei Mono",
];
const EMOJI: &[&str] = &["Noto Color Emoji"];

/// A font is found below a directory at most this deep and a table read at most this large, so a
/// link loop or a damaged file cannot hold the search.
const DEPTH: u32 = 5;
const TABLE_LIMIT: u32 = 8 << 20;

/// Where this platform keeps fonts. Empty on a platform this crate does not search yet (Apple,
/// Windows): there the library holds what the host adds and the bundled font.
pub fn system_font_dirs() -> Vec<PathBuf> {
    if cfg!(target_os = "android") {
        return vec!["/system/fonts".into(), "/product/fonts".into()];
    }
    if !cfg!(target_os = "linux") {
        return Vec::new();
    }
    let mut dirs = vec![
        PathBuf::from("/usr/share/fonts"),
        "/usr/local/share/fonts".into(),
    ];
    if let Some(home) = std::env::var_os("HOME").map(PathBuf::from) {
        dirs.extend([home.join(".local/share/fonts"), home.join(".fonts")]);
    }
    dirs
}

/// One font of a file: its family (name 1, which groups regular, bold, italic and bold italic)
/// and style.
struct Found {
    path: PathBuf,
    index: u32,
    family: String,
    bold: bool,
    italic: bool,
}

fn bytes<const N: usize>(file: &mut File, at: u64) -> Option<[u8; N]> {
    let mut out = [0; N];
    file.seek(SeekFrom::Start(at)).ok()?;
    file.read_exact(&mut out).ok()?;
    Some(out)
}

fn be16(b: &[u8], at: usize) -> Option<usize> {
    Some(usize::from(u16::from_be_bytes([
        *b.get(at)?,
        *b.get(at + 1)?,
    ])))
}

fn be32(b: &[u8]) -> u32 {
    u32::from_be_bytes([b[0], b[1], b[2], b[3]])
}

/// Name 1 of a `name` table: the Windows English record, else any Windows one (UTF-16BE), else a
/// Macintosh one (read as Latin-1, which its names are in practice).
fn family_name(table: &[u8]) -> Option<String> {
    let (count, strings) = (be16(table, 2)?, be16(table, 4)?);
    let mut best: Option<(u8, String)> = None;
    for record in (0..count).filter_map(|i| table.get(6 + i * 12..18 + i * 12)) {
        if be16(record, 6)? != 1 {
            continue;
        }
        let (platform, language) = (be16(record, 0)?, be16(record, 4)?);
        let start = strings + be16(record, 10)?;
        let Some(raw) = table.get(start..start + be16(record, 8)?) else {
            continue;
        };
        let (rank, name) = match platform {
            3 => (
                if language == 0x409 { 3 } else { 2 },
                String::from_utf16_lossy(
                    &raw.chunks_exact(2)
                        .map(|c| u16::from_be_bytes([c[0], c[1]]))
                        .collect::<Vec<_>>(),
                ),
            ),
            1 => (1, raw.iter().map(|&b| char::from(b)).collect()),
            _ => continue,
        };
        if best.as_ref().is_none_or(|(known, _)| rank > *known) {
            best = Some((rank, name));
        }
    }
    best.map(|(_, name)| name).filter(|name| !name.is_empty())
}

/// The fonts of one file (several for a collection), without reading its glyphs.
fn fonts_of(path: &Path) -> Option<Vec<Found>> {
    let mut file = File::open(path).ok()?;
    let head: [u8; 12] = bytes(&mut file, 0)?;
    let offsets: Vec<u64> = if &head[..4] == b"ttcf" {
        let count = be32(&head[8..]).min(64);
        (0..count)
            .filter_map(|i| bytes::<4>(&mut file, 12 + u64::from(i) * 4))
            .map(|b| u64::from(be32(&b)))
            .collect()
    } else {
        vec![0]
    };
    let mut found = Vec::new();
    for (index, offset) in offsets.into_iter().enumerate() {
        let header: [u8; 12] = bytes(&mut file, offset)?;
        let (mut name, mut style) = (None, None);
        for i in 0..be16(&header, 4)?.min(256) as u64 {
            let record: [u8; 16] = bytes(&mut file, offset + 12 + i * 16)?;
            let (at, len) = (u64::from(be32(&record[8..])), be32(&record[12..]));
            match &record[..4] {
                b"name" if len <= TABLE_LIMIT => {
                    let mut table = vec![0; len as usize];
                    file.seek(SeekFrom::Start(at)).ok()?;
                    file.read_exact(&mut table).ok()?;
                    name = family_name(&table);
                }
                // `head.macStyle`: bit 0 bold, bit 1 italic.
                b"head" => style = bytes::<2>(&mut file, at + 44).map(|b| b[1]),
                _ => {}
            }
        }
        if let (Some(family), Some(style)) = (name, style) {
            found.push(Found {
                path: path.to_path_buf(),
                index: index as u32,
                family,
                bold: style & 1 != 0,
                italic: style & 2 != 0,
            });
        }
    }
    Some(found)
}

fn search(dir: &Path, depth: u32, found: &mut Vec<Found>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut paths: Vec<PathBuf> = entries.flatten().map(|e| e.path()).collect();
    // Directory order differs per file system: the same fonts must give the same library.
    paths.sort();
    for path in paths {
        if path.is_dir() {
            if depth > 0 {
                search(&path, depth - 1, found);
            }
        } else if path.extension().and_then(|e| e.to_str()).is_some_and(|e| {
            ["ttf", "otf", "ttc", "otc"].contains(&e.to_ascii_lowercase().as_str())
        }) {
            found.extend(fonts_of(&path).unwrap_or_default());
        }
    }
}

impl FontLibrary {
    /// The fonts of this machine for the family list `wanted` (`Appearance::font_families`), and
    /// the bundled font. See [`FontLibrary::discover`].
    pub fn system(wanted: &[String]) -> Self {
        Self::discover(&system_font_dirs(), wanted)
    }

    /// The library a host draws `wanted` with from the fonts below `dirs`, in this order: each
    /// family `wanted` names that is installed (every style it has), under its own name; for a
    /// generic name (`monospace`) the platform's monospace font, under the generic name; one CJK
    /// and one emoji font; the bundled font as [`FALLBACK_FAMILY`]. A file that cannot be read or
    /// is not a font is skipped: the library is never empty.
    pub fn discover(dirs: &[PathBuf], wanted: &[String]) -> Self {
        let mut found = Vec::new();
        for dir in dirs {
            search(dir, DEPTH, &mut found);
        }
        let mut library = Self::new();
        // Registers every style of `family` as `name`; false when none is installed or readable.
        let mut register = |library: &mut Self, family: &str, name: &str| {
            let mut any = false;
            for font in found
                .iter()
                .filter(|f| f.family.eq_ignore_ascii_case(family))
            {
                // shortcut: the file is read into memory (a CJK collection is tens of megabytes);
                // map it instead when memory on a device is measured (G14).
                if let Ok(data) = std::fs::read(&font.path) {
                    any |= library
                        .add(name, font.bold, font.italic, data, font.index)
                        .is_ok();
                }
            }
            any
        };
        let first = |library: &mut Self,
                     register: &mut dyn FnMut(&mut Self, &str, &str) -> bool,
                     families: &[&str],
                     name: Option<&str>| {
            families
                .iter()
                .any(|family| register(library, family, name.unwrap_or(family)))
        };
        for name in wanted.iter().map(|name| name.trim()) {
            if GENERIC.iter().any(|g| g.eq_ignore_ascii_case(name)) {
                first(&mut library, &mut register, MONOSPACE, Some(name));
            } else {
                register(&mut library, name, name);
            }
        }
        // Before the CJK font, so Latin text never falls to its half-width letters.
        library
            .add(FALLBACK_FAMILY, false, false, FALLBACK, 0)
            .expect("the bundled font is a font");
        first(&mut library, &mut register, CJK, None);
        first(&mut library, &mut register, EMOJI, None);
        library
    }
}
