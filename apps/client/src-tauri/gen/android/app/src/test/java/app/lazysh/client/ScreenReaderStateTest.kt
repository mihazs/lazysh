package app.lazysh.client

import android.accessibilityservice.AccessibilityServiceInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ScreenReaderStateTest {
    @Test fun touchExplorationIsAScreenReaderWhateverServicesAreListed() {
        assertTrue(ScreenReader.active(touchExploration = true, readerServices = 0))
        assertTrue(ScreenReader.active(touchExploration = true, readerServices = 2))
    }

    @Test fun aSpokenOrBrailleServiceIsOneWithoutTouchExploration() {
        assertTrue(ScreenReader.active(touchExploration = false, readerServices = 1))
    }

    @Test fun nothingReadingTheScreenIsNoScreenReader() {
        assertFalse(ScreenReader.active(touchExploration = false, readerServices = 0))
    }

    @Test fun onlyServicesThatSpeakOrBrailleTheScreenCount() {
        assertEquals(AccessibilityServiceInfo.FEEDBACK_SPOKEN or AccessibilityServiceInfo.FEEDBACK_BRAILLE, ScreenReader.READERS)
        assertEquals(0, ScreenReader.READERS and AccessibilityServiceInfo.FEEDBACK_HAPTIC)
        assertEquals(0, ScreenReader.READERS and AccessibilityServiceInfo.FEEDBACK_GENERIC)
        assertEquals(0, ScreenReader.READERS and AccessibilityServiceInfo.FEEDBACK_VISUAL)
    }
}
