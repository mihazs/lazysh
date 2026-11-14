//! Real fonts in the wgpu renderer (#1325): face fallback, shaping, grapheme clusters in the core's
//! cell widths, the user's font settings, bold and italic, color glyphs, and goldens at two scales.
//! The fixtures are subsets of DejaVu Sans Mono, Noto Sans Mono CJK JP and Noto Color Emoji
//! (`tests/fonts/README.md`), so the images do not depend on what the machine has installed.

mod common;

#[path = "../../terminal-runtime/tests/support/golden.rs"]
#[allow(dead_code)]
mod golden;

use common::*;
use lazysh_terminal_renderer_wgpu::{FontError, FontLibrary};
use lazysh_terminal_runtime::{
    Appearance, CellMetrics, Image, RenderError, TerminalRenderer, Theme,
};

const DEJAVU: &[u8] = include_bytes!("fonts/DejaVuSansMono.subset.ttf");
const DEJAVU_BOLD: &[u8] = include_bytes!("fonts/DejaVuSansMono-Bold.subset.ttf");
const DEJAVU_OBLIQUE: &[u8] = include_bytes!("fonts/DejaVuSansMono-Oblique.subset.ttf");
const CJK: &[u8] = include_bytes!("fonts/NotoSansMonoCJKjp.subset.otf");
const EMOJI: &[u8] = include_bytes!("fonts/NotoColorEmoji.subset.ttf");

const MONO: &str = "DejaVu Sans Mono";
const CJK_FAMILY: &str = "Noto Sans Mono CJK JP";
const EMOJI_FAMILY: &str = "Noto Color Emoji";

/// What the fixtures include, so a test can leave a face out and see what the renderer does.
#[derive(Clone, Copy, Debug)]
struct Fonts {
    bold: bool,
    oblique: bool,
    cjk: bool,
    emoji: bool,
}

const ALL: Fonts = Fonts {
    bold: true,
    oblique: true,
    cjk: true,
    emoji: true,
};

fn library(with: Fonts) -> FontLibrary {
    let mut lib = FontLibrary::new();
    lib.add(MONO, false, false, DEJAVU, 0).unwrap();
    if with.bold {
        lib.add(MONO, true, false, DEJAVU_BOLD, 0).unwrap();
    }
    if with.oblique {
        lib.add(MONO, false, true, DEJAVU_OBLIQUE, 0).unwrap();
    }
    if with.cjk {
        lib.add(CJK_FAMILY, false, false, CJK, 0).unwrap();
    }
    if with.emoji {
        lib.add(EMOJI_FAMILY, false, false, EMOJI, 0).unwrap();
    }
    lib
}

/// 16 x 32 pixel cells: the default metrics at display scale 2.
fn appearance(families: &[&str]) -> Appearance {
    Appearance {
        metrics: CellMetrics::default().scaled(2, 1).unwrap(),
        font_families: families.iter().map(|f| f.to_string()).collect(),
        ..Appearance::default()
    }
}

fn stack() -> Appearance {
    appearance(&[MONO, CJK_FAMILY, EMOJI_FAMILY])
}

const CW: u32 = 16;
const CH: u32 = 32;

/// `text` on a screen of `cols` x `rows` (cursor hidden) drawn with `fonts`.
fn shoot(text: &str, cols: u16, rows: u16, ap: &Appearance, fonts: FontLibrary) -> Image {
    let rt = &mut runtime(cols, rows, format!("\x1b[?25l{text}").as_bytes());
    let mut r = gpu_with_fonts(cols, rows, ap, fonts);
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    r.read_image().unwrap()
}

/// The bounding box `(x0, y0, x1, y1)` (end exclusive) of the pixels in a region that are not the
/// theme background, or `None` for a blank region.
fn ink(img: &Image, (rx, ry, rw, rh): (u32, u32, u32, u32)) -> Option<(u32, u32, u32, u32)> {
    let bg = Theme::default().background;
    let mut bbox: Option<(u32, u32, u32, u32)> = None;
    for y in ry..ry + rh {
        for x in rx..rx + rw {
            let i = ((y * img.width + x) * 3) as usize;
            if img.rgb[i..i + 3] != [bg.r, bg.g, bg.b] {
                let (x0, y0, x1, y1) = bbox.unwrap_or((x, y, x + 1, y + 1));
                bbox = Some((x0.min(x), y0.min(y), x1.max(x + 1), y1.max(y + 1)));
            }
        }
    }
    bbox
}

