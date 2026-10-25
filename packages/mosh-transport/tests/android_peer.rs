#![cfg(target_os = "android")]
mod common;

#[test]
#[ignore = "started by official_server::android_emulator_official_server_interoperability"]
fn android_official_server_peer() {
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
        // Android Emulator's documented alias for the development host's loopback.
        let address = format!("10.0.2.2:{port}").parse().unwrap();
        workers.push(std::thread::spawn(move || {
            common::session(&key, address, label)
        }));
    }
    for worker in workers {
        worker.join().unwrap();
    }
}
