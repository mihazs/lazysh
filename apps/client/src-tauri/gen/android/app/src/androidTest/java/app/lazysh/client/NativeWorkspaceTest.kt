package app.lazysh.client

import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.espresso.Espresso.onView
import androidx.test.espresso.Espresso.closeSoftKeyboard
import androidx.test.espresso.action.ViewActions.typeTextIntoFocusedView
import androidx.test.espresso.matcher.ViewMatchers.isAssignableFrom
import androidx.test.espresso.web.sugar.Web.onWebView
import androidx.test.espresso.web.webdriver.DriverAtoms.findElement
import androidx.test.espresso.web.webdriver.DriverAtoms.webClick
import androidx.test.espresso.web.webdriver.Locator
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class NativeWorkspaceTest {
    private fun webView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) webView(view.getChildAt(index))?.let { return it }
        return null
    }

    private fun evaluate(scenario: ActivityScenario<MainActivity>, expression: String): String {
        val result = AtomicReference<String>()
        val completed = CountDownLatch(1)
        scenario.onActivity { activity ->
            val web = requireNotNull(webView(activity.window.decorView))
            web.evaluateJavascript(expression) { value -> result.set(value); completed.countDown() }
        }
        assertTrue("WebView evaluation timed out", completed.await(30, TimeUnit.SECONDS))
        return result.get()
    }

    private fun awaitDocument(scenario: ActivityScenario<MainActivity>, stage: String, expression: String) {
        val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(120)
        while (evaluate(scenario, expression) != "true") {
            val error = evaluate(scenario, "document.querySelector('[role=dialog] [role=alert]')?.textContent?.slice(0,320) || ''")
            assertTrue("Native workspace failed at $stage: $error", error == "\"\"")
            assertTrue("The bundled native workspace did not become ready at $stage", System.nanoTime() < deadline)
            Thread.sleep(200)
        }
    }

    private fun typeInto(scenario: ActivityScenario<MainActivity>, selector: String, text: String) {
        onWebView().withElement(findElement(Locator.CSS_SELECTOR, selector)).perform(webClick())
        // The DOM atom focuses the HTML input but does not grant native View
        // focus to RustWebView. Native key injection requires both focus layers.
        scenario.onActivity { activity ->
            val web = requireNotNull(webView(activity.window.decorView))
            assertTrue("Native WebView focus was denied", web.requestFocus())
            assertTrue("Native WebView did not acquire focus", web.hasFocus())
        }
        assertEquals("DOM input focus changed", "true", evaluate(scenario,
            "document.activeElement === document.querySelector(${JSONObject.quote(selector)})"))
        // Espresso webKeys uses JS value assignment. React tracks that setter,
        // so its later synthetic change can be ignored. Inject native keys into
        // the focused WebView instead, preserving normal browser input events.
        onView(isAssignableFrom(WebView::class.java)).perform(typeTextIntoFocusedView(text))
        assertEquals("true", evaluate(scenario,
            "document.querySelector(${JSONObject.quote(selector)})?.value === ${JSONObject.quote(text)}"))
    }

    @Test fun bundledWorkspaceSavesHostsThroughNativeIpcAndSurvivesActivityRecreation() {
        val fixture = "Instrumentation ${UUID.randomUUID()}"
        val selector = "button[aria-label='Connect to $fixture']"
        run { val scenario = NativeActivityFixture.scenario
            awaitDocument(scenario, "initial load", "Boolean(document.querySelector('button.welcome-connect'))")
            assertEquals("true", evaluate(scenario, "Boolean(window.__TAURI_INTERNALS__)"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Add host']")).perform(webClick())
            typeInto(scenario, "input[placeholder='Home workstation']", fixture)
            typeInto(scenario, "input[placeholder='workstation.local']", "instrumentation.invalid")
            typeInto(scenario, "input[placeholder='Your SSH username']", "test")
            closeSoftKeyboard()
            val diagnostics = evaluate(scenario, """JSON.stringify({
              valid:document.querySelector('form')?.checkValidity(),
              nameMatches:document.querySelector("input[placeholder='Home workstation']")?.value===${JSONObject.quote(fixture)},
              hostnameMatches:document.querySelector("input[placeholder='workstation.local']")?.value==='instrumentation.invalid',
              usernameMatches:document.querySelector("input[placeholder='Your SSH username']")?.value==='test',
              invalidFields:Array.from(document.querySelectorAll('form input:invalid')).map(x=>x.getAttribute('placeholder')||x.type)
            })""")
            android.util.Log.i("lazysh-instrumentation", "Fixture form diagnostics: $diagnostics")
            assertEquals("true", evaluate(scenario, "Boolean(document.querySelector('form')?.checkValidity())"))
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "form button.primary-button")).perform(webClick())
            awaitDocument(scenario, "saved host before recreation", "Boolean(document.querySelector(\"$selector\"))")
            scenario.recreate()
            awaitDocument(scenario, "saved host after recreation", "Boolean(document.querySelector(\"$selector\"))")
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Open hosts']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "button[aria-label='Delete $fixture']")).perform(webClick())
            onWebView().withElement(findElement(Locator.CSS_SELECTOR, "[role='dialog'][aria-label='Delete host'] button.danger-button")).perform(webClick())
            awaitDocument(scenario, "fixture deletion", "!document.querySelector(\"$selector\")")
        }
    }
}
