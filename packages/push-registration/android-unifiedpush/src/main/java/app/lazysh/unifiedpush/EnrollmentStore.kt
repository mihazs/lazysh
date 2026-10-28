package app.lazysh.unifiedpush

import android.content.Context
import android.util.Base64
import com.google.crypto.tink.integration.android.AndroidKeystoreKmsClient
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import org.json.JSONObject

/** Direct Keystore AEAD only. No AndroidKeysetManager/plaintext fallback. An
 * unreadable restored ciphertext is retained and never treated as an empty slot. */
internal class PrivateEnrollmentStore(context: Context) : EnrollmentStore {
    private val prefs = context.applicationContext.getSharedPreferences("lazysh-unifiedpush-enrollment-v1", Context.MODE_PRIVATE)
    private val aad = "lazysh/unifiedpush/enrollment/v1".toByteArray(Charsets.UTF_8)
    private val aead by lazy {
        AndroidKeystoreKmsClient.getOrGenerateNewAeadKey("android-keystore://lazysh.unifiedpush.enrollment.v1")
    }
    override var value: EnrollmentState?
        @Synchronized get() {
            try {
                val encoded = prefs.getString("ciphertext", null) ?: return null
                require(encoded.length in 1..16384)
                val clear = aead.decrypt(Base64.decode(encoded, Base64.NO_WRAP), aad)
                try {
                    require(clear.size in 1..8192)
                    val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(clear)).toString()
                    return decodeState(JSONObject(text))
                } finally { clear.fill(0) }
            } catch (_: Exception) { throw IllegalStateException("Private enrollment storage unavailable") }
        }
        @Synchronized set(value) {
            try {
                if (value == null) {
                    check(prefs.edit().remove("ciphertext").commit())
                    return
                }
                validateState(value)
                val clear = encodeState(value).toString().toByteArray(Charsets.UTF_8)
                try {
                    require(clear.size <= 8192)
                    val encrypted = aead.encrypt(clear, aad)
                    val encoded = Base64.encodeToString(encrypted, Base64.NO_WRAP)
                    require(encoded.length <= 16384)
                    check(prefs.edit().putString("ciphertext", encoded).commit())
                } finally { clear.fill(0) }
            } catch (_: Exception) { throw IllegalStateException("Private enrollment storage unavailable") }
        }
}

private val stateKeys = setOf("schemaVersion", "localId", "epoch", "origin", "credential", "bootstrapId", "enrollment",
    "phase", "deviceId", "generation", "vapid", "instance", "endpoint", "publicKey", "auth", "subscriptionId", "challengeId")
private fun encodeState(value: EnrollmentState): JSONObject {
    val json = JSONObject().put("schemaVersion", 1).put("localId", value.localId).put("epoch", value.epoch)
        .put("origin", value.origin).put("credential", value.credential).put("bootstrapId", value.bootstrapId)
        .put("phase", value.phase.name)
    for ((key, field) in mapOf("enrollment" to value.enrollment, "deviceId" to value.deviceId, "generation" to value.generation,
        "vapid" to value.vapid, "instance" to value.instance, "endpoint" to value.endpoint?.endpoint,
        "publicKey" to value.endpoint?.publicKey, "auth" to value.endpoint?.auth, "subscriptionId" to value.subscriptionId,
        "challengeId" to value.challengeId)) json.put(key, field ?: JSONObject.NULL)
    return json
}
private fun decodeState(json: JSONObject): EnrollmentState {
    require(json.keys().asSequence().toSet() == stateKeys && json.get("schemaVersion") == 1)
    fun optional(key: String): String? = if (json.isNull(key)) null else json.get(key) as? String ?: error("Invalid private state")
    val endpoint = optional("endpoint")
    val public = optional("publicKey")
    val auth = optional("auth")
    val keys = if (endpoint == null && public == null && auth == null) null
        else EndpointKeys(checkNotNull(endpoint), checkNotNull(public), checkNotNull(auth))
    val generation = if (json.isNull("generation")) null else (json.get("generation") as? Number)?.toLong()
        ?: error("Invalid private state")
    val value = EnrollmentState(json.get("localId") as String, (json.get("epoch") as Number).toLong(),
        json.get("origin") as String, json.get("credential") as String, json.get("bootstrapId") as String,
        optional("enrollment"), EnrollmentPhase.valueOf(json.get("phase") as String), optional("deviceId"), generation,
        optional("vapid"), optional("instance"), keys, optional("subscriptionId"), optional("challengeId"))
    validateState(value)
    return value
}
private fun validateState(value: EnrollmentState) {
    require(canonicalUuid(value.localId) && canonicalUuid(value.bootstrapId) && value.epoch >= 0 &&
        relayOrigin(value.origin) == value.origin && capability(value.credential))
    value.enrollment?.let { require(capability(it) && it != value.credential) }
    value.instance?.let { require(canonicalUuid(it)) }
    value.subscriptionId?.let { require(canonicalUuid(it)) }
    value.challengeId?.let { require(canonicalUuid(it)) }
    if (value.deviceId == null) require(value.generation == null && value.vapid == null)
    else require(canonicalUuid(value.deviceId) && value.generation != null && value.generation >= 0 && value.vapid != null && publicKey(value.vapid))
    value.endpoint?.let { require(usableEndpoint(it.endpoint, true) && publicKey(it.publicKey) && authKey(it.auth)) }
    if (value.phase in listOf(EnrollmentPhase.SUBSCRIBE, EnrollmentPhase.VERIFY, EnrollmentPhase.CONFIRMED))
        require(value.deviceId != null && value.instance != null && value.endpoint != null && value.subscriptionId != null)
    if (value.phase == EnrollmentPhase.VERIFY) require(value.challengeId != null)
    if (value.phase == EnrollmentPhase.BOOTSTRAP) require(value.enrollment != null && value.deviceId == null)
}
