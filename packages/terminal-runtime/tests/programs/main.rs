//! Real programs on the core (#1314): what tmux, vim, bash, Herdr and the agent TUIs do when the core is
//! their terminal, for the divergences from xterm.js that a program could notice
//! (`fixtures/divergences.json` names the test that settles each one). Each program runs on a pty, its
//! output is parsed by the core, the core's replies go back to it and its keys are encoded by the core.
//! tmux, vim, bash and Herdr are required in CI; an agent TUI that is not installed skips its test.
#![cfg(target_os = "linux")]

mod pty;

use lazysh_terminal_runtime::{ffi, RgbColor, Theme};
use pty::{find, Program, Scratch};
use std::path::Path;
use std::process::Command;
use std::time::Duration;

const SHIFT: u16 = ffi::GHOSTTY_MODS_SHIFT as u16;
const CTRL: u16 = ffi::GHOSTTY_MODS_CTRL as u16;
const ALT: u16 = ffi::GHOSTTY_MODS_ALT as u16;

/// What the core answers a program that asks who it is talking to (`device-attributes-identity`).
const DA1: &[u8] = b"\x1b[?62;22c";
const DA2: &[u8] = b"\x1b[>1;0;0c";

/// Black on white, to tell a program that took the core's colour reply from one that kept its own default.
fn light_theme() -> Theme {
    let rgb = |v| RgbColor { r: v, g: v, b: v };
    Theme {
        foreground: rgb(0),
        background: rgb(0xff),
        ..Theme::default()
    }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// The sequences the core ignores or reads differently from xterm.js and that a program could send: an
/// explicit 0 count on DCH, IL, DL, SU, SD, CHT or CBT and TBC without a parameter
/// (`explicit-zero-count-ignored`, `tab-clear-without-parameter`), and DECXCPR (`decxcpr-unanswered`).
fn unsupported_sequences(output: &[u8]) -> Vec<String> {
    let mut found = Vec::new();
    for (at, _) in output.windows(2).enumerate().filter(|(_, w)| w == b"\x1b[") {
        let body = &output[at + 2..];
        let Some(end) = body.iter().position(|b| (0x40..=0x7e).contains(b)) else {
            continue;
        };
        let (params, last) = (&body[..end], body[end]);
        let zero_count = params == b"0" && b"PLMSTIZ".contains(&last);
        if zero_count || (params.is_empty() && last == b'g') || (params == b"?6" && last == b'n') {
            found.push(format!(
                "ESC [ {}{}",
                params.escape_ascii(),
                char::from(last)
            ));
        }
    }
    found
}

fn assert_supported(who: &str, output: &[u8]) {
    assert_eq!(unsupported_sequences(output), Vec::<String>::new(), "{who}");
}

/// What a real program sent is the evidence for `explicit-zero-count-ignored`, `tab-clear-without-parameter`
/// and `decxcpr-unanswered`: none of the captures of the programs lazysh targets contains one of them.
#[test]
fn no_captured_program_sends_a_sequence_the_core_ignores() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/captures");
    let mut captures = 0;
    for entry in std::fs::read_dir(dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|ext| ext == "bin") {
            assert_supported(&path.display().to_string(), &std::fs::read(&path).unwrap());
            captures += 1;
        }
    }
    assert!(captures >= 15, "captures went missing: {captures}");
    // The scan itself: it finds each sequence it looks for and none of the ones that work.
    let sent = b"\x1b[0P\x1b[0m\x1b[3P\x1b[g\x1b[0g\x1b[?6n\x1b[6n\x1b[0Z\x1b[1;0H\x1b[?0S";
    assert_eq!(
        unsupported_sequences(sent),
        ["ESC [ 0P", "ESC [ g", "ESC [ ?6n", "ESC [ 0Z"]
    );
}

