#![cfg(target_os = "android")]
mod common;

#[test]
#[ignore = "started by official_server::android_emulator_official_server_interoperability"]
fn android_official_server_peer() {
    // Android Emulator's documented alias for the development host's loopback.
    common::fixture_peers("10.0.2.2");
}
