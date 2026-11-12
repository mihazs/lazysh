use crate::runtime::Error;

/// Upper bound on cells per session so a hostile or buggy size cannot allocate without limit.
pub const MAX_CELLS: u32 = 1 << 18;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Size {
    pub cols: u16,
    pub rows: u16,
    pub cell_width_px: u32,
    pub cell_height_px: u32,
}

impl Size {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            cols,
            rows,
            cell_width_px: 1,
            cell_height_px: 1,
        }
    }

    pub(crate) fn validate(self) -> Result<Self, Error> {
        if self.cols == 0
            || self.rows == 0
            || u32::from(self.cols) * u32::from(self.rows) > MAX_CELLS
        {
            return Err(Error::InvalidSize(self));
        }
        Ok(self)
    }
}

/// Who decides the grid size. `Transport` is Mosh's canonical framebuffer: UI requests are
/// forwarded, never applied locally.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeAuthority {
    Local,
    Transport,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SizeOutcome {
    Applied,
    /// Recorded as intent only; the caller forwards it to the transport, whose answer arrives via
    /// `apply_transport_size`.
    Deferred(Size),
}
