package app.lazysh.client;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.inputmethodservice.InputMethodService;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
import android.widget.Space;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import java.util.Objects;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Test APK only: retain the OS-provided remote connections in the actual IME process. */
public final class OwnedImeService extends InputMethodService {
    private static OwnedImeService service;
    private static String owner;
    private static Snapshot saved;
    private static long generation;
    private Snapshot current;

    private static final class Snapshot {
        final InputConnection connection;
        final long generation;
        final int inputType;
        final int options;
        Snapshot(InputConnection connection, EditorInfo info) {
            this.connection = connection;
            this.generation = ++OwnedImeService.generation;
            this.inputType = info.inputType;
            this.options = info.imeOptions;
        }
    }

    @Override public void onCreate() { super.onCreate(); service = this; }
    static View inputView(Context context) {
        View view = new Space(context);
        view.setMinimumHeight(1);
        return view;
    }
    @Override public View onCreateInputView() { return inputView(this); }
    @Override public void onStartInput(EditorInfo info, boolean restarting) {
        super.onStartInput(info, restarting);
        InputConnection connection = getCurrentInputConnection();
        current = "app.lazysh.client".equals(info.packageName) && connection != null
                ? new Snapshot(connection, info) : null;
    }
    @Override public void onFinishInput() { current = null; super.onFinishInput(); }
    @Override public void onDestroy() { current = null; service = null; super.onDestroy(); }

    /** The live editor, which must still be the connection the test captured. */
    private static InputConnection capturedConnection(Snapshot active) {
        Snapshot target = Objects.requireNonNull(active, "Owned IME editor unavailable");
        if (saved == null || saved.connection != target.connection)
            throw new IllegalStateException("Owned IME captured terminal required");
        return target.connection;
    }

    private static Bundle operation(String method, String nonce) {
        if ("arm".equals(method)) {
            if (owner != null && !owner.equals(nonce)) throw new IllegalStateException("Owned IME already armed");
            owner = nonce; saved = null;
        } else if (!nonce.equals(owner)) throw new IllegalStateException("Owned IME generation rejected");
        if ("release".equals(method)) { saved = null; owner = null; return new Bundle(); }
        Snapshot active = service == null ? null : service.current;
        Bundle result = new Bundle();
        if (active != null) {
            int variation = active.inputType & InputType.TYPE_MASK_VARIATION;
            boolean password = variation == InputType.TYPE_TEXT_VARIATION_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD
                    || variation == InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD;
            result.putBoolean("normalText", (active.inputType & InputType.TYPE_MASK_CLASS) == InputType.TYPE_CLASS_TEXT && !password);
            result.putBoolean("noSuggestions", (active.inputType & InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS) != 0);
            result.putBoolean("autoCorrect", (active.inputType & InputType.TYPE_TEXT_FLAG_AUTO_CORRECT) != 0);
            result.putBoolean("privateLearning", (active.options & EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING) != 0);
            result.putBoolean("remoteProxy", active.connection.getClass().getName().endsWith(".RemoteInputConnection"));
            result.putLong("generation", active.generation);
            result.putBoolean("distinct", saved != null && saved.connection != active.connection);
        }
        result.putBoolean("connected", active != null);
        if ("capture".equals(method)) { saved = Objects.requireNonNull(active, "Owned IME editor unavailable"); }
        if ("preedit".equals(method)) {
            result.putBoolean("accepted", Objects.requireNonNull(active, "Owned IME editor unavailable")
                    .connection.setComposingText("owned-preedit-" + nonce, 1));
        }
        // Fixed ASCII transactions only; the host raw receiver is the delivery oracle.
        if ("composeCorrection".equals(method) || "extendTail".equals(method)
                || "eraseTail".equals(method) || "repeatWord".equals(method) || "restoreTail".equals(method)) {
            InputConnection connection = capturedConnection(active);
            boolean accepted = connection.beginBatchEdit();
            try {
                if ("composeCorrection".equals(method)) {
                    accepted &= connection.setComposingText("teh", 1);
                    accepted &= connection.setComposingText("the", 1);
                    accepted &= connection.finishComposingText();
                } else if ("extendTail".equals(method)) {
                    accepted &= connection.setComposingRegion(0, 3);
                    accepted &= connection.setComposingText("there", 0);
                    accepted &= connection.finishComposingText();
                } else if ("restoreTail".equals(method)) {
                    accepted &= connection.setSelection(5, 5);
                } else if ("eraseTail".equals(method)) {
                    accepted &= connection.deleteSurroundingText(2, 0);
                } else {
                    accepted &= connection.commitText("the", 1);
                }
            } finally { accepted &= connection.endBatchEdit(); }
            result.putBoolean("accepted", accepted);
            CharSequence read = connection.getTextBeforeCursor(256, 0);
            String expected = "extendTail".equals(method) ? "" : "restoreTail".equals(method) ? "there" : "repeatWord".equals(method) ? "thethe" : "the";
            result.putBoolean("readMatched", read != null && expected.contentEquals(read));
            if ("extendTail".equals(method)) {
                CharSequence after = connection.getTextAfterCursor(256, 0);
                result.putBoolean("suffixMatched", after != null && "there".contentEquals(after));
            }
        }
        // SwiftKey-shaped transactions (shipped 9.13.18.4: setComposingText per key, finishComposingText or
        // commitText to end a word, deleteSurroundingText to replace or erase). Fixed ASCII, continuing the
        // text the transactions above left in the editor.
        if ("predictWord".equals(method) || "swipeWord".equals(method) || "composingBackspace".equals(method)
                || "replacePrevious".equals(method) || "eraseOne".equals(method) || "webWord".equals(method)) {
            InputConnection connection = capturedConnection(active);
            boolean accepted = connection.beginBatchEdit();
            try {
                if ("predictWord".equals(method)) {
                    // Typed letter by letter; the accepted prediction replaces the composing word and adds the separator.
                    for (String typed : new String[] {"o", "ow", "own", "owned"}) accepted &= connection.setComposingText(typed, 1);
                    accepted &= connection.commitText("owned ", 1);
                } else if ("swipeWord".equals(method)) {
                    // A gesture: the whole word and its separator are committed with no composing region.
                    accepted &= connection.commitText("swipe ", 1);
                } else if ("composingBackspace".equals(method)) {
                    // Backspace inside the composing region shortens the word; typing goes on from there.
                    for (String typed : new String[] {"t", "te", "tex", "te", "ten"}) accepted &= connection.setComposingText(typed, 1);
                    accepted &= connection.commitText("ten ", 1);
                } else if ("replacePrevious".equals(method)) {
                    // Autocorrect of the word before the caret: erase it, then commit the correction.
                    accepted &= connection.deleteSurroundingText(4, 0);
                    accepted &= connection.commitText("tan ", 1);
                } else if ("webWord".equals(method)) {
                    // SwiftKey's profile for a Chromium editor: each letter is a plain commit, and the word end
                    // rewrites the same word through a composing region before the separator is committed.
                    for (String letter : new String[] {"w", "e", "b"}) accepted &= connection.commitText(letter, 1);
                    accepted &= connection.setComposingRegion(21, 24);
                    accepted &= connection.setComposingText("web", 1);
                    accepted &= connection.finishComposingText();
                    accepted &= connection.commitText(" ", 1);
                } else {
                    accepted &= connection.deleteSurroundingText(1, 0);
                }
            } finally { accepted &= connection.endBatchEdit(); }
            result.putBoolean("accepted", accepted);
            CharSequence read = connection.getTextBeforeCursor(256, 0);
            String expected = "predictWord".equals(method) ? "thetheowned "
                    : "swipeWord".equals(method) ? "thetheowned swipe "
                    : "composingBackspace".equals(method) ? "thetheowned swipe ten "
                    : "replacePrevious".equals(method) ? "thetheowned swipe tan "
                    : "eraseOne".equals(method) ? "thetheowned swipe tan" : "thetheowned swipe tanweb ";
            result.putBoolean("readMatched", read != null && expected.contentEquals(read));
        }
        if ("lineBreak".equals(method)) {
            Snapshot target = Objects.requireNonNull(active, "Owned IME editor unavailable");
            // The WebView input connection delivers this exact commit as a synthetic soft Enter key press.
            result.putBoolean("accepted", target.connection.commitText("\n", 1));
            // A remote read orders the fixed commit; it does not acknowledge delivery.
            result.putBoolean("readReturned", target.connection.getTextBeforeCursor(256, 0) != null);
        }
        if ("old".equals(method) || "current".equals(method)) {
            Snapshot selected = Objects.requireNonNull("old".equals(method) ? saved : active, "Owned IME connection unavailable");
            String text = "owned-" + method + "-" + nonce;
            result.putBoolean("accepted", selected.connection.commitText(text, 1));
            // A following remote read is a completion barrier, not a delivery acknowledgement.
            CharSequence read = selected.connection.getTextBeforeCursor(256, 0);
            result.putBoolean("readReturned", read != null);
            result.putBoolean("readMatched", read != null && text.contentEquals(read));
        }
        return result;
    }

