//! iOS uses the same pinned mobile dependency sources, with Xcode target SDKs.
use std::{env, path::PathBuf, process::Command};

pub fn prepare() -> Vec<PathBuf> {
    let target = env::var("TARGET").unwrap();
    let (sdk, arch) = match target.as_str() {
        "aarch64-apple-ios" => ("iphoneos", "arm64"),
        "aarch64-apple-ios-sim" => ("iphonesimulator", "arm64"),
        "x86_64-apple-ios" => ("iphonesimulator", "x86_64"),
        _ => panic!("unsupported iOS target: {target}"),
    };
    for name in ["SDKROOT", "DEVELOPER_DIR", "IPHONEOS_DEPLOYMENT_TARGET"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let selected = Command::new("xcrun")
        .args(["--sdk", sdk, "--show-sdk-path"])
        .output()
        .expect("iOS Mosh requires full Xcode and xcrun");
    assert!(
        selected.status.success(),
        "Xcode could not locate the target iOS SDK"
    );
    let sdk = PathBuf::from(String::from_utf8(selected.stdout).unwrap().trim());
    assert!(sdk.is_dir(), "Xcode returned a missing SDK directory");
    let deployment = env::var("IPHONEOS_DEPLOYMENT_TARGET").unwrap_or_else(|_| "16.0".into());
    let version: Vec<_> = deployment
        .split('.')
        .map(|part| part.parse::<u32>().expect("invalid iOS deployment target"))
        .collect();
    assert!(
        !version.is_empty() && version[0] >= 16,
        "iOS Mosh requires deployment target 16 or later"
    );
    // These mutations affect this isolated build-script process and its native
    // compiler children only, never the app or another Cargo build script.
    env::set_var("SDKROOT", &sdk);
    env::set_var("IPHONEOS_DEPLOYMENT_TARGET", &deployment);
    let root = crate::mobile::sources();
    let installed = cmake::Config::new("native/android")
        .define("CMAKE_SYSTEM_NAME", "iOS")
        .define("CMAKE_TRY_COMPILE_TARGET_TYPE", "STATIC_LIBRARY")
        .define("CMAKE_OSX_SYSROOT", &sdk)
        .define("CMAKE_OSX_ARCHITECTURES", arch)
        .define("CMAKE_OSX_DEPLOYMENT_TARGET", &deployment)
        .define("LAZYSH_VENDOR", &root)
        .define("CMAKE_INSTALL_LIBDIR", "lib")
        .profile("Release")
        .build();
    crate::mobile::link(&installed, &root, false)
}
