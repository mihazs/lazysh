package app.lazysh.client

import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test
import org.w3c.dom.Element

class DeepLinkManifestTest {
    private val namespace = "http://schemas.android.com/apk/res/android"

    private fun Element.children(tag: String): List<Element> =
        (0 until childNodes.length).mapNotNull { childNodes.item(it) as? Element }.filter { it.tagName == tag }

    @Test
    fun canonicalManifestRetainsOneCustomSchemeRouteWithoutChangingActivityPolicy() {
        val document = DocumentBuilderFactory.newInstance().apply { isNamespaceAware = true }
            .newDocumentBuilder().parse(File("src/main/AndroidManifest.xml"))
        val activity = document.documentElement.children("application").single().children("activity").single {
            it.getAttributeNS(namespace, "name") == ".MainActivity"
        }
        assertEquals("singleTask", activity.getAttributeNS(namespace, "launchMode"))
        assertEquals("true", activity.getAttributeNS(namespace, "exported"))
        val filters = activity.children("intent-filter")
        assertEquals(2, filters.size)
        val route = filters.single { filter ->
            filter.children("action").any { it.getAttributeNS(namespace, "name") == "android.intent.action.VIEW" }
        }
        assertEquals(setOf("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE"),
            route.children("category").map { it.getAttributeNS(namespace, "name") }.toSet())
        val data = route.children("data").single()
        assertEquals("lazysh", data.getAttributeNS(namespace, "scheme"))
        assertEquals(1, data.attributes.length)
        assertFalse(route.hasAttributeNS(namespace, "autoVerify"))
    }
}
