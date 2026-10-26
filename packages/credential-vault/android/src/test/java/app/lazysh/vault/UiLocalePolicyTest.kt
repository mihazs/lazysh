package app.lazysh.vault

import org.junit.Assert.*
import org.junit.Test

class UiLocalePolicyTest {
    @Test fun onlyTheFourCosmeticChoicesAndBoundedRevisionsAreAccepted() {
        for (choice in listOf("system", "en", "pt-BR", "es")) assertTrue(UiLocalePolicy.validChoice(choice))
        for (choice in listOf("pt", "es-MX", "EN", "", "../es", "es\n")) assertFalse(UiLocalePolicy.validChoice(choice))
        assertTrue(UiLocalePolicy.validRevision("0"))
        assertTrue(UiLocalePolicy.validRevision("90a404eb-e3d4-4488-bd63-e671c06acf44"))
        for (value in listOf("", "1", "90A404EB-E3D4-4488-BD63-E671C06ACF44", "0".repeat(100))) assertFalse(UiLocalePolicy.validRevision(value))
    }
    @Test fun systemSelectionKeepsSupportedRegionalTagsAndUsesBrazilianPortuguese() {
        val cases = mapOf(
            listOf("fr-FR", "es-MX") to "es-MX",
            listOf("pt-PT", "en-US") to "pt-BR",
            listOf("invalid_tag", "en-GB") to "en-GB",
            listOf("de-DE", "zh-Hant") to "en",
            List(16) { "fr-FR" } + "es-ES" to "en",
        )
        for ((requested, expected) in cases) assertEquals(expected, UiLocalePolicy.resolve("system", requested))
        assertEquals("en", UiLocalePolicy.resolve("en", listOf("es-MX")))
        assertEquals("es", UiLocalePolicy.resolve("es", listOf("pt-BR")))
    }
}
