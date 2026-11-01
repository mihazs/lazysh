package app.lazysh.client

import android.app.Activity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import app.tauri.plugin.Channel
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Native view/controller fixture only: no vault proof, OS authentication or provider calls. */
@RunWith(AndroidJUnit4::class)
class NativeResumeCoverTest {
    @Test fun coverRebindsToRecreatedActivityWithoutReusingOldUnlock() {
        val type = Class.forName("app.lazysh.vault.ResumeCover")
        val load = type.getMethod("load", WebView::class.java, Activity::class.java)
        val apply = type.getMethod("apply", Boolean::class.javaPrimitiveType, Boolean::class.javaPrimitiveType,
            Long::class.javaPrimitiveType, Long::class.javaPrimitiveType)
        val events = mutableListOf<Pair<String, Long>>()
        val channel = Channel(0L, { payload ->
            val value = JSONObject(payload)
            events.add(value.getString("kind") to value.getLong("nativeGeneration"))
        }, ObjectMapper())
        var controller: Any? = null
        var original: Activity? = null
        // Use the existing fixture: closing Tauri's last Activity would terminate AndroidJUnitRunner.
        run { val scenario = NativeActivityFixture.scenario
            scenario.onActivity { activity ->
                original = activity
                val blank = WebView(activity)
                activity.findViewById<ViewGroup>(android.R.id.content).addView(blank)
                val cover = type.getConstructor(Activity::class.java).newInstance(activity)
                controller = cover
                fun coverView(name: String) = type.getDeclaredField(name).apply { isAccessible = true }.get(cover) as View
                load.invoke(cover, blank, activity)
                type.getMethod("register", Channel::class.java).invoke(cover, channel)
                assertEquals(View.INVISIBLE, blank.visibility)
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertEquals("Startup remains branded until native policy is known", View.VISIBLE, coverView("logo").visibility)
                assertEquals(View.GONE, coverView("unlock").visibility)
                assertEquals(View.GONE, coverView("title").visibility)
                // A native-ready notification is not a renderer-commit reveal.
                type.getMethod("register", Channel::class.java).invoke(cover, channel)
                type.getMethod("resume").invoke(cover)
                assertTrue(events.count { it.first == "ready" } >= 2)
                assertEquals(View.VISIBLE, coverView("logo").visibility)
                assertEquals(View.GONE, coverView("unlock").visibility)
                assertEquals(View.INVISIBLE, blank.visibility)
                assertFalse(blank.isEnabled)
                assertEquals("A disabled-policy reveal still needs the current native generation",
                    false, apply.invoke(cover, false, false, 1L, 1L))
                assertEquals(View.VISIBLE, coverView("logo").visibility)
                assertEquals(View.GONE, coverView("unlock").visibility)
                assertEquals(View.INVISIBLE, blank.visibility)
                assertEquals(true, apply.invoke(cover, true, true, 1L, 0L))
                assertEquals(View.INVISIBLE, blank.visibility)
                assertEquals(View.GONE, coverView("logo").visibility)
                assertEquals("A confirmed lock must retain its unlock action", View.VISIBLE, coverView("unlock").visibility)
                assertEquals(true, apply.invoke(cover, false, true, 2L, 0L))
                assertEquals(View.VISIBLE, blank.visibility)
                assertTrue("Enabled policy must retain secure-window protection while unlocked",
                    activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                (blank.parent as? ViewGroup)?.removeView(blank)
            }
            scenario.recreate()
            scenario.onActivity { activity ->
                assertNotSame(original, activity)
                val blank = WebView(activity)
                activity.findViewById<ViewGroup>(android.R.id.content).addView(blank)
                val cover = requireNotNull(controller)
                load.invoke(cover, blank, activity)
                assertEquals(View.INVISIBLE, blank.visibility)
                assertTrue(events.contains("rebind" to 1L))
                assertTrue(events.contains("ready" to 1L))
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertEquals(false, apply.invoke(cover, false, true, 2L, 0L))
                assertEquals(View.INVISIBLE, blank.visibility)
                val logo = type.getDeclaredField("logo").apply { isAccessible = true }.get(cover) as View
                val unlock = type.getDeclaredField("unlock").apply { isAccessible = true }.get(cover) as View
                assertEquals(View.VISIBLE, logo.visibility)
                assertEquals("Stale unlock must not flash an interactive cover", View.GONE, unlock.visibility)
                assertEquals(true, apply.invoke(cover, true, true, 3L, 1L))
                assertEquals(true, apply.invoke(cover, false, true, 4L, 1L))
                assertEquals(View.VISIBLE, blank.visibility)
                assertTrue(activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE != 0)
                assertEquals(true, apply.invoke(cover, false, false, 5L, 1L))
                assertTrue("Disabling policy restores normal screenshot behavior",
                    activity.window.attributes.flags and WindowManager.LayoutParams.FLAG_SECURE == 0)
                (blank.parent as? ViewGroup)?.removeView(blank)
                val overlay = type.getDeclaredField("overlay").apply { isAccessible = true }.get(cover) as? View
                (overlay?.parent as? ViewGroup)?.removeView(overlay)
            }
        }
    }
}
