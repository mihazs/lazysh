package app.lazysh.client

import androidx.test.core.app.ActivityScenario

/**
 * Keep the native event loop alive until instrumentation itself terminates.
 * Closing the last Tauri activity intentionally exits the Android process,
 * which also hosts AndroidJUnitRunner and would discard its test results.
 * Activity recreation remains covered separately, through configuration change.
 */
internal object NativeActivityFixture {
    val scenario: ActivityScenario<MainActivity> by lazy {
        ActivityScenario.launch(MainActivity::class.java)
    }
}
