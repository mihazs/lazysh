plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "app.lazysh.unifiedpush"
    defaultConfig { consumerProguardFiles("consumer-rules.pro") }
}
apply(from = "../android-shared/library.gradle.kts")

apply(from = "../android-shared/unifiedpush.gradle.kts")
