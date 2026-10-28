package app.lazysh.unifiedpush

import android.util.JsonReader
import android.util.JsonToken
import java.io.StringReader
import java.net.Proxy
import java.nio.ByteBuffer
import java.nio.charset.CodingErrorAction
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.MediaType.Companion.toMediaType
import okio.BufferedSink
import org.json.JSONObject

private class NumberValue(val text: String)
/** isOneShot also prevents HTTP 503/421 follow-ups; the connection-retry switch
 * alone does not cover every replay path in the pinned upstream interceptor. */
internal class PrivateRequestBody(private val bytes:ByteArray):RequestBody() {
    private val sent=AtomicBoolean(false)
    override fun contentType()="application/json".toMediaType()
    override fun contentLength()=bytes.size.toLong()
    override fun isOneShot()=true
    override fun writeTo(sink:BufferedSink) {
        check(sent.compareAndSet(false,true)) { "Private request body already transmitted" }
        sink.write(bytes)
    }
}
internal class EnrollmentFields private constructor(private val values: Map<String, Any?>) {
    fun string(key: String): String = values[key] as? String ?: error("Invalid private response")
    fun boolean(key: String): Boolean = values[key] as? Boolean ?: error("Invalid private response")
    fun number(key: String): Long {
        val text = (values[key] as? NumberValue)?.text ?: error("Invalid private response")
        require(text.matches(Regex("0|[1-9][0-9]*")))
        return text.toLong()
    }
    companion object {
        fun parse(bytes: ByteArray, limit: Int, keys: Set<String>): EnrollmentFields {
            require(bytes.isNotEmpty() && bytes.size <= limit)
            val text = Charsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString()
            val values = mutableMapOf<String, Any?>()
            JsonReader(StringReader(text)).use { reader ->
                reader.isLenient = false
                reader.beginObject()
                while (reader.hasNext()) {
                    val name = reader.nextName()
                    require(name in keys && name !in values)
                    values[name] = when (reader.peek()) {
                        JsonToken.STRING -> reader.nextString()
                        JsonToken.NUMBER -> NumberValue(reader.nextString())
                        JsonToken.BOOLEAN -> reader.nextBoolean()
                        JsonToken.NULL -> { reader.nextNull(); null }
                        else -> error("Invalid private response")
                    }
                }
                reader.endObject()
                require(reader.peek() == JsonToken.END_DOCUMENT && values.keys == keys)
            }
            return EnrollmentFields(values)
        }
    }
}

internal fun parseChallenge(content: ByteArray, decrypted: Boolean): Challenge? = try {
    if (!decrypted) null else {
        val fields = EnrollmentFields.parse(content, 2048,
            setOf("schemaVersion", "kind", "deviceId", "generation", "challengeId", "nonce"))
        require(fields.number("schemaVersion") == 1L && fields.string("kind") == "challenge")
        val device = fields.string("deviceId")
        val challenge = fields.string("challengeId")
        val nonce = fields.string("nonce")
        require(canonicalUuid(device) && canonicalUuid(challenge) && capability(nonce))
        Challenge(device, fields.number("generation"), challenge, nonce)
    }
} catch (_: Exception) { null }

/** Production owns this fixed TLS client. No certificate, resolver or transport
 * override is accepted by IPC, preferences, constructor or environment proxy. */
internal class EnrollmentHttp : EnrollmentRelay {
    private val client = OkHttpClient.Builder()
        .proxy(Proxy.NO_PROXY)
        .followRedirects(false)
        .followSslRedirects(false)
        .retryOnConnectionFailure(false)
        .connectTimeout(3, TimeUnit.SECONDS)
        .callTimeout(10, TimeUnit.SECONDS)
        .readTimeout(10, TimeUnit.SECONDS)
        .writeTimeout(10, TimeUnit.SECONDS)
        .build()

    override fun bootstrap(state: EnrollmentState, call: EnrollmentCall): BootstrapReply {
        val result = post(state, "/v1/push/bootstrap", checkNotNull(state.enrollment),
            JSONObject().put("requestId", state.bootstrapId).put("credential", state.credential),
            setOf("deviceId", "generation", "publicVapidKey", "confirmed"), call)
        val device = result.string("deviceId")
        val vapid = result.string("publicVapidKey")
        require(canonicalUuid(device) && publicKey(vapid))
        result.boolean("confirmed") // Never grants native confirmation authority.
        return BootstrapReply(device, result.number("generation"), vapid)
    }
    override fun subscribe(state: EnrollmentState, call: EnrollmentCall): String {
        val endpoint = checkNotNull(state.endpoint)
        require(usableEndpoint(endpoint.endpoint, true) && publicKey(endpoint.publicKey) && authKey(endpoint.auth))
        val result = post(state, "/v1/push/subscription", state.credential,
            JSONObject().put("requestId", checkNotNull(state.subscriptionId)).put("endpoint", endpoint.endpoint)
                .put("p256dh", endpoint.publicKey).put("auth", endpoint.auth),
            setOf("challengeId", "pushServiceAccepted", "confirmed"), call)
        require(!result.boolean("confirmed"))
        result.boolean("pushServiceAccepted") // Transport acceptance is not a proof.
        return result.string("challengeId").also { require(canonicalUuid(it)) }
    }
    override fun confirm(state: EnrollmentState, proof: Challenge, call: EnrollmentCall) {
        require(state.challengeId == proof.challengeId && state.deviceId == proof.deviceId && state.generation == proof.generation)
        val result = post(state, "/v1/push/confirm", state.credential,
            JSONObject().put("challengeId", proof.challengeId).put("nonce", proof.nonce), setOf("confirmed"), call)
        require(result.boolean("confirmed"))
    }
    override fun revoke(state: EnrollmentState, call: EnrollmentCall) {
        val result = post(state, "/v1/push/revoke", state.credential, JSONObject(), setOf("revoked"), call)
        require(result.boolean("revoked"))
    }
    private fun post(state: EnrollmentState, path: String, credential: String, body: JSONObject, keys: Set<String>, call: EnrollmentCall): EnrollmentFields {
        val bytes = body.toString().toByteArray(Charsets.UTF_8)
        try {
            check(call.active())
            require(relayOrigin(state.origin) == state.origin && capability(credential) && bytes.size <= 4096)
            val request = Request.Builder().url(state.origin + path)
                .header("Authorization", "Bearer $credential")
                .header("Accept-Encoding", "identity")
                .post(PrivateRequestBody(bytes)).build()
            val network = client.newCall(request)
            call.install { network.cancel() }
            network.execute().use { response ->
                require(response.isSuccessful && call.active())
                require(response.header("Content-Encoding") in listOf(null, "identity"))
                val stream = checkNotNull(response.body).byteStream()
                val value = ByteArray(4097)
                var count = 0
                while (count < value.size) {
                    val read = stream.read(value, count, value.size - count)
                    if (read < 0) break
                    count += read
                }
                require(count in 1..4096 && call.active())
                return EnrollmentFields.parse(value.copyOf(count), 4096, keys)
            }
        } catch (_: Exception) {
            throw IllegalStateException("Cannot complete private relay request")
        } finally { bytes.fill(0) }
    }
}

internal fun publicKey(value: String): Boolean = value.length == 87 && value.startsWith("B") && base64url(value)
internal fun authKey(value: String): Boolean = value.length == 22 && base64url(value)
private fun base64url(value: String) = value.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '-' || it == '_' }
