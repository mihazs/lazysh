//! The renderer hosts of the sessions a platform surface draws (#1327): one [`Host`] per session, created by the
//! first surface and kept across the surfaces that follow (the window destroys and recreates its surface on stop
//! and start; the session and its screen live on). Platform-neutral, so the bookkeeping is tested on every host
//! with offscreen targets; the Android entry points in [`super::android`] only turn a `Surface` into a [`Target`].
#![cfg_attr(not(any(target_os = "android", target_os = "linux")), allow(dead_code))]
use super::{CursorStyle, SurfaceLook};
use crate::native_renderer::{Host, Inbox, Look};
use crate::terminal_core::{css_color, theme_of};
use lazysh_terminal_renderer_wgpu::Target;
use lazysh_terminal_runtime::{
    BoldText, CursorDefault, CursorVisualStyle, RgbColor, Session, Theme,
};
use std::any::Any;
use std::collections::HashMap;
use std::sync::{Mutex, PoisonError};

/// What the platform keeps alive for a surface (an `ANativeWindow` reference) until its renderer is destroyed.
pub(crate) type Holder = Box<dyn Any + Send>;

/// Most sessions whose preferences are kept; more than a window shows, so only a broken page asks for more.
const MAX_LOOKS: usize = 64;

/// The look each session was last told to have: kept by the shell, not by a surface, because the page sends it
/// when it applies the preferences, which is before its surface exists and goes on while the surface is lost.
static LOOKS: Mutex<Option<HashMap<String, Look>>> = Mutex::new(None);

fn looks<R>(call: impl FnOnce(&mut HashMap<String, Look>) -> R) -> R {
    let mut looks = LOOKS.lock().unwrap_or_else(PoisonError::into_inner);
    call(looks.get_or_insert_with(HashMap::new))
}

/// What a session looks like on a display of `scale` device pixels per CSS pixel: the preferences its page sent,
/// or, before it has, the system's monospace at 14 CSS pixels in the default theme on the pane's `background`.
pub(crate) fn look(session: &str, scale: f32, background: u32) -> Look {
    if let Some(look) = looks(|looks| looks.get(session).cloned()) {
        return Look { scale, ..look };
    }
    let mut theme = Theme::default();
    let [_, r, g, b] = background.to_be_bytes();
    theme.background = RgbColor { r, g, b };
    Look {
        theme,
        font_family: "monospace".into(),
        font_px: 14.0,
        scale,
        system_fonts: true,
        bold: BoldText::default(),
        cursor: None,
        imported: Vec::new(),
    }
}

/// Keeps `wanted` as the look of `session`, from its next surface on. The caller applies it to a surface that is
/// already drawing.
pub(crate) fn remember(session: &str, wanted: &SurfaceLook) -> Result<(), String> {
    let look = look_of(wanted)?;
    looks(|looks| {
        if looks.len() >= MAX_LOOKS && !looks.contains_key(session) {
            looks.retain(|id, _| crate::terminal_core::live(id).is_ok());
        }
        if looks.len() >= MAX_LOOKS && !looks.contains_key(session) {
            return Err("Too many terminal sessions have a look".to_owned());
        }
        looks.insert(session.to_owned(), look);
        Ok(())
    })
}

/// The renderer's look for what the page sent. The theme is the client's `TerminalTheme`, read as the core reads
/// it; its selection colours are the renderer's.
fn look_of(wanted: &SurfaceLook) -> Result<Look, String> {
    let colour = |key: &str| {
        wanted
            .theme
            .get(key)
            .and_then(serde_json::Value::as_str)
            .and_then(css_color)
    };
    let mut theme = theme_of(&wanted.theme)?;
    theme.selection_background =
        colour("selectionBackground").unwrap_or(theme.selection_background);
    theme.selection_foreground = colour("selectionForeground");
    let bold = BoldText {
        bright: wanted.bright_bold,
        color: match &wanted.bold_color {
            None => None,
            Some(text) => Some(css_color(text).ok_or("The bold colour is not a hex colour")?),
        },
    };
    let style = match wanted.cursor_style {
        CursorStyle::Block => CursorVisualStyle::Block,
        CursorStyle::Underline => CursorVisualStyle::Underline,
        CursorStyle::Bar => CursorVisualStyle::Bar,
    };
    Ok(Look {
        theme,
        font_family: wanted.font_family.clone(),
        font_px: wanted.font_size as f32,
        scale: 1.0,
        system_fonts: true,
        // The page handed over the fonts its family list names before it sent the look.
        imported: crate::native_fonts::named(&crate::native_renderer::families(
            &wanted.font_family,
        )),
        bold,
        cursor: Some(CursorDefault {
            style,
            blink: wanted.cursor_blink,
        }),
    })
}

struct Pane {
    host: Host,
    /// Dropped after the host destroyed the renderer that drew on it.
    holder: Option<Holder>,
    look: Look,
}

#[derive(Default)]
pub(crate) struct Panes(HashMap<String, Pane>);

