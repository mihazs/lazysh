package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The editor is judged by what the remote command line ends up holding. [Remote] applies the bytes the bridge sends the
 * way a shell's line editor does (a DEL erases one character), so a wrong delta shows as a different line, not as a
 * different string of escape bytes. The transactions are the ones `OwnedImeService` replays against a real editor and
 * `terminal-swiftkey.spec.ts` replays against Chromium.
 */
class TerminalImeEditorTest {
    private class Remote : TerminalInputSink {
        val sent = mutableListOf<String>()
        val keys = mutableListOf<TerminalKey>()
        val unapplied = mutableListOf<UnappliedEdit?>()
        var line = ""
            private set

        override fun text(text: String) {
            sent += text
            for (c in text) when (c) {
                '\u007f' -> line = line.dropLast(1)
                '\r' -> line += "\n" // the line break the editor holds for an Enter
                else -> line += c
            }
        }

        override fun key(key: TerminalKey) {
            keys += key
            sent += "<${key.key}>"
            if (key.key == "Backspace") line = line.dropLast(1)
        }

        override fun paste(pasted: String) { sent += "<paste:$pasted>" }

        override fun unapplied(edit: UnappliedEdit?) { unapplied += edit }
    }

    private val remote = Remote()
    private var resyncs = 0
    private var open = true
    private val editor = TerminalImeEditor(remote, acceptsInput = { open }, resync = { resyncs++ })

    private fun batch(block: TerminalImeEditor.() -> Unit) {
        editor.beginBatchEdit()
        editor.block()
        editor.endBatchEdit()
    }

    private fun assertRemoteFollowsEditor() = assertEquals("the remote line is the editor text", editor.text, remote.line)

    @Test
    fun theKeyboardCanDismissAfterPendingCompositionHasCommitted() {
        assertTrue(editor.canDismissKeyboard)
        editor.beginBatchEdit()
        assertFalse(editor.canDismissKeyboard)
        editor.setComposingText("日本", 1)
        editor.endBatchEdit()
        assertFalse(editor.canDismissKeyboard)
        editor.finishComposingText()
        assertEquals("日本", remote.line)
        assertTrue(editor.canDismissKeyboard)
    }

    @Test fun anAutocorrectedWordIsTypedOnceAndNeverAsPreedit() {
        batch {
            setComposingText("teh", 1)
            setComposingText("the", 1)
        }
        assertEquals("preedit stays on the device while the keyboard composes", emptyList<String>(), remote.sent)
        assertEquals("the", editor.composing)
        editor.finishComposingText()
        assertEquals(listOf("the"), remote.sent)
        assertNull(editor.composing)
        assertRemoteFollowsEditor()
    }

    @Test fun theFixedKeyboardTransactionsKeepTheRemoteLineEqualToTheEditor() {
        val steps = listOf<Pair<String, TerminalImeEditor.() -> Unit>>(
            "composeCorrection" to { setComposingText("teh", 1); setComposingText("the", 1); finishComposingText() },
            "extendTail" to { setComposingRegion(0, 3); setComposingText("there", 0); finishComposingText() },
            "restoreTail" to { setSelection(5, 5) },
            "eraseTail" to { deleteSurroundingText(2, 0) },
            "repeatWord" to { commitText("the", 1) },
            "predictWord" to { for (typed in listOf("o", "ow", "own", "owned")) setComposingText(typed, 1); commitText("owned ", 1) },
            "swipeWord" to { commitText("swipe ", 1) },
            "composingBackspace" to { for (typed in listOf("t", "te", "tex", "te", "ten")) setComposingText(typed, 1); commitText("ten ", 1) },
            "replacePrevious" to { deleteSurroundingText(4, 0); commitText("tan ", 1) },
            "eraseOne" to { deleteSurroundingText(1, 0) },
            "webWord" to {
                for (letter in listOf("w", "e", "b")) commitText(letter, 1)
                setComposingRegion(21, 24); setComposingText("web", 1); finishComposingText(); commitText(" ", 1)
            },
        )
        val expectedText = listOf("the", "there", "there", "the", "thethe", "thetheowned ", "thetheowned swipe ",
            "thetheowned swipe ten ", "thetheowned swipe tan ", "thetheowned swipe tan", "thetheowned swipe tanweb ")
        for ((index, step) in steps.withIndex()) {
            batch(step.second)
            assertEquals("editor text after ${step.first}", expectedText[index], editor.text)
            assertRemoteFollowsEditor()
        }
        assertTrue("every transaction was accepted without staging an edit", remote.unapplied.isEmpty())
        assertEquals("the editor was never replaced under the keyboard", 0, resyncs)
    }

