package app.lazysh.client

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.webkit.MimeTypeMap
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin as MobilePlugin
import java.io.File

/**
 * Hands a host file that Rust already staged in the app cache to Android: saved through the system
 * document picker (which asks before replacing a file), opened or shared as a read-only content URI of
 * the manifest's FileProvider. The file is never executed and no other path is reachable.
 */
internal object FileExchange {
    /** The staged copy, only when it really is a regular file inside this app's cache. */
    fun staged(context: Context, path: String): File {
        val file = File(path).canonicalFile
        val cache = context.cacheDir.canonicalPath + File.separator
        require(file.isFile && file.path.startsWith(cache)) { "That file is not a downloaded copy." }
        return file
    }
    fun mime(name: String): String =
        MimeTypeMap.getSingleton().getMimeTypeFromExtension(name.substringAfterLast('.', "").lowercase())
            ?: "application/octet-stream"
    fun uri(context: Context, file: File): Uri =
        FileProvider.getUriForFile(context, context.packageName + ".fileprovider", file)
    fun view(context: Context, file: File, name: String): Intent =
        Intent(Intent.ACTION_VIEW).setDataAndType(uri(context, file), mime(name))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    fun send(context: Context, file: File, name: String): Intent =
        Intent(Intent.ACTION_SEND).setType(mime(name)).putExtra(Intent.EXTRA_STREAM, uri(context, file))
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
    fun create(name: String): Intent =
        Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(mime(name))
            .putExtra(Intent.EXTRA_TITLE, name)
    /** Writes the staged bytes to the document the user chose, replacing nothing else. */
    fun copy(context: Context, file: File, destination: Uri) {
        val out = context.contentResolver.openOutputStream(destination, "w") ?: throw IllegalStateException("Android could not open the chosen file.")
        out.use { stream -> file.inputStream().use { it.copyTo(stream) } }
    }
}

/** Save, open and share commands for the Rust file_transfer module; renderer calls are refused in Rust. */
@TauriPlugin
class FileExchangePlugin(private val owner: Activity) : MobilePlugin(owner) {
    private fun request(invoke: Invoke): Pair<File, String>? = try {
        val args = invoke.getArgs()
        val name = args.getString("name")
        val path = args.getString("path")
        if (name.isNullOrEmpty() || path.isNullOrEmpty()) null else FileExchange.staged(owner, path) to name
    } catch (_: Exception) { null }

    private fun launch(invoke: Invoke, build: (File, String) -> Intent) = owner.runOnUiThread {
        val (file, name) = request(invoke) ?: run { invoke.reject("That file is not available any more. Download it again."); return@runOnUiThread }
        try {
            owner.startActivity(Intent.createChooser(build(file, name), name))
            invoke.resolve(JSObject())
        } catch (_: ActivityNotFoundException) {
            invoke.reject("No app on this device can open this file. Download it instead.")
        } catch (_: Exception) {
            invoke.reject("Android could not complete this action.")
        }
    }

    @Command fun open(invoke: Invoke) = launch(invoke) { file, name -> FileExchange.view(owner, file, name) }
    @Command fun share(invoke: Invoke) = launch(invoke) { file, name -> FileExchange.send(owner, file, name) }

    @Command fun save(invoke: Invoke) = owner.runOnUiThread {
        val (_, name) = request(invoke) ?: run { invoke.reject("That file is not available any more. Download it again."); return@runOnUiThread }
        try { startActivityForResult(invoke, FileExchange.create(name), "saved") }
        catch (_: Exception) { invoke.reject("Android could not open its file picker.") }
    }

    @ActivityCallback
    fun saved(invoke: Invoke, result: ActivityResult) {
        val destination = result.data?.data
        if (result.resultCode != Activity.RESULT_OK || destination == null) { invoke.reject("exchange_cancelled"); return }
        val (file, name) = request(invoke) ?: run { invoke.reject("That file is not available any more. Download it again."); return }
        Thread {
            try {
                FileExchange.copy(owner, file, destination)
                invoke.resolve(JSObject().put("location", name))
            } catch (_: Exception) { invoke.reject("Android could not write the file you chose.") }
        }.start()
    }
}
