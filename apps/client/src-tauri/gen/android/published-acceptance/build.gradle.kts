import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application") version "9.3.1"
    id("org.jetbrains.kotlin.android") version "2.2.10"
}

android {
    namespace = "app.lazysh.acceptance"
    compileSdk = 36
    defaultConfig {
        applicationId = "app.lazysh.acceptance"
        minSdk = 24
        targetSdk = 36
        versionCode = 1
        versionName = "1"
    }
    buildTypes.getByName("debug") { isDebuggable = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    kotlinOptions { jvmTarget = JvmTarget.JVM_1_8.target }
}

dependencies {
    implementation("androidx.test:runner:1.7.0")
    implementation("androidx.test.ext:junit:1.3.0")
    implementation("androidx.test.uiautomator:uiautomator:2.4.0")
}
