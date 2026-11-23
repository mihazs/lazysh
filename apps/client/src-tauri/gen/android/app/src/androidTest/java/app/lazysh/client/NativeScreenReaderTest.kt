package app.lazysh.client

import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assert.assertEquals
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The screen-reader check of the native terminal (#1329) on the real MainActivity: the renderer's `screen_reader_active` command is
 * allowed by the ACL even before the app is unlocked, reaches the Kotlin plugin and answers what Android reports. The emulator has no
 * screen reader, so a command that is refused, misnamed or unregistered, which the client reads as a screen reader being on, fails
 * here and not silently on a device. Turning TalkBack on is not tried (a test that enables touch exploration would change how the
 * following cases' touches are delivered); the logic over what Android reports is ScreenReaderStateTest.
 */
@RunWith(AndroidJUnit4::class)
class NativeScreenReaderTest {
    @Before fun unlockedPage() { PageDriver.awaitStartPage() }

    @Test fun theCommandAnswersThatNoScreenReaderIsOnAnEmulatorWithoutOne() {
        assertEquals("false", PageDriver.invoke("screen_reader_active"))
    }
}