/// tmux asks for device attributes and the terminal version at startup and sets itself up from the answers;
/// on the core's identity it draws its status line, takes Alt+arrow as `M-Left` (the standard encoding, where
/// xterm.js sent the Ctrl form), and writes the clipboard with an empty OSC 52 selection, which the core
/// hands to the host (the `osc52-selection-filter` drops only writes that name no clipboard).
#[test]
fn tmux_starts_on_the_cores_identity_reads_alt_arrow_and_writes_the_clipboard() {
    let scratch = Scratch::new("tmux");
    let Some(mut tmux) = Tmux::start(&scratch, "bind -n M-Left send-keys ALT-LEFT-SEEN\nbind -n C-Left send-keys CTRL-LEFT-SEEN\nset -g set-clipboard on\n") else {
        return;
    };
    tmux.program.wait_for_text("[probe]");
    // tmux 3.2 asks DA2 and the terminal version, 3.3 and later DA1 as well: it gets the core's answer to each.
    let mut asked = 0;
    for (query, answer) in [(&b"\x1b[c"[..], DA1), (&b"\x1b[>c"[..], DA2)] {
        if contains(&tmux.program.printed, query) {
            assert!(contains(&tmux.program.replies, answer), "{query:?}");
            asked += 1;
        }
    }
    assert!(asked > 0, "tmux asked for neither DA1 nor DA2");

    assert_eq!(
        tmux.program.press("ArrowLeft", "ArrowLeft", ALT),
        b"\x1b[1;3D"
    );
    tmux.program.wait_for_text("ALT-LEFT-SEEN");
    assert_eq!(
        tmux.program.press("ArrowLeft", "ArrowLeft", CTRL),
        b"\x1b[1;5D"
    );
    tmux.program.wait_for_text("CTRL-LEFT-SEEN");

    // `set-buffer -w` makes tmux write OSC 52 with an empty selection.
    tmux.run(&["set-buffer", "-w", "from tmux"]);
    let mut writes = Vec::new();
    for _ in 0..100 {
        tmux.program.pump(Duration::from_millis(50));
        writes.extend(tmux.program.rt.take_events().clipboard_writes);
        if !writes.is_empty() {
            break;
        }
    }
    assert_eq!(writes, [b"from tmux".to_vec()]);
    assert_supported("tmux", &tmux.program.printed);
}

/// Emoji and CJK take two cells in the core (`unicode-widths-and-graphemes`), the width tmux's own layout
/// assumes: the pane border stays in one column on the row that holds them, and a resize redraws cleanly.
#[test]
fn tmux_lays_out_a_row_of_emoji_and_cjk_the_way_the_core_measures_it() {
    let scratch = Scratch::new("tmux-wide");
    let Some(mut tmux) = Tmux::start(&scratch, "") else {
        return;
    };
    tmux.program.wait_for_text("[probe]");
    tmux.run(&["split-window", "-h"]);
    tmux.run(&["select-pane", "-L"]);
    tmux.program.type_text("echo 😀😀😀 日本語");
    tmux.program.press("Enter", "Enter", 0);
    let screen = tmux.program.wait_for("the echoed line", |s| {
        s.matches("😀😀😀 日本語").count() == 2
    });
    let row = screen
        .lines()
        .position(|line| line.starts_with("😀😀😀 日本語"))
        .unwrap();
    for y in 0..23 {
        assert_eq!(
            tmux.program.cell(40, y),
            "│",
            "the pane border on row {y} (the wide characters are on row {row})"
        );
    }

    tmux.program.resize(60, 20);
    tmux.program
        .wait_for("the status line on the last row", |s| {
            s.lines().nth(19).is_some_and(|l| l.starts_with("[probe]"))
        });
    assert_eq!(tmux.program.screen().lines().count(), 20);
}

/// vim asks for the terminal's identity and keeps the answer in `v:termresponse`; Alt+arrow reaches a
/// `<M-Left>` mapping with the standard encoding.
#[test]
fn vim_starts_on_the_cores_identity_and_reads_alt_arrow() {
    let Some(vim) = find("vim") else { return };
    let scratch = Scratch::new("vim");
    let home = scratch.dir("home");
    let mut program = Program::start(
        &vim,
        &["-u", "NONE", "-N", "-n", "-i", "NONE"],
        &[("HOME", &home)],
        80,
        24,
    );
    program.wait_for_text("VIM");
    assert!(contains(&program.replies, DA2), "vim asked DA2");

    program.type_text(":inoremap <M-Left> ALT");
    program.press("Enter", "Enter", 0);
    program.type_text("ihello 日本語");
    assert_eq!(program.press("ArrowLeft", "ArrowLeft", ALT), b"\x1b[1;3D");
    program.wait_for("the mapping to type into line 1", |s| {
        s.lines()
            .next()
            .is_some_and(|l| l.contains("hello 日本語ALT"))
    });
    program.press("Escape", "Escape", 0);
    program.type_text(":echo v:termresponse");
    program.press("Enter", "Enter", 0);
    program.wait_for_text("^[[>1;0;0c");
    assert_supported("vim", &program.printed);
}

