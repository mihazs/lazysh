package app.lazysh.client

import android.content.Context
import android.util.Base64
import androidx.test.platform.app.InstrumentationRegistry
import java.lang.reflect.InvocationTargetException
import java.security.KeyStore
import java.util.UUID
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test

/** Owned F-Droid APK acceptance. No registration, remote HTTP, user data reset or
 * notification-display claim is made by these Keystore/parser tests. */
class UnifiedPushEnrollmentTest {
    private val context get()=InstrumentationRegistry.getInstrumentation().targetContext
    private fun nativeClass(name:String):Class<*> {
        val result=try { Class.forName("app.lazysh.unifiedpush.$name",true,context.classLoader) } catch (_:ClassNotFoundException) { null }
        assumeTrue("UnifiedPush-only acceptance",result!=null)
        return checkNotNull(result)
    }
    private fun proof():JSONObject = JSONObject().put("schemaVersion",1).put("kind","challenge")
        .put("deviceId",UUID(1,1).toString()).put("generation",7)
        .put("challengeId",UUID(2,2).toString()).put("nonce","f".repeat(64))
    @Test fun strictNativeChallengeParserRejectsPlaintextUnknownDuplicateAndOversizedMessages() {
        val codec=nativeClass("EnrollmentHttpKt").getDeclaredMethod("parseChallenge",ByteArray::class.java,
            checkNotNull(Boolean::class.javaPrimitiveType))
        fun parse(bytes:ByteArray,decrypted:Boolean=true)=codec.invoke(null,bytes,decrypted)
        val valid=proof().toString()
        val admitted=checkNotNull(parse(valid.toByteArray(Charsets.UTF_8)))
        assertEquals("PrivateChallenge",admitted.toString())
        assertNotNull(parse((valid+" ".repeat(2048-valid.length)).toByteArray(Charsets.UTF_8)))
        assertNull(parse(valid.toByteArray(Charsets.UTF_8),false))
        assertNull(parse(valid.toByteArray(Charsets.UTF_8).copyOf(2049)))
        assertNull(parse(byteArrayOf(0xc3.toByte(),0x28)))
        assertNull(parse(ByteArray(0)))
        val malformed=listOf(
            proof().put("unknown","ignored").toString(),
            proof().put("kind","needs_attention").toString(),
            proof().put("generation",-1).toString(),
            proof().put("generation","7").toString(),
            proof().put("deviceId",UUID(0,0).toString()).toString(),
            proof().put("challengeId","not-an-id").toString(),
            proof().put("nonce","invalid").toString(),
            valid.dropLast(1)+",\"nonce\":\"${"e".repeat(64)}\"}",
            valid.replace("\"schemaVersion\":1","\"schemaVersion\":1.0"),
            "$valid {}",
        )
        for (value in malformed) assertNull("Malformed challenge must remain inert",parse(value.toByteArray(Charsets.UTF_8)))
        println("lazysh native enrollment parser: boundedEncryptedChallengeOnly=true malformedInert=true")
    }
    @Test fun privateEnrollmentUsesRealKeystoreCiphertextAndRejectsCorruptionWithoutFallback() {
        val type=nativeClass("PrivateEnrollmentStore")
        val stateType=nativeClass("EnrollmentState")
        val phaseType=nativeClass("EnrollmentPhase")
        val prefs=context.getSharedPreferences("lazysh-unifiedpush-enrollment-v1",Context.MODE_PRIVATE)
        val keys=KeyStore.getInstance("AndroidKeyStore").apply {load(null)}
        val alias="lazysh.unifiedpush.enrollment.v1"
        // Never overwrite or remove an existing app/user's private enrollment.
        assertFalse("Acceptance requires its own empty private namespace",prefs.contains("ciphertext"))
        assertFalse("Acceptance requires its own absent Keystore alias",keys.containsAlias(alias))
        val store=type.getDeclaredConstructor(Context::class.java).newInstance(context)
        val setter=type.getDeclaredMethod("setValue",stateType)
        val getter=type.getDeclaredMethod("getValue")
        val credential="e".repeat(64)
        val enrollment="d".repeat(64)
        val phase=checkNotNull(phaseType.enumConstants).single {it.toString()=="BOOTSTRAP"}
        val state=stateType.declaredConstructors.single {it.parameterTypes.size==14}.newInstance(
            UUID(1,1).toString(),1L,"https://owned.invalid",credential,UUID(2,2).toString(),enrollment,phase,
            null,null,null,null,null,null,null)
        try {
            setter.invoke(store,state)
            val encoded=checkNotNull(prefs.getString("ciphertext",null))
            assertTrue("The real Android Keystore owns the new alias",keys.containsAlias(alias))
            val key=keys.getEntry(alias,null) as KeyStore.SecretKeyEntry
            assertNull("The system key must not be exportable",key.secretKey.encoded)
            assertTrue("Only bounded ciphertext is persisted",encoded.length in 1..16384)
            assertFalse("No private credential plaintext",encoded.contains(credential))
            assertFalse("No enrollment capability plaintext",encoded.contains(enrollment))
            assertFalse("No origin plaintext",encoded.contains("owned.invalid"))
            val restored=checkNotNull(getter.invoke(store))
            assertEquals("PrivateEnrollment",restored.toString())
            val restoredCredential=stateType.getDeclaredMethod("getCredential").invoke(restored)
            assertTrue("Keystore roundtrip preserves the private credential",restoredCredential==credential)
            val bytes=Base64.decode(encoded,Base64.NO_WRAP)
            val decoded=bytes.toString(Charsets.UTF_8)
            assertFalse("Base64 is not a plaintext storage substitute",decoded.contains(credential) || decoded.contains(enrollment))
            bytes[bytes.lastIndex]=(bytes.last().toInt() xor 1).toByte()
            val corrupted=Base64.encodeToString(bytes,Base64.NO_WRAP)
            check(prefs.edit().putString("ciphertext",corrupted).commit())
            try { getter.invoke(store); fail("Corruption must fail closed") }
            catch (error:InvocationTargetException) {
                assertEquals("Private enrollment storage unavailable",error.targetException.message)
            }
            assertTrue("Unreadable ciphertext is retained without fallback or overwrite",prefs.getString("ciphertext",null)==corrupted)
            check(prefs.edit().putString("ciphertext",encoded).commit())
            keys.deleteEntry(alias)
            val restoredWithoutKey=type.getDeclaredConstructor(Context::class.java).newInstance(context)
            try {getter.invoke(restoredWithoutKey);fail("A missing system key must not adopt old ciphertext")}
            catch (error:InvocationTargetException) {assertEquals("Private enrollment storage unavailable",error.targetException.message)}
            assertTrue("Key loss must retain original ciphertext",prefs.getString("ciphertext",null)==encoded)
        } finally {
            setter.invoke(store,null)
            keys.deleteEntry(alias)
            assertFalse(prefs.contains("ciphertext"))
            assertFalse(keys.containsAlias(alias))
        }
        println("lazysh native enrollment storage: realKeystore=true ciphertextOnly=true corruptionRejected=true keyLossRejected=true ownedCleanup=true")
    }
}
