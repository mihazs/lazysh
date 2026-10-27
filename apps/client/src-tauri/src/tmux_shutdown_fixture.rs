//! Controlled shutdown discriminators, not a claim about the hosted failure's cause.
use super::*;
use std::{
    future::{poll_fn, Future},
    pin::Pin,
    task::Poll,
};

async fn absent(pid: i32) {
    let mut polls = tokio::time::interval(Duration::from_millis(10));
    loop {
        polls.tick().await;
        if unsafe { libc::kill(pid, 0) } != 0 {
            assert_eq!(
                std::io::Error::last_os_error().raw_os_error(),
                Some(libc::ESRCH)
            );
            return;
        }
    }
}

#[tokio::test]
#[ignore = "requires owned OpenSSH, tmux and Linux process metadata; controlled shutdown discriminator"]
async fn real_tmux_shutdown_distinguishes_wrapper_drop_and_pending_client() {
    timeout(Duration::from_secs(30), probe())
        .await
        .expect("bounded owned shutdown discriminator");
}

async fn probe() {
    let mut f = Fixture::new().await;
    let wrapper = f.handle.take().unwrap();
    let weak = Arc::downgrade(&wrapper);
    let core = wrapper.handle.clone();
    drop(wrapper);
    assert!(weak.upgrade().is_none());
    let mut transport = match Arc::try_unwrap(core) {
        Ok(transport) => transport,
        Err(_) => panic!("owned transport unexpectedly has another handle owner"),
    };
    let pending = poll_fn(|cx| Poll::Ready(Pin::new(&mut transport).poll(cx).is_pending())).await;
    assert!(
        pending,
        "wrapper drop alone must not be mistaken for SSH task completion"
    );
    transport
        .disconnect(
            russh::Disconnect::ByApplication,
            "owned discriminator",
            "en",
        )
        .await
        .unwrap();
    let _ = timeout(BOUND, completed_transport(transport))
        .await
        .expect("explicitly disconnected owned SSH task must finish");

    let mut servers = NamedServers {
        fixture: &f,
        names: vec!["shutdown".into()],
    };
    let identity = servers.direct(
        "shutdown",
        &[
            "new-session",
            "-d",
            "-s",
            "same",
            "-P",
            "-F",
            "#{pid}:#{pane_pid}",
            "exec sleep 120",
        ],
    );
    let pids = identity
        .split(':')
        .map(|pid| pid.parse::<i32>().unwrap())
        .collect::<Vec<_>>();
    assert_eq!(pids.len(), 2);
    let mut client = Process(
        Command::new(&f.tmux)
            .args(["-C", "-L", "shutdown", "attach-session", "-t", "=same"])
            .env("TMUX_TMPDIR", f.dir.path())
            .env_remove("TMUX")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap(),
    );
    let client_pid = client.0.id() as i32;
    timeout(BOUND, async {
        loop {
            assert!(
                client.0.try_wait().unwrap().is_none(),
                "owned control client exited before attachment"
            );
            if servers
                .direct(
                    "shutdown",
                    &["list-clients", "-F", "#{client_pid}|#{client_control_mode}"],
                )
                .lines()
                .any(|line| line == format!("{client_pid}|1"))
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("owned control client must attach");
    let mut observations = teardown::Processes::capture(&[pids[0], pids[1], client_pid]);
    assert!(
        observations.same_state(0).is_some(),
        "same-user Linux server metadata required for this discriminator"
    );
    // This directly spawned child remains unreaped: its PID cannot be recycled.
    assert!(client.0.try_wait().unwrap().is_none());
    assert_eq!(unsafe { libc::kill(client_pid, libc::SIGSTOP) }, 0);
    timeout(BOUND, async {
        while observations.same_state(2) != Some('T') {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("owned client must be stopped before cleanup");
    observations.clients(servers.command("shutdown")).await;
    let before = observations.failure();
    assert!(
        before
            .split("children=")
            .nth(1)
            .is_some_and(|rows| rows.contains("Same(")),
        "owned live workload must appear in bounded direct-child observation"
    );
    observations.before_stop();
    let cleanup = servers.stop();
    // Keep existing private-namespace cleanup armed on assertion failure. The
    // directly spawned client drops (kill + wait) before this server guard.
    servers.names.push("shutdown".into());
    assert!(matches!(
        cleanup.as_slice(),
        [teardown::Stop::Exited {
            code: Some(0),
            signal: None
        }]
    ));
    // The exact existing server-exit predicate and three-second budget must
    // distinguish a successful kill request from an unacknowledged client exit.
    assert!(
        timeout(BOUND, absent(pids[0])).await.is_err(),
        "held client did not preserve the server; hypothesis not reproduced"
    );
    let server_state = observations.same_state(0);
    assert!(
        matches!(server_state, Some('R' | 'S' | 'D' | 'I')),
        "same owned server must remain live, not zombie or reused"
    );
    timeout(BOUND, absent(pids[1]))
        .await
        .expect("owned workload must exit even while client acknowledgement is held");
    assert_eq!(observations.same_state(2), Some('T'));
    let receipt = observations.failure();
    let clients = receipt
        .split("clients(index,control,written,discarded,state)=")
        .nth(1)
        .unwrap()
        .split("; children=")
        .next()
        .unwrap();
    assert!(clients.starts_with("[(0, true,") && clients.ends_with("\"Same(T)\")]"),
        "bounded receipt must identify only the stopped owned control client, excluding its observer");
    eprintln!("controlled remaining shutdown: {receipt}");
    eprintln!("controlled shutdown: wrapper_gone_task_pending=true kill_request_ok=true same_server_state={server_state:?} workload_absent=true client_stopped=true");

    assert!(client.0.try_wait().unwrap().is_none());
    assert_eq!(unsafe { libc::kill(client_pid, libc::SIGCONT) }, 0);
    timeout(BOUND, async {
        while client.0.try_wait().unwrap().is_none() {
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("resumed owned client must acknowledge shutdown and exit");
    timeout(BOUND, absent(pids[0]))
        .await
        .expect("same owned server must exit after its client resumes");
    eprintln!(
        "controlled shutdown: client_resumed=true client_exited=true original_server_absent=true"
    );
    servers.names.clear();
    drop(servers);
    f.stop_listener().await;
}
