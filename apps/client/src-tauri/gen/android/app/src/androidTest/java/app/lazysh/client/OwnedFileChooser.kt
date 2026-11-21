package app.lazysh.client

import android.app.Instrumentation
import android.content.ContentValues
import android.content.pm.ApplicationInfo
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Xml
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.util.concurrent.TimeUnit
import java.util.regex.Pattern
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.xmlpull.v1.XmlPullParser

/**
 * Drives the real system file picker (DocumentsUI, opened through Wry's `onShowFileChooser`) with UiAutomator.
 *
 * The owned fixture is published to the device's image collection under a unique name and found in the picker by that
 * visible name, never by a resource id: the picker packages (AOSP and Google builds) and releases differ in ids, and the
 * name is the one thing the owner of the fixture controls. A grid entry exposes it as a content description that starts
 * with the name, a list entry as the title text. The picker reopens in the last folder it showed, so when the entry is not
 * in the first view the helper opens the roots drawer and the newest-first "Recent" root, where a just-published image is
 * listed whatever its folder. Nothing here injects a result into the page.
 */
internal object OwnedFileChooser {
    private val shell = setOf("android", "com.android.systemui")
    private const val OUTLINE_NODES = 160
    private const val OUTLINE_CHARS = 8_192

    /** Publishes the bundled fixture as an image owned by the test package; [unstage] removes it again. */
    fun stage(instrumentation: Instrumentation, asset: String, name: String): Uri {
        assertTrue("Staging a picker fixture requires scoped MediaStore (API 29)", Build.VERSION.SDK_INT >= 29)
        val resolver = instrumentation.context.contentResolver
        val collection = MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
        val uri = requireNotNull(resolver.insert(collection, ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, "image/png")
            put(MediaStore.MediaColumns.RELATIVE_PATH, "Pictures/lazysh-owned")
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        })) { "MediaStore refused the picker fixture" }
        try {
            instrumentation.context.assets.open(asset).use { input ->
                requireNotNull(resolver.openOutputStream(uri, "w")) { "MediaStore gave no stream for the picker fixture" }.use { input.copyTo(it) }
            }
            resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        } catch (failure: Throwable) {
            resolver.delete(uri, null, null)
            throw failure
        }
        return uri
    }

    fun unstage(instrumentation: Instrumentation, uri: Uri) {
        instrumentation.context.contentResolver.delete(uri, null, null)
    }

    /** True while a window that is neither the app, the test package nor the system shell is in front. */
    fun pickerOpen(instrumentation: Instrumentation): Boolean = pickerPackage(instrumentation) != null

    private fun pickerPackage(instrumentation: Instrumentation): String? {
        val current = UiDevice.getInstance(instrumentation).currentPackageName
        return current?.takeIf { it != instrumentation.targetContext.packageName && it != instrumentation.context.packageName && it !in shell }
    }

    /** Presses Back until the picker is gone (a picker closes an open drawer or folder first), so the app is in front again. */
    fun dismiss(instrumentation: Instrumentation) {
        val device = UiDevice.getInstance(instrumentation)
        repeat(4) {
            if (!pickerOpen(instrumentation)) return
            device.pressBack()
            device.waitForIdle(1_000)
        }
        assertTrue("The file picker must close", !pickerOpen(instrumentation))
    }

    /**
     * Waits for the system picker the app just opened, selects the entry named [name] and waits for the picker to close.
     * Any failure carries [outline] of the picker as it was, which is the diagnostic for calibrating the selectors.
     */
    fun choose(instrumentation: Instrumentation, name: String, budgetMillis: Long = 30_000) {
        val device = UiDevice.getInstance(instrumentation)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(budgetMillis)
        var picker: String? = null
        while (picker == null && System.nanoTime() < deadline) {
            picker = pickerPackage(instrumentation)
            if (picker == null) Thread.sleep(100)
        }
        if (picker == null) throw AssertionError("The app's file input opened no picker window; foreground=${device.currentPackageName}")
        try {
            val info = instrumentation.targetContext.packageManager.getApplicationInfo(picker, 0)
            assertTrue("The file picker must be a system application: $picker", info.flags and ApplicationInfo.FLAG_SYSTEM != 0)
            // API 33+ answers an image/* input with the Photo Picker, which names no file: it lists media newest first, and the
            // fixture was published moments ago, so its first tile is the fixture (the page then proves the decoded content).
            val photoGrid = By.pkg(picker).res(picker, "picker_tab_recyclerview")
            if (device.wait(Until.hasObject(photoGrid), 3_000)) {
                val tile = device.wait(Until.findObject(By.pkg(picker).clickable(true).hasAncestor(photoGrid)), 10_000)
                    ?: throw AssertionError("The Photo Picker lists no image")
                tile.click()
                assertTrue("The picker must close after the entry is chosen", device.wait(Until.gone(By.pkg(picker)), 10_000))
                return
            }
            val entry = By.pkg(picker).desc(Pattern.compile(Pattern.quote(name) + ", .*"))
            val title = By.pkg(picker).text(name)
            fun entries(untilNanos: Long): List<UiObject2> {
                var found = device.findObjects(entry) + device.findObjects(title)
                while (found.isEmpty() && System.nanoTime() < untilNanos) {
                    Thread.sleep(250)
                    found = device.findObjects(entry) + device.findObjects(title)
                }
                return found
            }
            var found = entries(minOf(deadline, System.nanoTime() + TimeUnit.SECONDS.toNanos(3)))
            if (found.isEmpty()) {
                // Not in the folder the picker reopened in. The drawer button is absent when the roots are already on screen.
                device.findObject(By.pkg(picker).desc("Show roots"))?.click()
                val recent = device.wait(Until.findObject(By.pkg(picker).res("android", "title").text("Recent")), 5_000)
                    ?: throw AssertionError("The picker has no Recent root to list the new fixture")
                recent.click()
                found = entries(deadline)
            }
            assertEquals("The picker must list exactly one entry named like the fixture", 1, found.size)
            found.single().click()
            assertTrue("The picker must close after the entry is chosen", device.wait(Until.gone(By.pkg(picker)), 10_000))
        } catch (failure: Throwable) {
            // The picker may still be open, so describe it before anyone presses Back; a missing outline never hides the failure.
            failure.addSuppressed(AssertionError("Picker $picker outline: ${outline(device, name)}"))
            throw failure
        }
    }

    /**
     * The picker's accessibility tree: class, resource id, clickable flag and each label cut to 24 characters, with the owned
     * fixture name shown as `<fixture>`. Only an owned emulator reaches this, and only inside a failure report.
     */
    fun outline(device: UiDevice, name: String): String = try {
        val xml = ByteArrayOutputStream().also { device.dumpWindowHierarchy(it) }.toByteArray()
        val parser = Xml.newPullParser().apply { setInput(ByteArrayInputStream(xml), "UTF-8") }
        fun label(value: String?) = when {
            value.isNullOrEmpty() -> "-"
            value.startsWith(name) -> "<fixture>"
            else -> "'${value.take(24)}'"
        }
        val rows = mutableListOf<String>()
        var event = parser.eventType
        while (event != XmlPullParser.END_DOCUMENT && rows.size < OUTLINE_NODES) {
            if (event == XmlPullParser.START_TAG && parser.name == "node") {
                fun attribute(key: String) = parser.getAttributeValue(null, key)
                val id = attribute("resource-id")?.substringAfter(":id/", "")?.ifEmpty { "-" } ?: "-"
                rows.add("${attribute("class")?.substringAfterLast('.')} id=$id click=${attribute("clickable")} text=${label(attribute("text"))} desc=${label(attribute("content-desc"))}")
            }
            event = parser.next()
        }
        rows.joinToString("; ").take(OUTLINE_CHARS)
    } catch (failure: Throwable) {
        "unavailable (${failure.javaClass.simpleName})"
    }
}
