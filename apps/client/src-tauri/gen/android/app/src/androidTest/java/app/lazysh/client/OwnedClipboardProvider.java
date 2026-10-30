package app.lazysh.client;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Binder;
import android.os.ParcelFileDescriptor;
import android.os.Process;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.util.Objects;

/** Test APK only. Framework-only so its standalone provider process needs no target-app runtime. */
public final class OwnedClipboardProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }

    private String kind(Uri uri) {
        Context context = Objects.requireNonNull(getContext());
        int target;
        try {
            target = context.getPackageManager().getApplicationInfo("app.lazysh.client", 0).uid;
        } catch (PackageManager.NameNotFoundException missing) {
            throw new IllegalStateException("Clipboard fixture target unavailable");
        }
        if (Binder.getCallingUid() != target && Binder.getCallingUid() != Process.myUid())
            throw new IllegalStateException("Clipboard fixture caller rejected");
        String path = uri.getPath();
        if (!"content".equals(uri.getScheme()) || !"app.lazysh.client.test.clipboardfixture".equals(uri.getAuthority())
                || uri.getQuery() != null || uri.getFragment() != null
                || !("/png".equals(path) || "/jpg".equals(path) || "/oversize".equals(path)))
            throw new IllegalStateException("Clipboard fixture URI rejected");
        return path;
    }

    @Override public String getType(Uri uri) { return "/jpg".equals(kind(uri)) ? "image/jpeg" : "image/png"; }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        String kind = kind(uri);
        if (!"r".equals(mode)) throw new IllegalStateException("Clipboard fixture mode rejected");
        try {
            File file = File.createTempFile("owned-clipboard-", ".bin", Objects.requireNonNull(getContext()).getCacheDir());
            try {
                Bitmap bitmap = Bitmap.createBitmap(4, 3, Bitmap.Config.ARGB_8888);
                try (FileOutputStream output = new FileOutputStream(file)) {
                    if (!bitmap.compress("/jpg".equals(kind) ? Bitmap.CompressFormat.JPEG : Bitmap.CompressFormat.PNG, 90, output))
                        throw new IllegalStateException("Clipboard fixture compression failed");
                    if ("/oversize".equals(kind)) {
                        byte[] padding = new byte[8192];
                        int remaining = 10 * 1024 * 1024 + 1 - (int) file.length();
                        while (remaining > 0) {
                            int count = Math.min(remaining, padding.length);
                            output.write(padding, 0, count); remaining -= count;
                        }
                    }
                } finally { bitmap.recycle(); }
                ParcelFileDescriptor descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
                if (!file.delete()) {
                    descriptor.close(); throw new IllegalStateException("Clipboard fixture file did not retire");
                }
                return descriptor;
            } finally {
                if (file.exists() && !file.delete()) throw new IllegalStateException("Clipboard fixture cleanup failed");
            }
        } catch (IOException failure) {
            throw new FileNotFoundException("Clipboard fixture IO failed");
        }
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) { return null; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Clipboard fixture is read only"); }
    @Override public int delete(Uri uri, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("Clipboard fixture is read only"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) { throw new UnsupportedOperationException("Clipboard fixture is read only"); }
}
