dependencies {
    add("implementation", "org.unifiedpush.android:connector:3.3.5") {
        (this as org.gradle.api.artifacts.ExternalModuleDependency).exclude(group = "com.google.crypto.tink", module = "tink")
    }
    add("implementation", "com.google.crypto.tink:tink-android:1.23.0")
    add("implementation", "com.squareup.okhttp3:okhttp:5.5.1")
}
