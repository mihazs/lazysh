package app.lazysh.vault

internal data class CredentialEnvelope(val alias: String?, val iv: String, val ciphertext: String) {
    val biometric get() = alias != null
    companion object {
        fun parse(blob: String, aliasPrefix: String): CredentialEnvelope {
            require(blob.length <= 180000)
            val parts = blob.split(":")
            val biometric = parts.size == 4 && parts[0] == "v2b"
            require(biometric || parts.size == 2)
            val alias = if (biometric) parts[1] else null
            if (alias != null) {
                require(alias.startsWith(aliasPrefix))
                val suffix = alias.removePrefix(aliasPrefix)
                require(java.util.UUID.fromString(suffix).toString() == suffix)
            }
            val iv = parts[if (biometric) 2 else 0]
            val ciphertext = parts[if (biometric) 3 else 1]
            require(iv.length == 16 && iv.all { it.isLetterOrDigit() || it == '+' || it == '/' })
            require(ciphertext.length in 24..174784 && ciphertext.matches(Regex("[A-Za-z0-9+/]+={0,2}")))
            return CredentialEnvelope(alias, iv, ciphertext)
        }
    }
}
