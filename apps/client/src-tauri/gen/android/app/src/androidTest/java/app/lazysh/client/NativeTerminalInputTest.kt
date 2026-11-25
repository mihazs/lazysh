package app.lazysh.client

import android.text.InputType
import android.view.KeyEvent
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * The native terminal input bridge on the real framework classes: [TerminalInputView] hands the keyboard a real
 * `InputConnection` (a `BaseInputConnection` subclass whose `getSurroundingText` the framework calls on API 31 and
 * later) and receives real `KeyEvent`s. The keyboard side is replayed in the process: the transactions are the fixed
 * ones of `OwnedImeService`, in its order and with its expected reads, but no keyboard process is involved, so
 * Gboard, SwiftKey and the remote `InputConnection` proxy are not covered here.
 */
@RunWith(AndroidJUnit4::class)
class NativeTerminalInputTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val delivered = mutableListOf<String>()
    private val sink = object : TerminalInputSink {
        override fun text(text: String) { delivered += "text:$text" }
        override fun key(key: TerminalKey) { delivered += "key:${key.code}${if (key.shift) "+shift" else ""}${if (key.ctrl) "+ctrl" else ""}${if (key.release) "/up" else ""}" }
        override fun unapplied(edit: UnappliedEdit?) { if (edit != null) delivered += "unapplied:${edit.text}" }
    }

    private fun onMain(block: () -> Unit) {
        var failure: Throwable? = null
        instrumentation.runOnMainSync { try { block() } catch (error: Throwable) { failure = error } }
        failure?.let { throw it }
    }

    private fun connect(view: TerminalInputView, info: EditorInfo = EditorInfo()): InputConnection =
        checkNotNull(view.onCreateInputConnection(info))

    private fun key(view: TerminalInputView, action: Int, keyCode: Int, meta: Int = 0): Boolean =
        view.dispatchKeyEvent(KeyEvent(0, 0, action, keyCode, 0, meta))

    @Test fun theKeyboardIsAskedForPlainTextWithoutAnActionKey() = onMain {
        val info = EditorInfo()
        connect(TerminalInputView(instrumentation.targetContext, sink), info)
        assertEquals(InputType.TYPE_CLASS_TEXT, info.inputType and InputType.TYPE_MASK_CLASS)
        assertEquals("the text editor is multi-line so Enter is a line break", InputType.TYPE_TEXT_FLAG_MULTI_LINE, info.inputType and InputType.TYPE_TEXT_FLAG_MULTI_LINE)
        assertEquals("no autocorrect, as the page's terminal editor", 0, info.inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT)
        assertEquals(EditorInfo.IME_ACTION_NONE, info.imeOptions and EditorInfo.IME_MASK_ACTION)
        assertTrue(info.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0)
    }

    @Test fun privateKeyboardAsksForAVisiblePasswordWithNoSuggestionsAndNoLearning() = onMain {
        PrivateKeyboard.set(true)
        try {
            val info = EditorInfo()
            connect(TerminalInputView(instrumentation.targetContext, sink), info)
            assertEquals(PrivateKeyboard.INPUT_TYPE, info.inputType)
            assertTrue(info.imeOptions and androidx.core.view.inputmethod.EditorInfoCompat.IME_FLAG_NO_PERSONALIZED_LEARNING != 0)
        } finally { PrivateKeyboard.set(false) }
    }

    @Test fun theFixedKeyboardTransactionsAreTypedOnceAndReadBackAsTheFixtureExpects() = onMain {
        val view = TerminalInputView(instrumentation.targetContext, sink)
        val connection = connect(view)
        fun transaction(read: String, body: InputConnection.() -> Unit) {
            assertTrue(connection.beginBatchEdit())
            connection.body()
            connection.endBatchEdit()
            assertEquals(read, connection.getTextBeforeCursor(256, 0).toString())
        }
        transaction("the") { setComposingText("teh", 1); setComposingText("the", 1); finishComposingText() }
        assertEquals(listOf("text:the"), delivered)
        transaction("") { setComposingRegion(0, 3); setComposingText("there", 0); finishComposingText() }
        assertEquals("there", connection.getTextAfterCursor(256, 0).toString())
        transaction("there") { setSelection(5, 5) }
        transaction("the") { deleteSurroundingText(2, 0) }
        transaction("thethe") { commitText("the", 1) }
        transaction("thetheowned ") { for (typed in listOf("o", "ow", "own", "owned")) setComposingText(typed, 1); commitText("owned ", 1) }
        transaction("thetheowned swipe ") { commitText("swipe ", 1) }
        transaction("thetheowned swipe ten ") { for (typed in listOf("t", "te", "tex", "te", "ten")) setComposingText(typed, 1); commitText("ten ", 1) }
        transaction("thetheowned swipe tan ") { deleteSurroundingText(4, 0); commitText("tan ", 1) }
        transaction("thetheowned swipe tan") { deleteSurroundingText(1, 0) }
        transaction("thetheowned swipe tanweb ") {
            for (letter in listOf("w", "e", "b")) commitText(letter, 1)
            setComposingRegion(21, 24); setComposingText("web", 1); finishComposingText(); commitText(" ", 1)
        }
        assertEquals(
            listOf("text:the", "text:re", "text:\u007f\u007f", "text:the", "text:owned ", "text:swipe ", "text:ten ",
                "text:\u007f\u007f\u007fan ", "text:\u007f", "text:web "),
            delivered,
        )
    }

    @Test fun theFrameworkReadsTheSameTextThroughGetSurroundingText() = onMain {
        val connection = connect(TerminalInputView(instrumentation.targetContext, sink))
        connection.commitText("hello", 1)
        connection.setSelection(2, 2)
        if (android.os.Build.VERSION.SDK_INT >= 31) {
            val surrounding = checkNotNull(connection.getSurroundingText(10, 10, 0))
            assertEquals("hello", surrounding.text.toString())
            assertEquals(2, surrounding.selectionStart)
            assertEquals(2, surrounding.selectionEnd)
        }
    }

    @Test fun anEnterTheKeyboardSendsAsAKeyEventIsAKeyNotText() = onMain {
        val connection = connect(TerminalInputView(instrumentation.targetContext, sink))
        connection.commitText("ls", 1)
        assertTrue(connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)))
        assertTrue(connection.sendKeyEvent(KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_ENTER)))
        assertEquals("", connection.getTextBeforeCursor(10, 0).toString())
        connection.commitText("ls", 1)
        connection.commitText("\n", 1)
        assertEquals("", connection.getTextBeforeCursor(10, 0).toString())
        assertEquals(listOf("text:ls", "key:Enter", "key:Enter/up", "text:ls", "text:\r"), delivered)
    }

    @Test fun hardwareShortcutsReachTheTerminalAsKeysAndSystemKeysDoNot() = onMain {
        val view = TerminalInputView(instrumentation.targetContext, sink)
        assertTrue(key(view, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER, KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON))
        assertTrue(key(view, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_C, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON))
        assertTrue(key(view, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_C, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON))
        assertEquals(listOf("key:Enter+shift", "key:KeyC+ctrl", "key:KeyC+ctrl/up"), delivered)
        delivered.clear()
        assertFalse("Back stays with the system", key(view, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK))
        assertFalse("volume stays with the system", key(view, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP))
        assertEquals(emptyList<String>(), delivered)
    }

    @Test fun aHardwareKeyDeliversThePreeditTheKeyboardWasComposing() = onMain {
        val view = TerminalInputView(instrumentation.targetContext, sink)
        val connection = connect(view)
        connection.setComposingText("ab", 1)
        assertEquals(emptyList<String>(), delivered)
        key(view, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_ENTER)
        assertEquals(listOf("text:ab", "key:Enter"), delivered)
    }

    @Test fun anExplicitCorrectionReplacesOnlyTheRequestedWord() = onMain {
        org.junit.Assume.assumeTrue(android.os.Build.VERSION.SDK_INT >= 34)
        val input = connect(TerminalInputView(instrumentation.targetContext, sink))
        input.commitText("first secod", 1)
        assertTrue(input.replaceText(6, 11, "second", 1, null))
        input.deleteSurroundingText(1, 0)
        assertEquals("first secon", input.getTextBeforeCursor(256, 0).toString())
        assertEquals(listOf("text:first secod", "text:\u007fnd", "text:\u007f"), delivered)
    }

    @Test fun aProvisionalConnectionDoesNotDisplaceTheServedKeyboard() = onMain {
        val view = TerminalInputView(instrumentation.targetContext, sink)
        val served = connect(view)
        assertTrue(served.commitText("hello ", 1))

        connect(view).closeConnection()
        assertTrue(served.commitText("world", 1))
        assertEquals(listOf("text:hello ", "text:world"), delivered)
    }

    @Test fun aRetiredKeyboardCannotRewriteDeleteOrCommitTheCurrentWord() = onMain {
        val view = TerminalInputView(instrumentation.targetContext, sink)
        val retired = connect(view)
        retired.commitText("first second ", 1)
        retired.beginBatchEdit()
        val keyboard = connect(view)
        keyboard.setComposingText("third", 1)
        assertFalse(retired.setComposingRegion(0, 13))
        assertFalse(retired.deleteSurroundingText(13, 0))
        assertFalse(retired.commitText("second ", 1))
        retired.closeConnection()
        assertEquals(listOf("text:first second "), delivered)

        keyboard.setComposingText("thir", 1)
        keyboard.commitText("third", 1)
        keyboard.deleteSurroundingText(1, 0)
        assertEquals("first second thir", keyboard.getTextBeforeCursor(256, 0).toString())
        assertEquals(listOf("text:first second ", "text:third", "text:\u007f"), delivered)
    }

    @Test fun losingWindowFocusDropsTheComposingTextAndDeliversNothing() = onMain {
        val view = TerminalInputView(instrumentation.targetContext, sink)
        val connection = connect(view)
        connection.setComposingText("abc", 1)
        view.onWindowFocusChanged(false)
        connection.finishComposingText()
        assertEquals(emptyList<String>(), delivered)
        assertEquals("", connection.getTextBeforeCursor(10, 0).toString())
    }
}