/// The cells `[col, col + cells)` of row `row` as a pixel region.
fn cells(col: u32, row: u32, n: u32) -> (u32, u32, u32, u32) {
    (col * CW, row * CH, n * CW, CH)
}

/// How much text color the pixels in a region carry: the sum of their distance from the background.
fn weight(img: &Image, region: (u32, u32, u32, u32)) -> u64 {
    let bg = Theme::default().background;
    let (rx, ry, rw, rh) = region;
    let mut sum = 0;
    for y in ry..ry + rh {
        for x in rx..rx + rw {
            let i = ((y * img.width + x) * 3) as usize;
            sum += (0..3)
                .map(|c| u64::from(img.rgb[i + c].abs_diff([bg.r, bg.g, bg.b][c])))
                .sum::<u64>();
        }
    }
    sum
}

fn region_of(img: &Image, region: (u32, u32, u32, u32)) -> Vec<u8> {
    let (rx, ry, rw, rh) = region;
    (ry..ry + rh)
        .flat_map(|y| {
            let from = ((y * img.width + rx) * 3) as usize;
            img.rgb[from..from + (rw * 3) as usize].to_vec()
        })
        .collect()
}

#[test]
fn bytes_that_are_not_fonts_are_refused_and_good_ones_register_by_family() {
    let mut lib = FontLibrary::new();
    assert_eq!(
        lib.add("Broken", false, false, DEJAVU[..40].to_vec(), 0),
        Err(FontError::Unreadable)
    );
    assert!(lib.is_empty(), "refused fonts leave no trace");
    lib.add(MONO, false, false, DEJAVU, 0).unwrap();
    lib.add(" \"dejavu sans mono\" ", true, false, DEJAVU_BOLD, 0)
        .unwrap();
    assert_eq!(lib.families().collect::<Vec<_>>(), ["dejavu sans mono"]);
}

#[test]
fn a_glyph_does_not_depend_on_what_was_rasterized_before_it() {
    // Regression: the rasterizer reused one buffer and a smaller glyph showed the larger one's
    // leftovers, so the same letter looked different next to different neighbours.
    let alone = shoot("a", 3, 1, &stack(), library(ALL));
    for before in ["A", "W", "日", "😀", "e\u{301}"] {
        let after = shoot(&format!("{before} a"), 6, 1, &stack(), library(ALL));
        let col = if before == "日" || before == "😀" {
            3
        } else {
            2
        };
        assert_eq!(
            region_of(&after, cells(col, 0, 1)),
            region_of(&alone, cells(0, 0, 1)),
            "an `a` drawn after {before:?}"
        );
    }
}

#[test]
fn every_cluster_stays_in_its_cells() {
    // (cluster, cells it takes): narrow Latin, a mark, CJK, Hangul, a ZWJ family, a flag, a skin
    // tone, a keycap, a symbol and a heart with emoji presentation; each followed by a space.
    let clusters: [(&str, u32); 11] = [
        ("a", 1),
        ("e\u{301}", 1),
        ("日", 2),
        ("한", 2),
        ("😀", 2),
        ("👨\u{200d}👩\u{200d}👧", 2),
        ("🇧🇷", 2),
        ("👍🏽", 2),
        ("1\u{fe0f}\u{20e3}", 2),
        ("⚡", 2),
        ("❤\u{fe0f}", 2),
    ];
    let mut line = String::new();
    let mut at = Vec::new();
    let mut col = 0;
    for (cluster, n) in clusters {
        at.push((cluster, col, n));
        line.push_str(cluster);
        line.push(' ');
        col += n + 1;
    }
    let img = shoot(&line, col as u16, 1, &stack(), library(ALL));
    for (cluster, col, n) in at {
        let own = ink(&img, cells(col, 0, n))
            .unwrap_or_else(|| panic!("{cluster:?} drew nothing in its {n} cells"));
        assert_eq!(
            ink(&img, cells(col + n, 0, 1)),
            None,
            "{cluster:?} left ink in the space after it"
        );
        let (mid, want) = ((own.0 + own.2) / 2, col * CW + n * CW / 2);
        if n == 2 {
            assert!(
                mid.abs_diff(want) <= 3,
                "{cluster:?} is {} px off the middle of its two cells",
                mid.abs_diff(want)
            );
        }
        assert!(
            own.0 >= col * CW && own.2 <= (col + n) * CW,
            "{cluster:?} {own:?} leaves its cells"
        );
        if cluster == "a" || cluster == "e\u{301}" || n == 2 && cluster.chars().count() == 1 {
            assert!(
                own.0 > col * CW && own.2 < (col + n) * CW,
                "{cluster:?} {own:?} was cut at a cell border instead of fitted"
            );
        }
    }
}

