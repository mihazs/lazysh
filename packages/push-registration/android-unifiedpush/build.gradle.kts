plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android { namespace = "app.lazysh.unifiedpush" }
apply(from = "../android-shared/library.gradle.kts")

dependencies {
    implementation("org.unifiedpush.android:connector:3.3.5") {
        exclude(group = "com.google.crypto.tink", module = "tink")
    }
    implementation("com.google.crypto.tink:tink-android:1.23.0")
    implementation("com.squareup.okhttp3:okhttp:5.5.1")
}
