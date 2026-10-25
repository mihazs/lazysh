//! Android target-native dependencies; never use host pkg-config libraries.
use std::{env, fs, path::PathBuf};

pub fn prepare() -> Vec<PathBuf> {
    let root = crate::mobile::sources();
    // Tauri selects NDK_HOME. CI images may also export an older default
    // ANDROID_NDK_HOME; never combine its CMake/sysroot with Tauri's compiler.
    let ndk = env::var_os("NDK_HOME")
        .or_else(|| env::var_os("ANDROID_NDK_HOME"))
        .expect("ANDROID_NDK_HOME or NDK_HOME must select the Android NDK");
    let ndk = PathBuf::from(ndk);
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
    let installed = cmake::Config::new("native/android")
        .define(
            "CMAKE_TOOLCHAIN_FILE",
            ndk.join("build/cmake/android.toolchain.cmake"),
        )
        .define("ANDROID_ABI", abi)
        .define("ANDROID_PLATFORM", format!("android-{api}"))
        .define("LAZYSH_VENDOR", &root)
        .define("CMAKE_INSTALL_LIBDIR", "lib")
        .profile("Release")
        .build();
    // Tauri provides TARGET_AR but no TARGET_RANLIB. cc's inferred GNU-prefixed
    // ranlib is absent from modern NDKs. Pin it to this NDK's LLVM binutils.
    let ranlib = fs::read_dir(ndk.join("toolchains/llvm/prebuilt"))
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .path()
                .join(format!("bin/llvm-ranlib{}", env::consts::EXE_SUFFIX))
        })
        .find(|path| path.is_file())
        .expect("selected NDK must contain llvm-ranlib");
    env::set_var("TARGET_RANLIB", ranlib);
    crate::mobile::link(&installed, &root, true)
}
