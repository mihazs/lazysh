package app.lazysh.unifiedpush

import android.content.Context
import org.json.JSONObject

/** Direct Keystore AEAD only. No AndroidKeysetManager/plaintext fallback. An
 * unreadable restored ciphertext is retained and never treated as an empty slot. */
internal class PrivateEnrollmentStore(context: Context) : EnrollmentStore {
    private val blob=PrivatePushBlob(context,"enrollment-v1",8192)
    override var value: EnrollmentState?
        @Synchronized get() {
            try {
                return blob.read()?.let { decodeState(JSONObject(it)) }
            } catch (_: Exception) { throw IllegalStateException("Private enrollment storage unavailable") }
        }
        @Synchronized set(value) {
            try {
                if (value == null) {
                    blob.write(null)
                    return
                }
                validateState(value)
                blob.write(encodeState(value).toString())
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
