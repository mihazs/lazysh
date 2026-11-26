package app.lazysh.client

import android.view.KeyEvent

/**
 * Android key codes in the vocabulary of a DOM `KeyboardEvent` (`code` names the physical key, `key` what it produced),
 * the input `KeyInput::from_dom` in the shared core already maps for the WebView. The bridge forwards identities and
 * modifiers and nothing else: Shift+Enter, Ctrl+C and the keyboard protocols are encoded by the core, which is held to
 * what xterm.js sends, so no byte table lives here.
 *
 * The code is the US-layout position, as `KeyboardEvent.code` is for a browser with that layout; Android reports no
 * layout-independent position, so a non-US hardware layout gets the US `code` for each key with `key` carrying what
 * the layout produced, and the core reads `code` first.
 */
object TerminalKeys {
    private val named = mapOf(
        KeyEvent.KEYCODE_ENTER to ("Enter" to "Enter"),
        KeyEvent.KEYCODE_NUMPAD_ENTER to ("NumpadEnter" to "Enter"),
        KeyEvent.KEYCODE_DEL to ("Backspace" to "Backspace"),
        KeyEvent.KEYCODE_FORWARD_DEL to ("Delete" to "Delete"),
        KeyEvent.KEYCODE_TAB to ("Tab" to "Tab"),
        KeyEvent.KEYCODE_ESCAPE to ("Escape" to "Escape"),
        KeyEvent.KEYCODE_SPACE to ("Space" to " "),
        KeyEvent.KEYCODE_DPAD_UP to ("ArrowUp" to "ArrowUp"),
        KeyEvent.KEYCODE_DPAD_DOWN to ("ArrowDown" to "ArrowDown"),
        KeyEvent.KEYCODE_DPAD_LEFT to ("ArrowLeft" to "ArrowLeft"),
        KeyEvent.KEYCODE_DPAD_RIGHT to ("ArrowRight" to "ArrowRight"),
        KeyEvent.KEYCODE_MOVE_HOME to ("Home" to "Home"),
        KeyEvent.KEYCODE_MOVE_END to ("End" to "End"),
        KeyEvent.KEYCODE_PAGE_UP to ("PageUp" to "PageUp"),
        KeyEvent.KEYCODE_PAGE_DOWN to ("PageDown" to "PageDown"),
        KeyEvent.KEYCODE_INSERT to ("Insert" to "Insert"),
        KeyEvent.KEYCODE_SHIFT_LEFT to ("ShiftLeft" to "Shift"),
        KeyEvent.KEYCODE_SHIFT_RIGHT to ("ShiftRight" to "Shift"),
        KeyEvent.KEYCODE_CTRL_LEFT to ("ControlLeft" to "Control"),
        KeyEvent.KEYCODE_CTRL_RIGHT to ("ControlRight" to "Control"),
        KeyEvent.KEYCODE_ALT_LEFT to ("AltLeft" to "Alt"),
        KeyEvent.KEYCODE_ALT_RIGHT to ("AltRight" to "Alt"),
        KeyEvent.KEYCODE_META_LEFT to ("MetaLeft" to "Meta"),
        KeyEvent.KEYCODE_META_RIGHT to ("MetaRight" to "Meta"),
        KeyEvent.KEYCODE_CAPS_LOCK to ("CapsLock" to "CapsLock"),
        KeyEvent.KEYCODE_NUM_LOCK to ("NumLock" to "NumLock"),
        KeyEvent.KEYCODE_SCROLL_LOCK to ("ScrollLock" to "ScrollLock"),
        KeyEvent.KEYCODE_BREAK to ("Pause" to "Pause"),
        KeyEvent.KEYCODE_SYSRQ to ("PrintScreen" to "PrintScreen"),
        KeyEvent.KEYCODE_MENU to ("ContextMenu" to "ContextMenu"),
    )

