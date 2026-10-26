pub fn words(text: &str) -> Vec<String> {
    text.split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_ascii_uppercase)
        .collect()
}

pub fn word_error_rate(reference: &str, observed: &str) -> f64 {
    let reference = words(reference);
    let observed = words(observed);
    assert!(!reference.is_empty());
    let mut previous: Vec<usize> = (0..=observed.len()).collect();
    for (i, expected) in reference.iter().enumerate() {
        let mut row = vec![i + 1];
        for (j, actual) in observed.iter().enumerate() {
            row.push(
                (previous[j] + usize::from(expected != actual))
                    .min(previous[j + 1] + 1)
                    .min(row[j] + 1),
            );
        }
        previous = row;
    }
    previous[observed.len()] as f64 / reference.len() as f64
}

#[cfg(target_os = "linux")]
pub fn terminate_processes_matching(
    executable: &std::path::Path,
    exact_argument: &std::ffi::OsStr,
) {
    use std::os::unix::ffi::OsStrExt;
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else {
            continue;
        };
        let Ok(command) = std::fs::read(entry.path().join("cmdline")) else {
            continue;
        };
        if matches_process(&command, executable, exact_argument.as_bytes()) {
            let _ = std::process::Command::new("kill")
                .args(["-TERM", &pid.to_string()])
                .status();
        }
    }
}

#[cfg(target_os = "linux")]
fn matches_process(command: &[u8], executable: &std::path::Path, argument: &[u8]) -> bool {
    use std::os::unix::ffi::OsStrExt;
    let args = command.split(|byte| *byte == 0).collect::<Vec<_>>();
    args.first().is_some_and(|arg| {
        std::path::Path::new(std::ffi::OsStr::from_bytes(arg)).file_name() == executable.file_name()
    }) && args.contains(&argument)
}

pub fn successful_output(command: &mut std::process::Command) -> String {
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    String::from_utf8(output.stdout).unwrap()
}

/// Dev-feature adapter for the private validator observer seam; absent from normal builds.
pub fn observe_sidecar(
    kind: crate::private_state::SidecarKind,
    observe: impl FnMut() -> std::io::Result<Option<std::fs::Metadata>>,
) -> std::io::Result<()> {
    crate::private_state::observe_sidecar(kind, observe)
}
pub fn regular_state_metadata(
    path: &std::path::Path,
    message: &'static str,
) -> std::io::Result<Option<std::fs::Metadata>> {
    crate::private_state::regular_state_metadata(path, message)
}

#[cfg(test)]
mod tests {
    #[test]
    fn word_error_counts_insertions_deletions_and_substitutions() {
        assert_eq!(super::word_error_rate("hello world", "HELLO, world!"), 0.0);
        for observed in ["hello", "hello wide world", "hello there"] {
            assert_eq!(super::word_error_rate("hello world", observed), 0.5);
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn process_match_requires_executable_and_exact_private_argument() {
        let binary = std::path::Path::new("/fixture/etterminal");
        let command = b"/usr/bin/etterminal\0--fifo\0/private/fixture\0";
        assert!(super::matches_process(command, binary, b"/private/fixture"));
        assert!(!super::matches_process(
            command,
            binary,
            b"/private/fixture-other"
        ));
        assert!(!super::matches_process(
            command,
            std::path::Path::new("other"),
            b"/private/fixture"
        ));
    }
}
