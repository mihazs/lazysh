plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "app.lazysh.displayidle"
    compileSdk = 36
    defaultConfig { minSdk = 24 }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = "1.8" }
}
dependencies {
    implementation(project(":tauri-android"))
    // Tauri exposes AppCompat lifecycle types but keeps their dependency private.
    compileOnly("androidx.appcompat:appcompat:1.7.1")
    testImplementation("junit:junit:4.13.2")
}