#[test]
fn a_combining_mark_sits_above_its_base_inside_one_cell() {
    let img = shoot("e e\u{301}", 4, 1, &stack(), library(ALL));
    let (plain, marked) = (
        ink(&img, cells(0, 0, 1)).unwrap(),
        ink(&img, cells(2, 0, 1)).unwrap(),
    );
    assert!(marked.1 < plain.1, "the accent rises above the letter");
    assert!(
        marked.0 > 2 * CW && marked.2 < 3 * CW,
        "and stays inside its cell"
    );
    let accent = ink(&img, (2 * CW, 0, CW, plain.1)).expect("ink above the letter's top");
    let (accent_mid, base_mid) = ((accent.0 + accent.2) / 2, (plain.0 + plain.2) / 2 + 2 * CW);
    assert!(
        accent_mid.abs_diff(base_mid) <= 3,
        "the accent is centered over its base: {accent_mid} against {base_mid}"
    );
}

#[test]
fn cjk_falls_back_to_the_cjk_face_and_a_missing_glyph_shows_a_box() {
    let with = shoot("日", 3, 1, &stack(), library(ALL));
    let without = shoot("日", 3, 1, &stack(), library(Fonts { cjk: false, ..ALL }));
    let (a, b) = (
        ink(&with, cells(0, 0, 2)).unwrap(),
        ink(&without, cells(0, 0, 2)).expect("a missing glyph is drawn, not skipped"),
    );
    assert!(a.2 - a.0 > CW, "the ideograph spans past its first cell");
    assert_ne!(
        region_of(&with, cells(0, 0, 2)),
        region_of(&without, cells(0, 0, 2)),
        "the CJK face and the notdef box are different pictures"
    );
    assert!(b.2 <= 2 * CW);
}

#[test]
fn color_glyphs_are_drawn_as_they_are_and_text_takes_the_text_color() {
    let plain = shoot("a😀", 4, 1, &stack(), library(ALL));
    let red = shoot("\x1b[31ma😀", 4, 1, &stack(), library(ALL));
    assert_eq!(
        region_of(&plain, cells(1, 0, 2)),
        region_of(&red, cells(1, 0, 2)),
        "an emoji ignores the text color"
    );
    assert_ne!(
        region_of(&plain, cells(0, 0, 1)),
        region_of(&red, cells(0, 0, 1)),
        "a letter does not"
    );
    let colorful = region_of(&plain, cells(1, 0, 2))
        .chunks(3)
        .filter(|p| p[0].abs_diff(p[2]) > 40)
        .count();
    assert!(colorful > 50, "the emoji has color: {colorful} pixels");
}

#[test]
fn a_zwj_family_is_not_its_first_member() {
    let family = shoot("👨\u{200d}👩\u{200d}👧", 3, 1, &stack(), library(ALL));
    let man = shoot("👨", 3, 1, &stack(), library(ALL));
    assert_ne!(
        region_of(&family, cells(0, 0, 2)),
        region_of(&man, cells(0, 0, 2)),
        "the sequence shapes to its own glyph"
    );
    assert_eq!(ink(&family, cells(2, 0, 1)), None, "in two cells, no more");
}

#[test]
fn bold_and_italic_use_the_family_faces_and_synthesize_what_it_lacks() {
    let bold = |f| shoot("\x1b[1mH", 2, 1, &stack(), library(f));
    let (regular, real, faked) = (
        shoot("H", 2, 1, &stack(), library(ALL)),
        bold(ALL),
        bold(Fonts { bold: false, ..ALL }),
    );
    let w = |i: &Image| weight(i, cells(0, 0, 1));
    assert!(w(&real) > w(&regular), "the bold face is heavier");
    assert!(w(&faked) > w(&regular), "so is a synthesized one");
    assert_ne!(
        region_of(&real, cells(0, 0, 1)),
        region_of(&faked, cells(0, 0, 1)),
        "and they are different pictures"
    );
    // A slanted H leans right: the ink of its upper half sits to the right of its lower half's.
    let lean = |f| {
        let img = shoot("\x1b[3mH", 2, 1, &stack(), library(f));
        let (top, bottom) = (
            ink(&img, (0, 0, CW, CH / 2)).unwrap(),
            ink(&img, (0, CH / 2, CW, CH / 2)).unwrap(),
        );
        let upright = shoot("H", 2, 1, &stack(), library(f));
        assert_ne!(
            region_of(&img, cells(0, 0, 1)),
            region_of(&upright, cells(0, 0, 1)),
            "italic is not upright with {f:?}"
        );
        (top.0 + top.2) as i32 - (bottom.0 + bottom.2) as i32
    };
    assert!(lean(ALL) > 0, "the oblique face leans right");
    assert!(
        lean(Fonts {
            oblique: false,
            ..ALL
        }) > 0,
        "so does the synthesized slant"
    );
}

