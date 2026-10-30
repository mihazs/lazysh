import java.util.Properties
import java.io.File
import java.io.ByteArrayInputStream
import java.nio.file.Files
import java.nio.file.LinkOption
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import org.gradle.api.DefaultTask
import org.gradle.api.file.DirectoryProperty
import org.gradle.api.file.RegularFileProperty
import org.gradle.api.tasks.InputFile
import org.gradle.api.tasks.OutputDirectory
import org.gradle.api.tasks.PathSensitive
import org.gradle.api.tasks.PathSensitivity
import org.gradle.api.tasks.TaskAction
import com.android.build.api.variant.ApplicationAndroidComponentsExtension

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

abstract class PrepareUnifiedPushAcceptanceTrust : DefaultTask() {
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE)
    abstract val certificate: RegularFileProperty
    @get:InputFile @get:PathSensitive(PathSensitivity.NONE)
    abstract val baseTrust: RegularFileProperty
    @get:OutputDirectory abstract val destination: DirectoryProperty
    @TaskAction fun generate() {
        val ca=Files.newInputStream(certificate.get().asFile.toPath(),LinkOption.NOFOLLOW_LINKS)
            .use {it.readNBytes(8193)}
        check(ca.isNotEmpty() && ca.size<=8192) {"UnifiedPush acceptance CA changed or exceeded its bound"}
        val certificates=CertificateFactory.getInstance("X.509")
            .generateCertificates(ByteArrayInputStream(ca))
        check(certificates.size==1 && (certificates.single() as X509Certificate).basicConstraints>=0) {
            "UnifiedPush acceptance requires exactly one CA certificate"
        }
        val directory=destination.get().asFile
        val output=directory.resolve("raw/lazysh_unifiedpush_test_ca.pem")
        output.parentFile.mkdirs();output.writeBytes(ca)
        val xml=directory.resolve("xml/network_security_config.xml")
        xml.parentFile.mkdirs()
        val original=baseTrust.get().asFile.readText()
        check(original.split("</network-security-config>").size==2)
        xml.writeText(original.replace("</network-security-config>",
            "<debug-overrides><trust-anchors><certificates src=\"@raw/lazysh_unifiedpush_test_ca\"/>"+
                "</trust-anchors></debug-overrides></network-security-config>"))
    }
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Optional CI-owned production identity. Ordinary debug and unsigned F-Droid
// source builds retain their existing behavior when this variable is absent.
val releaseSigning = System.getenv("LAZYSH_ANDROID_SIGNING_PROPERTIES")?.let { path ->
    Properties().apply {
        File(path).inputStream().use { load(it) }
        listOf("storeFile", "storePassword", "keyAlias", "keyPassword").forEach { key ->
            require(!getProperty(key).isNullOrEmpty()) { "Missing release signing property: $key" }
        }
    }
}

// Only the owned ntfy acceptance invocation may add a private test CA. Ordinary
// debug/release builds never include this resource directory or change trust.
val unifiedPushAcceptanceCa = providers.gradleProperty("lazyshUnifiedPushAcceptanceCa").orNull?.let { path ->
    check(listOf("lazyshFdroidAcceptance","lazyshThemeLinkAcceptance","lazyshSshAcceptance","lazyshCompanionAcceptance","lazyshQrCameraAcceptance")
        .none {providers.gradleProperty(it).orNull=="true"}) {"UnifiedPush acceptance requires its private report namespace"}
    val allowed = setOf("assembleUniversalDebug", "assembleUniversalDebugAndroidTest",
        "connectedUniversalDebugAndroidTest", "compileUniversalDebugAndroidTestKotlin",
        "processUniversalDebugResources")
    check(gradle.startParameter.taskNames.isNotEmpty() &&
        gradle.startParameter.taskNames.all { it.substringAfterLast(':') in allowed }) {
        "UnifiedPush acceptance trust requires an explicit debug acceptance task"
    }
    val expected = rootProject.file("../../../../../packages/push-registration/android-unifiedpush").canonicalFile
    check(rootProject.findProject(":tauri-plugin-lazysh-push")?.projectDir?.canonicalFile == expected) {
        "UnifiedPush acceptance trust requires the F-Droid native provider"
    }
    check(File(path).isAbsolute) { "UnifiedPush acceptance requires an absolute owned CA path" }
    file(path).also {
        check(it.isFile && !Files.isSymbolicLink(it.toPath()) && it.length() in 1..8192) {
            "UnifiedPush acceptance requires a bounded owned CA file"
        }
    }
}
val unifiedPushAcceptanceResources = layout.buildDirectory.dir("generated/unifiedpush-acceptance/res")
if (unifiedPushAcceptanceCa != null) {
    val prepareTrust = tasks.register<PrepareUnifiedPushAcceptanceTrust>("prepareUnifiedPushAcceptanceTrust") {
        certificate.set(unifiedPushAcceptanceCa)
        baseTrust.set(file("src/main/res/xml/network_security_config.xml"))
        destination.set(unifiedPushAcceptanceResources)
    }
    val components=extensions.getByType<ApplicationAndroidComponentsExtension>()
    components.onVariants(components.selector().withBuildType("debug")) {variant ->
        checkNotNull(variant.sources.res).addGeneratedSourceDirectory(prepareTrust) {it.destination}
    }
}

