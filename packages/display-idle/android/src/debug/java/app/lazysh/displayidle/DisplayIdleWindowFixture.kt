package app.lazysh.displayidle

import android.app.Activity
import android.os.Looper
import android.view.WindowManager

/** Called by an Android instrumentation host on its resumed Activity's UI thread. */
object DisplayIdleWindowFixture {
    fun verify(activity: Activity) {
        check(Looper.myLooper() == Looper.getMainLooper())
        val bit = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        val previous = activity.window.attributes.flags and bit != 0
        val state = DisplayIdleState({ enabled ->
            if (enabled) activity.window.addFlags(bit) else activity.window.clearFlags(bit)
        }, { activity.window.attributes.flags and bit != 0 })
        try {
            val epoch = state.epoch; val first = state.issue(); val second = state.issue()
            state.acquire(epoch, first, true); check(state.active)
            state.acquire(epoch, second, true); state.release(epoch, first); check(state.active)
            state.invalidate(); check(activity.window.attributes.flags and bit == 0)
        } finally { if (previous) activity.window.addFlags(bit) else activity.window.clearFlags(bit) }
    }
}
