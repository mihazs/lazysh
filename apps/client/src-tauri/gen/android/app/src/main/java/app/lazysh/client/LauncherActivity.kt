package app.lazysh.client

import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import android.os.Bundle

/**
 * Launcher icon aliases target this trampoline. MainActivity's task therefore always has an
 * explicit MainActivity base intent, and disabling the previous icon alias cannot remove it.
 * The incoming launcher intent is never forwarded: no data, extras or selector reach the app.
 */
class LauncherActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val workspace = Intent(this, MainActivity::class.java)
        val running = getSystemService(ActivityManager::class.java)?.appTasks?.firstOrNull { task ->
            runCatching { task.taskInfo?.baseIntent?.component == workspace.component }.getOrDefault(false)
        }
        // Bring the existing workspace forward unchanged, as a launcher tap did before aliases.
        if (running == null || runCatching { running.moveToFront() }.isFailure) {
            startActivity(workspace.setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
        finish()
    }
}
