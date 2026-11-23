package app.lazysh.client

import android.graphics.Bitmap
import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import java.io.ByteArrayOutputStream
import org.json.JSONObject

/**
 * What a case measured, for the job that ran it: logged under `lazysh-evidence` and left as `/data/local/tmp/lazysh-evidence/<name>.json` (and
 * `<name>.png` for a picture), which survives the uninstall Gradle does when the run ends. The host harness reads the files after the run
 * (`tests/support/androidTerminalCore.ts`); the Waydroid lane's runbook reads them with `adb shell cat` and `adb pull`.
 */
internal object Evidence {
    const val DIRECTORY = "/data/local/tmp/lazysh-evidence"

    /** Runs `command` as the shell user (its line is split on spaces, never by a shell), feeds it `stdin` and waits for it to end. */
    private fun shell(command: String, stdin: ByteArray) {
        val (output, input) = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommandRw(command)
        ParcelFileDescriptor.AutoCloseOutputStream(input).use { it.write(stdin) }
        ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes() }
    }

    private fun check(name: String) = require(Regex("[a-z0-9-]{1,40}").matches(name)) { "An evidence name is lowercase words" }

    fun record(name: String, evidence: JSONObject) {
        check(name)
        val json = evidence.toString(2)
        Log.i("lazysh-evidence", "$name $json")
        shell("sh", "mkdir -p $DIRECTORY\ncat > $DIRECTORY/$name.json <<'LAZYSH_EVIDENCE_END'\n$json\nLAZYSH_EVIDENCE_END\n".toByteArray())
    }

    fun recordPicture(name: String, bitmap: Bitmap) {
        check(name)
        val png = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
        shell("sh", "mkdir -p $DIRECTORY\n".toByteArray())
        shell("dd of=$DIRECTORY/$name.png", png)
    }
}
