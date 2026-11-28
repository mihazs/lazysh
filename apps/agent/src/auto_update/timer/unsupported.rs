//! A platform no companion release exists for: there is no timer to manage.
use super::State;
use crate::{Error, Result};

pub const KIND: &str = "none";

pub fn state(_: Option<&str>) -> State {
    State {
        supported: false,
        installed: false,
        enabled: false,
        drift: false,
    }
}
pub fn enable(_: &str) -> Result<()> {
    Err(Error::AutoUpdate("timerUnsupported"))
}
pub fn disable() -> Result<()> {
    Ok(())
}
