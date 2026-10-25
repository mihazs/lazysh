#![cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]

use std::process::Command;

#[test]
fn cpp_exception_and_ownership_boundary() {
    let build = env!("LAZYSH_PARAKEET_NATIVE_BUILD");
    let mut native_build = Command::new("cmake");
    native_build.args([
        "--build",
        build,
        "--config",
        "Release",
        "--target",
        "parakeet-boundary-tests",
    ]);
    native_build.arg("parakeet-runtime-tests");
    assert!(native_build
        .status()
        .expect("CMake native test build")
        .success());
    assert!(Command::new("ctest")
        .args(["--test-dir", build, "-C", "Release", "--output-on-failure"])
        .status()
        .expect("CTest native fixtures")
        .success());
}
