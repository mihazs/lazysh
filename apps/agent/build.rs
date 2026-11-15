fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    // Windows gives the main thread 1 MiB. `lazysh-agent update` runs its TLS client and the async install
    // on that thread, and the debug build used for the update tests overflowed it (exit 0xC00000FD).
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc") {
        println!("cargo:rustc-link-arg-bins=/STACK:8388608");
    }
}
