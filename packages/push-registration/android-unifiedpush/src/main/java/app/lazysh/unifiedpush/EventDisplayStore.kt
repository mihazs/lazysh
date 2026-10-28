package app.lazysh.unifiedpush

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

internal class PrivateDisplayStore(context:Context):DisplayStore {
    private val blob=PrivatePushBlob(context,"display-v1",32768)
    override var value:DisplayState?
        @Synchronized get() = try { blob.read()?.let { decodeDisplayState(JSONObject(it)) } }
            catch (_:Exception) { throw IllegalStateException("Private notification state unavailable") }
        @Synchronized set(value) {
            try { blob.write(value?.let(::encodeDisplayState)?.toString()) }
            catch (_:Exception) { throw IllegalStateException("Private notification state unavailable") }
        }
}

private val displayKeys=setOf("schemaVersion","localId","epoch","instance","deviceId","generation",
    "subscriptionId","enabled","highWater","receipts")
private val receiptKeys=setOf("receiptId","expiresAt")
private fun JSONObject.integer(key:String):Long {
    val value=get(key)
    require(value is Int || value is Long)
    return (value as Number).toLong().also { require(it>=0) }
}
private fun validateDisplayState(state:DisplayState) {
    val binding=state.binding
    require(listOf(binding.localId,binding.instance,binding.deviceId,binding.subscriptionId).all(::canonicalUuid) &&
        binding.epoch>=0 && binding.generation>=0 && state.highWater in 0..Long.MAX_VALUE-300 && state.receipts.size<=128)
    require(state.receipts.map { it.receiptId }.toSet().size==state.receipts.size)
    for (receipt in state.receipts) require(canonicalUuid(receipt.receiptId) && receipt.expiresAt>0 &&
        receipt.expiresAt<=state.highWater+300)
}
internal fun encodeDisplayState(state:DisplayState):JSONObject {
    validateDisplayState(state)
    val binding=state.binding
    val receipts=JSONArray()
    for (receipt in state.receipts) receipts.put(JSONObject().put("receiptId",receipt.receiptId)
        .put("expiresAt",receipt.expiresAt))
    return JSONObject().put("schemaVersion",1).put("localId",binding.localId).put("epoch",binding.epoch)
        .put("instance",binding.instance).put("deviceId",binding.deviceId).put("generation",binding.generation)
        .put("subscriptionId",binding.subscriptionId).put("enabled",state.enabled)
        .put("highWater",state.highWater).put("receipts",receipts)
}
internal fun decodeDisplayState(json:JSONObject):DisplayState {
    require(json.keys().asSequence().toSet()==displayKeys && json.integer("schemaVersion")==1L)
    fun string(key:String)=json.get(key) as? String ?: error("Invalid private notification state")
    val list=json.get("receipts") as? JSONArray ?: error("Invalid private notification state")
    require(list.length()<=128)
    val receipts=(0 until list.length()).map { index ->
        val receipt=list.get(index) as? JSONObject ?: error("Invalid private notification state")
        require(receipt.keys().asSequence().toSet()==receiptKeys)
        DisplayReceipt(receipt.get("receiptId") as String,receipt.integer("expiresAt"))
    }
    return DisplayState(DisplayBinding(string("localId"),json.integer("epoch"),string("instance"),
        string("deviceId"),json.integer("generation"),string("subscriptionId")),
        json.get("enabled") as Boolean,json.integer("highWater"),receipts).also(::validateDisplayState)
}
