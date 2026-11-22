//! Windows: a Scheduled Task of the current user, registered from an XML document.
use super::{render, render::NAME, tool, Failure, State};
use std::io::Write;

/// The task's registered XML, or `None` when there is no task of this name. `schtasks` answers in the
/// console code page or in UTF-16, so NUL padding is dropped before reading it as text.
fn registered() -> Option<String> {
    let output = tool("schtasks", &["/Query", "/TN", NAME, "/XML"])?;
    output.status.success().then(|| {
        let bytes: Vec<u8> = output
            .stdout
            .into_iter()
            .filter(|byte| *byte != 0)
            .collect();
        String::from_utf8_lossy(&bytes).into_owned()
    })
}
fn foreign(xml: &str) -> bool {
    !xml.contains(render::MARKER)
}
const FOREIGN: Failure = Failure::Refused("A task that lazysh did not create has this name");

pub fn install(
    exe: &str,
    before_write: &mut dyn FnMut() -> Result<(), Failure>,
) -> Result<(), Failure> {
    before_write()?;
    if registered().is_some_and(|xml| foreign(&xml)) {
        return Err(FOREIGN);
    }
    let refused = |_| Failure::Refused("The task document cannot be written");
    let mut document = tempfile::Builder::new()
        .suffix(".xml")
        .tempfile()
        .map_err(refused)?;
    // Task Scheduler reads the document it declares as UTF-16 little-endian with a byte order mark.
    let units: Vec<u8> = std::iter::once(0xFEFF)
        .chain(render::task_xml(exe).encode_utf16())
        .flat_map(u16::to_le_bytes)
        .collect();
    document.write_all(&units).map_err(refused)?;
    document.flush().map_err(refused)?;
    let path = document
        .path()
        .to_str()
        .ok_or(Failure::Refused("The task document path is not text"))?;
    match tool("schtasks", &["/Create", "/TN", NAME, "/XML", path, "/F"]) {
        Some(output) if output.status.success() => Ok(()),
        _ => Err(Failure::Refused("schtasks refused the task")),
    }
}

pub fn remove() -> Result<(), Failure> {
    let Some(xml) = registered() else {
        return Ok(());
    };
    if foreign(&xml) {
        return Err(FOREIGN);
    }
    match tool("schtasks", &["/Delete", "/TN", NAME, "/F"]) {
        Some(output) if output.status.success() => Ok(()),
        _ => Err(Failure::Refused("schtasks refused to delete the task")),
    }
}

pub fn state(exe: &str) -> State {
    match registered() {
        None => State::Absent,
        Some(xml) if !foreign(&xml) && xml.contains(exe.replace('&', "&amp;").as_str()) => {
            State::Installed
        }
        Some(_) => State::Drift,
    }
}
