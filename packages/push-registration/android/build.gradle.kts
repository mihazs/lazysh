plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

extensions.configure<com.android.build.api.dsl.LibraryExtension> {
    namespace = "app.lazysh.push"
    defaultConfig { consumerProguardFiles("../android-unifiedpush/consumer-rules.pro") }
    sourceSets.getByName("main").java.srcDir("../android-unifiedpush/src/main/java")
}
apply(from = "../android-shared/unifiedpush.gradle.kts")
apply(from = "../android-shared/library.gradle.kts")

dependencies {
    implementation("com.google.firebase:firebase-messaging:26.0.0")
    implementation("com.google.android.gms:play-services-base:18.11.1")
}