#[test]
fn the_font_settings_choose_the_primary_and_the_fallback_order() {
    let draw = |families: &[&str]| shoot("Aa日", 5, 1, &appearance(families), library(ALL));
    let dejavu = draw(&[MONO, CJK_FAMILY]);
    let cjk_first = draw(&[CJK_FAMILY, MONO]);
    assert_ne!(
        region_of(&dejavu, cells(0, 0, 2)),
        region_of(&cjk_first, cells(0, 0, 2)),
        "the first family listed draws the letters it has"
    );
    assert_eq!(
        region_of(&draw(&["Not Installed", MONO, CJK_FAMILY]), cells(0, 0, 5)),
        region_of(&dejavu, cells(0, 0, 5)),
        "a family nobody registered is skipped"
    );
    assert_eq!(
        region_of(&draw(&["\"DejaVu SANS Mono\"", CJK_FAMILY]), cells(0, 0, 5)),
        region_of(&dejavu, cells(0, 0, 5)),
        "names ignore case and quotes"
    );
    assert_eq!(
        region_of(&draw(&[]), cells(0, 0, 5)).len(),
        region_of(&dejavu, cells(0, 0, 5)).len(),
        "an empty list still draws with what is registered"
    );
}

#[test]
fn a_range_limited_cjk_font_leaves_latin_to_the_primary() {
    // What the client does with an imported CJK font: `unicode-range` limits it to the CJK blocks.
    let ranges = [
        0x1100..=0x11ff,
        0x2e80..=0x9fff,
        0xac00..=0xd7ff,
        0xff00..=0xffef,
    ];
    let mut lib = library(ALL);
    lib.restrict(CJK_FAMILY, ranges.clone()).unwrap();
    assert_eq!(
        lib.restrict("Missing", ranges),
        Err(FontError::UnknownFamily)
    );
    let text = "Aa日한";
    let limited = shoot(text, 6, 1, &appearance(&[CJK_FAMILY, MONO]), lib);
    let usual = shoot(text, 6, 1, &appearance(&[MONO, CJK_FAMILY]), library(ALL));
    assert_eq!(
        limited, usual,
        "the CJK font listed first still draws only CJK"
    );
    let unlimited = shoot(text, 6, 1, &appearance(&[CJK_FAMILY, MONO]), library(ALL));
    assert_ne!(
        region_of(&limited, cells(0, 0, 2)),
        region_of(&unlimited, cells(0, 0, 2)),
        "without the limit its Latin letters win"
    );
}

