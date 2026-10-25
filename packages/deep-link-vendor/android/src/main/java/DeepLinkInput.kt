// Copyright 2026 Mihael Zamin Sousa
// SPDX-License-Identifier: GPL-3.0-or-later
// lazysh-authored patch; see LAZYSH_PATCH.md for provenance.

package app.tauri.deep_link

// Reject by UTF-16 length first, so UTF-8 encoding itself is bounded. The actual
// ingress limit is bytes, matching Rust; non-ASCII URLs can exceed it earlier.
internal fun isBoundedDeepLinkInput(url: String): Boolean {
    val limit = 16 * 1024
    if (url.length > limit) return false
    return url.toByteArray(Charsets.UTF_8).size <= limit
}