    @Test fun recomposingAnAlreadyTypedWordDrawsOnlyTheNewSuffix() {
        editor.commitText("the", 1)
        batch { setComposingRegion(0, 3); setComposingText("there", 1) }
        assertEquals("re", editor.composing)
        editor.finishComposingText()
        assertEquals(listOf("the", "re"), remote.sent)
    }

    @Test fun extendingATailWithTheCaretBeforeItTypesOnlyTheNewLetters() {
        batch { commitText("the", 1) }
        remote.sent.clear()
        batch { setComposingRegion(0, 3); setComposingText("there", 0); finishComposingText() }
        assertEquals(listOf("re"), remote.sent)
        assertEquals("", editor.textBeforeCursor(10))
        assertEquals("there", editor.textAfterCursor(10))
    }

    @Test fun largeKeyboardContextLengthsStayWithinTheEditor() {
        editor.commitText("abc", 1)
        editor.setSelection(1, 1)
        assertEquals("bc", editor.textAfterCursor(Int.MAX_VALUE))
        editor.deleteSurroundingText(0, Int.MAX_VALUE)
        assertEquals("a", editor.text)
        editor.deleteSurroundingTextInCodePoints(Int.MAX_VALUE, Int.MAX_VALUE)
        assertEquals("", editor.text)
    }

    @Test fun movingTheCaretSendsNothing() {
        batch { commitText("there", 1) }
        remote.sent.clear()
        editor.setSelection(0, 0)
        editor.setSelection(5, 5)
        assertEquals(emptyList<String>(), remote.sent)
    }

    @Test fun aReplacementOfPlainAsciiBacksUpOverTheChangedTailOnly() {
        batch { commitText("swipe ten ", 1) }
        remote.sent.clear()
        batch { deleteSurroundingText(4, 0); commitText("tan ", 1) }
        assertEquals(listOf("\u007f\u007f\u007fan "), remote.sent)
    }

    @Test fun softKeyboardEnterIsACarriageReturnAndEndsOwnershipOfTheLine() {
        batch { commitText("ls", 1) }; batch { commitText("\n", 1) }
        assertEquals(listOf("ls", "\r"), remote.sent)
        assertEquals("", editor.textBeforeCursor(10))
        batch { commitText("x", 1) }
        assertEquals("typing goes on after the line break", listOf("ls", "\r", "x"), remote.sent)
        assertEquals("x", editor.text)
    }

    @Test fun enterBatchedWithTheFinalWordAlsoStartsAFreshLine() {
        batch { commitText("hello", 1); commitText("\n", 1) }
        assertEquals(listOf("hello\n"), remote.sent)
        assertEquals("", editor.text)
        assertEquals(1, resyncs)
    }

    @Test fun backspacingIntoAPreviousLineIsNotGuessedAt() {
        batch { commitText("ls\nx", 1) }
        remote.sent.clear()
        batch { deleteSurroundingText(2, 0) }
        assertEquals("nothing is replayed into the earlier command", emptyList<String>(), remote.sent)
        assertEquals(listOf(UnappliedEdit("ls", false)), remote.unapplied.filterNotNull())
        assertEquals("the keyboard is told to read the empty editor", 1, resyncs)
        assertEquals("", editor.text)
    }

    @Test fun identicalConsecutiveCommandsAreBothSent() {
        repeat(2) { batch { commitText("ls", 1) }; batch { commitText("\n", 1) } }
        assertEquals(listOf("ls", "\r", "ls", "\r"), remote.sent)
    }

    @Test fun anEditThatErasesNonAsciiTextIsStagedAndTheEditorStartsAgain() {
        batch { commitText("café", 1) }
        remote.sent.clear()
        batch { deleteSurroundingText(1, 0); commitText("e", 1) }
        assertEquals("the peer owns erase units for committed Unicode", emptyList<String>(), remote.sent)
        assertEquals(listOf(UnappliedEdit("cafe", false)), remote.unapplied.filterNotNull())
        batch { commitText("x", 1) }
        assertEquals("the next keystroke is sent normally", listOf("x"), remote.sent)
    }

    @Test fun aStagedEditIsBoundedWithoutSplittingASupplementaryCharacter() {
        batch { commitText("é", 1) }
        batch {
            setComposingRegion(0, 1)
            setComposingText("e" + "a".repeat(TerminalImeEditor.MAX_CONTEXT - 2) + "😀" + "a".repeat(10), 1)
            finishComposingText()
        }
        val edit = remote.unapplied.filterNotNull().single()
        assertTrue(edit.truncated)
        assertEquals(TerminalImeEditor.MAX_CONTEXT - 1, edit.text.length)
        assertFalse("no lone high surrogate", edit.text.last().isHighSurrogate())
    }