impl Panes {
    /// Surface `generation` of `id` exists. The first one creates the host from `drawing` (the core's session and
    /// its inbox, made once because the inbox belongs to one host); a later one draws the same session again from a
    /// snapshot. An error leaves the session without a renderer: the platform host keeps its fallback.
    pub(crate) fn ready(
        &mut self,
        id: &str,
        drawing: impl FnOnce() -> Option<(Session, Inbox)>,
        target: Target,
        holder: Holder,
        generation: u32,
        look: Look,
    ) -> Result<(), String> {
        if let Some(pane) = self.0.get_mut(id) {
            pane.host.surface(target, generation)?;
            (pane.holder, pane.look) = (Some(holder), look);
            return Ok(());
        }
        let (session, inbox) = drawing().ok_or("The session has no native core to draw")?;
        let host = Host::attach(session, inbox, target, generation, look.clone())?;
        self.0.insert(
            id.to_owned(),
            Pane {
                host,
                holder: Some(holder),
                look,
            },
        );
        Ok(())
    }

    /// The same surface changed size, or the pane's colour or scale changed.
    pub(crate) fn changed(
        &mut self,
        id: &str,
        width: u32,
        height: u32,
        look: Look,
    ) -> Result<(), String> {
        let pane = self.0.get_mut(id).ok_or("The session has no renderer")?;
        pane.host.resize(width, height)?;
        if pane.look != look {
            pane.host.set_look(look.clone())?;
            pane.look = look;
        }
        Ok(())
    }

    /// The session's preferences changed (see [`remember`]): its renderer draws with them from the next frame. A
    /// session that is not drawing yet has nothing to change; its next surface reads them.
    pub(crate) fn relook(&mut self, id: &str) -> Result<(), String> {
        let Some(pane) = self.0.get_mut(id) else {
            return Ok(());
        };
        let RgbColor { r, g, b } = pane.look.theme.background;
        let wanted = look(id, pane.look.scale, u32::from_be_bytes([0, r, g, b]));
        if pane.look != wanted {
            pane.host.set_look(wanted.clone())?;
            pane.look = wanted;
        }
        Ok(())
    }

    /// The platform takes surface `generation` back: the renderer is destroyed before this returns, then the
    /// handle to the surface is released.
    pub(crate) fn lost(&mut self, id: &str, generation: u32) {
        if let Some(pane) = self.0.get_mut(id) {
            let _ = pane.host.lost(generation);
            pane.holder = None;
        }
    }

