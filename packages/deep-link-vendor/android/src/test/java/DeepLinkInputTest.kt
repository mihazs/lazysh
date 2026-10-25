// Copyright 2026 Mihael Zamin Sousa
// SPDX-License-Identifier: GPL-3.0-or-later
// lazysh-authored patch; see LAZYSH_PATCH.md for provenance.

package app.tauri.deep_link

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class DeepLinkInputTest {
    @Test
    fun acceptsTheByteBoundaryAndRejectsLongInputs() {
        assertTrue(isBoundedDeepLinkInput("a".repeat(16 * 1024)))
        assertFalse(isBoundedDeepLinkInput("a".repeat(16 * 1024 + 1)))
        assertTrue(isBoundedDeepLinkInput("é".repeat(8 * 1024)))
        // Fits the character limit but exceeds the byte limit before URI parsing.
        assertFalse(isBoundedDeepLinkInput("é".repeat(8 * 1024 + 1)))
        assertTrue(isBoundedDeepLinkInput("😀".repeat(4 * 1024)))
        assertFalse(isBoundedDeepLinkInput("😀".repeat(4 * 1024 + 1)))
    }
}
