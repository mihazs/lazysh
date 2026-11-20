// buildSrc reads this file, not the root settings.gradle. The kotlin-dsl plugin's Kotlin classpath
// resolves from the plugin portal alone by default, so a portal that answers "not found" for it
// (run 44622961036, v1.80.4) fails the build. Central is a second place to look, the same one
// the portal redirects to; Gradle moves on only when a repository reports "not found", not on a
// 429 or 5xx, which the release retry script handles.
pluginManagement {
    repositories {
        gradlePluginPortal()
        mavenCentral()
    }
}
