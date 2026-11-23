//! The host on a real core and the real wgpu renderer, on an offscreen surface. They need a GPU
//! adapter and fail without one (CI installs Mesa's software Vulkan); what is on the surface is
//! compared with the CPU reference renderer, fed by a second core that received the same bytes.
//! Presenting on a window is not exercised here: no test host has a display.

use super::*;
use lazysh_terminal_renderer_wgpu::Policy;
use lazysh_terminal_runtime::{
    CellPos, CellRange, Config, CursorVisualStyle, Hooks, Hub, HubConfig, Image, Offer, Origin,
    PtyWriter, ReferenceRenderer, Refused, Selection, SelectionKind, Size,
};

const COLS: u16 = 24;
const ROWS: u16 = 5;
/// DECSCUSR 2 and 1: a steady block, so a picture does not depend on the blink phase, and a
/// blinking one.
const STEADY: &str = "\x1b[2 q";
const BLINKING: &str = "\x1b[1 q";

static HUB: LazyLock<Hub> = LazyLock::new(|| Hub::new(HubConfig::default()));

struct NoPeer;

impl PtyWriter for NoPeer {
    fn write(&self, _: Origin, _: &[u8]) -> Result<(), Refused> {
        Ok(())
    }
}

/// The reference renderer's default cells and colours.
fn look() -> Look {
    Look {
        theme: Theme::default(),
        font_family: "monospace".into(),
        font_px: 40.0 / 3.0,
        scale: 1.0,
        system_fonts: false,
        bold: BoldText::default(),
        cursor: None,
    }
}

/// A session of `COLS` x `ROWS` cells and the inbox its `changed` hook rings.
pub(crate) fn session() -> (Session, Inbox) {
    session_of(COLS, ROWS)
}

fn session_of(cols: u16, rows: u16) -> (Session, Inbox) {
    let (wake, inbox) = wake();
    let hooks = Hooks {
        writer: Arc::new(NoPeer),
        credit: Box::new(|_| {}),
        changed: Some(wake.hook()),
    };
    let config = Config {
        size: Size::new(cols, rows),
        scrollback_bytes: 64 * 1024,
        ..Config::default()
    };
    let id = uuid::Uuid::new_v4().to_string();
    (HUB.create(id, config, hooks).unwrap(), inbox)
}

