//! Shared pinned mobile dependency sources and static linking.
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub fn sources() -> PathBuf {
    println!("cargo:rerun-if-changed=vendor-android.sha256");
    let manifest = fs::read_to_string("vendor-android.sha256").expect("mobile source manifest");
    for line in manifest.lines() {
        let (hash, path) = line
            .split_once("  ")
            .expect("invalid mobile source manifest");
        println!("cargo:rerun-if-changed={path}");
        let bytes = fs::read(path).expect("missing pinned mobile dependency");
        assert_eq!(
            format!("{:x}", Sha256::digest(bytes)),
            hash,
            "mobile source integrity failed: {path}"
        );
    }
    Path::new(env!("CARGO_MANIFEST_DIR")).join("vendor-android")
}

pub fn link(installed: &Path, root: &Path, android: bool) -> Vec<PathBuf> {
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
    // The mobile SDK supplies zlib; Android additionally needs logging and dl.
    println!("cargo:rustc-link-lib=z");
    if android {
        println!("cargo:rustc-link-lib=log");
        println!("cargo:rustc-link-lib=dl");
    }
    vec![
        root.join("protobuf/src"),
        root.join("abseil"),
        root.join("protobuf/third_party/utf8_range"),
        crypto.include_dir().to_owned(),
    ]
}
