package app.lazysh.client

import android.content.ClipboardManager
import android.content.Context
import android.os.Build
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.inputmethod.BaseInputConnection
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.view.inputmethod.SurroundingText
import android.view.inputmethod.TextAttribute
import androidx.annotation.RequiresApi
import androidx.core.view.inputmethod.EditorInfoCompat

/**
 * The keyboard's editor for a native terminal surface: a focusable view that is the soft keyboard's `InputConnection`
 * and receives hardware keys, with no pixels of its own. It replaces xterm's hidden textarea and the `terminalIme.ts`
 * layer over it for a surface the WebView does not draw; the DOM path is untouched. Developer builds only: the surface host creates one
 * per native session and a page forwards what it delivers to the core.
 *
 * Editor setup follows the page's terminal editor: plain text without autocorrect or capitalisation, and while
 * [PrivateKeyboard] is on a visible-password field with no suggestions and no personalised learning. Enter is an
 * ordinary editor action (no action key), so a keyboard sends it as a key event or a line break, never as Go or Send.
 */
class TerminalInputView(
    context: Context,
    sink: TerminalInputSink,
    acceptsInput: () -> Boolean = { true },
    /** The composing text after every change (null: none), for the page to draw at the cursor. */
    private val onComposing: (String?) -> Unit = {},
) : View(context) {
    private var connection: Connection? = null
    private var nextConnection = 0L
    private var servedConnection = 0L
    private val imm = context.getSystemService(InputMethodManager::class.java)
    val editor = TerminalImeEditor(sink, acceptsInput, resync = { imm?.restartInput(this) })

    init {
        isFocusable = true
        isFocusableInTouchMode = true
    }

    override fun onCheckIsTextEditor() = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        val private = PrivateKeyboard.active
        outAttrs.inputType = if (private) PrivateKeyboard.INPUT_TYPE else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
        outAttrs.imeOptions = EditorInfo.IME_ACTION_NONE or EditorInfo.IME_FLAG_NO_ENTER_ACTION or EditorInfo.IME_FLAG_NO_FULLSCREEN or
            EditorInfo.IME_FLAG_NO_EXTRACT_UI or (if (private) EditorInfoCompat.IME_FLAG_NO_PERSONALIZED_LEARNING else 0)
        outAttrs.initialSelStart = editor.selectionStart
        outAttrs.initialSelEnd = editor.selectionEnd
        // What the editor holds, up front: SwiftKey reads the text around the caret from here and from getExtractedText before it composes, and works from nothing without them.
        EditorInfoCompat.setInitialSurroundingText(outAttrs, editor.text)
        return Connection(++nextConnection)
    }

    // Hardware keys the terminal owns; Back, volume and the rest stay with the system.
    override fun onKeyDown(keyCode: Int, event: KeyEvent) = forward(event, release = false) || super.onKeyDown(keyCode, event)
    override fun onKeyUp(keyCode: Int, event: KeyEvent) = forward(event, release = true) || super.onKeyUp(keyCode, event)

    /** The clipboard's text, or null when it holds none or the system withholds it. */
    private fun clipboardText(): String? = try {
        context.getSystemService(ClipboardManager::class.java)?.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.takeIf { it.isNotEmpty() }
    } catch (_: RuntimeException) { null }

    /** Shift+Insert and Ctrl+Shift+V paste, as in xterm.js; a plain Ctrl+V is the program's own key. */
    private fun isPaste(event: KeyEvent): Boolean {
        val shift = event.isShiftPressed
        return shift && (event.keyCode == KeyEvent.KEYCODE_INSERT && !event.isCtrlPressed || event.keyCode == KeyEvent.KEYCODE_V && event.isCtrlPressed)
    }

    private fun forward(event: KeyEvent, release: Boolean): Boolean {
        if (isPaste(event)) {
            if (!release && event.repeatCount == 0) clipboardText()?.let { editor.paste(it); publish() }
            return true
        }
        val unicode = event.getUnicodeChar(event.metaState and TerminalKeys.NON_TEXT_META.inv())
        val key = TerminalKeys.key(event.keyCode, event.metaState, unicode, event.repeatCount > 0, release) ?: return false
        editor.key(key)
        publish()
        return true
    }

    // The WebView-side terminal drops its editor when it is blurred; so does this one, including text still composing.
    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: android.graphics.Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        if (!gainFocus) { editor.revoke(); onComposing(null) }
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (!hasWindowFocus) { editor.revoke(); onComposing(null) }
    }

    override fun onDetachedFromWindow() {
        editor.revoke()
        onComposing(null)
        super.onDetachedFromWindow()
    }

    private fun publish(selectionChanged: Boolean = true) {
        if (editor.inBatch) return
        connection?.publishExtractedText()
        if (selectionChanged) imm?.updateSelection(this, editor.selectionStart, editor.selectionEnd, editor.composingStart, editor.composingEnd)
        onComposing(editor.composing)
    }

    private inner class Connection(private val id: Long) : BaseInputConnection(this@TerminalInputView, false) {
        private var monitorToken: Int? = null
        private var closed = false

        private fun activate(): Boolean {
            if (closed || id < servedConnection) return false
            if (connection !== this) {
                // Android can create and discard a connection without giving it to the keyboard.
                servedConnection = id
                connection = this
                editor.connectionOpened()
            }
            return true
        }

        private inline fun edit(selectionChanged: Boolean = true, change: () -> Boolean): Boolean {
            if (!activate()) return false
            val result = change()
            publish(selectionChanged)
            return result
        }

        override fun beginBatchEdit() = activate() && editor.beginBatchEdit()
        override fun endBatchEdit() = edit { editor.endBatchEdit() }
        override fun commitText(text: CharSequence?, newCursorPosition: Int) = edit { editor.commitText(text ?: "", newCursorPosition) }
        @RequiresApi(34)
        override fun replaceText(start: Int, end: Int, text: CharSequence, newCursorPosition: Int, textAttribute: TextAttribute?) =
            edit { editor.replaceText(start, end, text, newCursorPosition) }

        override fun setComposingText(text: CharSequence?, newCursorPosition: Int) = edit { editor.setComposingText(text ?: "", newCursorPosition) }
        override fun setComposingRegion(start: Int, end: Int) = edit(selectionChanged = false) { editor.setComposingRegion(start, end) }
        override fun finishComposingText() = edit { editor.finishComposingText() }
        override fun deleteSurroundingText(beforeLength: Int, afterLength: Int) = edit { editor.deleteSurroundingText(beforeLength, afterLength) }
        override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int) = edit { editor.deleteSurroundingTextInCodePoints(beforeLength, afterLength) }
        override fun setSelection(start: Int, end: Int) = edit { editor.setSelection(start, end) }
        override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence = if (activate()) editor.textBeforeCursor(n) else ""
        override fun getTextAfterCursor(n: Int, flags: Int): CharSequence = if (activate()) editor.textAfterCursor(n) else ""
        override fun getSelectedText(flags: Int): CharSequence? = if (activate()) editor.selectedText() else null
        override fun getCursorCapsMode(reqModes: Int) = 0

        // The whole editor as one extracted text, which keyboards that track the field (SwiftKey) ask for; the editor has no extract UI.
        override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? {
            if (!activate()) return null
            if (flags and InputConnection.GET_EXTRACTED_TEXT_MONITOR != 0) monitorToken = request?.token
            return extractedText()
        }

        fun publishExtractedText() {
            monitorToken?.let { imm?.updateExtractedText(this@TerminalInputView, it, extractedText()) }
        }

        private fun extractedText() = ExtractedText().also {
            it.text = editor.text
            it.startOffset = 0
            it.partialStartOffset = -1
            it.partialEndOffset = -1
            it.selectionStart = editor.selectionStart
            it.selectionEnd = editor.selectionEnd
        }

        @RequiresApi(Build.VERSION_CODES.S)
        override fun getSurroundingText(beforeLength: Int, afterLength: Int, flags: Int): SurroundingText? {
            if (!activate()) return null
            val before = editor.textBeforeCursor(beforeLength)
            val selected = editor.selectedText() ?: ""
            return SurroundingText(before + selected + editor.textAfterCursor(afterLength), before.length, before.length + selected.length, editor.selectionStart - before.length)
        }

        // The keyboard's clipboard strip asks the editor to paste; the text goes as a paste so a program that enabled bracketed paste receives it as one.
        override fun performContextMenuAction(id: Int): Boolean {
            if (id != android.R.id.paste && id != android.R.id.pasteAsPlainText) return super.performContextMenuAction(id)
            val pasted = clipboardText() ?: return false
            return edit { editor.paste(pasted) }
        }

        /** Enter, Backspace, arrows and the like arrive here from the keyboard; they are keys, not text. */
        override fun sendKeyEvent(event: KeyEvent): Boolean {
            if (event.action != KeyEvent.ACTION_DOWN && event.action != KeyEvent.ACTION_UP) return false
            val unicode = event.getUnicodeChar(event.metaState and TerminalKeys.NON_TEXT_META.inv())
            val key = TerminalKeys.key(event.keyCode, event.metaState, unicode, event.repeatCount > 0, event.action == KeyEvent.ACTION_UP) ?: return false
            return edit { editor.key(key) }
        }

        // A closed connection commits what it was composing, as an editor does, unless focus already left.
        override fun closeConnection() {
            closed = true
            if (connection === this) {
                connection = null
                editor.connectionClosed()
                onComposing(null)
            }
            super.closeConnection()
        }
    }
}
