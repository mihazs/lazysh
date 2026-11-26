package app.lazysh.client

import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class TerminalKeysTest {
    private fun key(keyCode: Int, meta: Int = 0, unicode: Int = 0, repeat: Boolean = false, release: Boolean = false) =
        TerminalKeys.key(keyCode, meta, unicode, repeat, release)

    @Test fun shiftEnterIsTheEnterKeyWithShiftNotText() {
        assertEquals(TerminalKey("Enter", "Enter", shift = true), key(KeyEvent.KEYCODE_ENTER, KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON))
    }

    @Test fun ctrlAndALetterKeepTheLetterAsItsKey() {
        // getUnicodeChar without the Ctrl bits: the DOM key of Ctrl+C is "c", never the control character.
        assertEquals(TerminalKey("KeyC", "c", ctrl = true), key(KeyEvent.KEYCODE_C, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON, 'c'.code))
        assertEquals(TerminalKey("KeyC", "C", shift = true, ctrl = true, alt = true, meta = true),
            key(KeyEvent.KEYCODE_C, KeyEvent.META_SHIFT_ON or KeyEvent.META_CTRL_ON or KeyEvent.META_ALT_ON or KeyEvent.META_META_ON, 'C'.code))
    }

    @Test fun rightAltCharacterIsTypedWithoutTurningOrdinaryAltIntoText() {
        val rightAlt = KeyEvent.META_ALT_ON or KeyEvent.META_ALT_RIGHT_ON
        val transformed = TerminalKeys.key(KeyEvent.KEYCODE_Q, rightAlt, 'q'.code, false, false, '@'.code)
        assertEquals(TerminalKey("KeyQ", "@"), transformed)
        val ordinary = TerminalKeys.key(KeyEvent.KEYCODE_Q, rightAlt, 'q'.code, false, false, 'q'.code)
        assertEquals(TerminalKey("KeyQ", "q", alt = true), ordinary)
        for (modifier in listOf(KeyEvent.META_CTRL_ON, KeyEvent.META_META_ON)) {
            val chord = TerminalKeys.key(KeyEvent.KEYCODE_Q, rightAlt or modifier, 'q'.code, false, false, '@'.code)
            assertEquals(TerminalKey("KeyQ", "q", ctrl = modifier == KeyEvent.META_CTRL_ON,
                alt = true, meta = modifier == KeyEvent.META_META_ON), chord)
        }
        val release = TerminalKeys.key(KeyEvent.KEYCODE_Q, rightAlt, 'q'.code, false, true, '@'.code)
        assertEquals(TerminalKey("KeyQ", "@", release = true), release)
    }

    @Test fun repeatAndReleaseAreCarried() {
        assertEquals(TerminalKey("ArrowUp", "ArrowUp", repeat = true), key(KeyEvent.KEYCODE_DPAD_UP, repeat = true))
        assertEquals(TerminalKey("ArrowUp", "ArrowUp", release = true), key(KeyEvent.KEYCODE_DPAD_UP, release = true))
    }

    private fun named(keyCode: Int, code: String, key: String) {
        val k = key(keyCode)
        assertEquals("code of $keyCode", code, k?.code)
        assertEquals("key of $keyCode", key, k?.key)
    }

    @Test fun theNamedKeysUseTheDomNames() {
        named(KeyEvent.KEYCODE_DEL, "Backspace", "Backspace")
        named(KeyEvent.KEYCODE_FORWARD_DEL, "Delete", "Delete")
        named(KeyEvent.KEYCODE_TAB, "Tab", "Tab")
        named(KeyEvent.KEYCODE_ESCAPE, "Escape", "Escape")
        named(KeyEvent.KEYCODE_MOVE_HOME, "Home", "Home")
        named(KeyEvent.KEYCODE_MOVE_END, "End", "End")
        named(KeyEvent.KEYCODE_PAGE_UP, "PageUp", "PageUp")
        named(KeyEvent.KEYCODE_PAGE_DOWN, "PageDown", "PageDown")
        named(KeyEvent.KEYCODE_INSERT, "Insert", "Insert")
        named(KeyEvent.KEYCODE_NUMPAD_ENTER, "NumpadEnter", "Enter")
        named(KeyEvent.KEYCODE_DPAD_LEFT, "ArrowLeft", "ArrowLeft")
        named(KeyEvent.KEYCODE_DPAD_DOWN, "ArrowDown", "ArrowDown")
        named(KeyEvent.KEYCODE_SHIFT_RIGHT, "ShiftRight", "Shift")
        named(KeyEvent.KEYCODE_CTRL_LEFT, "ControlLeft", "Control")
        named(KeyEvent.KEYCODE_ALT_RIGHT, "AltRight", "Alt")
        named(KeyEvent.KEYCODE_META_LEFT, "MetaLeft", "Meta")
    }

    @Test fun lettersDigitsKeypadAndFunctionKeysMapByOffset() {
        assertEquals("KeyA", TerminalKeys.code(KeyEvent.KEYCODE_A))
        assertEquals("KeyZ", TerminalKeys.code(KeyEvent.KEYCODE_Z))
        assertEquals("Digit0", TerminalKeys.code(KeyEvent.KEYCODE_0))
        assertEquals("Digit9", TerminalKeys.code(KeyEvent.KEYCODE_9))
        assertEquals("Numpad0", TerminalKeys.code(KeyEvent.KEYCODE_NUMPAD_0))
        assertEquals("Numpad9", TerminalKeys.code(KeyEvent.KEYCODE_NUMPAD_9))
        assertEquals("F1", TerminalKeys.code(KeyEvent.KEYCODE_F1))
        assertEquals("F12", TerminalKeys.code(KeyEvent.KEYCODE_F12))
        assertEquals(TerminalKey("F5", "F5"), key(KeyEvent.KEYCODE_F5))
    }

    @Test fun punctuationAndSpaceCarryTheirCharacter() {
        assertEquals(TerminalKey("Space", " "), key(KeyEvent.KEYCODE_SPACE, unicode = ' '.code))
        assertEquals(TerminalKey("Slash", "?", shift = true), key(KeyEvent.KEYCODE_SLASH, KeyEvent.META_SHIFT_ON, '?'.code))
        assertEquals(TerminalKey("Semicolon", "ç"), key(KeyEvent.KEYCODE_SEMICOLON, unicode = 0xe7))
    }

    @Test fun everyMappedKeyHasItsOwnPhysicalCode() {
        val codes = (0..400).mapNotNull { TerminalKeys.code(it) }
        assertTrue("a code per key", codes.isNotEmpty())
        assertEquals("no two key codes share a DOM code", codes.size, codes.toSet().size)
    }

    @Test fun keysThatBelongToTheSystemAreNotTheTerminals() {
        for (keyCode in listOf(KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_HOME, KeyEvent.KEYCODE_APP_SWITCH, KeyEvent.KEYCODE_VOLUME_UP,
            KeyEvent.KEYCODE_VOLUME_DOWN, KeyEvent.KEYCODE_POWER, KeyEvent.KEYCODE_CAMERA, KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, KeyEvent.KEYCODE_SEARCH))
            assertNull("key $keyCode stays with Android", key(keyCode))
    }

    @Test fun aDeadKeyAndAnUnproducingKeyAreNamedNotTyped() {
        assertEquals("Dead", key(KeyEvent.KEYCODE_APOSTROPHE, unicode = Int.MIN_VALUE or '\''.code)?.key)
        assertEquals("Unidentified", key(KeyEvent.KEYCODE_COMMA, unicode = 0)?.key)
        assertNotNull(key(KeyEvent.KEYCODE_COMMA, unicode = ','.code))
    }
}
