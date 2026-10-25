#![cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]

use std::process::Command;

#[cfg(target_os = "linux")]
#[test]
fn embedded_protobuf_is_private_without_changing_the_ort_c_api() {
    let build = std::path::Path::new(env!("LAZYSH_PARAKEET_NATIVE_BUILD"));
    let archive = build.join("private-ort/libonnxruntime.a");
    let output = Command::new("nm")
        .args(["--format=posix", "--extern-only"])
        .arg(archive)
        .output()
        .expect("inspect transformed ORT archive");
    assert!(
        output.status.success(),
        "target symbol inspection must succeed"
    );
    let symbols = String::from_utf8(output.stdout).unwrap();
    let names: Vec<_> = symbols
        .lines()
        .filter_map(|line| line.split_whitespace().next())
        .collect();
    assert!(names
        .iter()
        .any(|name| name.contains("17lazysh_ort_google8protobuf")));
    assert!(
        !names
            .iter()
            .any(|name| name.starts_with("_Z") && name.contains("6google8protobuf")),
        "no embedded protobuf definitions or references may share the system namespace"
    );
    assert!(
        names.contains(&"OrtGetApiBase"),
        "the public ORT C entry point is unchanged"
    );
}

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
    #[cfg(target_os = "macos")]
    assert!(Command::new("cmake")
        .args([
            "--build",
            build,
            "--config",
            "Release",
            "--target",
            "parakeet-storage-tests"
        ])
        .status()
        .expect("macOS storage test build")
        .success());
    assert!(Command::new("ctest")
        .args(["--test-dir", build, "-C", "Release", "--output-on-failure"])
        .status()
        .expect("CTest native fixtures")
        .success());
    #[cfg(target_os = "linux")]
    {
        // Inspect the actual CTest executable, not only the Rust archive manifest:
        // an unchanged CMake INTERFACE_LINK_LIBRARIES could silently test upstream ORT.
        let output = Command::new("nm")
            .args(["--format=posix", "--extern-only"])
            .arg(std::path::Path::new(build).join("parakeet-runtime-tests"))
            .output()
            .expect("inspect the native runtime fixture");
        assert!(output.status.success());
        let symbols = String::from_utf8(output.stdout).unwrap();
        assert!(
            symbols.contains("17lazysh_ort_google8protobuf"),
            "CTest must link private ORT protobuf"
        );
        assert!(
            !symbols
                .lines()
                .filter_map(|line| line.split_whitespace().next())
                .any(|name| name.starts_with("_Z") && name.contains("6google8protobuf")),
            "CTest must not silently link the original protobuf archive"
        );
    }
}