    @Test fun aHardwareKeyDeliversThePreeditOnceAndThenTheKey() {
        batch { setComposingText("ab", 1) }
        assertEquals(emptyList<String>(), remote.sent)
        editor.key(TerminalKey("Enter", "Enter"))
        assertEquals(listOf("ab", "<Enter>"), remote.sent)
        assertNull(editor.composing)
        assertEquals("", editor.text)
        assertEquals(1, resyncs)
        batch { setComposingText("abc", 1); finishComposingText() }
        assertEquals(listOf("ab", "<Enter>", "abc"), remote.sent)
    }

    @Test fun aModifierAloneChangesNothing() {
        batch { setComposingText("ab", 1) }
        editor.key(TerminalKey("ShiftLeft", "Shift", shift = true))
        assertEquals("the preedit is still being composed", "ab", editor.composing)
        assertEquals(listOf("<Shift>"), remote.sent)
    }

    @Test fun aKeyboardBackspaceKeyEditsTheEditorAndReachesTheTerminalOnce() {
        batch { commitText("ab", 1) }
        editor.key(TerminalKey("Backspace", "Backspace"))
        assertEquals("a", editor.text)
        assertRemoteFollowsEditor()
        batch { deleteSurroundingText(1, 0) }
        assertEquals("", editor.text)
        assertRemoteFollowsEditor()
        assertEquals("one DEL from the key and one from the edit, not two each", listOf("ab", "<Backspace>", "\u007f"), remote.sent)
    }

    @Test fun typingContinuesAfterAKeyboardEraseCrossesThePreviousOwnershipBoundary() {
        editor.commitText("first second", 1)
        editor.settleOwnership()
        editor.deleteSurroundingText(1, 0)
        editor.commitText("d", 1)
        assertEquals(listOf("first second", "\u007f", "d"), remote.sent)
        assertRemoteFollowsEditor()
    }

    @Test fun backspaceOverAnEmptyEditorStillReachesTheTerminal() {
        editor.key(TerminalKey("Backspace", "Backspace"))
        assertEquals(listOf("<Backspace>"), remote.sent)
        assertEquals("", editor.text)
    }

    @Test fun aKeyReleaseDoesNotEndOwnershipOrDeliverPreedit() {
        batch { setComposingText("ab", 1) }
        editor.key(TerminalKey("Enter", "Enter", release = true))
        assertEquals(listOf("<Enter>"), remote.sent)
        assertEquals("ab", editor.composing)
    }

    @Test fun openingANewConnectionDoesNotInheritAnUnfinishedBatch() {
        editor.commitText("first second ", 1)
        assertTrue(editor.beginBatchEdit())
        editor.connectionOpened()
        batch { setComposingText("thir", 1); commitText("third", 1) }
        editor.deleteSurroundingText(1, 0)
        assertEquals("first second thir", remote.line)
        assertEquals(listOf("first second ", "third", "\u007f"), remote.sent)
    }

    @Test fun reopeningTheEditorDeliversPendingCompositionOnce() {
        editor.setComposingText("word", 1)
        editor.connectionOpened()
        editor.commitText(" next", 1)
        assertEquals(listOf("word", " next"), remote.sent)
        assertRemoteFollowsEditor()
    }

    @Test fun losingFocusDropsTheComposingTextAndDeliversNothing() {
        batch { setComposingText("abc", 1) }
        editor.revoke()
        assertEquals(emptyList<String>(), remote.sent)
        assertEquals("", editor.text)
        assertNull(editor.composing)
    }

    @Test fun aClosedConnectionKeepsWhatItWasComposing() {
        batch { setComposingText("abc", 1) }
        editor.connectionClosed()
        assertEquals(listOf("abc"), remote.sent)
    }

    @Test fun nothingIsDeliveredWhileInputIsGated() {
        open = false
        batch { commitText("x", 1) }
        editor.key(TerminalKey("Enter", "Enter"))
        assertEquals(emptyList<String>(), remote.sent)
        assertEquals("", editor.text)
        assertTrue("the keyboard re-reads the emptied editor", resyncs > 0)
        open = true
        batch { commitText("y", 1) }
        assertEquals("input resumes from a clean editor", listOf("y"), remote.sent)
    }

    @Test fun aLongSessionOfTypingIsBoundedAndKeepsDelivering() {
        val chunk = "a".repeat(1024)
        repeat(TerminalImeEditor.MAX_CONTEXT / 1024 + 1) { batch { commitText(chunk, 1) } }
        assertEquals("every chunk reached the terminal", chunk.length * (TerminalImeEditor.MAX_CONTEXT / 1024 + 1), remote.line.length)
        assertEquals("the editor was emptied once it passed the bound", "", editor.text)
        assertEquals(1, resyncs)
        batch { commitText("z", 1) }
        assertTrue(remote.line.endsWith("z"))
    }

