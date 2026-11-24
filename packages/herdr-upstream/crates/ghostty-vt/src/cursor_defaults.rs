use crate::{ffi, CursorVisualStyle, Error, GhosttyResultExt, Terminal};
use std::ptr;

impl Terminal {
    pub fn set_default_cursor(
        &mut self,
        style: CursorVisualStyle,
        blink: bool,
    ) -> Result<(), Error> {
        use ffi::{
            GhosttyTerminalCursorStyle_GHOSTTY_TERMINAL_CURSOR_STYLE_BAR as BAR,
            GhosttyTerminalCursorStyle_GHOSTTY_TERMINAL_CURSOR_STYLE_BLOCK as BLOCK,
            GhosttyTerminalCursorStyle_GHOSTTY_TERMINAL_CURSOR_STYLE_BLOCK_HOLLOW as HOLLOW,
            GhosttyTerminalCursorStyle_GHOSTTY_TERMINAL_CURSOR_STYLE_UNDERLINE as UNDERLINE,
        };
        let style = match style {
            CursorVisualStyle::Bar => BAR,
            CursorVisualStyle::Block => BLOCK,
            CursorVisualStyle::BlockHollow => HOLLOW,
            CursorVisualStyle::Underline => UNDERLINE,
        };
        // SAFETY: the option values have the exact C types and the terminal copies them.
        unsafe {
            ffi::ghostty_terminal_set(
                self.raw,
                ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_STYLE,
                ptr::from_ref(&style).cast(),
            )
            .into_result()?;
            ffi::ghostty_terminal_set(
                self.raw,
                ffi::GhosttyTerminalOption_GHOSTTY_TERMINAL_OPT_DEFAULT_CURSOR_BLINK,
                ptr::from_ref(&blink).cast(),
            )
            .into_result()
        }
    }
}
