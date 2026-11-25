package app.lazysh.client

/**
 * A key press or release that is not text, in the vocabulary of a DOM `KeyboardEvent` (the shape the shared core's
 * `KeyInput::from_dom` already maps), so the encoder, not this bridge, decides the bytes for Shift+Enter, Ctrl+C and
 * the protocols a program enables.
 */
data class TerminalKey(
    val code: String,
    val key: String,
    val shift: Boolean = false,
    val ctrl: Boolean = false,
    val alt: Boolean = false,
    val meta: Boolean = false,
    val repeat: Boolean = false,
    val release: Boolean = false,
)

/** An edit the bridge will not guess at; the text stays on the device for the person to review. */
data class UnappliedEdit(val text: String, val truncated: Boolean)

/** Where the bridge delivers what was typed, on the main thread and in order. */
interface TerminalInputSink {
    /** Typed text exactly as the terminal must receive it: erase units are DEL (0x7f) and Enter is CR. */
    fun text(text: String)

    /** A key press or release that is not text. */
    fun key(key: TerminalKey)

    /** Text pasted from the clipboard (the keyboard's clipboard strip, Shift+Insert): the core brackets it when the program asked for that; a sink without paste receives it as typed text. */
    fun paste(pasted: String) = text(pasted)

    /** An edit that cannot be applied to the remote text, or null once nothing is waiting for review. */
    fun unapplied(edit: UnappliedEdit?)
}

/**
 * The text a soft keyboard edits for the native terminal surface, and the translation of its edits into terminal input.
 *
 * It is the native twin of `terminalIme.ts`. The keyboard sees a small editor (this class); the remote command line
 * only ever sees the *owned suffix* of it, the text typed since the last key, Enter or toolbar key ended ownership.
 * Every change the keyboard makes is turned into the shortest remote edit that has the same effect there: backspaces
 * over the changed tail, then the new text. Composing text stays on the device until the keyboard ends the
 * composition, exactly as xterm.js delivers it on `compositionend`. A change the remote text cannot follow (erasing
 * text that is not plain ASCII, or text before the owned suffix) is never replayed: it is surfaced as an
 * [UnappliedEdit] and the editor starts again empty.
 *
 * Plain Kotlin on purpose (no Android types): the same instance serves the `InputConnection` and the JVM tests.
 */