    /** Same target-UID-only boundary as the existing clipboard fixture; no arbitrary text or commands. */
    public static final class Control extends ContentProvider {
        @Override public boolean onCreate() { return true; }
        @Override public Bundle call(String method, String arg, Bundle extras) {
            OwnedClipboardProvider.requireTargetCaller(Objects.requireNonNull(getContext()));
            if (arg == null || !arg.matches("[0-9a-f]{32}") || extras != null
                    || !("arm".equals(method) || "state".equals(method) || "capture".equals(method)
                    || "composeCorrection".equals(method) || "extendTail".equals(method)
                    || "eraseTail".equals(method) || "repeatWord".equals(method) || "restoreTail".equals(method)
                    || "predictWord".equals(method) || "swipeWord".equals(method) || "composingBackspace".equals(method)
                    || "replacePrevious".equals(method) || "eraseOne".equals(method) || "webWord".equals(method)
                    || "preedit".equals(method) || "lineBreak".equals(method) || "old".equals(method) || "current".equals(method) || "release".equals(method)))
                throw new IllegalStateException("Owned IME operation rejected");
            CountDownLatch completed = new CountDownLatch(1);
            AtomicReference<Bundle> result = new AtomicReference<>();
            AtomicReference<RuntimeException> failure = new AtomicReference<>();
            new Handler(Looper.getMainLooper()).post(() -> {
                try { result.set(operation(method, arg)); }
                catch (RuntimeException error) { failure.set(error); }
                finally { completed.countDown(); }
            });
            try {
                if (!completed.await(30, TimeUnit.SECONDS)) throw new IllegalStateException("Owned IME operation deadline");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt(); throw new IllegalStateException("Owned IME operation interrupted");
            }
            if (failure.get() != null) throw failure.get();
            return Objects.requireNonNull(result.get());
        }
        @Override public String getType(Uri uri) { throw new UnsupportedOperationException(); }
        @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sort) { throw new UnsupportedOperationException(); }
        @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException(); }
        @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException(); }
        @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException(); }
    }
}