android {
    compileSdk = 37
    ndkVersion = "29.0.14206865"
    namespace = "app.lazysh.client"
    if (unifiedPushAcceptanceCa != null) {
        // Framework logcat/reports may contain upstream registration details.
        // The owner exports only a finite receipt, never these private raw files.
        testOptions {
            reportDir = unifiedPushAcceptanceCa.parentFile.resolve("android-reports").path
            resultsDir = unifiedPushAcceptanceCa.parentFile.resolve("android-results").path
        }
    }
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "app.lazysh.client"
        minSdk = 24
        targetSdk = 36
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        // Tauri exits its process when the last activity is finished. Keep the
        // shared native activity alive until AndroidJUnitRunner reports results.
        testInstrumentationRunnerArguments["waitForActivitiesToComplete"] = "false"
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        releaseSigning?.let { properties ->
            create("production") {
                storeFile = File(properties.getProperty("storeFile"))
                storePassword = properties.getProperty("storePassword")
                keyAlias = properties.getProperty("keyAlias")
                keyPassword = properties.getProperty("keyPassword")
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {
                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (releaseSigning != null) signingConfig = signingConfigs.getByName("production")
            optimization {
               enable = true
            }
            proguardFiles(
                *fileTree(".") {
                  include("**/*.pro")
                  exclude("build/**")
                }.files.toTypedArray()
            )
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_1_8
        targetCompatibility = JavaVersion.VERSION_1_8
    }
    // Keep first-Activity link receipts when the ordinary instrumentation task
    // executes afterward. Both paths use Gradle's native connected-test reports.
    if (providers.gradleProperty("lazyshThemeLinkAcceptance").orNull == "true") {
        testOptions {
            reportDir = "${layout.buildDirectory.get().asFile}/reports/androidTests/theme-links"
            resultsDir = "${layout.buildDirectory.get().asFile}/outputs/androidTest-results/theme-links"
        }
    }
    if (providers.gradleProperty("lazyshSshAcceptance").orNull == "true") {
        testOptions {
            reportDir = "${layout.buildDirectory.get().asFile}/reports/androidTests/ssh-ui"
            resultsDir = "${layout.buildDirectory.get().asFile}/outputs/androidTest-results/ssh-ui"
        }
    }
    if (providers.gradleProperty("lazyshCompanionAcceptance").orNull == "true") {
        testOptions {
            reportDir = "${layout.buildDirectory.get().asFile}/reports/androidTests/companion-ui"
            resultsDir = "${layout.buildDirectory.get().asFile}/outputs/androidTest-results/companion-ui"
        }
    }
    if (providers.gradleProperty("lazyshHerdrAcceptance").orNull == "true") {
        testOptions {
            reportDir = "${layout.buildDirectory.get().asFile}/reports/androidTests/herdr-ui"
            resultsDir = "${layout.buildDirectory.get().asFile}/outputs/androidTest-results/herdr-ui"
        }
    }
    if (providers.gradleProperty("lazyshQrCameraAcceptance").orNull == "true") {
        testOptions {
            reportDir = "${layout.buildDirectory.get().asFile}/reports/androidTests/qr-camera"
            resultsDir = "${layout.buildDirectory.get().asFile}/outputs/androidTest-results/qr-camera"
        }
    }
    if (providers.gradleProperty("lazyshFdroidAcceptance").orNull == "true") {
        testOptions {
            reportDir = "${layout.buildDirectory.get().asFile}/reports/androidTests/fdroid-push"
            resultsDir = "${layout.buildDirectory.get().asFile}/outputs/androidTest-results/fdroid-push"
        }
    }
    buildFeatures {
        buildConfig = true
    }
    testOptions.unitTests.all {
        // This JUnit fixture reads authored XML rather than packaged resources.
        // Register it so incremental checks cannot reuse a stale passing result.
        it.inputs.file(file("src/main/AndroidManifest.xml"))
    }
}

kotlin {
    compilerOptions {
        jvmTarget = JvmTarget.JVM_1_8
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test:core:1.7.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    androidTestImplementation("androidx.test.espresso:espresso-web:3.7.0")
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.4.0")
    androidTestImplementation("com.fasterxml.jackson.core:jackson-databind:2.15.3")
}

apply(from = file("tauri.build.gradle.kts"))
