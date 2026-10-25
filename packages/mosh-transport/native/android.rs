//! Android target-native dependencies; never use host pkg-config libraries.
use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
};

pub fn prepare() -> Vec<PathBuf> {
    println!("cargo:rerun-if-changed=vendor-android.sha256");
    let manifest = fs::read_to_string("vendor-android.sha256").expect("Android source manifest");
    for line in manifest.lines() {
        let (hash, path) = line
            .split_once("  ")
            .expect("invalid Android source manifest");
        println!("cargo:rerun-if-changed={path}");
        let bytes = fs::read(path).expect("missing pinned Android dependency");
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            hash,
            "Android source integrity failed: {path}"
        );
    }
    let ndk = env::var_os("ANDROID_NDK_HOME")
        .or_else(|| env::var_os("NDK_HOME"))
        .expect("ANDROID_NDK_HOME or NDK_HOME must select the Android NDK");
    for name in ["ANDROID_NDK_HOME", "NDK_HOME", "ANDROID_API_LEVEL"] {
        println!("cargo:rerun-if-env-changed={name}");
    }
    let target = env::var("TARGET").unwrap();
    let abi = match target.as_str() {
        "aarch64-linux-android" => "arm64-v8a",
        "x86_64-linux-android" => "x86_64",
        "armv7-linux-androideabi" => "armeabi-v7a",
        "i686-linux-android" => "x86",
        _ => panic!("unsupported Android ABI: {target}"),
    };
    // Tauri supports Android 7+; the caller must use the same API for cc/linking.
    let api = env::var("ANDROID_API_LEVEL").unwrap_or_else(|_| "24".into());
    let api: u32 = api.parse().expect("ANDROID_API_LEVEL must be a number");
    assert!(api >= 24, "Android Mosh requires API level 24 or later");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor-android");
    let installed = cmake::Config::new("native/android")
        .define(
            "CMAKE_TOOLCHAIN_FILE",
            PathBuf::from(ndk).join("build/cmake/android.toolchain.cmake"),
        )
        .define("ANDROID_ABI", abi)
        .define("ANDROID_PLATFORM", format!("android-{api}"))
        .define("LAZYSH_VENDOR", &root)
        .define("CMAKE_INSTALL_LIBDIR", "lib")
        .profile("Release")
        .build();
    println!(
        "cargo:rustc-link-search=native={}",
        installed.join("lib").display()
    );
    let mut libraries: Vec<_> = fs::read_dir(installed.join("lib"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "a"))
        .collect();
    libraries.sort();
    for path in libraries {
        let name = path
            .file_stem()
            .unwrap()
            .to_str()
            .unwrap()
            .strip_prefix("lib")
            .unwrap();
        println!("cargo:rustc-link-lib=static={name}");
    }
    let crypto = openssl_src::Build::new().build();
    println!(
        "cargo:rustc-link-search=native={}",
        crypto.lib_dir().display()
    );
    println!("cargo:rustc-link-lib=static=crypto");
    // Android's public NDK API supplies zlib and logging, not libcrypto/protobuf.
    println!("cargo:rustc-link-lib=z");
    println!("cargo:rustc-link-lib=log");
    println!("cargo:rustc-link-lib=dl");
    vec![
        root.join("protobuf/src"),
        root.join("abseil"),
        root.join("protobuf/third_party/utf8_range"),
        crypto.include_dir().to_owned(),
    ]
}
