package app.lazysh.client;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.inputmethodservice.InputMethodService;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.View;
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
    @Override public View onCreateInputView() {
        View view = new View(this);
        view.setMinimumHeight(1);
        return view;
    }
    @Override public void onStartInput(EditorInfo info, boolean restarting) {
        super.onStartInput(info, restarting);
        InputConnection connection = getCurrentInputConnection();
        current = "app.lazysh.client".equals(info.packageName) && connection != null
                ? new Snapshot(connection, info) : null;
    }
    @Override public void onFinishInput() { current = null; super.onFinishInput(); }
    @Override public void onDestroy() { current = null; service = null; super.onDestroy(); }

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
                    || "preedit".equals(method) || "old".equals(method) || "current".equals(method) || "release".equals(method)))
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
