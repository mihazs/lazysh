plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android { namespace = "app.lazysh.push" }
apply(from = "../android-shared/library.gradle.kts")

dependencies {
    implementation("com.google.firebase:firebase-messaging:26.0.0")
    implementation("com.google.android.gms:play-services-base:18.11.1")
}
