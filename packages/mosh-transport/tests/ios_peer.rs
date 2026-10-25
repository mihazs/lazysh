#![cfg(target_os = "ios")]
mod common;

#[test]
#[ignore = "started by official_server::ios_simulator_official_server_interoperability"]
fn ios_official_server_peer() {
    // iOS Simulator shares the macOS host's loopback networking.
    common::fixture_peers("127.0.0.1");
}
