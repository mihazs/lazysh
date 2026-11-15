//! A tiny real executable that answers like a companion, built with `rustc` so the same test runs on
//! every platform. `hold` keeps the process (and therefore its image) alive.
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
};

const SOURCE: &str = r#"
use std::{env, fs, io::Read, path::PathBuf, thread, time::Duration};
fn main() {
    let args: Vec<String> = env::args().collect();
    let state = env::var_os("LAZYSH_STATE_DIR").map(PathBuf::from);
    match args.get(1).map(String::as_str) {
        Some("--version") => {
            // The flaky one is right only while it is a staged file, and wrong once it is installed.
            let staged = env::current_exe().unwrap().file_name().unwrap().to_string_lossy().starts_with(".update-");
            println!("lazysh-agent {}", if FLAKY && !staged { "0.0.1" } else { VERSION });
        }
        Some("ingest") => {
            let mut text = String::new();
            std::io::stdin().read_to_string(&mut text).unwrap();
            let dir = state.unwrap();
            fs::create_dir_all(&dir).unwrap();
            fs::write(dir.join("event"), text).unwrap();
        }
        Some("snapshot") => {
            if fs::metadata(state.unwrap().join("event")).is_ok() {
                println!("{{\"schemaVersion\":1,\"sessions\":[{{\"sessionId\":\"lazysh-update-selftest\"}}]}}");
            }
        }
        Some("hold") => thread::sleep(Duration::from_secs(120)),
        _ => std::process::exit(2),
    }
}
"#;

/// The bytes of a stub that reports `version`; `flaky` ones report another version once installed.
pub fn build(scratch: &Path, version: &str, flaky: bool) -> Vec<u8> {
    let source = scratch.join(format!("stub-{version}-{flaky}.rs"));
    let out: PathBuf = scratch.join(format!(
        "stub-{version}-{flaky}{}",
        std::env::consts::EXE_SUFFIX
    ));
    fs::write(
        &source,
        format!("const VERSION: &str = {version:?};\nconst FLAKY: bool = {flaky};\n{SOURCE}"),
    )
    .unwrap();
    let rustc = std::env::var_os("RUSTC").unwrap_or_else(|| "rustc".into());
    let status = Command::new(rustc)
        .args([
            "--crate-name",
            "stub",
            "--edition",
            "2021",
            "-C",
            "debuginfo=0",
            "-o",
        ])
        .arg(&out)
        .arg(&source)
        .status()
        .unwrap();
    assert!(status.success(), "rustc could not build the stub companion");
    fs::read(out).unwrap()
}