    /** Physical keys whose `key` is the character they produced (punctuation and the numeric keypad's operators). */
    private val characters = mapOf(
        KeyEvent.KEYCODE_GRAVE to "Backquote",
        KeyEvent.KEYCODE_MINUS to "Minus",
        KeyEvent.KEYCODE_EQUALS to "Equal",
        KeyEvent.KEYCODE_LEFT_BRACKET to "BracketLeft",
        KeyEvent.KEYCODE_RIGHT_BRACKET to "BracketRight",
        KeyEvent.KEYCODE_BACKSLASH to "Backslash",
        KeyEvent.KEYCODE_SEMICOLON to "Semicolon",
        KeyEvent.KEYCODE_APOSTROPHE to "Quote",
        KeyEvent.KEYCODE_COMMA to "Comma",
        KeyEvent.KEYCODE_PERIOD to "Period",
        KeyEvent.KEYCODE_SLASH to "Slash",
        KeyEvent.KEYCODE_NUMPAD_ADD to "NumpadAdd",
        KeyEvent.KEYCODE_NUMPAD_SUBTRACT to "NumpadSubtract",
        KeyEvent.KEYCODE_NUMPAD_MULTIPLY to "NumpadMultiply",
        KeyEvent.KEYCODE_NUMPAD_DIVIDE to "NumpadDivide",
        KeyEvent.KEYCODE_NUMPAD_DOT to "NumpadDecimal",
        KeyEvent.KEYCODE_NUMPAD_COMMA to "NumpadComma",
        KeyEvent.KEYCODE_NUMPAD_EQUALS to "NumpadEqual",
    )

    /** The DOM `code` of a key code, or null for a key that is not the terminal's (Back, Home, volume, media, power). */
    fun code(keyCode: Int): String? = when (keyCode) {
        in KeyEvent.KEYCODE_A..KeyEvent.KEYCODE_Z -> "Key" + ('A' + (keyCode - KeyEvent.KEYCODE_A))
        in KeyEvent.KEYCODE_0..KeyEvent.KEYCODE_9 -> "Digit" + (keyCode - KeyEvent.KEYCODE_0)
        in KeyEvent.KEYCODE_NUMPAD_0..KeyEvent.KEYCODE_NUMPAD_9 -> "Numpad" + (keyCode - KeyEvent.KEYCODE_NUMPAD_0)
        in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12 -> "F" + (keyCode - KeyEvent.KEYCODE_F1 + 1)
        else -> named[keyCode]?.first ?: characters[keyCode]
    }

    fun key(event: KeyEvent, release: Boolean): TerminalKey? {
        val meta = event.metaState
        return key(event.keyCode, meta, event.getUnicodeChar(meta and NON_TEXT_META.inv()),
            event.repeatCount > 0, release, event.getUnicodeChar(meta))
    }

    /**
     * The key for an Android key event, or null when the key is not the terminal's and must stay with the system.
     * [unicode] is `KeyEvent.getUnicodeChar` computed with Shift and Caps Lock only: with Ctrl or Alt held it would be
     * a control character or an accented one, while the DOM `key` of Ctrl+C is `c`.
     */
    fun key(keyCode: Int, metaState: Int, unicode: Int, repeat: Boolean, release: Boolean, modifiedUnicode: Int = unicode): TerminalKey? {
        val altGr = metaState and KeyEvent.META_ALT_RIGHT_ON != 0 &&
            metaState and (KeyEvent.META_CTRL_MASK or KeyEvent.META_META_MASK) == 0 &&
            modifiedUnicode > 0 && modifiedUnicode != unicode && !Character.isISOControl(modifiedUnicode)
        val text = if (altGr) modifiedUnicode else unicode
        val code = code(keyCode) ?: return null
        val name = named[keyCode]?.second
            ?: if (keyCode in KeyEvent.KEYCODE_F1..KeyEvent.KEYCODE_F12) code
            else if (text and DEAD != 0) "Dead"
            else if (text > 0) String(Character.toChars(text))
            else "Unidentified"
        return TerminalKey(
            code = code,
            key = name,
            shift = metaState and KeyEvent.META_SHIFT_ON != 0,
            ctrl = metaState and KeyEvent.META_CTRL_ON != 0,
            alt = !altGr && metaState and KeyEvent.META_ALT_ON != 0,
            meta = metaState and KeyEvent.META_META_ON != 0,
            repeat = repeat,
            release = release,
        )
    }

    /** The modifiers whose presence turns a character key into something other than the text on its cap. */
    private const val NON_TEXT_META = KeyEvent.META_CTRL_MASK or KeyEvent.META_ALT_MASK or KeyEvent.META_META_MASK

    private const val DEAD = Int.MIN_VALUE
}
