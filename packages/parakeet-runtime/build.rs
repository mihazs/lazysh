use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-changed=native");
    for name in [
        "LAZYSH_PARAKEET_SOURCE_ARCHIVE",
        "CMAKE_TOOLCHAIN_FILE",
        "CMAKE_BUILD_PARALLEL_LEVEL",
        "SHERPA_ONNXRUNTIME_INCLUDE_DIR",
        "SHERPA_ONNXRUNTIME_LIB_DIR",
        "NDK_HOME",
        "ANDROID_NDK_HOME",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let mut build = cmake::Config::new("native");
    build
        .profile("Release")
        .build_target("lazysh-parakeet-native");
    let target = env::var("CARGO_CFG_TARGET_OS").expect("target OS");
    let architecture = env::var("CARGO_CFG_TARGET_ARCH").expect("target architecture");
    if target == "ios" {
        let simulator = env::var("TARGET").expect("target triple").ends_with("-sim")
            || architecture == "x86_64";
        build.define("LAZYSH_IOS_SIMULATOR", if simulator { "ON" } else { "OFF" });
        build.define("CMAKE_OSX_DEPLOYMENT_TARGET", "16.0");
    } else if target == "macos" {
        build.define("CMAKE_OSX_DEPLOYMENT_TARGET", "13.0");
    } else if target == "android" {
        let abi = match architecture.as_str() {
            "aarch64" => "arm64-v8a",
            "x86_64" => "x86_64",
            _ => panic!("Parakeet Android package targets arm64-v8a and x86_64 only"),
        };
        build
            .define("ANDROID_ABI", abi)
            .define("ANDROID_PLATFORM", "android-24")
            .define("CMAKE_SYSTEM_VERSION", "24");
        if env::var_os("CMAKE_TOOLCHAIN_FILE").is_none() {
            let ndk = env::var_os("ANDROID_NDK_HOME")
                .or_else(|| env::var_os("NDK_HOME"))
                .expect("Android requires ANDROID_NDK_HOME or NDK_HOME");
            build.define(
                "CMAKE_TOOLCHAIN_FILE",
                PathBuf::from(ndk).join("build/cmake/android.toolchain.cmake"),
            );
        }
    }
    if env::var_os("CMAKE_BUILD_PARALLEL_LEVEL").is_none() {
        build.env("CMAKE_BUILD_PARALLEL_LEVEL", "4");
    }
    let built = build.build().join("build");
    let libraries = fs::read_to_string(built.join("native-libraries-Release.txt"))
        .expect("native archive manifest");
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR")).join("lib");
    fs::create_dir_all(&output).expect("native library directory");
    println!("cargo:rustc-link-search=native={}", output.display());
    let mut found_ort = false;
    for path in libraries.lines().filter(|line| !line.is_empty()) {
        let path = PathBuf::from(path);
        let file = path
            .file_name()
            .expect("archive filename")
            .to_string_lossy();
        let name = file.strip_prefix("lib").unwrap_or(&file);
        let name = name
            .strip_suffix(".a")
            .or_else(|| name.strip_suffix(".lib"))
            .unwrap_or(name);
        found_ort |= name == "onnxruntime";
        let destination = if target == "windows" {
            format!("{name}.lib")
        } else {
            format!("lib{name}.a")
        };
        fs::copy(&path, output.join(destination)).expect("copy static archive");
        // Preserve the archive identity on ELF so final consumers can isolate
        // ORT's private protobuf symbols from system protobuf shared libraries.
        if target == "linux" && name == "onnxruntime" {
            println!("cargo:rustc-link-lib=static:-bundle={name}");
        } else {
            println!("cargo:rustc-link-lib=static={name}");
        }
    }
    assert!(found_ort, "pinned static ONNX Runtime is missing");
    match target.as_str() {
        "linux" => {
            for name in ["stdc++", "m", "pthread", "dl"] {
                println!("cargo:rustc-link-lib=dylib={name}");
            }
        }
        "macos" | "ios" => {
            println!("cargo:rustc-link-lib=dylib=c++");
            println!("cargo:rustc-link-lib=framework=Foundation");
        }
        "android" => {
            for name in ["c++_shared", "android", "log", "m"] {
                println!("cargo:rustc-link-lib=dylib={name}");
            }
        }
        "windows" => {}
        _ => panic!("Parakeet CPU runtime is unsupported on this target"),
    }
    println!(
        "cargo:rustc-env=LAZYSH_PARAKEET_NATIVE_BUILD={}",
        built.display()
    );
}
