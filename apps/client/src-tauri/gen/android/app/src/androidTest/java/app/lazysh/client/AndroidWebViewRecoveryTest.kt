package app.lazysh.client

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidWebViewRecoveryTest {
    @Test fun rendererExitRebuildsTheActivityAndRestoresTheStartPage() {
        assumeTrue(Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
        PageDriver.awaitStartPage()
        PageDriver.terminateRendererAndAwaitReplacement()
    }
}