fn wait(what: &str, done: impl Fn() -> bool) {
    let start = Instant::now();
    while !done() {
        assert!(
            start.elapsed() < Duration::from_secs(10),
            "timed out: {what}"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
}

/// The program prints `output`, and the core has parsed it.
fn prints(session: &Session, output: &str) {
    let before = session.stats().unwrap().processed;
    assert!(matches!(session.feed(output.into()), Ok(Offer::Accepted)));
    wait("the core parses the output", || {
        session.stats().unwrap().processed >= before + output.len() as u64
    });
}

/// The surface of `COLS` x `ROWS` cells of `look`, in device pixels.
fn size(look: &Look) -> (u32, u32) {
    let m = look.appearance().unwrap().metrics;
    (
        u32::from(COLS) * m.cell_width,
        u32::from(ROWS) * m.cell_height,
    )
}

/// An offscreen surface for `look` that accepts software adapters, as CI has only those.
fn target(look: &Look) -> Target {
    let (width, height) = size(look);
    Target::new(width, height).with_policy(Policy::for_platform().with_software())
}

/// What the reference renderer draws for a core that received `output`.
fn reference(output: &str, look: &Look, selection: Option<Selection>) -> Image {
    let overlay = Overlay {
        selection,
        ..Overlay::default()
    };
    reference_with(output, look, overlay)
}

fn reference_with(output: &str, look: &Look, overlay: Overlay) -> Image {
    let (session, _inbox) = session();
    prints(&session, output);
    let (width, height) = size(look);
    let blank = Image::new(width, height, look.theme.background).unwrap();
    let mut renderer =
        ReferenceRenderer::create(blank.clone(), look.appearance().unwrap()).unwrap();
    renderer.apply(&session.attach().unwrap()).unwrap();
    session.close();
    renderer.set_overlay(overlay).unwrap();
    renderer.draw().unwrap();
    renderer.present().unwrap();
    assert_ne!(*renderer.surface(), blank, "a blank oracle proves nothing");
    renderer.surface().clone()
}

/// A session on its first surface.
struct Shown {
    host: Host,
    session: Session,
}

impl Shown {
    fn new(output: &str, look: Look) -> Self {
        let (session, inbox) = session();
        let host = Host::attach(session.clone(), inbox, target(&look), 1, look)
            .expect("a GPU adapter is required");
        prints(&session, output);
        Self { host, session }
    }

    /// What is on the surface now; `None` while the session has none.
    fn image(&self) -> Option<Image> {
        let read = |state: &mut Loop| state.renderer.as_mut().map(|r| r.read_image().unwrap());
        self.host.ask(read).unwrap()
    }

    /// The host draws `expected`, without being asked to.
    fn shows(&self, expected: &Image, what: &str) {
        wait(what, || self.image().as_ref() == Some(expected));
    }

    /// GPU submissions and presented frames so far.
    fn drawn(&self) -> (u64, u64) {
        let count = |state: &mut Loop| {
            let renderer = state.renderer.as_ref().unwrap();
            (
                renderer.gpu_stats().submissions,
                renderer.stats().frames_presented,
            )
        };
        self.host.ask(count).unwrap()
    }
}

impl Drop for Shown {
    fn drop(&mut self) {
        self.session.close();
    }
}

#[test]
fn a_fed_session_is_drawn_with_the_pixels_of_the_reference_renderer() {
    let first = format!("{STEADY}lazysh \x1b[1;31mred\x1b[0m 日本語\r\n\x1b[4munder\x1b[0m line");
    let shown = Shown::new(&first, look());
    shown.shows(&reference(&first, &look(), None), "the first screen");
    // Later output arrives as dirty rows, not as a snapshot.
    prints(&shown.session, "\r\n\x1b[7mmore\x1b[0m output");
    let both = format!("{first}\r\n\x1b[7mmore\x1b[0m output");
    shown.shows(&reference(&both, &look(), None), "the later output");
}

#[test]
fn an_idle_session_submits_nothing_to_the_gpu() {
    let text = format!("{STEADY}idle");
    let shown = Shown::new(&text, look());
    shown.shows(&reference(&text, &look(), None), "the screen");
    let before = shown.drawn();
    std::thread::sleep(3 * BLINK_HALF_PERIOD);
    assert_eq!(
        shown.drawn(),
        before,
        "nothing changed, so nothing is drawn"
    );
    // The counters are live: one more character is one more frame.
    prints(&shown.session, "!");
    wait("the new character is drawn", || {
        let (submissions, frames) = shown.drawn();
        submissions > before.0 && frames == before.1 + 1
    });
}

#[test]
fn a_suspended_host_draws_nothing_and_resuming_shows_what_arrived_meanwhile() {
    let text = format!("{STEADY}before");
    let shown = Shown::new(&text, look());
    let before = reference(&text, &look(), None);
    shown.shows(&before, "the screen");
    shown.host.set_active(false).unwrap();
    let drawn = shown.drawn();
    prints(&shown.session, "\r\nwhile away");
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(shown.drawn(), drawn, "a suspended host draws nothing");
    assert_eq!(shown.image(), Some(before), "the surface keeps its picture");
    shown.host.set_active(true).unwrap();
    let all = format!("{text}\r\nwhile away");
    shown.shows(&reference(&all, &look(), None), "the resumed screen");
}

#[test]
fn a_lost_surface_detaches_and_a_newer_generation_draws_the_same_pixels_from_a_snapshot() {
    let text = format!("{STEADY}surface \x1b[32mone\x1b[0m");
    let shown = Shown::new(&text, look());
    let first = reference(&text, &look(), None);
    shown.shows(&first, "the first surface");

    shown.host.lost(7).unwrap();
    assert!(
        shown.image().is_some(),
        "a surface it does not have is not lost"
    );
    shown.host.lost(1).unwrap();
    assert_eq!(shown.image(), None, "the renderer went with its surface");
    assert!(
        shown.host.surface(target(&look()), 1).is_err(),
        "a late callback does not bring the old surface back"
    );
    shown.host.surface(target(&look()), 2).unwrap();
    shown.shows(&first, "the second surface shows the same pixels");

    // What the program prints while the session has no surface is on the next one.
    shown.host.lost(2).unwrap();
    prints(&shown.session, "\r\nprinted without a surface");
    shown.host.surface(target(&look()), 3).unwrap();
    let all = format!("{text}\r\nprinted without a surface");
    shown.shows(&reference(&all, &look(), None), "the third surface");
}

#[test]
fn a_lost_device_is_rebuilt_and_the_screen_is_drawn_again_identically() {
    let text = format!("{STEADY}device \x1b[44mloss\x1b[0m");
    let shown = Shown::new(&text, look());
    let expected = reference(&text, &look(), None);
    shown.shows(&expected, "the screen");
    let recoveries = |state: &mut Loop| {
        let renderer = state.renderer.as_ref().unwrap();
        renderer.gpu_stats().device_recoveries
    };
    assert_eq!(shown.host.ask(recoveries).unwrap(), 0);
    let lose = |state: &mut Loop| state.renderer.as_mut().unwrap().lose_device();
    shown.host.ask(lose).unwrap();
    wait("the device is rebuilt", || {
        shown.host.ask(recoveries).unwrap() == 1
    });
    shown.shows(&expected, "the screen on the new device");
}

#[test]
fn the_selection_and_composing_text_are_drawn_like_the_reference() {
    let text = format!("{STEADY}select me\r\nab");
    let shown = Shown::new(&text, look());
    let plain = reference(&text, &look(), None);
    shown.shows(&plain, "the screen");

    let selection = Selection {
        kind: SelectionKind::Linear,
        anchor: (2, 0),
        head: (7, 0),
    };
    let cell = |(x, y): (u16, u16)| CellPos { x, y: y.into() };
    shown.session.set_selection(Some(CellRange {
        start: cell(selection.anchor),
        end: cell(selection.head),
    }));
    let selected = reference(&text, &look(), Some(selection));
    assert_ne!(selected, plain);
    shown.shows(&selected, "the selection");
    shown.session.set_selection(None);
    shown.shows(&plain, "the selection is gone");

    // What a keyboard composes looks like underlined text at the cursor, with the cursor after it.
    shown.host.set_composing(Some("日本x".into())).unwrap();
    let composed = format!("{text}\x1b[4m日本x\x1b[24m");
    shown.shows(&reference(&composed, &look(), None), "the composing text");
    // The program prints while the keyboard composes: the text follows the cursor.
    prints(&shown.session, "c");
    let moved = format!("{text}c\x1b[4m日本x\x1b[24m");
    shown.shows(&reference(&moved, &look(), None), "composing after output");
    shown.host.set_composing(None).unwrap();
    let ended = format!("{text}c");
    shown.shows(&reference(&ended, &look(), None), "composing ended");
}

#[test]
fn composing_text_stops_at_the_end_of_the_row_and_never_leaves_half_a_wide_character() {
    // The cursor is on the last but one column: one narrow cell fits, a wide one does not.
    let text = format!("{STEADY}\x1b[1;{}H", COLS - 1);
    let shown = Shown::new(&text, look());
    shown.host.set_composing(Some("a日".into())).unwrap();
    let fits = format!("{text}\x1b[4ma\x1b[24m");
    shown.shows(&reference(&fits, &look(), None), "the text that fits");

    // Composing over the first half of a wide character blanks its second half.
    let wide = format!("{STEADY}日本\x1b[1;1H");
    let shown = Shown::new(&wide, look());
    shown.host.set_composing(Some("a".into())).unwrap();
    let cut = format!("{STEADY}\x1b[4ma\x1b[24m \x1b[1;3H本\x1b[1;2H");
    shown.shows(&reference(&cut, &look(), None), "the cut wide character");
}

#[test]
fn a_blinking_cursor_redraws_only_its_row_once_per_phase_without_any_output() {
    let text = format!("{BLINKING}blink\r\nsecond row");
    let shown = Shown::new(&text, look());
    let phase = |cursor_phase_on| {
        let overlay = Overlay {
            cursor_phase_on,
            ..Overlay::default()
        };
        reference_with(&text, &look(), overlay)
    };
    let (on, off) = (phase(true), phase(false));
    assert_ne!(on, off);
    let rows = |state: &mut Loop| {
        let stats = state.renderer.as_ref().unwrap().stats();
        (stats.frames_drawn, stats.rows_drawn)
    };
    shown.shows(&on, "the cursor");
    let before = shown.host.ask(rows).unwrap();
    shown.shows(&off, "the cursor's cell without the cursor");
    shown.shows(&on, "the cursor again");
    let after = shown.host.ask(rows).unwrap();
    assert_eq!(after.1 - before.1, after.0 - before.0, "one row per phase");
    assert!(
        (2..=3).contains(&(after.0 - before.0)),
        "a phase lasts {BLINK_HALF_PERIOD:?}: one frame each, and the timer does not spin"
    );
}

#[test]
fn the_preferences_decide_the_cells_the_colours_and_the_fonts() {
    let rgb = |r, g, b| lazysh_terminal_runtime::RgbColor { r, g, b };
    let theme = Theme {
        foreground: rgb(0x20, 0x30, 0x20),
        background: rgb(0xf0, 0xf0, 0xe0),
        cursor: rgb(0xc0, 0x20, 0x20),
        ..Theme::default()
    };
    let light = Look {
        theme,
        font_family: "'SFMono-Regular', Consolas, \"Liberation Mono\", monospace".into(),
        ..look()
    };
    let appearance = light.appearance().unwrap();
    assert_eq!(appearance.theme, theme);
    assert_eq!(
        appearance.font_families,
        ["SFMono-Regular", "Consolas", "Liberation Mono", "monospace"]
    );
    let large = Look {
        font_px: 14.0,
        scale: 2.0,
        ..look()
    };
    let metrics = large.appearance().unwrap().metrics;
    assert_eq!((metrics.cell_width, metrics.cell_height), (17, 34));
    let none = Look {
        font_px: 0.0,
        ..look()
    };
    assert_eq!(none.appearance(), Err(RenderError::InvalidSize));

    // The theme the session was attached with, then another one.
    let text = format!("{STEADY}prefs \x1b[1mbold\x1b[0m");
    let shown = Shown::new(&text, light.clone());
    let themed = reference(&text, &light, None);
    assert_ne!(themed, reference(&text, &look(), None));
    shown.shows(&themed, "the light theme");
    shown.host.set_look(look()).unwrap();
    shown.shows(&reference(&text, &look(), None), "the default theme");
    // A larger font on a display of twice the density: larger cells on a larger surface.
    let (width, height) = size(&large);
    shown.host.set_look(large.clone()).unwrap();
    shown.host.resize(width, height).unwrap();
    shown.shows(&reference(&text, &large, None), "larger cells");
    assert!(
        shown.host.set_look(none).is_err(),
        "an impossible font size is refused"
    );
    shown.shows(&reference(&text, &large, None), "and changes nothing");
}

#[test]
fn bold_text_follows_the_bold_preferences_and_changes_live() {
    let colour = lazysh_terminal_runtime::RgbColor {
        r: 0x33,
        g: 0x66,
        b: 0x99,
    };
    let styled = Look {
        bold: BoldText {
            bright: true,
            color: Some(colour),
        },
        ..look()
    };
    let text = format!("{STEADY}\x1b[1;31mred\x1b[0m \x1b[1mdefault\x1b[0m");
    let (plain, bright) = (
        reference(&text, &look(), None),
        reference(&text, &styled, None),
    );
    // Not the reference against itself: bold red is the palette's bright red and bold default text the bold colour.
    let has = |image: &Image, color| {
        (0..image.height).any(|y| (0..image.width).any(|x| image.pixel(x, y) == color))
    };
    let bright_red = Theme::default().palette[9];
    assert!(has(&bright, colour) && has(&bright, bright_red));
    assert!(!has(&plain, colour) && !has(&plain, bright_red));

    let shown = Shown::new(&text, styled.clone());
    shown.shows(&bright, "bold text in the bold colours");
    shown.host.set_look(look()).unwrap();
    shown.shows(&plain, "bold text in the foreground colours");
    shown.host.set_look(styled).unwrap();
    shown.shows(&bright, "the bold colours again");
}

#[test]
fn a_program_that_chose_no_cursor_gets_the_preferred_one_and_a_program_that_did_keeps_its_own() {
    let default = |style, blink| Look {
        cursor: Some(CursorDefault { style, blink }),
        ..look()
    };
    let steady_bar = default(CursorVisualStyle::Bar, false);
    // The oracle is a program that asked for the cursor itself: DECSCUSR 6 is a steady bar, 4 a steady underline.
    let bar = reference("cursor\x1b[6 q", &look(), None);
    let underline = reference("cursor\x1b[4 q", &look(), None);
    assert_ne!(bar, underline);
    // No DECSCUSR, and DECSCUSR 0, which hands the cursor back: the preference.
    Shown::new("cursor", steady_bar.clone()).shows(&bar, "the preferred cursor");
    Shown::new("cursor\x1b[0 q", steady_bar.clone()).shows(&bar, "after a reset");
    // The program's own steady cursor is its choice.
    Shown::new("cursor\x1b[4 q", steady_bar.clone()).shows(&underline, "the program's cursor");

    // A new preference reaches the cursor of a screen that is already drawn.
    let shown = Shown::new("cursor", steady_bar);
    shown.shows(&bar, "the preferred bar");
    shown
        .host
        .set_look(default(CursorVisualStyle::Underline, false))
        .unwrap();
    shown.shows(&underline, "the preferred underline");
}

#[test]
fn the_cell_a_page_divides_its_pane_by_is_the_cell_the_renderer_draws() {
    let theme = Theme::default();
    for (font_px, scale) in [(14.0, 1.0), (14.0, 2.625), (10.0, 3.0), (32.0, 1.5)] {
        let cell = cell_metrics(font_px, scale).unwrap();
        let look = Look {
            font_px,
            scale,
            ..look()
        };
        assert_eq!(
            look.appearance().unwrap().metrics,
            cell,
            "{font_px} at {scale}"
        );
        // A steady block cursor fills its cell with the theme's cursor colour: its box is the cell, on the grid.
        let shown = Shown::new(&format!("{STEADY}\x1b[3;4H"), look);
        let drawn = |image: &Image| {
            let (mut left, mut top, mut right, mut bottom) = (u32::MAX, u32::MAX, 0, 0);
            let mut hit = false;
            for (x, y) in (0..image.height).flat_map(|y| (0..image.width).map(move |x| (x, y))) {
                if image.pixel(x, y) == theme.cursor {
                    (hit, left, top, right, bottom) =
                        (true, left.min(x), top.min(y), right.max(x), bottom.max(y));
                }
            }
            hit.then_some((left, top, right, bottom))
        };
        let (left, top) = (3 * cell.cell_width, 2 * cell.cell_height);
        let expected = (
            left,
            top,
            left + cell.cell_width - 1,
            top + cell.cell_height - 1,
        );
        wait(
            &format!("{font_px} at {scale}: the cursor fills its cell"),
            || {
                shown
                    .image()
                    .is_some_and(|image| drawn(&image) == Some(expected))
            },
        );
    }
    // A phone: 14 px text at 2.625 device pixels to a CSS pixel, on a surface of 1080 x 1900 pixels.
    let phone = cell_metrics(14.0, 2.625).unwrap();
    assert_eq!((phone.cell_width, phone.cell_height), (22, 44));
    assert_eq!(
        (1080 / phone.cell_width, 1900 / phone.cell_height),
        (49, 43)
    );
    // Nothing the renderer cannot draw has a cell.
    assert_eq!(cell_metrics(0.0, 1.0), Err(RenderError::InvalidSize));
}

#[test]
fn a_core_of_80_by_24_is_drawn_with_the_looks_a_phone_gets_before_its_page_sends_one_and_is_not_blank(
) {
    // The look of a pane on a phone (2.625 device pixels to a CSS pixel) the page has not sent preferences to:
    // the machine's monospace, then the bundled font, in the default theme on the pane's background (#2457).
    let look = crate::native_terminal_surface::panes::look("android-defaults", 2.625, 0x10_13_11);
    assert!(look.system_fonts, "the shipped look draws with fonts");
    let metrics = look.appearance().unwrap().metrics;
    let (width, height) = (80 * metrics.cell_width, 24 * metrics.cell_height);
    let (session, inbox) = session_of(80, 24);
    let target = Target::new(width, height).with_policy(Policy::for_platform().with_software());
    let host = Host::attach(session.clone(), inbox, target, 1, look.clone())
        .expect("a GPU adapter is required");
    prints(
        &session,
        "lazysh@phone:~$ ls -la\r\ntotal 4\r\n\x1b[1;34mdocs\x1b[0m  notes.txt\r\n\x1b[41m red \x1b[0m",
    );
    let read = |state: &mut Loop| state.renderer.as_mut().map(|r| r.read_image().unwrap());
    // Text is the theme's light foreground: count the pixels that are, which the pane's dark background and the
    // cursor's gold never are.
    let light = |image: &Image| {
        (0..image.height)
            .flat_map(|y| (0..image.width).map(move |x| (x, y)))
            .filter(|&(x, y)| {
                let p = image.pixel(x, y);
                p.r > 0xc0 && p.g > 0xc0 && p.b > 0xc0
            })
            .count()
    };
    wait("text is drawn", || {
        host.ask(read)
            .unwrap()
            .is_some_and(|image| light(&image) > 100)
    });
    let image = host.ask(read).unwrap().unwrap();
    assert_eq!((image.width, image.height), (width, height));
    assert_eq!(
        image.pixel(width - 1, height - 1),
        look.theme.background,
        "the rest of the grid is the pane's background"
    );
    // The red cell of the fourth row is drawn in its own colour, so colour reaches the frame too.
    let red = Theme::default().palette[1];
    assert!(
        (0..image.height).any(|y| (0..image.width).any(|x| image.pixel(x, y) == red)),
        "the red cell is drawn"
    );
    session.close();
}

#[test]
fn with_system_fonts_text_is_drawn_from_a_font_and_follows_the_family_list() {
    // A family no machine has: the generic name, or the renderer's bundled font, draws the text.
    let fonts = Look {
        font_family: "'No Such Font', monospace".into(),
        system_fonts: true,
        ..look()
    };
    let text = format!("{STEADY}fonts \x1b[1mbold\x1b[0m");
    let dots = reference(&text, &look(), None);
    let blank = Image::new(dots.width, dots.height, fonts.theme.background).unwrap();
    let shown = Shown::new(&text, look());
    shown.shows(&dots, "the reference glyphs without fonts");
    // The preferences turn the fonts on, off and on again: the same pixels each way.
    shown.host.set_look(fonts.clone()).unwrap();
    wait("glyphs from a font", || shown.image().unwrap() != dots);
    let drawn = shown.image().unwrap();
    assert_ne!(drawn, blank, "a font draws the text, not nothing");
    shown.host.set_look(look()).unwrap();
    shown.shows(&dots, "the reference glyphs again");
    shown.host.set_look(fonts.clone()).unwrap();
    shown.shows(&drawn, "the font's glyphs again");
    // A session attached with the fonts on draws them from its first surface.
    Shown::new(&text, fonts).shows(&drawn, "the font's glyphs on a first surface");
}

#[test]
fn the_shipping_policy_refuses_a_cpu_rasterizer_and_only_the_debug_switch_on_android_allows_one() {
    assert!(!policy_for(false).allow_software);
    assert!(policy_for(true).allow_software);
    assert_eq!(policy_for(true).backends, Policy::for_platform().backends);
    // No other build compiles the variable in, so a host has the shipping policy.
    assert_eq!(policy(), Policy::for_platform());
}