/// vim queries the default colours with BEL-terminated `OSC 10` and `OSC 11` (`color-query-terminator-echoed`): the
/// core answers each with a BEL, as xterm does, and vim takes the background it is told (light here) for its
/// `background` option.
#[test]
fn vim_takes_its_background_from_the_cores_bel_terminated_reply() {
    let Some(vim) = find("vim") else { return };
    let scratch = Scratch::new("vim-light");
    let home = scratch.dir("home");
    let mut program = Program::start_themed(
        &vim,
        &["-u", "NONE", "-N", "-n", "-i", "NONE"],
        &[("HOME", &home)],
        80,
        24,
        light_theme(),
    );
    program.wait_for_text("VIM");
    // vim 9 asks for the background after DA2; an older vim (Ubuntu 22.04's 8.2) may not ask at all.
    program.pump(Duration::from_secs(2));
    if !contains(&program.printed, b"\x1b]11;?\x07") {
        eprintln!("skipped: this vim does not query the background colour");
        return;
    }
    assert!(
        contains(&program.replies, b"\x1b]11;rgb:ffff/ffff/ffff\x07"),
        "the reply ends the way the query did"
    );
    // vim reads the reply after it has drawn its first screen, so ask until it has.
    let mut shown = String::new();
    for _ in 0..10 {
        program.type_text(":set background?");
        program.press("Enter", "Enter", 0);
        program.pump(Duration::from_millis(500));
        shown = program.screen();
        if shown.contains("background=light") {
            return;
        }
    }
    panic!(
        "vim kept a dark background though the core's reply said white; the screen shows:\n{shown}"
    );
}

/// Readline takes the standard Alt+Left (`CSI 1;3D`) as backward-word, as it does the Ctrl form xterm.js sent.
#[test]
fn bash_moves_back_a_word_on_the_standard_alt_arrow() {
    let Some(bash) = find("bash") else { return };
    let scratch = Scratch::new("bash");
    let home = scratch.dir("home");
    let env = [
        ("HOME", home.as_str()),
        ("PS1", "$ "),
        ("INPUTRC", "/dev/null"),
    ];
    let mut program = Program::start(&bash, &["--noprofile", "--norc", "-i"], &env, 80, 24);
    program.wait_for_text("$");
    program.type_text("echo one two");
    assert_eq!(program.press("ArrowLeft", "ArrowLeft", ALT), b"\x1b[1;3D");
    program.type_text("X");
    program.wait_for_text("$ echo one Xtwo");
    assert_supported("bash", &program.printed);
}

/// Herdr pushes the Kitty keyboard flags (`CSI > 7 u`, then `CSI > 31 u`) and parses what the core encodes
/// under them: Esc closes its settings dialog as `CSI 27 u`, and Ctrl+b then ? opens its keybinds overlay
/// from `CSI 98;5 u` and the report of `?` (`kitty-keyboard-protocol-honoured`).
#[test]
fn herdr_takes_its_keys_as_kitty_reports_from_the_core() {
    let Some(herdr) = find("herdr") else { return };
    let scratch = Scratch::new("herdr");
    let (home, socket) = (
        scratch.dir("home"),
        scratch
            .path("herdr.sock")
            .into_os_string()
            .into_string()
            .unwrap(),
    );
    let env = [
        ("HOME", home.as_str()),
        ("HERDR_SOCKET_PATH", socket.as_str()),
        ("SHELL", "/bin/sh"),
    ];
    let mut program = Program::start(&herdr, &[], &env, 100, 30);
    let mut stop = Command::new(&herdr);
    stop.args(["server", "stop"]).env_clear().envs(env);
    program.cleanup_with(stop);

    program.wait_for_text("mouse-first");
    program.wait_for_output(b"\x1b[>7u");
    assert!(contains(&program.replies, DA1), "Herdr asked DA1");
    assert_eq!(program.press("Enter", "Enter", 0), b"\r");
    program.wait_for_text("agent integrations");
    assert_eq!(program.press("Escape", "Escape", 0), b"\x1b[27u");
    program.wait_for("the settings dialog to close", |s| {
        !s.contains("agent integrations") && s.contains('$')
    });
    assert_eq!(program.press("KeyB", "b", CTRL), b"\x1b[98;5u");
    program.press("Slash", "?", SHIFT);
    program.wait_for_text("prefix+?");
    assert_supported("Herdr", &program.printed);
}

