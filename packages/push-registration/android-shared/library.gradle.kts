import com.android.build.api.dsl.LibraryExtension
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.jetbrains.kotlin.gradle.dsl.KotlinAndroidProjectExtension

extensions.configure<LibraryExtension> {
    compileSdk = 37
    defaultConfig { minSdk = 24 }
    sourceSets.getByName("main").java.srcDir("../android-shared/src/main/java")
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
}
extensions.configure<KotlinAndroidProjectExtension> {
    compilerOptions.jvmTarget.set(JvmTarget.JVM_1_8)
}
dependencies {
    add("implementation", project(":tauri-android"))
    add("implementation", "androidx.core:core:1.17.0")
    add("testImplementation", "junit:junit:4.13.2")
}
