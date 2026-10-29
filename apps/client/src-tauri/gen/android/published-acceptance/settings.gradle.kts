pluginManagement {
    resolutionStrategy.eachPlugin {
        when (requested.id.id) {
            "com.android.application" -> useModule("com.android.tools.build:gradle:${requested.version}")
            "org.jetbrains.kotlin.android" -> useModule("org.jetbrains.kotlin:kotlin-gradle-plugin:${requested.version}")
        }
    }
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositories { google(); mavenCentral() }
}
rootProject.name = "published-acceptance"
