package app.lazysh.client

import android.Manifest
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
import androidx.test.uiautomator.StaleObjectException
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

/** Bounded awake-background acceptance for the unchanged official Gotify 2.10.1 APK. */
@RunWith(AndroidJUnit4::class)
class GotifyAndroidTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private val context get() = instrumentation.targetContext
    private val device get() = UiDevice.getInstance(instrumentation)
    private val gotify = "com.github.gotify"
    private var deadline = 0L
    private var begun = 0L
    private var gotifyUid = 0
    // Seconds at which each closed phase was entered, so a failing hosted run shows where its time went (see gotifyNativeTimeline).
    private val timeline = StringBuilder()
    private var phase = "admission"
        set(value) {
            field = value
            if (begun != 0L) timeline.append(value).append('=').append((SystemClock.elapsedRealtime() - begun) / 1000).append(' ')
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
        begun = SystemClock.elapsedRealtime()
        deadline = begun + 600_000
        val started = System.currentTimeMillis()
        try {
            check(Build.VERSION.SDK_INT == 36) { "Owned API36 required" }
            phase = "parser-calibration"
            parserChecks()
            phase = "fixture-input"
            input = consume(".json", setOf("schemaVersion", "nonce", "origin", "username", "password", "alias", "applicationId", "gotifyUid"))
            phase = "fixture-identity"
            val origin = input["origin"] as? String ?: error("Invalid origin")
            // The official client reaches the server over a loopback-only plain-HTTP listener; the relay keeps verified HTTPS.
            check(origin.matches(Regex("http://localhost:[1-9][0-9]{0,4}")) && java.net.URI(origin).port in 1..65535)
            check(input["username"] == "admin" && (input["password"] as? String).orEmpty()
                .matches(Regex("[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}")))
            check(input["alias"] == "owned-gotify-${nonce.take(12)}")
            check(integer(input, "applicationId") > 0 && integer(input, "gotifyUid") > 0)
            // The host attests the exact APK/signature and installed UID before instrumentation.
            val uid = integer(input, "gotifyUid")
            gotifyUid = uid
            check(uid / 100000 == android.os.Process.myUid() / 100000)
            phase = "fresh-permission"
            check(!permissionGranted()) { "Fresh Gotify permission state required" }
            phase = "record-calibration"
            recordChecks(uid, started)
            phase = "workspace"
            NativeActivityFixture.scenario
            phase = "login"
            login(origin)
            // The official app starts its service only after its notification permission is granted (its own permission callback runs
            // the sign-in), so the app's "Connected" notification is expected without restarting it.
            phase = "background-home"
            home()
            phase = "background"
            awaitCondition { key(uid, -1) in ownedKeys(uid) }
            phase = "background-connected"
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
            phase = "history-open"
            showCard(states.last()).click()
            awaitCondition { showing(gotify) && device.hasObject(By.res(gotify, "messages_view")) }
            phase = "history"
            for (state in states) node(By.pkg(gotify).text(body(state)))
            stage(4, JSONObject().put("history", true))
        } catch (failure: Throwable) {
            // Never propagate upstream exceptions, credentials, shell output or UI trees to JUnit.
            throw AssertionError("Owned Gotify acceptance failed: $phase\nOwned Gotify timeline: ${timeline.toString().trim()}${screenEvidence()}${causeEvidence(failure)}")
        }
    }

    private fun login(origin: String) {
        // The app asks for this through a platform Settings screen that this lane does not qualify; allow it the way that screen
        // does (a uid-mode change of the app op) before the app asks, so only the app's own behavior is under test.
        phase = "alarm-permission"
        shell("cmd appops set --uid $gotify SCHEDULE_EXACT_ALARM allow")
        phase = "login-launch"
        launchGotify()
        phase = "login-url"
        node(By.res(gotify, "gotify_url_editext")).text = origin
        phase = "login-url-submit"
        node(By.res(gotify, "checkurl")).click()
        // The official app warns about a plain-HTTP address in a modal dialog over the login form; its one button
        // acknowledges the warning (the form is not reachable behind it).
        awaitCondition { device.hasObject(By.res(gotify, "username_editext")) || device.hasObject(By.res("android", "button1").pkg(gotify)) }
        device.findObject(By.res("android", "button1").pkg(gotify))?.click()
        phase = "login-auth-form"
        node(By.res(gotify, "username_editext")).text = input["username"] as String
        node(By.res(gotify, "password_editext")).text = input["password"] as String
        node(By.res(gotify, "login")).click()
        phase = "login-client-name"
        node(By.res(gotify, "client_name_editext")).text = "lazysh-gotify-$nonce"
        node(By.res("android", "button1").pkg(gotify)).click()
        phase = "notification-permission"
        // The system dialog names its button by resource id on stock images and by its label elsewhere; a grant that already
        // happened needs no click.
        val allow = By.res("com.android.permissioncontroller", "permission_allow_button")
        val allowLabel = By.pkg("com.android.permissioncontroller").text(java.util.regex.Pattern.compile("Allow", java.util.regex.Pattern.CASE_INSENSITIVE))
        awaitCondition { device.hasObject(allow) || device.hasObject(allowLabel) || permissionGranted() }
        phase = "notification-permission-grant"
        // A tap can land while the dialog is still being laid out and then does nothing, so it is repeated until the grant shows.
        awaitCondition { (device.findObject(allow) ?: device.findObject(allowLabel))?.click(); permissionGranted() }
        phase = "alarm-permission"
        // The grant above made the app check its alarm permission, which was allowed before the launch: the app's own prompt must
        // not appear. The list view is hidden while the history is empty (the app flips to its "no messages" view), so either ends the wait.
        awaitCondition {
            check(!device.hasObject(By.res("android", "button1").pkg(gotify).text("Grant"))) { "Alarm prompt appeared" }
            device.hasObject(By.res(gotify, "messages_view")) || device.hasObject(emptyHistory())
        }
        // An empty official history is required before the host may publish anything.
        node(emptyHistory())
    }

    private fun emptyHistory() = By.pkg(gotify).text("There are no messages, yet.\nSend a message to Gotify\nand it will appear here.")

    // Started through the shell, as a user's launcher would: after the force-stop the instrumented app has no window in the
    // foreground, and Android only sometimes lets such an app start another app's activity.
    private fun launchGotify() = shell("am start -W -n $gotify/$gotify.init.InitializationActivity")

    // Read through the shell: the app's own PackageManager hides a package that its manifest declares no <queries> for (it lists only
    // UnifiedPush distributor intents), so checkPermission(..., gotify) answers "denied" however the dialog was answered.
    private fun permissionGranted(): Boolean = runtimePermissionGranted(shell("dumpsys package $gotify"), Manifest.permission.POST_NOTIFICATIONS)

    /** True only when the `dumpsys package` runtime-permission section holds exactly one row for [permission] and it is granted. */
    private fun runtimePermissionGranted(dump: String, permission: String): Boolean =
        dump.lines().map { it.trim() }.filter { it.startsWith("$permission: granted=") }.singleOrNull()?.startsWith("$permission: granted=true") == true

    // UiDevice.launcherPackageName resolves the HOME intent through the app's PackageManager, which hides the launcher (see
    // permissionGranted) and answers null, so the launcher is read through the shell.
    private val launcher by lazy { launcherPackage(shell("cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.HOME")) }

    /** The package of the `package/.Activity` line that `resolve-activity --brief` prints last. */
    private fun launcherPackage(output: String): String =
        output.trim().lines().last().substringBefore('/').also { check(it.matches(Regex("[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+"))) { "Unrecognized launcher" } }

    // UiDevice.currentPackageName waits for an active-window root and, while the window has none (a starting app), sleeps in a
    // retry loop that outlasted the runner's test timeout; looking for the package's windows answers at once.
    private fun showing(pkg: String) = device.hasObject(By.pkg(pkg))

    private fun home() {
        check(device.pressHome())
        awaitCondition { showing(launcher) && !showing(gotify) }
    }

    private fun body(state: String) = "${input["alias"]}: $state"

    private fun showCard(state: String): UiObject2 {
        check(showing(launcher))
        check(device.openNotification())
        val target = By.pkg("com.android.systemui").text(body(state))
        var card: UiObject2? = null
        // SystemUI rebuilds the shade while the app's notifications settle, which invalidates nodes read a moment earlier: a stale node
        // only means "look again", while a card that is there but wrong still fails the case.
        awaitCondition {
            try {
                val content = device.findObject(target)
                if (content == null) {
                    // Expand only a Gotify-owned notification row, never an arbitrary shade group.
                    for (group in device.findObjects(By.res("com.android.systemui", "expandableNotificationRow"))) {
                        if (group.hasObject(By.res("android:id/app_name_text").text("Gotify"))) {
                            group.findObject(By.res("android:id/expand_button"))?.click()
                        }
                    }
                    false
                } else {
                    var row: UiObject2? = content
                    var depth = 0
                    while (row != null && row.resourceName != "com.android.systemui:id/expandableNotificationRow" && depth++ < 8) row = row.parent
                    check(row?.hasObject(By.text("lazysh")) == true && showing("com.android.systemui"))
                    check(content.visibleBounds.width() > 0 && content.visibleBounds.height() > 0)
                    card = content
                    true
                }
            } catch (_: StaleObjectException) { false }
        }
        return checkNotNull(card)
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
        // executeShellCommand splits the command on spaces and starts no shell, so a quoted key would reach `cmd` with its quotes.
        return shell("cmd notification get $ownKey")
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

    // Which of a fixed set of packages own a window now, and (TEMPORARY diagnosis) the crash buffer and the app's process
    // lifecycle events, as printable ASCII.
    private fun screenEvidence(): String = try {
        val shown = listOf(gotify, "app.lazysh.client", "com.android.systemui", "com.android.permissioncontroller", "com.android.settings", "android")
            .filter { device.hasObject(By.pkg(it)) } + listOfNotNull("launcher".takeIf { runCatching { device.hasObject(By.pkg(launcher)) }.getOrDefault(false) })
        fun log(command: String, keep: Int) = shell(command, bounded = false).lineSequence().filter { it.isNotBlank() }.toList()
            .takeLast(keep).joinToString("|") { it.trim().take(160) }.replace(Regex("[^A-Za-z0-9 .:_/-]+"), "|").takeLast(2000)
        "\nOwned Gotify windows: ${shown.joinToString(" ")}\nOwned Gotify crash: ${log("logcat -d -b crash -t 30", 30).takeLast(900)}" +
            "\nOwned Gotify boot: ${log("logcat -d -b all -e BOOT_COMPLETED -t 10", 10).takeLast(900)}" +
            "\nOwned Gotify events: ${log("logcat -d -b events -e com.github.gotify -t 40", 40)}" +
            "\nOwned Gotify record: ${record()}" +
            "\nOwned Gotify texts: ${texts()}"
    } catch (_: Throwable) { "" }

    // TEMPORARY diagnosis: the exception class and its first stack frame inside this class, as printable ASCII.
    private fun causeEvidence(failure: Throwable): String {
        val frame = failure.stackTrace.firstOrNull { it.className.startsWith("app.lazysh.client") }
        return "\nOwned Gotify cause: ${(failure.javaClass.simpleName + " " + failure.message.orEmpty().take(100) + " " + frame?.methodName + ":" + frame?.lineNumber)
            .replace(Regex("[^A-Za-z0-9 .:_/-]+"), "|")}"
    }

    // The texts the app's windows show (TEMPORARY diagnosis; the case's own messages and labels, no credential), as printable ASCII.
    private fun texts(): String = runCatching {
        device.findObjects(By.pkg(gotify)).mapNotNull { runCatching { it.text }.getOrNull() }.take(14).joinToString("|") { it.take(70) }
            .replace(Regex("[^A-Za-z0-9 .:_/-]+"), "|").takeLast(1000)
    }.getOrDefault("unavailable")

    // The app's foreground-service record as the failing "Connected" check saw it (TEMPORARY diagnosis).
    private fun record(): String = shell("cmd notification get ${key(gotifyUid, -1)}", bounded = false).lineSequence()
        .filter { "NotificationRecord(" in it || it.trim().startsWith("flags=") || "android.title" in it || "android.text" in it }
        .joinToString("|") { it.trim().take(300) }.replace(Regex("[^A-Za-z0-9 .:_/-]+"), "|").takeLast(1500)

    private fun shell(command: String, bounded: Boolean = true): String {
        check(!bounded || SystemClock.elapsedRealtime() < deadline)
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
        // The app may not create hard links on API 36 (link fails with EACCES), so the closed file is renamed into place: the final
        // name appears complete, with one link, and only when nothing is there yet.
        try { Os.lstat(file.path); error("Published file already exists") } catch (missing: ErrnoException) { check(missing.errno == OsConstants.ENOENT) }
        Os.rename(temporary.path, file.path)
        val published = Os.lstat(file.path)
        check(published.st_ino == identity.st_ino && published.st_dev == identity.st_dev && published.st_nlink == 1L)
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
        check(launcherPackage("priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=true\ncom.android.launcher3/.uioverrides.QuickstepLauncher\n") == "com.android.launcher3")
        check(runCatching { launcherPackage("No activity found") }.isFailure)
        val permission = Manifest.permission.POST_NOTIFICATIONS
        val granted = "    runtime permissions:\n      $permission: granted=true, flags=[ USER_SET]\n      android.permission.CAMERA: granted=false, flags=[ ]"
        check(runtimePermissionGranted(granted, permission))
        for (bad in listOf(
            granted.replace("$permission: granted=true", "$permission: granted=false"),
            granted.replace(permission, "android.permission.POST_NOTIFICATIONS_FAKE"),
            "      android.permission.CAMERA: granted=true, flags=[ ]",
            "",
            granted + "\n      $permission: granted=true, flags=[ ]",
        )) check(!runtimePermissionGranted(bad, permission))
    }

    private fun parserChecks() {
        check(flatJson("{\"step\":0,\"state\":\"done\"}".toByteArray())["step"] == 0)
        for (bad in listOf("{\"step\":0,\"step\":1}", "{\"step\":1.0}", "{\"step\":\"1\"} {}", "{\"step\":true}", "{\"step\":01}")) {
            check(runCatching { flatJson(bad.toByteArray()) }.isFailure)
        }
    }
}
