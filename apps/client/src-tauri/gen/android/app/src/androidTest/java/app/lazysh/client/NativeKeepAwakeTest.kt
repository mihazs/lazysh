package app.lazysh.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import app.lazysh.displayidle.DisplayIdleWindowFixture
import org.junit.Test
import org.junit.runner.RunWith

/** Actual Window API ownership; UI/IPC and physical idle-timeout checks are separate. */
@RunWith(AndroidJUnit4::class)
class NativeKeepAwakeTest {
    @Test fun displayFlagUsesExactTicketsAndReleasesOnInvalidation() {
        NativeActivityFixture.scenario.onActivity { activity -> DisplayIdleWindowFixture.verify(activity) }
    }
}
