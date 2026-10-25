plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.lazysh.push"
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
    implementation("com.google.firebase:firebase-messaging:26.0.0")
    implementation("com.google.android.gms:play-services-base:18.11.1")
    implementation("androidx.core:core:1.17.0")
    testImplementation("junit:junit:4.13.2")
}