class TerminalImeEditor(
    private val sink: TerminalInputSink,
    /** False while terminal input is gated (locked, backgrounded, another renderer): nothing is delivered. */
    private val acceptsInput: () -> Boolean = { true },
    /** The editor changed without the keyboard asking: it must read the text again. */
    private val resync: () -> Unit = {},
) {
    private var value = ""
    private var selStart = 0
    private var selEnd = 0
    private var compStart = -1
    private var compEnd = -1
    /** What the remote command line already matches. */
    private var previous = ""
    /** Where the owned suffix of [previous] and [value] begins. */
    private var owned = 0
    private var depth = 0

    val inBatch: Boolean get() = depth > 0
    val text: String get() = value
    val selectionStart: Int get() = minOf(selStart, selEnd)
    val selectionEnd: Int get() = maxOf(selStart, selEnd)
    val composingStart: Int get() = compStart
    val composingEnd: Int get() = compEnd

    /** The preedit the surface should draw at the cursor while the keyboard composes, or null. */
    val composing: String? get() {
        if (compStart < 0) return null
        // The terminal already drew the unchanged prefix at these positions.
        var start = compStart
        while (start < compEnd && start < previous.length && value[start] == previous[start]) start++
        if (start > compStart && start < compEnd && value[start].isLowSurrogate() && value[start - 1].isHighSurrogate()) start--
        return if (start == compEnd) null else value.substring(start, compEnd)
    }

    // ---- InputConnection operations ----

    fun beginBatchEdit(): Boolean { depth++; return true }

    /** True while still inside an outer batch. */
    fun endBatchEdit(): Boolean {
        if (depth > 0) depth--
        settle()
        return depth > 0
    }

    fun commitText(text: CharSequence, newCursorPosition: Int): Boolean {
        val (start, end) = region()
        replace(start, end, text, newCursorPosition, composing = false)
        settle()
        return true
    }

    fun replaceText(start: Int, end: Int, text: CharSequence, newCursorPosition: Int): Boolean {
        if (start < 0 || end < 0) return false
        val from = minOf(start, end, value.length)
        val to = minOf(maxOf(start, end), value.length)
        replace(from, to, text, newCursorPosition, composing = false)
        settle()
        return true
    }

    fun setComposingText(text: CharSequence, newCursorPosition: Int): Boolean {
        val (start, end) = region()
        replace(start, end, text, newCursorPosition, composing = true)
        settle()
        return true
    }

    fun setComposingRegion(start: Int, end: Int): Boolean {
        val a = start.coerceIn(0, value.length)
        val b = end.coerceIn(0, value.length)
        compStart = if (a == b) -1 else minOf(a, b)
        compEnd = if (a == b) -1 else maxOf(a, b)
        settle()
        return true
    }

    fun finishComposingText(): Boolean {
        compStart = -1
        compEnd = -1
        settle()
        return true
    }

    fun deleteSurroundingText(before: Int, after: Int): Boolean {
        delete(maxOf(before, 0), maxOf(after, 0))
        settle()
        return true
    }

    fun deleteSurroundingTextInCodePoints(before: Int, after: Int): Boolean {
        var from = selectionStart
        repeat(maxOf(before, 0)) { if (from > 0) from -= if (from >= 2 && value[from - 1].isLowSurrogate() && value[from - 2].isHighSurrogate()) 2 else 1 }
        var to = selectionEnd
        repeat(maxOf(after, 0)) { if (to < value.length) to += if (to + 1 < value.length && value[to].isHighSurrogate() && value[to + 1].isLowSurrogate()) 2 else 1 }
        delete(selectionStart - from, to - selectionEnd)
        settle()
        return true
    }

    fun setSelection(start: Int, end: Int): Boolean {
        val a = start.coerceIn(0, value.length)
        val b = end.coerceIn(0, value.length)
        selStart = a
        selEnd = b
        return true
    }

    fun textBeforeCursor(length: Int): String = value.substring(maxOf(0, selectionStart - maxOf(length, 0)), selectionStart)

    fun textAfterCursor(length: Int): String = value.substring(selectionEnd, minOf(value.length, selectionEnd + maxOf(length, 0)))

    fun selectedText(): String? = if (selectionStart == selectionEnd) null else value.substring(selectionStart, selectionEnd)

    // ---- keys ----

    /**
     * A key that is not text: a hardware key, or one the keyboard sent as a key event (Enter, Backspace, arrows).
     * Pending composition is delivered as typed first, ownership of the typed text ends, and the key goes to the
     * terminal. Backspace and Delete also edit the text the keyboard holds, so that its next read matches what the
     * terminal now shows; Backspace over an empty editor still reaches the terminal, which owns the text before it.
     * A modifier alone changes nothing.
     */
    fun key(key: TerminalKey): Boolean {
        if (!acceptsInput()) { resetAndResync(); return true }
        if (!key.release && !modifierOnly(key)) {
            flush()
            if (!key.shift && !key.ctrl && !key.alt && !key.meta && (key.key == "Backspace" || key.key == "Delete")) {
                // A selection is what the key erases; otherwise the unit before (Backspace) or after (Delete) the caret.
                if (selStart != selEnd) replace(selectionStart, selectionEnd, "", 1, composing = false)
                else if (key.key == "Backspace") delete(1, 0) else delete(0, 1)
            }
            previous = value
            owned = value.length
        }
        sink.key(key)
        if (!key.release && key.key == "Enter" && !key.shift && !key.ctrl && !key.alt && !key.meta) resetAndResync()
        return true
    }

    /** Pasted text: what the keyboard held is delivered first, then the paste goes as one unit and the editor starts fresh. False while input is gated. */
    fun paste(pasted: String): Boolean {
        if (!acceptsInput()) { resetAndResync(); return false }
        if (pasted.isEmpty()) return true
        settleOwnership()
        sink.paste(pasted)
        return true
    }

    /** Deliver the text the keyboard holds as typed and end ownership of it. Pending composition stays composing. */
    fun flush() {
        if (deliver()) owned = value.length
    }

    /** A toolbar key or paste reached the terminal through another path: start from a fresh editor context. */
    fun settleOwnership() {
        flush()
        sink.unapplied(null)
        previous = value
        owned = value.length
    }

    /** The keyboard's connection closed while the view kept focus: what it was composing is committed as typed. */
    fun connectionClosed() {
        depth = 0
        compStart = -1
        compEnd = -1
        flush()
    }

    /** The replacement keyboard starts from the text already delivered to the terminal. */
    fun connectionOpened() {
        depth = 0
        compStart = -1
        compEnd = -1
        if (value != previous) flush()
        owned = value.length
    }

    /** Focus left the surface: drop the editor, including composing text, and deliver nothing. */
    fun revoke() {
        clear()
        sink.unapplied(null)
    }

    // ---- internals ----

    private fun modifierOnly(key: TerminalKey) = key.key == "Shift" || key.key == "Control" || key.key == "Alt" || key.key == "Meta"

    private fun region(): Pair<Int, Int> = if (compStart >= 0) compStart to compEnd else selectionStart to selectionEnd

    private fun replace(start: Int, end: Int, text: CharSequence, cursor: Int, composing: Boolean) {
        value = value.substring(0, start) + text + value.substring(end)
        val caret = (if (cursor > 0) start + text.length + cursor - 1 else start + cursor).coerceIn(0, value.length)
        selStart = caret
        selEnd = caret
        compStart = if (composing && text.isNotEmpty()) start else -1
        compEnd = if (composing && text.isNotEmpty()) start + text.length else -1
    }

    /** Remove [before] units before the selection and [after] units after it, keeping the selection and composing text aligned. */
    private fun delete(before: Int, after: Int) {
        val s = selectionStart
        val e = selectionEnd
        val from = maxOf(0, s - before)
        val to = minOf(value.length, e + after)
        value = value.substring(0, from) + value.substring(s, e) + value.substring(to)
        fun remap(p: Int) = when {
            p <= from -> p
            p <= s -> from
            p <= e -> p - (s - from)
            p <= to -> from + (e - s)
            else -> p - (s - from) - (to - e)
        }
        if (compStart >= 0) {
            val a = remap(compStart)
            val b = remap(compEnd)
            compStart = if (a == b) -1 else a
            compEnd = if (a == b) -1 else b
        }
        selStart = from
        selEnd = from + (e - s)
    }

    private fun settle() {
        if (depth > 0) return
        // SwiftKey reopens the last word on Backspace. A pure tail erase must show while it composes.
        if (compStart >= 0 && !asciiTailErase(previous, value)) return
        if (!deliver()) return
        if (value.length > MAX_CONTEXT) resetAndResync()
    }

    /** Deliver [value] against [previous]; false when nothing was delivered because the edit was refused or input is gated. */
    private fun deliver(): Boolean {
        if (!acceptsInput()) { resetAndResync(); return false }
        val delta = ownedDelta(previous, value, owned)
        if (delta == null) { stage(); return false }
        previous = value
        owned = minOf(owned, value.length)
        // Enter typed as text is a carriage return, sent as it is in every keyboard mode (#1043); a line break inside
        // longer text goes as typed, like xterm.js. Either way what came before the break is no longer editable.
        if (delta.isNotEmpty()) {
            sink.text(if (delta == "\n") "\r" else delta)
            if (delta.endsWith('\n') || delta.endsWith('\r')) resetAndResync()
            else if (delta.contains('\n') || delta.contains('\r')) owned = value.length
        }
        return true
    }

    private fun stage() {
        // This is local keyboard context, not an editable remote command line. Never log or persist it.
        var end = minOf(value.length, MAX_CONTEXT)
        if (end < value.length && end > 0 && value[end - 1].isHighSurrogate()) end--
        val edit = UnappliedEdit(value.substring(0, end), end != value.length)
        resetAndResync()
        sink.unapplied(edit)
    }

    private fun resetAndResync() {
        clear()
        resync()
    }

    private fun clear() {
        depth = 0
        value = ""
        previous = ""
        selStart = 0; selEnd = 0
        compStart = -1; compEnd = -1
        owned = 0
    }

    companion object {
        /** Bounds the editor text and an unapplied edit. shortcut: a fixed 64 KiB, as terminalIme.ts bounds a staged edit; raise it if a keyboard needs more context. */
        const val MAX_CONTEXT = 65536
        private const val ERASE = "\u007f"

        private fun asciiTailErase(previous: String, value: String): Boolean =
            value.length < previous.length && previous.startsWith(value) &&
                (value.length until previous.length).all { previous[it] in ' '..'~' }

        /**
         * The remote edit that turns [previous] into [value], or null when it cannot be made safely. Erasing the end
         * of the editor is a Backspace press even over text that a key made unowned since it was typed. Anything
         * else is held to the owned suffix starting at [owned]: the remote cursor sits at its end, so a change inside
         * it is that many backspaces and the text after the first difference, and only plain ASCII may be backspaced
         * (the peer owns erase units; rolling back committed Unicode is never guessed).
         */
        internal fun ownedDelta(previous: String, value: String, owned: Int): String? {
            if (asciiTailErase(previous, value))
                return ERASE.repeat(previous.length - value.length)
            if (value.take(owned) != previous.take(owned)) return null
            val old = previous.substring(minOf(owned, previous.length)).codePoints().toArray()
            val next = value.substring(minOf(owned, value.length)).codePoints().toArray()
            var common = 0
            while (common < old.size && common < next.size && old[common] == next[common]) common++
            if ((common until old.size).any { old[it] !in 0x20..0x7e }) return null
            return ERASE.repeat(old.size - common) + String(next, common, next.size - common)
        }
    }
}
