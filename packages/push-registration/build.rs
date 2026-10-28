fn main() {
    let android = if cfg!(feature = "fdroid") {
        "android-unifiedpush"
    } else {
        "android"
    };
    tauri_plugin::Builder::new(&[])
        .ios_path("ios")
        .android_path(android)
        .build();
}
