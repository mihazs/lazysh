use std::process::Command;

#[test]
fn cpp_exception_and_ownership_boundary() {
    let build = env!("LAZYSH_PARAKEET_NATIVE_BUILD");
    assert!(Command::new("cmake")
        .args([
            "--build",
            build,
            "--config",
            "Release",
            "--target",
            "parakeet-boundary-tests"
        ])
        .status()
        .expect("CMake native test build")
        .success());
    assert!(Command::new("ctest")
        .args(["--test-dir", build, "-C", "Release", "--output-on-failure"])
        .status()
        .expect("CTest native fixtures")
        .success());
}
