//! The renderer hosts of the sessions a platform surface draws (#1327): one [`Host`] per session, created by the
//! first surface and kept across the surfaces that follow (the window destroys and recreates its surface on stop
//! and start; the session and its screen live on). Platform-neutral, so the bookkeeping is tested on every host
//! with offscreen targets; the Android entry points in [`super::android`] only turn a `Surface` into a [`Target`].
#![cfg_attr(not(target_os = "android"), allow(dead_code))]
use crate::native_renderer::{Host, Inbox, Look};
use lazysh_terminal_renderer_wgpu::Target;
use lazysh_terminal_runtime::{RgbColor, Session, Theme};
use std::any::Any;
use std::collections::HashMap;

/// What the platform keeps alive for a surface (an `ANativeWindow` reference) until its renderer is destroyed.
pub(crate) type Holder = Box<dyn Any + Send>;

// shortcut: the font is the system's monospace at 14 CSS pixels and the colours are the default theme on the
// pane's background; take both from the user's preferences once the page sends them with the anchor.
pub(crate) fn look(scale: f32, background: u32) -> Look {
    let mut theme = Theme::default();
    let [_, r, g, b] = background.to_be_bytes();
    theme.background = RgbColor { r, g, b };
    Look {
        theme,
        font_family: "monospace".into(),
        font_px: 14.0,
        scale,
        system_fonts: true,
    }
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
            ..look(1.0, 0x10_20_30)
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

    #[test]
    fn a_size_for_a_session_without_a_renderer_is_refused() {
        let mut panes = Panes::default();
        assert!(panes.changed("s", 10, 10, look(1.0, 0)).is_err());
    }

    #[test]
    fn a_session_without_a_core_leaves_no_renderer() {
        let mut panes = Panes::default();
        let result = panes.ready("s", || None, target(), Box::new(()), 1, look(1.0, 0));
        assert!(result.is_err());
        assert!(panes.changed("s", 10, 10, look(1.0, 0)).is_err());
    }
}
