//! Runs the companion executable the way a hook does in tmux pane `%7`, with its state in an isolated directory.
use serde_json::Value;
use std::{
    path::Path,
    process::{Command, Output},
};
#[path = "process.rs"]
mod process;

pub fn run(directory: &Path, args: &[&str], input: &Value) -> Output {
    process::run(
        Command::new(env!("CARGO_BIN_EXE_lazysh-agent"))
            .args(args)
            .env("LAZYSH_STATE_DIR", directory)
            .env("TMUX_PANE", "%7"),
        &serde_json::to_vec(input).unwrap(),
    )
}
