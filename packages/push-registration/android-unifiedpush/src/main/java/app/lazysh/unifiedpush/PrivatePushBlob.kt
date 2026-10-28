package app.lazysh.unifiedpush

import android.content.Context
import android.util.Base64
import com.google.crypto.tink.integration.android.AndroidKeystoreKmsClient
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction

/** Fixed internal namespaces only; direct Keystore AEAD has no plaintext fallback. */
internal class PrivatePushBlob(context:Context, name:String, private val limit:Int) {
    private val prefs=context.applicationContext.getSharedPreferences("lazysh-unifiedpush-$name",Context.MODE_PRIVATE)
    private val aad="lazysh/unifiedpush/${name.replace('-','/')}".toByteArray(Charsets.UTF_8)
    private val aead by lazy {
        AndroidKeystoreKmsClient.getOrGenerateNewAeadKey("android-keystore://lazysh.unifiedpush.${name.replace('-','.')}")
    }
    @Synchronized fun read():String? {
        val encoded=prefs.getString("ciphertext",null) ?: return null
        require(encoded.length in 1..limit*2)
        val clear=aead.decrypt(Base64.decode(encoded,Base64.NO_WRAP),aad)
        try {
            require(clear.size in 1..limit)
            return Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(clear)).toString()
        } finally { clear.fill(0) }
    }
    @Synchronized fun write(text:String?) {
        if (text==null) { check(prefs.edit().remove("ciphertext").commit()); return }
        val clear=text.toByteArray(Charsets.UTF_8)
        try {
            require(clear.size in 1..limit)
            val encoded=Base64.encodeToString(aead.encrypt(clear,aad),Base64.NO_WRAP)
            require(encoded.length<=limit*2)
            check(prefs.edit().putString("ciphertext",encoded).commit())
        } finally { clear.fill(0) }
    }
}