    @Test fun theCursorFollowsNewCursorPositionRelativeToTheInsertedText() {
        batch { commitText("abc", 1) }
        assertEquals(3, editor.selectionStart)
        batch { commitText("d", 0) }
        assertEquals("0 puts the caret before the text", 3, editor.selectionStart)
        assertEquals("abcd", editor.text)
        batch { commitText("e", 2) }
        assertEquals("2 puts it one past the end of the text, clamped to it", 5, editor.selectionStart)
    }

    @Test fun deletingByCodePointsKeepsASupplementaryCharacterWhole() {
        batch { commitText("ab😀", 1) }
        remote.sent.clear()
        editor.beginBatchEdit()
        editor.deleteSurroundingTextInCodePoints(1, 0)
        assertEquals("ab", editor.text)
        editor.endBatchEdit()
        assertEquals("a non-ASCII erase is never guessed at", emptyList<String>(), remote.sent)
        assertEquals(1, remote.unapplied.filterNotNull().size)
    }

    @Test fun anAsciiCodePointDeleteEqualsADeleteOfThatManyUnits() {
        batch { commitText("abc", 1) }
        batch { deleteSurroundingTextInCodePoints(2, 0) }
        assertEquals("a", editor.text)
        assertRemoteFollowsEditor()
    }

    @Test fun ownedDeltaRefusesAChangeBeforeTheOwnedSuffix() {
        assertNull(TerminalImeEditor.ownedDelta("abcd", "abXd", owned = 3))
        assertEquals("\u007fX", TerminalImeEditor.ownedDelta("abcd", "abcX", owned = 3))
        assertEquals("a tail erase is a Backspace press even before the owned start", "\u007f\u007f", TerminalImeEditor.ownedDelta("abcd", "ab", owned = 4))
    }

    @Test fun aPasteDeliversWhatWasTypedFirstThenTheTextAsOnePasteAndStartsFresh() {
        batch { commitText("ls ", 1) }
        assertTrue(editor.paste("a\nb"))
        batch { commitText("x", 1) }
        assertEquals(listOf("ls ", "<paste:a\nb>", "x"), remote.sent)
    }

    @Test fun aPasteIsRefusedWhileInputIsGated() {
        open = false
        assertFalse(editor.paste("secret"))
        assertEquals(emptyList<String>(), remote.sent)
    }

    @Test fun anEmptyPasteSendsNothing() {
        assertTrue(editor.paste(""))
        assertEquals(emptyList<String>(), remote.sent)
    }

    @Test fun swiftKeyBackspaceErasesTheCommittedTailWhileRecomposingTheWord() {
        editor.commitText("hello world ", 1)
        batch { deleteSurroundingText(1, 0); setComposingRegion(6, 11) }
        assertEquals("hello world", remote.line)
        batch { setComposingText("worl", 1) }
        assertEquals("hello worl", remote.line)
        batch { setComposingText("world", 1); finishComposingText(); commitText(" ", 1) }
        assertEquals(listOf("hello world ", "\u007f", "\u007f", "d "), remote.sent)
        assertRemoteFollowsEditor()
    }

    /**
     * A SwiftKey-style session as the keyboard drives the editor (#2489): every letter updates the composing word in its own batch, the space
     * commits the word with it, the next word is mistyped and replaced by an autocorrect over the previous word, a backspace is a
     * deleteSurroundingText, and a word is composed again after the caret moves back. The bytes are exact, and nothing is sent twice.
     */
    @Test fun aRecordedSwiftKeySequenceSendsExactlyTheBytesTheRemoteLineNeeds() {
        for (preedit in listOf("h", "he", "hel", "hell", "hello")) batch { setComposingText(preedit, 1) }
        assertEquals("nothing leaves while the word is composing", emptyList<String>(), remote.sent)
        batch { commitText("hello", 1); commitText(" ", 1) }
        assertEquals("the word and its space are one delivery", listOf("hello "), remote.sent)
        for (preedit in listOf("w", "wo", "wrl", "wrld")) batch { setComposingText(preedit, 1) }
        batch { commitText("wrld", 1); commitText(" ", 1) }
        assertEquals("hello wrld ", remote.line)
        // The autocorrect replaces the word it just committed: the keyboard marks it composing again and commits the correction.
        batch { setComposingRegion(6, 11); commitText("world ", 1) }
        assertEquals("hello world ", remote.line)
        batch { deleteSurroundingText(1, 0) }
        assertEquals("hello world", remote.line)
        batch { setComposingText("!", 1); finishComposingText() }
        assertEquals("hello world!", remote.line)
        assertRemoteFollowsEditor()
        // Every delivery is a delta: the correction backs up over the changed tail ("rld ") and types the new one, and nothing is resent.
        assertEquals(listOf("hello ", "wrld ", "\u007f\u007f\u007f\u007forld ", "\u007f", "!"), remote.sent)
    }
}
