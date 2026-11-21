package app.lazysh.client

import android.util.Log
import android.view.KeyEvent
import android.view.inputmethod.CorrectionInfo
import android.view.inputmethod.ExtractedText
import android.view.inputmethod.ExtractedTextRequest
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputConnectionWrapper

/**
 * Debug builds only: logs, under `lazysh-ime-trace`, every call the soft keyboard makes on the focused web editor, so a
 * real SwiftKey session can be compared with the DOM events in docs/android-testing.md. The text is never logged: only its
 * length and shape, with letters and digits masked (`a`, `0`) and spaces shown as `_`, so a dot or an autospace stays visible.
 */
internal class ImeTrace(target: InputConnection) : InputConnectionWrapper(target, true) {
    private fun shape(text: CharSequence?): String = when (text) {
        null -> "null"
        else -> "${text.length}:" + text.take(24).map { if (it.isLetter()) 'a' else if (it.isDigit()) '0' else if (it == ' ') '_' else it }.joinToString("")
    }
    private fun <T> traced(call: String, block: () -> T): T = block().also { Log.d(TAG, "$call -> ${if (it is CharSequence) shape(it) else it}") }

    override fun commitText(text: CharSequence?, newCursorPosition: Int) = traced("commitText(${shape(text)}, $newCursorPosition)") { super.commitText(text, newCursorPosition) }
    override fun setComposingText(text: CharSequence?, newCursorPosition: Int) = traced("setComposingText(${shape(text)}, $newCursorPosition)") { super.setComposingText(text, newCursorPosition) }
    override fun setComposingRegion(start: Int, end: Int) = traced("setComposingRegion($start, $end)") { super.setComposingRegion(start, end) }
    override fun finishComposingText() = traced("finishComposingText()") { super.finishComposingText() }
    override fun deleteSurroundingText(beforeLength: Int, afterLength: Int) = traced("deleteSurroundingText($beforeLength, $afterLength)") { super.deleteSurroundingText(beforeLength, afterLength) }
    override fun deleteSurroundingTextInCodePoints(beforeLength: Int, afterLength: Int) = traced("deleteSurroundingTextInCodePoints($beforeLength, $afterLength)") { super.deleteSurroundingTextInCodePoints(beforeLength, afterLength) }
    override fun commitCorrection(correctionInfo: CorrectionInfo?) = traced("commitCorrection(at ${correctionInfo?.offset}, old ${shape(correctionInfo?.oldText)}, new ${shape(correctionInfo?.newText)})") { super.commitCorrection(correctionInfo) }
    override fun setSelection(start: Int, end: Int) = traced("setSelection($start, $end)") { super.setSelection(start, end) }
    override fun sendKeyEvent(event: KeyEvent?) = traced("sendKeyEvent(action ${event?.action}, code ${event?.keyCode})") { super.sendKeyEvent(event) }
    override fun performEditorAction(editorAction: Int) = traced("performEditorAction($editorAction)") { super.performEditorAction(editorAction) }
    override fun beginBatchEdit() = traced("beginBatchEdit()") { super.beginBatchEdit() }
    override fun endBatchEdit() = traced("endBatchEdit()") { super.endBatchEdit() }
    override fun getTextBeforeCursor(n: Int, flags: Int): CharSequence? = traced("getTextBeforeCursor($n)") { super.getTextBeforeCursor(n, flags) }
    override fun getTextAfterCursor(n: Int, flags: Int): CharSequence? = traced("getTextAfterCursor($n)") { super.getTextAfterCursor(n, flags) }
    override fun getSelectedText(flags: Int): CharSequence? = traced("getSelectedText()") { super.getSelectedText(flags) }
    override fun getExtractedText(request: ExtractedTextRequest?, flags: Int): ExtractedText? = super.getExtractedText(request, flags).also {
        Log.d(TAG, "getExtractedText() -> text ${shape(it?.text)} selection ${it?.selectionStart},${it?.selectionEnd} offset ${it?.startOffset}")
    }

    companion object { const val TAG = "lazysh-ime-trace" }
}
