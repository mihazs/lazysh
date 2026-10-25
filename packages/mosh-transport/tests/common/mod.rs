use lazysh_mosh_transport::Client;
use std::{
    thread,
    time::{Duration, Instant},
};

fn until(client: &mut Client, marker: &str) -> Vec<u8> {
    let deadline = Instant::now() + Duration::from_secs(8);
    let mut output = Vec::new();
    while Instant::now() < deadline {
        let update = client.poll().unwrap();
        output.extend_from_slice(&update.bytes);
        assert!(output.len() < 8 * 1024 * 1024);
        if String::from_utf8_lossy(&output).contains(marker) {
            return output;
        }
        assert!(!update.finished, "server ended before expected marker");
        thread::sleep(Duration::from_millis(5));
    }
    panic!("timed out waiting for expected terminal marker: {marker}");
}
pub fn session(key: &str, address: std::net::SocketAddr, label: &str) {
    let mut client = Client::new(key, address, 80, 24).unwrap();
    until(&mut client, "READY");
    client.write(format!("{label}_世界\n").as_bytes()).unwrap();
    until(&mut client, &format!("RECEIVED_{label}_世界_END"));
    client.resize(120, 40).unwrap();
    client.write(b"size\n").unwrap();
    until(&mut client, "SIZE_ROWS_40_COLS_120");
    client.shutdown().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if client.poll().unwrap().finished {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Mosh shutdown was not acknowledged"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[cfg(any(target_os = "android", target_os = "ios"))]
pub fn fixture_peers(host: &str) {
    let mut workers = Vec::new();
    for label in ["ONE", "TWO"] {
        let key =
            std::env::var(format!("LAZYSH_MOSH_TEST_{label}_KEY")).expect("ephemeral fixture key");
        let port: u16 = std::env::var(format!("LAZYSH_MOSH_TEST_{label}_PORT"))
            .expect("ephemeral fixture port")
            .parse()
            .unwrap();
        assert!(port > 0);
        assert_eq!(key.len(), 22);
        let address = format!("{host}:{port}").parse().unwrap();
        workers.push(std::thread::spawn(move || session(&key, address, label)));
    }
    for worker in workers {
        worker.join().unwrap();
    }
}
