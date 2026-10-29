package app.lazysh.client

import android.content.ContentProvider
import android.content.ContentValues
import android.database.Cursor
import android.graphics.Bitmap
import android.net.Uri
import android.os.Binder
import android.os.ParcelFileDescriptor
import android.os.Process
import java.io.File
import java.io.FileOutputStream

/** Test APK only. No supplied filenames, provider forwarding, or non-synthetic content. */
class OwnedClipboardProvider : ContentProvider() {
    override fun onCreate() = true
    private fun kind(uri: Uri): String {
        val context = requireNotNull(context)
        val target = context.packageManager.getApplicationInfo("app.lazysh.client", 0).uid
        check(Binder.getCallingUid() == target || Binder.getCallingUid() == Process.myUid()) { "Clipboard fixture caller rejected" }
        check(uri.scheme == "content" && uri.authority == "app.lazysh.client.test.clipboardfixture" &&
            uri.query == null && uri.fragment == null && uri.path in listOf("/png", "/jpg", "/oversize")) { "Clipboard fixture URI rejected" }
        return requireNotNull(uri.path)
    }
    override fun getType(uri: Uri) = if (kind(uri) == "/jpg") "image/jpeg" else "image/png"
    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val kind = kind(uri)
        check(mode == "r") { "Clipboard fixture mode rejected" }
        val file = File.createTempFile("owned-clipboard-", ".bin", requireNotNull(context).cacheDir)
        try {
            val bitmap = Bitmap.createBitmap(4, 3, Bitmap.Config.ARGB_8888)
            try { FileOutputStream(file).use { output ->
                check(bitmap.compress(if (kind == "/jpg") Bitmap.CompressFormat.JPEG else Bitmap.CompressFormat.PNG, 90, output))
                if (kind == "/oversize") {
                    val padding = ByteArray(8192)
                    var remaining = 10 * 1024 * 1024 + 1 - file.length().toInt()
                    while (remaining > 0) { val count = minOf(remaining, padding.size); output.write(padding, 0, count); remaining -= count }
                }
            } } finally { bitmap.recycle() }
            val descriptor = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY)
            if (!file.delete()) { descriptor.close(); error("Clipboard fixture file did not retire") }
            return descriptor
        } finally { check(!file.exists() || file.delete()) { "Clipboard fixture cleanup failed" } }
    }
    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? = null
    override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("Clipboard fixture is read only")
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("Clipboard fixture is read only")
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?): Int = throw UnsupportedOperationException("Clipboard fixture is read only")
}