/// The agent TUIs start on the core and take the keys it encodes. Their first-run screens need no account.
fn agent(scratch: &Scratch, name: &str, args: &[&str], env: &[(&str, &str)]) -> Option<Program> {
    let program = find(name)?;
    let home = scratch.dir("home");
    let mut full = vec![
        ("HOME", home.as_str()),
        ("XDG_CONFIG_HOME", &home),
        ("XDG_DATA_HOME", &home),
        ("XDG_STATE_HOME", &home),
        ("XDG_CACHE_HOME", &home),
    ];
    full.extend_from_slice(env);
    Some(Program::start(&program, args, &full, 100, 30))
}

/// Codex pushes `CSI > 7 u` and reads the Down arrow as `CSI 1;1:1 B` (a press event).
#[test]
fn codex_moves_its_menu_selection_on_the_core_s_kitty_key_reports() {
    let scratch = Scratch::new("codex");
    let codex_home = scratch.dir("codex");
    let Some(mut program) = agent(&scratch, "codex", &[], &[("CODEX_HOME", &codex_home)]) else {
        return;
    };
    program.wait_for("the first selection", |s| {
        s.contains("> 1. Sign in with ChatGPT")
    });
    let sent = program.press_until("ArrowDown", "ArrowDown", |s| {
        !s.contains("> 1. Sign in with ChatGPT")
    });
    assert_eq!(sent, b"\x1b[1;1:1B");
    program.wait_for("the selection to leave the first option", |s| {
        s.contains("> 2.") || s.contains("> 3.")
    });
    assert_supported("Codex", &program.printed);
}

/// Claude Code asks DA1, XTVERSION and the Kitty flags (it gets `?0u`) and keeps its legacy keys.
#[test]
fn claude_code_starts_and_moves_its_theme_selection_on_legacy_keys() {
    let scratch = Scratch::new("claude");
    let config = scratch.dir("claude");
    let env = [
        ("CLAUDE_CONFIG_DIR", config.as_str()),
        ("DISABLE_AUTOUPDATER", "1"),
        ("DISABLE_TELEMETRY", "1"),
    ];
    let Some(mut program) = agent(&scratch, "claude", &[], &env) else {
        return;
    };
    program.wait_for("the theme picker", |s| s.contains("Choose the text style"));
    program.wait_for_output(b"\x1b[?u");
    assert!(
        contains(&program.replies, b"\x1b[?0u"),
        "Claude Code asked for the Kitty flags"
    );
    let sent = program.press_until("ArrowDown", "ArrowDown", |s| {
        !s.lines().any(|l| {
            l.contains('❯')
                && l.contains("Dark mode")
                && !l.contains("colorblind")
                && !l.contains("ANSI")
        })
    });
    assert_eq!(sent, b"\x1b[B");
    assert_supported("Claude Code", &program.printed);
}

/// OpenCode asks whether the terminal clusters graphemes (mode 2027) and reports colour scheme changes
/// (mode 2031) and lays its home screen out on the answer (`private-mode-queries-known`).
#[test]
fn opencode_starts_and_learns_that_the_core_clusters_graphemes() {
    let scratch = Scratch::new("opencode");
    let Some(mut program) = agent(&scratch, "opencode", &[], &[]) else {
        return;
    };
    program.wait_for("the prompt box", |s| s.contains("Ask anything"));
    assert!(
        contains(&program.replies, b"\x1b[?2027;1$y"),
        "mode 2027 is set"
    );
    assert!(
        contains(&program.replies, b"\x1b[?2031;1$y"),
        "mode 2031 is set"
    );
    program.type_text("hello 日本語 😀");
    program.wait_for_text("hello 日本語 😀");
    assert_supported("OpenCode", &program.printed);
}

