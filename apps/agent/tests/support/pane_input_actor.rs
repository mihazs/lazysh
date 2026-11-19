//! Drives `lazysh-agent herdr-pane-input` over its JSON-lines stdin and stdout.
use serde_json::Value;
use std::{process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout, Command},
};

pub struct Actor {
    pub child: Child,
    pub stdin: Option<ChildStdin>,
    stdout: BufReader<ChildStdout>,
}
impl Actor {
    /// Starts the actor for `session` with the environment already set on `command`.
    pub fn spawn(mut command: Command, session: &str) -> Self {
        let mut child = command
            .args(["herdr-pane-input", "--session", session])
            .kill_on_drop(true)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take();
        let stdout = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            stdin,
            stdout,
        }
    }
    pub async fn line(&mut self) -> Option<Value> {
        let mut line = String::new();
        let read = tokio::time::timeout(Duration::from_secs(10), self.stdout.read_line(&mut line))
            .await
            .expect("the actor answered in time")
            .unwrap();
        (read > 0).then(|| serde_json::from_str(&line).unwrap())
    }
    pub async fn write(&mut self, line: &str) {
        let stdin = self.stdin.as_mut().unwrap();
        stdin.write_all(line.as_bytes()).await.unwrap();
        stdin.write_all(b"\n").await.unwrap();
    }
    pub async fn ask(&mut self, request: Value) -> Value {
        self.write(&request.to_string()).await;
        self.line().await.expect("an answer")
    }
    /// Closes stdin and reports whether the actor then exited cleanly.
    pub async fn exit_success(mut self) -> bool {
        drop(self.stdin.take());
        tokio::time::timeout(Duration::from_secs(10), self.child.wait())
            .await
            .expect("the actor exited")
            .unwrap()
            .success()
    }
    /// Waits for the actor to end by itself and reports whether it failed.
    pub async fn ended_with_failure(&mut self) -> bool {
        assert!(self.line().await.is_none(), "the actor ended");
        !self.child.wait().await.unwrap().success()
    }
}
