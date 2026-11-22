package app.lazysh.client

import android.os.ParcelFileDescriptor
import android.util.Log
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONObject

/**
 * What a case measured, for the job that ran it: logged under `lazysh-evidence` and left as `/data/local/tmp/lazysh-evidence/<name>.json`,
 * which survives the uninstall Gradle does when the run ends. The host harness reads the file after the run (`tests/support/androidTerminalCore.ts`);
 * the Waydroid lane's runbook reads it with `adb shell cat`.
 */
internal object Evidence {
    const val DIRECTORY = "/data/local/tmp/lazysh-evidence"

    fun record(name: String, evidence: JSONObject) {
        require(Regex("[a-z0-9-]{1,40}").matches(name)) { "An evidence name is lowercase words" }
        val json = evidence.toString(2)
        Log.i("lazysh-evidence", "$name $json")
        // The shell's own command line is split on spaces, so the file goes in through the stdin of `sh`.
        val (output, input) = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommandRw("sh")
        ParcelFileDescriptor.AutoCloseOutputStream(input).use {
            it.write("mkdir -p $DIRECTORY\ncat > $DIRECTORY/$name.json <<'LAZYSH_EVIDENCE_END'\n$json\nLAZYSH_EVIDENCE_END\n".toByteArray())
        }
        ParcelFileDescriptor.AutoCloseInputStream(output).use { it.readBytes() }
    }
}
