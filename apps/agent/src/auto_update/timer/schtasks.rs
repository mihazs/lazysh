//! Windows: a Scheduled Task of the current user, created with `schtasks /Create /XML` without
//! elevation, at logon and then hourly. `schtasks` reads the definition as UTF-16.
//! Not exercised on a Windows host by this repository's tests: the XML is validated as written, and
//! the commands below follow the documented `schtasks` syntax.
use super::{failed, render, tool, State};
use crate::{Error, Result};

pub const KIND: &str = "schtasks";

fn schtasks(args: &[&str]) -> Option<super::Output> {
    tool("schtasks", args)
}
/// The task's own definition as the scheduler reports it, when there is one.
fn definition() -> Option<String> {
    schtasks(&["/Query", "/TN", render::TASK_NAME, "/XML"])
        .filter(|output| output.success)
        .map(|output| output.stdout)
}

pub fn state(exe: Option<&str>) -> State {
    let supported = schtasks(&["/?"]).is_some_and(|output| output.success);
    let found = definition().filter(|xml| xml.contains(render::MARKER));
    let installed = found.is_some();
    // The scheduler escapes the command the way the template does, so containment is the check.
    let exact = installed
        && exe.is_some_and(|exe| {
            let wanted = render::task_xml(exe);
            let command = wanted
                .split("<Command>")
                .nth(1)
                .and_then(|rest| rest.split("</Command>").next());
            command.is_some_and(|command| found.as_deref().is_some_and(|xml| xml.contains(command)))
        });
    State {
        supported,
        installed,
        enabled: installed
            && found
                .as_deref()
                .is_some_and(|xml| !xml.contains("<Enabled>false</Enabled>")),
        drift: installed && !exact,
    }
}

pub fn enable(exe: &str) -> Result<()> {
    if !schtasks(&["/?"]).is_some_and(|output| output.success) {
        return Err(Error::AutoUpdate("timerUnsupported"));
    }
    // A task of that name that is not ours is somebody else's.
    if definition().is_some_and(|xml| !xml.contains(render::MARKER)) {
        return Err(failed());
    }
    let mut file = tempfile::Builder::new()
        .prefix("lazysh-task-")
        .suffix(".xml")
        .tempfile()
        .map_err(|_| failed())?;
    let bytes = render::utf16le_with_bom(&render::task_xml(exe));
    std::io::Write::write_all(&mut file, &bytes).map_err(|_| failed())?;
    let path = file.path().to_string_lossy().into_owned();
    let created = schtasks(&["/Create", "/TN", render::TASK_NAME, "/XML", &path, "/F"])
        .is_some_and(|output| output.success);
    created.then_some(()).ok_or_else(failed)
}

pub fn disable() -> Result<()> {
    if definition().is_some_and(|xml| xml.contains(render::MARKER)) {
        schtasks(&["/Delete", "/TN", render::TASK_NAME, "/F"]);
    }
    Ok(())
}