    /// The session is over: its renderer thread stops.
    pub(crate) fn remove(&mut self, id: &str) {
        self.0.remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_renderer::tests::session;
    use lazysh_terminal_renderer_wgpu::Policy;

    fn drawing() -> Option<(Session, Inbox)> {
        Some(session())
    }

    /// Offscreen, accepting the software adapters CI has.
    fn target() -> Target {
        Target::new(240, 120).with_policy(Policy::for_platform().with_software())
    }

    fn ready(panes: &mut Panes, made: &mut u32, generation: u32) -> Result<(), String> {
        let look = Look {
            system_fonts: false,
            ..look("s", 1.0, 0x10_20_30)
        };
        panes.ready(
            "s",
            || {
                *made += 1;
                drawing()
            },
            target(),
            Box::new(()),
            generation,
            look,
        )
    }

    #[test]
    fn a_session_keeps_its_host_across_surfaces_and_a_removed_one_starts_again() {
        let (mut panes, mut made) = (Panes::default(), 0);
        ready(&mut panes, &mut made, 1).unwrap();
        panes.lost("s", 1);
        // Stop and start: a newer surface draws the same session, so the core is not asked for a second inbox.
        ready(&mut panes, &mut made, 2).unwrap();
        assert_eq!(made, 1);
        // A late callback of an older surface cannot bring it back.
        assert!(ready(&mut panes, &mut made, 2).is_err());
        panes.remove("s");
        ready(&mut panes, &mut made, 1).unwrap();
        assert_eq!(made, 2);
    }

    fn page_look(extra: serde_json::Value) -> SurfaceLook {
        let mut wanted = serde_json::json!({
            "theme": {"background": "#fafafa", "foreground": "#202020", "red": "#aa0000",
                "selectionBackground": "#cbdac0", "selectionForeground": "#101010"},
            "fontFamily": "'Fira Code', monospace", "fontSize": 20, "cursorStyle": "underline",
            "cursorBlink": false, "brightBold": true, "boldColor": "#336699",
        });
        wanted
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        serde_json::from_value(wanted).unwrap()
    }

    #[test]
    fn a_session_is_drawn_with_the_look_its_page_sent_on_every_display_and_the_default_before() {
        let before = look("look-a", 2.0, 0x10_20_30);
        assert_eq!(
            (before.font_px, before.scale, before.cursor),
            (14.0, 2.0, None)
        );
        assert_eq!(
            before.theme.background,
            RgbColor {
                r: 0x10,
                g: 0x20,
                b: 0x30
            }
        );

        remember("look-a", &page_look(serde_json::json!({}))).unwrap();
        let after = look("look-a", 2.5, 0x10_20_30);
        assert_eq!((after.font_px, after.scale), (20.0, 2.5));
        assert_eq!(after.font_family, "'Fira Code', monospace");
        assert_eq!(
            after.theme.background,
            RgbColor {
                r: 0xfa,
                g: 0xfa,
                b: 0xfa
            },
            "the theme's, not the pane's"
        );
        assert_eq!(
            after.theme.palette[1],
            RgbColor {
                r: 0xaa,
                g: 0,
                b: 0
            }
        );
        assert_eq!(
            after.theme.palette[2],
            RgbColor {
                r: 0x4e,
                g: 0x9a,
                b: 0x06
            },
            "what the theme leaves out is xterm.js's"
        );
        assert_eq!(
            after.theme.selection_background,
            RgbColor {
                r: 0xcb,
                g: 0xda,
                b: 0xc0
            }
        );
        assert_eq!(
            after.theme.selection_foreground,
            Some(RgbColor {
                r: 0x10,
                g: 0x10,
                b: 0x10
            })
        );
        assert_eq!(
            after.bold,
            BoldText {
                bright: true,
                color: Some(RgbColor {
                    r: 0x33,
                    g: 0x66,
                    b: 0x99
                })
            }
        );
        assert_eq!(
            after.cursor,
            Some(CursorDefault {
                style: CursorVisualStyle::Underline,
                blink: false
            })
        );
        // Another session has its own.
        assert_eq!(look("look-b", 1.0, 0).font_px, 14.0);
    }

    #[test]
    fn the_look_carries_the_imported_fonts_its_family_list_names_and_no_others() {
        let family = "lazysh-font-test-look-primary";
        crate::native_fonts::hold(crate::native_fonts::ImportedFont {
            family: family.into(),
            cjk: false,
            bytes: std::sync::Arc::from(vec![0u8; 16]),
        });
        let named = |list: String| {
            remember(
                "look-fonts",
                &page_look(serde_json::json!({"fontFamily": list})),
            )
            .unwrap();
            look("look-fonts", 1.0, 0).imported
        };
        let carried = named(format!("\"{family}\", 'Fira Code', monospace"));
        assert_eq!(
            carried
                .iter()
                .map(|font| font.family.as_str())
                .collect::<Vec<_>>(),
            [family]
        );
        assert!(named("'Fira Code', monospace".into()).is_empty());
        crate::native_fonts::forget(family);
        assert!(
            named(format!("\"{family}\", monospace")).is_empty(),
            "a font the app let go of is not carried"
        );
    }

    #[test]
    fn a_look_the_renderer_cannot_use_is_refused_and_changes_nothing() {
        remember("look-c", &page_look(serde_json::json!({}))).unwrap();
        for bad in [
            serde_json::json!({"theme": {"background": "red"}}),
            serde_json::json!({"theme": "dark"}),
            serde_json::json!({"boldColor": "blue"}),
        ] {
            assert!(
                remember("look-c", &page_look(bad.clone())).is_err(),
                "{bad}"
            );
        }
        assert_eq!(look("look-c", 1.0, 0).font_px, 20.0);
        // A selection colour the renderer cannot read is the default one, not an error.
        let odd = serde_json::json!({"theme": {"selectionBackground": "rgba(1, 2, 3, 0.3)"}});
        remember("look-c", &page_look(odd)).unwrap();
        assert_eq!(
            look("look-c", 1.0, 0).theme.selection_background,
            Theme::default().selection_background
        );
    }

    #[test]
    fn a_new_look_reaches_a_drawing_session_and_waits_for_one_that_is_not() {
        let mut panes = Panes::default();
        assert_eq!(
            panes.relook("look-d"),
            Ok(()),
            "no renderer, nothing to change"
        );
        let first = Look {
            system_fonts: false,
            ..look("look-d", 1.0, 0x10_20_30)
        };
        panes
            .ready("look-d", drawing, target(), Box::new(()), 1, first)
            .unwrap();
        remember("look-d", &page_look(serde_json::json!({}))).unwrap();
        assert_eq!(panes.relook("look-d"), Ok(()));
        assert_eq!(panes.0["look-d"].look.font_px, 20.0);
        assert_eq!(
            panes.0["look-d"].look.theme.background,
            RgbColor {
                r: 0xfa,
                g: 0xfa,
                b: 0xfa
            }
        );
        remember("look-d", &page_look(serde_json::json!({"fontSize": 12}))).unwrap();
        assert_eq!(panes.relook("look-d"), Ok(()));
        assert_eq!(panes.0["look-d"].look.font_px, 12.0);
    }

    #[test]
    fn a_size_for_a_session_without_a_renderer_is_refused() {
        let mut panes = Panes::default();
        assert!(panes.changed("s", 10, 10, look("s", 1.0, 0)).is_err());
    }

    #[test]
    fn a_session_without_a_core_leaves_no_renderer() {
        let mut panes = Panes::default();
        let result = panes.ready("s", || None, target(), Box::new(()), 1, look("s", 1.0, 0));
        assert!(result.is_err());
        assert!(panes.changed("s", 10, 10, look("s", 1.0, 0)).is_err());
    }
}
