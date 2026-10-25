use sha2::{Digest, Sha256};
use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};
#[path = "native/android.rs"]
mod android;
#[path = "native/ios.rs"]
mod ios;
#[path = "native/mobile.rs"]
mod mobile;

fn main() {
    println!("cargo:rerun-if-env-changed=PROTOC");
    if !matches!(
        env::var("CARGO_CFG_TARGET_OS").unwrap().as_str(),
        "linux" | "macos" | "android" | "ios"
    ) {
        return;
    }
    println!("cargo:rerun-if-changed=vendor.sha256");
    println!("cargo:rerun-if-changed=native");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let root = output.join("core");
    let manifest = fs::read_to_string("vendor.sha256").unwrap();
    let mut sources = Vec::new();
    for line in manifest.lines() {
        let (hash, path) = line
            .split_once("  ")
            .expect("invalid source checksum manifest");
        println!("cargo:rerun-if-changed={path}");
        let bytes = fs::read(path).expect("missing pinned upstream source");
        assert_eq!(
            format!("{:x}", Sha256::digest(&bytes)),
            hash,
            "upstream source integrity failed: {path}"
        );
        let relative = Path::new(path).strip_prefix("vendor").unwrap();
        let target = root.join(relative);
        fs::create_dir_all(target.parent().unwrap()).unwrap();
        let mut text = String::from_utf8(bytes).expect("upstream source must be UTF-8");
        // Keep checks enabled, converting upstream CLI aborts into caught exceptions.
        text = text
            .replace("assert(", "lazysh_assert(")
            .replace("assert (", "lazysh_assert (")
            .replace("fatal_lazysh_assert", "fatal_assert")
            .replace("dos_lazysh_assert", "dos_assert")
            .replace("static_lazysh_assert", "static_assert");
        if relative == Path::new("src/util/fatal_assert.h") {
            text = text.replace(
                "#include <cstdlib>",
                "#include <cstdlib>\n#include <stdexcept>",
            );
            let start = text.find("  fprintf(").unwrap();
            let end = start + text[start..].find("  abort();").unwrap() + "  abort();".len();
            text.replace_range(
                start..end,
                "  throw std::runtime_error(\"Mosh core rejected invalid state\");",
            );
        }
        if relative == Path::new("src/statesync/completeterminal.cc") {
            text = text.replace("  fatal_assert( input.ParseFromString( diff ) );", "  fatal_assert( input.ParseFromString( diff ) );\n  fatal_assert( input.instruction_size() <= 4096 );");
            text = text.replace("    } else if ( input.instruction( i ).HasExtension( resize ) ) {", "    } else if ( input.instruction( i ).HasExtension( resize ) ) {\n      const auto& size = input.instruction( i ).GetExtension( resize );\n      fatal_assert( size.width() > 0 && size.height() > 0 && size.width() <= 512 && size.height() <= 256 && int64_t(size.width()) * size.height() <= 32768 );");
        }
        if relative == Path::new("src/crypto/crypto.h") {
            text = text
                .replace(
                    "#include <exception>",
                    "#include <exception>\n#include <openssl/crypto.h>",
                )
                .replace(
                    "  Base64Key();",
                    "  ~Base64Key() { OPENSSL_cleanse(key, sizeof key); }\n  Base64Key();",
                );
        }
        if relative == Path::new("src/crypto/crypto.cc") {
            // ae_clear always returns AE_SUCCESS; a destructor must never throw.
            text = text.replace(
                "  fatal_assert( ae_clear( ctx ) == AE_SUCCESS );",
                "  (void)ae_clear( ctx );",
            );
        }
        if relative == Path::new("src/network/networktransport-impl.h") {
            text = text.replace("    process_throwaway_until( inst.throwaway_num() );", "    dos_assert( inst.throwaway_num() <= inst.old_num() );\n    process_throwaway_until( inst.throwaway_num() );\n    if ( received_states.size() >= 32 ) { return; }");
        }
        if relative == Path::new("src/network/transportfragment.cc") {
            text = text.replace(
                "  fragment_num &= 0x7FFF;",
                "  fragment_num &= 0x7FFF;\n  fatal_assert( fragment_num < 4096 );",
            );
        }
        if relative.extension().is_some_and(|ext| ext == "cc") {
            sources.push(target.clone());
        }
        if relative
            .extension()
            .is_some_and(|ext| ext == "cc" || ext == "h")
        {
            text.insert_str(0, "// Modified for lazysh headless embedding and bounded error handling, 2026-10-24.\n// Original copyright and license notices follow unchanged.\n");
        }
        fs::write(&target, text).unwrap();
    }
    fs::create_dir_all(root.join("src/include")).unwrap();
    let apple = env::var("CARGO_CFG_TARGET_VENDOR").unwrap() == "apple";
    let byte_order = if apple {
        "#define HAVE_OSX_SWAP 1\n"
    } else {
        "#define HAVE_ENDIAN_H 1\n#define HAVE_DECL_BE64TOH 1\n"
    };
    fs::write(root.join("src/include/config.h"), format!("#define HAVE_CLOCK_GETTIME 1\n#define HAVE_GETTIMEOFDAY 1\n#define HAVE_SYS_UIO_H 1\n#define HAVE_POSIX_MEMALIGN 1\n#define HAVE_STRINGS_H 1\n{byte_order}")).unwrap();
    let android_target = env::var("CARGO_CFG_TARGET_OS").unwrap() == "android";
    let ios_target = env::var("CARGO_CFG_TARGET_OS").unwrap() == "ios";
    let include_paths = if android_target {
        android::prepare()
    } else if ios_target {
        ios::prepare()
    } else {
        let protobuf = pkg_config::Config::new()
            .probe("protobuf-lite")
            .expect("target libprotobuf-lite and matching protoc are required");
        let crypto = pkg_config::Config::new()
            .probe("libcrypto")
            .expect("target OpenSSL libcrypto is required");
        let zlib = pkg_config::Config::new()
            .probe("zlib")
            .expect("target zlib is required");
        protobuf
            .include_paths
            .into_iter()
            .chain(crypto.include_paths)
            .chain(zlib.include_paths)
            .collect()
    };
    let protos = ["userinput", "hostinput", "transportinstruction"];
    if android_target || ios_target {
        for name in protos {
            for extension in ["pb.cc", "pb.h"] {
                fs::copy(
                    format!("vendor-android/generated/{name}.{extension}"),
                    root.join(format!("src/protobufs/{name}.{extension}")),
                )
                .unwrap();
            }
        }
    } else {
        let mut protoc = Command::new(env::var_os("PROTOC").unwrap_or_else(|| "protoc".into()));
        protoc
            .arg(format!(
                "--cpp_out={}",
                root.join("src/protobufs").display()
            ))
            .arg(format!("-I{}", root.join("src/protobufs").display()));
        for name in protos {
            protoc.arg(root.join(format!("src/protobufs/{name}.proto")));
        }
        assert!(
            protoc.status().expect("cannot start protoc").success(),
            "protoc generation failed"
        );
    }
    let mut compiler = cc::Build::new();
    compiler
        .cpp(true)
        .std("c++17")
        .warnings(false)
        .include(&root)
        .include(root.join("src/include"))
        .include("native")
        .flag("-include")
        .flag("native/checks.h");
    for path in &include_paths {
        compiler.include(path);
    }
    compiler.files(sources).file("native/bridge.cc");
    for name in protos {
        compiler.file(root.join(format!("src/protobufs/{name}.pb.cc")));
    }
    compiler.compile("lazysh_mosh_core");
}
