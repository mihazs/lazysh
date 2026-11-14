//! What this build can offer the native terminal engine (#1336). The client's backend registry asks once per
//! device before it will pick the native engine; any missing piece is an answer with a reason, never an error, so a
//! build that cannot run the engine falls back to xterm.js and says why. Today the stages are the core (a build
//! feature) and a renderer (none exists in the app yet); GPU, surface and self-test stages join as their renderers land.
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq, Eq)]
pub struct NativeProbe {
    /// The core (`lazysh-terminal-runtime` on libghostty-vt) is built into this app.
    core: bool,
    /// A renderer that passed its surface and self-test stages can draw it.
    renderer: bool,
    /// The first missing piece, in words for the user; absent when nothing is missing.
    reason: Option<&'static str>,
}

fn probe(core: bool, renderer: bool) -> NativeProbe {
    let reason = match (core, renderer) {
        (false, _) => Some("The native terminal core is not built into this app."),
        (true, false) => Some("This build has no native terminal renderer."),
        (true, true) => None,
    };
    NativeProbe {
        core,
        renderer,
        reason,
    }
}

/// Capability only, like `local_capability`: it reveals nothing about a session, so it answers while the app is locked.
#[tauri::command]
pub fn terminal_native_probe() -> NativeProbe {
    // No renderer is wired into the app yet, so the answer is always "not available".
    probe(cfg!(feature = "native-terminal"), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_first_missing_piece_and_nothing_when_complete() {
        assert_eq!(
            probe(false, true).reason,
            Some("The native terminal core is not built into this app.")
        );
        assert_eq!(
            probe(false, false).reason,
            Some("The native terminal core is not built into this app.")
        );
        assert_eq!(
            probe(true, false).reason,
            Some("This build has no native terminal renderer.")
        );
        assert_eq!(probe(true, true).reason, None);
    }

    #[test]
    fn this_build_is_not_available_and_answers_as_the_client_reads_it() {
        let answer = serde_json::to_value(terminal_native_probe()).unwrap();
        assert_eq!(answer["core"], cfg!(feature = "native-terminal"));
        assert_eq!(answer["renderer"], false);
        assert!(answer["reason"].is_string());
    }

    #[test]
    fn a_locked_app_still_answers_the_probe() {
        assert!(crate::app_lock::allowed_while_locked(
            "terminal_native_probe"
        ));
    }
}