/// OpenCode queries the default colours and the palette with BEL-terminated `OSC 10`, `11` and `4`
/// (`color-query-terminator-echoed`) and paints its home screen in the scheme it is told: the background
/// the core's reply names, white or black here.
#[test]
fn opencode_paints_the_scheme_the_cores_bel_terminated_replies_name() {
    let scratch = Scratch::new("opencode-theme");
    let Some(opencode) = find("opencode") else {
        return;
    };
    let home = scratch.dir("home");
    let env = [
        ("HOME", home.as_str()),
        ("XDG_CONFIG_HOME", &home),
        ("XDG_DATA_HOME", &home),
        ("XDG_STATE_HOME", &home),
        ("XDG_CACHE_HOME", &home),
    ];
    let brightness = |theme| {
        let mut program = Program::start_themed(&opencode, &[], &env, 100, 30, theme);
        program.wait_for("the prompt box", |s| s.contains("Ask anything"));
        assert!(
            contains(&program.replies, b"\x1b]11;rgb:"),
            "OpenCode asked for the background"
        );
        // Its first frames may precede the theme it derives from the replies.
        program.pump(Duration::from_secs(1));
        let bg = program.dominant_background().unwrap();
        u16::from(bg.r) + u16::from(bg.g) + u16::from(bg.b)
    };
    assert!(brightness(light_theme()) > 600, "a white background");
    assert!(brightness(Theme::default()) < 100, "a black background");
}

/// A tmux client on a private socket and config; its server is killed with the program.
struct Tmux {
    program: Program,
    path: std::path::PathBuf,
    socket: std::path::PathBuf,
}

impl Tmux {
    fn start(scratch: &Scratch, config: &str) -> Option<Self> {
        let path = find("tmux")?;
        let (socket, conf) = (scratch.path("tmux.sock"), scratch.path("tmux.conf"));
        std::fs::write(&conf, config).unwrap();
        let home = scratch.dir("home");
        let args = [
            "-S",
            socket.to_str().unwrap(),
            "-f",
            conf.to_str().unwrap(),
            "new-session",
            "-s",
            "probe",
            "sh",
        ];
        let mut program = Program::start(
            &path,
            &args,
            &[("HOME", &home), ("SHELL", "/bin/sh")],
            80,
            24,
        );
        let mut kill = Command::new(&path);
        kill.args(["-S", socket.to_str().unwrap(), "kill-server"]);
        program.cleanup_with(kill);
        Some(Self {
            program,
            path,
            socket,
        })
    }

    fn run(&self, args: &[&str]) {
        let out = Command::new(&self.path)
            .arg("-S")
            .arg(&self.socket)
            .args(args)
            .output()
            .unwrap();
        assert!(out.status.success(), "tmux {args:?}: {out:?}");
    }
}

/// A program that starts a daemon in its own session (as `codex app-server` does) leaves nothing behind
/// when the test ends, normally or by panic.
#[test]
fn a_detached_daemon_does_not_outlive_the_program_guard() {
    let alive = |pid: &str| Path::new(&format!("/proc/{pid}")).exists();
    let run = |panic: bool| {
        let scratch = Scratch::new(if panic { "daemon-panic" } else { "daemon-ok" });
        let pidfile = scratch.path("daemon.pid");
        let script = format!(
            "setsid sleep 300 </dev/null >/dev/null 2>&1 & echo $! > {pidfile:?}; sleep 300"
        );
        let body = std::panic::AssertUnwindSafe(|| {
            let program = Program::start(Path::new("/bin/sh"), &["-c", &script], &[], 80, 24);
            let pid = loop {
                if let Ok(pid) = std::fs::read_to_string(&pidfile) {
                    if !pid.trim().is_empty() {
                        break pid.trim().to_string();
                    }
                }
                std::thread::sleep(Duration::from_millis(20));
            };
            assert!(alive(&pid), "the daemon runs while the program does");
            let _program = program;
            if panic {
                panic!("test body fails");
            }
            pid
        });
        let result = std::panic::catch_unwind(body);
        let pid = std::fs::read_to_string(&pidfile)
            .unwrap()
            .trim()
            .to_string();
        assert_eq!(result.is_err(), panic);
        assert!(
            !alive(&pid),
            "daemon {pid} outlived the test (panic: {panic})"
        );
    };
    run(false);
    run(true);
}