#[test]
fn changing_the_font_list_or_the_fonts_repaints_like_a_fresh_renderer() {
    let text = "Aa日😀";
    let mut rt = runtime(6, 1, format!("\x1b[?25l{text}").as_bytes());
    let frame = rt.snapshot().unwrap();
    let fresh = |families: &[&str]| shoot(text, 6, 1, &appearance(families), library(ALL));

    let mut r = gpu_with_fonts(6, 1, &appearance(&[MONO]), library(ALL));
    r.apply(&frame).unwrap();
    assert_eq!(r.draw().unwrap(), 1);
    r.present().unwrap();
    assert_eq!(r.read_image().unwrap(), fresh(&[MONO]));

    r.set_appearance(appearance(&[CJK_FAMILY, MONO])).unwrap();
    assert_eq!(r.draw().unwrap(), 1, "a new font list repaints");
    r.present().unwrap();
    assert_eq!(r.read_image().unwrap(), fresh(&[CJK_FAMILY, MONO]));

    // The user removes the emoji font in Preferences: the emoji is a missing glyph again.
    r.set_fonts(library(Fonts {
        emoji: false,
        ..ALL
    }))
    .unwrap();
    assert_eq!(r.draw().unwrap(), 1, "new fonts repaint");
    r.present().unwrap();
    let after = r.read_image().unwrap();
    assert_ne!(after, fresh(&[CJK_FAMILY, MONO]));
    assert!(ink(&after, cells(4, 0, 2)).is_some(), "a box, not a hole");

    // No fonts at all: back to the layout's reference dot patterns.
    r.set_fonts(FontLibrary::new()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    let dots = r.read_image().unwrap();
    let mut reference = gpu_at(6, 1, &appearance(&[MONO]));
    reference.apply(&frame).unwrap();
    reference.draw().unwrap();
    reference.present().unwrap();
    assert_eq!(dots, reference.read_image().unwrap());
}

#[test]
fn fonts_survive_a_lost_device() {
    let mut rt = runtime(6, 1, "\x1b[?25lAa日😀".as_bytes());
    let mut r = gpu_with_fonts(6, 1, &stack(), library(ALL));
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    let before = r.read_image().unwrap();

    r.lose_device();
    assert_eq!(r.draw(), Err(RenderError::DeviceLost));
    r.resume().unwrap();
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    let after = r.read_image().unwrap();
    let differing: Vec<usize> = (0..before.rgb.len() / 3)
        .filter(|&i| before.rgb[i * 3..i * 3 + 3] != after.rgb[i * 3..i * 3 + 3])
        .collect();
    assert!(
        differing.is_empty(),
        "{} pixels differ after recovery, first at x={} y={}",
        differing.len(),
        differing[0] % before.width as usize,
        differing[0] / before.width as usize
    );
}

#[test]
fn masks_are_rasterized_once_and_color_glyphs_have_their_own_atlas() {
    let mut rt = runtime(8, 2, "\x1b[?25lab日😀 ab日😀".as_bytes());
    let mut r = gpu_with_fonts(8, 2, &stack(), library(ALL));
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    r.present().unwrap();
    let first = r.gpu_stats();
    assert_eq!(first.glyph_misses, 4, "four distinct clusters, drawn twice");
    assert_eq!(first.glyph_hits, 4);
    assert!(
        first.text_time > std::time::Duration::ZERO,
        "text time is measured"
    );
    assert_eq!(
        r.atlas_slots().1,
        3,
        "two letters and an ideograph in the coverage atlas"
    );
    assert_eq!(r.color_atlas_slots().1, 1, "the emoji in the color atlas");

    // The same words again, then a blank: nothing is rasterized for what is resident.
    support::feed(&mut rt, "\x1b[2J\x1b[Hab日 \x1b[2;1H日😀".as_bytes());
    r.apply(&rt.snapshot().unwrap()).unwrap();
    r.draw().unwrap();
    let second = r.gpu_stats();
    assert_eq!(
        second.glyph_misses, first.glyph_misses,
        "all four were resident"
    );
    assert_eq!(
        second.text_time, first.text_time,
        "so no text work was done"
    );
}

#[test]
fn text_matches_the_goldens() {
    let update = std::env::var_os("UPDATE_GOLDEN").is_some();
    let dir = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/golden");
    std::fs::create_dir_all(dir).unwrap();
    let cases: [(&str, u16, u16, &str, u32); 4] = [
        (
            "text_latin_cjk",
            24,
            4,
            "Hello, lazysh!\r\nThe quick brown fox\r\n日本語 漢字 한국어 ひらがな カタカナ",
            2,
        ),
        (
            "text_marks_and_symbols",
            24,
            2,
            "e\u{301} a\u{308} n\u{303} o\u{302} ★ → αβγ абв\r\nΩ é à ü ç ñ ¿ ¡ ©",
            2,
        ),
        (
            "text_emoji",
            24,
            2,
            "😀 👨\u{200d}👩\u{200d}👧 🇧🇷 👍🏽 ⚡\r\n1\u{fe0f}\u{20e3} ❤\u{fe0f} A😀B",
            2,
        ),
        (
            "text_styles",
            24,
            3,
            "\x1b[1mbold\x1b[0m \x1b[3mitalic\x1b[0m \x1b[1;3mboth\x1b[0m \x1b[4munder\x1b[0m\r\n\x1b[31mred\x1b[0m \x1b[7minverse\x1b[0m \x1b[2mfaint\x1b[0m \x1b[9mgone\x1b[0m\r\n\x1b[1m日本\x1b[0m \x1b[3m漢字\x1b[0m",
            2,
        ),
    ];
    for (name, cols, rows, text, scale) in cases {
        let ap = Appearance {
            metrics: CellMetrics::default().scaled(scale, 1).unwrap(),
            ..stack()
        };
        let img = shoot(text, cols, rows, &ap, library(ALL));
        golden::assert_golden_within(dir, name, &img, update, 2);
    }
}
