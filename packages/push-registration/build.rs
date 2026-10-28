fn main() {
    let builder = tauri_plugin::Builder::new(&[]).ios_path("ios");
    // Omitting native metadata excludes the entire Google-dependent Gradle project.
    #[cfg(not(feature = "fdroid"))]
    let builder = builder.android_path("android");
    builder.build();
}
