package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuthBrowserRouteTest {
    @Test fun aPageOpensAtOnceOnlyWhileLazyshHasAVisibleWindow() {
        assertEquals(AuthRoute.LAUNCH, AuthBrowserRoute.of(inFront = true, notificationsEnabled = true))
        assertEquals(AuthRoute.LAUNCH, AuthBrowserRoute.of(inFront = true, notificationsEnabled = false))
    }
    @Test fun anotherAppInFrontMakesItANotification() {
        assertEquals(AuthRoute.NOTIFY, AuthBrowserRoute.of(inFront = false, notificationsEnabled = true))
    }
    @Test fun noVisibleWindowAndNoNotificationOpensNothing() {
        assertEquals(AuthRoute.BLOCKED, AuthBrowserRoute.of(inFront = false, notificationsEnabled = false))
    }
    @Test fun onlyWebPagesStartAnotherApp() {
        assertTrue(AuthBrowserRoute.isWeb("https://idp.example/authorize?state=x"))
        assertTrue(AuthBrowserRoute.isWeb("HTTP://localhost:8085/"))
        for (url in listOf("intent://scan/#Intent;scheme=zxing;end", "javascript:alert(1)", "file:///data", "content://x", "lazysh://x", " https://x", ""))
            assertFalse(url, AuthBrowserRoute.isWeb(url))
    }
}
