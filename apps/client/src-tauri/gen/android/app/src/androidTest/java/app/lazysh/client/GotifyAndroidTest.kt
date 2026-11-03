package app.lazysh.client

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.SystemClock
import android.os.ParcelFileDescriptor
import android.system.ErrnoException
import android.system.Os
import android.system.OsConstants
import android.util.JsonReader
import android.util.JsonToken
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import org.json.JSONObject
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.StringReader
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.regex.Pattern

/** Bounded awake-background acceptance for the unchanged official Gotify 2.10.1 APK. */
@RunWith(AndroidJUnit4::class)
class GotifyAndroidTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val device get() = UiDevice.getInstance(instrumentation)
    private val gotify = "com.github.gotify"
    private var deadline = 0L
    private var phase = "admission"
        set(value) {
            field = value
            if (::nonce.isInitialized) {
                try { publish(".phase-$value", JSONObject().put("phase", value)) }
                catch (_: Exception) { /* Optional evidence cannot replace the acceptance result. */ }
            }
        }
    private lateinit var nonce: String
    private lateinit var input: Map<String, Any>
    private val states = listOf("working", "needs_attention", "done")

    @Test fun notificationRecordCalibrationRejectsForeignAndStaleEntries() {
        nonce = "0".repeat(32)
        input = mapOf("applicationId" to 1)
        recordChecks(10001, System.currentTimeMillis())
    }

    @Test fun ownedOfficialGotifyDisplaysFiniteEventsWhileBackgrounded() {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue("Owned official Gotify acceptance only", args.getString("lazyshGotifyAcceptance") == "true")
        nonce = args.getString("lazyshGotifyNonce").orEmpty()
        check(nonce.matches(Regex("[a-f0-9]{32}"))) { "Invalid Gotify fixture nonce" }
        deadline = SystemClock.elapsedRealtime() + 180_000
        val started = System.currentTimeMillis()
        try {
            check(Build.VERSION.SDK_INT == 36) { "Owned API36 required" }
            phase = "parser-calibration"
            parserChecks()
            phase = "fixture-input"
            input = consume(".json", setOf("schemaVersion", "nonce", "origin", "username", "password", "caName", "alias", "applicationId", "gotifyUid"))
            phase = "fixture-identity"
            val origin = input["origin"] as? String ?: error("Invalid origin")
            check(origin.matches(Regex("https://localhost:[1-9][0-9]{0,4}")) && java.net.URI(origin).port in 1..65535)
            check(input["username"] == "admin" && (input["password"] as? String).orEmpty()
                .matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")))
            check(input["caName"] == "lazysh-gotify-$nonce.crt" && input["alias"] == "owned-gotify-${nonce.take(12)}")
            check(integer(input, "applicationId") > 0 && integer(input, "gotifyUid") > 0)
            // The host attests the exact APK/signature and installed UID before instrumentation.
            val uid = integer(input, "gotifyUid")
            check(uid / 100000 == android.os.Process.myUid() / 100000)
            phase = "fresh-permission"
            check(!permissionGranted()) { "Fresh Gotify permission state required" }
            phase = "record-calibration"
            recordChecks(uid, started)
            phase = "workspace"
            NativeActivityFixture.scenario
            phase = "login"
            login(origin)
            phase = "background"
            home()
            awaitCondition { foregroundConnected(uid) }
            val baseline = ownedKeys(uid).toSet()
            stage(0, JSONObject().put("background", true))
            val seen = mutableSetOf<Int>()
            states.forEachIndexed { index, state ->
                phase = "message-$index"
                val message = consume(".message-$index.json", setOf("schemaVersion", "nonce", "step", "messageId", "state", "priority"))
                check(message["step"] == index && message["state"] == state && message["priority"] == if (index == 1) 5 else 2)
                val id = integer(message, "messageId")
                check(id > 0 && seen.add(id))
                val key = key(uid, id)
                check(key !in baseline)
                awaitCondition { key in ownedKeys(uid) }
                val dump = notification(key)
                check(record(dump, key, uid, id, state, started)) { "Owned message record rejected" }
                showCard(state)
                home()
                stage(index + 1, JSONObject().put("messageId", id).put("state", state)
                    .put("osRecord", true).put("visibleCard", true).put("background", true))
            }
            phase = "history"
            showCard(states.last()).click()
            awaitCondition { device.currentPackageName == gotify && device.hasObject(By.res(gotify, "messages_view")) }
            for (state in states) node(By.pkg(gotify).text(body(state)))
            stage(4, JSONObject().put("history", true))
        } catch (_: Throwable) {
            // Never propagate upstream exceptions, credentials, shell output or UI trees to JUnit.
            throw AssertionError("Owned Gotify acceptance failed: $phase")
        }
    }

    private fun login(origin: String) {
        phase = "login-launch"
        context.startActivity(Intent().setComponent(ComponentName(gotify, "$gotify.init.InitializationActivity"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        phase = "login-url"
        node(By.res(gotify, "gotify_url_editext")).text = origin
        phase = "login-advanced"
        node(By.res(gotify, "advanced_settings")).click()
        check(!node(By.res(gotify, "disableSSL")).isChecked)
        phase = "login-ca-picker"
        node(By.res(gotify, "toggle_ca_cert")).click()
        val documents = Pattern.compile("com\\.(android|google\\.android)\\.documentsui")
        awaitCondition { device.hasObject(By.pkg(documents)) }
        phase = "login-ca-import"
        val filename = input["caName"] as String
        if (!device.hasObject(By.pkg(documents).text(filename))) {
            phase = "login-ca-roots"
            node(By.pkg(documents).desc("Show roots")).click()
            node(By.pkg(documents).text("Downloads")).click()
        }
        phase = "login-ca-select"
        node(By.pkg(documents).text(filename)).click()
        phase = "login-ca-callback"
        awaitCondition { device.hasObject(By.res(gotify, "toggle_ca_cert").text("Remove CA Certificate")) }
        phase = "login-ca-confirm"
        check(!node(By.res(gotify, "disableSSL")).isChecked)
        node(By.res("android", "button1").pkg(gotify)).click()
        phase = "login-url-submit"
        node(By.res(gotify, "checkurl")).click()
        phase = "login-auth-form"
        node(By.res(gotify, "username_editext")).text = input["username"] as String
        node(By.res(gotify, "password_editext")).text = input["password"] as String
        node(By.res(gotify, "login")).click()
        phase = "login-client-name"
        node(By.res(gotify, "client_name_editext")).text = "lazysh-gotify-$nonce"
        node(By.res("android", "button1").pkg(gotify)).click()
        phase = "notification-permission"
        node(By.res("com.android.permissioncontroller", "permission_allow_button")).click()
        awaitCondition { permissionGranted() }
        phase = "alarm-permission"
        awaitCondition {
            if (device.hasObject(By.res(gotify, "messages_view"))) true
            else {
                val grant = device.findObject(By.res("android", "button1").pkg(gotify).text("Grant"))
                if (grant != null) {
                    check(device.hasObject(By.pkg(gotify).text("Gotify requires permission to schedule reconnecting after connection is lost.")))
                    grant.click()
                    node(By.pkg("com.android.settings").text("Allow setting alarms and reminders"))
                    node(By.pkg("com.android.settings").text("Gotify"))
                    val toggle = node(By.pkg("com.android.settings").res("android:id/switch_widget"))
                    check(!toggle.isChecked)
                    toggle.click()
                    check(node(By.pkg("com.android.settings").res("android:id/switch_widget")).isChecked)
                    device.pressBack()
                }
                false
            }
        }
        // An empty official history is required before the host may publish anything.
        node(By.pkg(gotify).text("There are no messages, yet.\nSend a message to Gotify\nand it will appear here."))
    }

    private fun permissionGranted(): Boolean = context.packageManager.checkPermission(Manifest.permission.POST_NOTIFICATIONS, gotify) == PackageManager.PERMISSION_GRANTED

    private fun home() {
        check(device.pressHome())
        awaitCondition { device.currentPackageName == device.launcherPackageName && device.currentPackageName != gotify }
    }

    private fun body(state: String) = "${input["alias"]}: $state"

    private fun showCard(state: String): UiObject2 {
        check(device.currentPackageName == device.launcherPackageName)
        check(device.openNotification())
        val target = By.pkg("com.android.systemui").text(body(state))
        awaitCondition {
            if (device.hasObject(target)) true
            else {
                // Expand only a Gotify-owned notification row, never an arbitrary shade group.
                val groups = device.findObjects(By.res("com.android.systemui", "expandableNotificationRow"))
                for (group in groups) {
                    if (group.hasObject(By.res("android:id/app_name_text").text("Gotify"))) {
                        group.findObject(By.res("android:id/expand_button"))?.click()
                    }
                }
                false
            }
        }
        val content = node(target)
        var row: UiObject2? = content
        var depth = 0
        while (row != null && row.resourceName != "com.android.systemui:id/expandableNotificationRow" && depth++ < 8) row = row.parent
        check(row?.hasObject(By.text("lazysh")) == true && device.currentPackageName == "com.android.systemui")
        check(content.visibleBounds.width() > 0 && content.visibleBounds.height() > 0)
        return content
    }

    private fun key(uid: Int, id: Int) = "${uid / 100000}|$gotify|$id|null|$uid"

    private fun ownedKeys(uid: Int): List<String> {
        val pattern = Regex("${uid / 100000}\\|com\\.github\\.gotify\\|-?[0-9]+\\|null\\|$uid")
        val selected = shell("cmd notification list").lineSequence().filter { pattern.matches(it) }.toList()
        check(selected.size == selected.toSet().size)
        return selected
    }

    private fun foregroundConnected(uid: Int): Boolean {
        val ownKey = key(uid, -1)
        if (ownKey !in ownedKeys(uid)) return false
        val lines = notification(ownKey).lines()
        return lines.firstOrNull()?.contains("pkg=$gotify user=UserHandle{${uid / 100000}} id=-1 tag=null ") == true &&
            lines.count { it == "  uid=$uid userId=${uid / 100000}" } == 1 &&
            lines.count { it == "  opPkg=$gotify" } == 1 &&
            lines.count { it == "  key=$ownKey" } == 1 &&
            lines.any { it.startsWith("  flags=") && "FOREGROUND_SERVICE" in it } &&
            lines.count { it == "        android.title=String (Connected)" } == 1 &&
            "Notification(channel=gotify_foreground " in lines.first()
    }

    private fun notification(ownKey: String): String {
        check(ownKey.matches(Regex("[0-9]+\\|com\\.github\\.gotify\\|-?[0-9]+\\|null\\|[0-9]+")))
        return shell("cmd notification get '$ownKey'")
    }

    // AOSP android16-release NotificationRecord.dump(false) and Notification.toString().
    private fun record(dump: String, ownKey: String, uid: Int, id: Int, state: String, started: Long): Boolean {
        val lines = dump.lines()
        val header = lines.firstOrNull() ?: return false
        val channel = "gotify_messages_${if (state == "needs_attention") "default" else "low"}_importance"
        val importance = if (state == "needs_attention") 3 else 2
        val headerPattern = Regex("NotificationRecord\\(0x[0-9a-f]{8}: pkg=com\\.github\\.gotify user=UserHandle\\{${uid / 100000}\\} id=$id tag=null importance=$importance key=${Regex.escape(ownKey)}: Notification\\(channel=(?:${integer(input, "applicationId")}::)?$channel .+\\)\\)")
        fun unique(line: String) = lines.count { it == line } == 1
        val flags = lines.filter { it.startsWith("  flags=") }.singleOrNull() ?: return false
        val created = lines.filter { it.startsWith("  mCreationTimeMs=") }.singleOrNull()?.substringAfter('=')?.toLongOrNull() ?: return false
        val effective = lines.filter { it.startsWith("  effectiveNotificationChannel=NotificationChannel{") }.singleOrNull() ?: return false
        val channelMatch = Regex("mId='((?:${integer(input, "applicationId")}::)?$channel)'").findAll(effective).toList()
        return headerPattern.matches(header) && lines.count { it.startsWith("NotificationRecord(") } == 1 &&
            unique("  uid=$uid userId=${uid / 100000}") && unique("  opPkg=$gotify") && unique("  key=$ownKey") &&
            flags.removePrefix("  flags=").split('|').let { value ->
                "AUTO_CANCEL" in value && value.all { it in setOf("AUTO_CANCEL", "SHOW_LIGHTS", "CAN_COLORIZE") }
            } &&
            unique("        android.title=String (lazysh)") && unique("        android.text=String (${body(state)})") &&
            created in started..System.currentTimeMillis() && channelMatch.size == 1 &&
            Regex("(?:^|, )mImportance=$importance(?:,|\\})").containsMatchIn(effective.substringAfter('{')) &&
            unique("  mHidden==false") && unique("  mIntercept=false")
    }

    private fun shell(command: String): String {
        check(SystemClock.elapsedRealtime() < deadline)
        return ParcelFileDescriptor.AutoCloseInputStream(instrumentation.uiAutomation.executeShellCommand(command)).use { stream ->
            val bytes = stream.readNBytes(131073)
            check(bytes.size <= 131072)
            bytes.toString(Charsets.UTF_8)
        }
    }

    private fun node(selector: BySelector): UiObject2 {
        var result: UiObject2? = null
        awaitCondition { result = device.findObject(selector); result != null }
        return checkNotNull(result)
    }

    private fun awaitCondition(condition: () -> Boolean) {
        while (SystemClock.elapsedRealtime() < deadline) {
            if (condition()) return
            SystemClock.sleep(100)
        }
        error("Gotify deadline expired")
    }

    private fun integer(data: Map<String, Any>, field: String) = data[field] as? Int ?: error("Invalid finite integer")

    private fun flatJson(bytes: ByteArray): Map<String, Any> {
        val decoded = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
            .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
        val result = mutableMapOf<String, Any>()
        JsonReader(StringReader(decoded)).use { reader ->
            reader.isLenient = false
            reader.beginObject()
            while (reader.hasNext()) {
                val name = reader.nextName()
                check(name !in result)
                result[name] = when (reader.peek()) {
                    JsonToken.STRING -> reader.nextString()
                    JsonToken.NUMBER -> reader.nextString().also { check(it.matches(Regex("0|[1-9][0-9]*"))) }.toInt()
                    else -> error("Invalid finite JSON value")
                }
            }
            reader.endObject()
            check(reader.peek() == JsonToken.END_DOCUMENT)
        }
        return result
    }

    private fun consume(suffix: String, fields: Set<String>): Map<String, Any> {
        val file = File(context.filesDir, ".lazysh-gotify-$nonce$suffix")
        var descriptor: java.io.FileDescriptor? = null
        awaitCondition {
            try {
                val candidate = Os.open(file.path, OsConstants.O_RDONLY or OsConstants.O_NOFOLLOW or OsConstants.O_NONBLOCK, 0)
                val stat = Os.fstat(candidate)
                if (suffix.startsWith(".message-") && stat.st_nlink == 2L) {
                    try {
                        check(OsConstants.S_ISREG(stat.st_mode) && stat.st_uid == android.os.Process.myUid() &&
                            (stat.st_mode and 0x1ff) == 0x180 && stat.st_size in 1L..8192L)
                        false
                    } finally { Os.close(candidate) }
                } else {
                    descriptor = candidate
                    true
                }
            } catch (error: ErrnoException) {
                if (error.errno != OsConstants.ENOENT) throw error
                false
            }
        }
        val fd = checkNotNull(descriptor)
        val bytes = FileInputStream(fd).use { stream ->
            val stat = Os.fstat(fd)
            check(OsConstants.S_ISREG(stat.st_mode) && stat.st_uid == android.os.Process.myUid() && stat.st_nlink == 1L &&
                (stat.st_mode and 0x1ff) == 0x180 && stat.st_size in 1L..8192L)
            stream.readNBytes(8193).also {
                check(it.size.toLong() == stat.st_size)
                val current = Os.lstat(file.path)
                check(current.st_dev == stat.st_dev && current.st_ino == stat.st_ino && current.st_nlink == 1L &&
                    current.st_mode == stat.st_mode && current.st_uid == stat.st_uid && current.st_size == stat.st_size)
                Os.remove(file.path)
            }
        }
        return try {
            flatJson(bytes).also { check(it.keys == fields && it["schemaVersion"] == 1 && it["nonce"] == nonce) }
        } finally { bytes.fill(0) }
    }

    private fun stage(step: Int, details: JSONObject) {
        check(SystemClock.elapsedRealtime() < deadline)
        publish(".stage-$step", details.put("step", step))
    }

    private fun publish(suffix: String, details: JSONObject) {
        val file = File(context.filesDir, ".lazysh-gotify-$nonce$suffix.json")
        val proof = details.put("schemaVersion", 1).put("nonce", nonce).toString().toByteArray(Charsets.UTF_8)
        val temporary = File(context.filesDir, ".lazysh-gotify-$nonce$suffix.tmp")
        val fd = Os.open(temporary.path, OsConstants.O_WRONLY or OsConstants.O_CREAT or OsConstants.O_EXCL or OsConstants.O_NOFOLLOW, 0x180)
        val identity = Os.fstat(fd)
        FileOutputStream(fd).use { stream -> stream.write(proof); stream.fd.sync() }
        // link is exclusive; the host waits for nlink=1 before reading the immutable complete proof.
        Os.link(temporary.path, file.path)
        val published = Os.lstat(file.path)
        check(published.st_ino == identity.st_ino && published.st_dev == identity.st_dev && published.st_nlink == 2L)
        Os.remove(temporary.path)
        check(Os.lstat(file.path).st_nlink == 1L)
    }

    private fun recordChecks(uid: Int, started: Long) {
        val ownKey = key(uid, 17)
        val sample = """NotificationRecord(0x01234567: pkg=com.github.gotify user=UserHandle{${uid / 100000}} id=17 tag=null importance=2 key=$ownKey: Notification(channel=gotify_messages_low_importance shortcut=null flags=AUTO_CANCEL))
  uid=$uid userId=${uid / 100000}
  opPkg=com.github.gotify
  key=$ownKey
  flags=AUTO_CANCEL
        android.title=String (lazysh)
        android.text=String (${body("working")})
  mCreationTimeMs=$started
  effectiveNotificationChannel=NotificationChannel{mId='gotify_messages_low_importance', mImportance=2}
  mHidden==false
  mIntercept=false"""
        check(record(sample, ownKey, uid, 17, "working", started))
        for (bad in listOf(
            sample.replace("flags=AUTO_CANCEL", "flags=AUTO_CANCEL|GROUP_SUMMARY"),
            sample.replace("flags=AUTO_CANCEL", "flags=AUTO_CANCEL|FOREGROUND_SERVICE"),
            sample.replace("mCreationTimeMs=$started", "mCreationTimeMs=1"),
            sample.replace("android.text=String", "android.text=Unknown"),
            sample.replace("  uid=$uid", "  uid=0"),
            sample + "\n  key=$ownKey",
        )) check(!record(bad, ownKey, uid, 17, "working", started))
    }

    private fun parserChecks() {
        check(flatJson("{\"step\":0,\"state\":\"done\"}".toByteArray())["step"] == 0)
        for (bad in listOf("{\"step\":0,\"step\":1}", "{\"step\":1.0}", "{\"step\":\"1\"} {}", "{\"step\":true}", "{\"step\":01}")) {
            check(runCatching { flatJson(bad.toByteArray()) }.isFailure)
        }
    }
}
