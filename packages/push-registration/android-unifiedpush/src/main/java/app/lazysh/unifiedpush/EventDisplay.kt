package app.lazysh.unifiedpush

import java.util.UUID

internal class DisplayEvent(val deviceId:String, val generation:Long, val receiptId:String,
    val eventId:String, val kind:String, val issuedAt:Long, val expiresAt:Long) {
    override fun toString() = "BoundDisplayEvent"
}

internal fun parseDisplayEvent(content:ByteArray, decrypted:Boolean):DisplayEvent? = try {
    if (!decrypted) null else {
        val fields=EnrollmentFields.parse(content,2048,setOf("schemaVersion","deviceId","generation",
            "receiptId","eventId","kind","alias","issuedAt","expiresAt"))
        val device=fields.string("deviceId")
        val receipt=fields.string("receiptId")
        val event=fields.string("eventId")
        val kind=fields.string("kind")
        val alias=fields.string("alias")
        val issued=fields.number("issuedAt")
        val expires=fields.number("expiresAt")
        require(fields.number("schemaVersion")==2L && canonicalUuid(device) && canonicalUuid(receipt) &&
            UUID.fromString(event).toString()==event && kind in setOf("working","needs_attention","done") &&
            alias.length in 1..64 && alias.all { it in ' '..'~' } && expires>issued && expires-issued<=300)
        DisplayEvent(device,fields.number("generation"),receipt,event,kind,issued,expires)
    }
} catch (_:Exception) { null }

/** No credentials, endpoint or event contents enter this separate private state. */
internal data class DisplayBinding(val localId:String, val epoch:Long, val instance:String,
    val deviceId:String, val generation:Long, val subscriptionId:String)
internal data class DisplayReceipt(val receiptId:String, val expiresAt:Long)
internal data class DisplayState(val binding:DisplayBinding, val enabled:Boolean,
    val highWater:Long, val receipts:List<DisplayReceipt>)
internal interface DisplayStore { var value:DisplayState? }
internal interface DisplayNotifications {
    fun permitted():Boolean
    fun post()
    fun cancel()
}

/** Callers hold registration -> enrollment before entering this monitor. The
 * durable admission precedes notify: process death can lose a notification, never
 * justify retrying a receipt whose side effect may already have happened. */
internal class EventDisplayController(private val store:DisplayStore,
    private val notifications:DisplayNotifications, private val now:()->Long) {
    private var failed=false
    private fun <T> storage(action:()->T):T {
        check(!failed) { "Private notification state unavailable" }
        return try { action() } catch (_:Exception) {
            failed=true
            throw IllegalStateException("Private notification state unavailable")
        }
    }
    private fun time(previous:DisplayState?):Long {
        val at=now()
        check(at>=0 && (previous==null || at>=previous.highWater)) { "Notification clock moved backwards" }
        return at
    }
    @Synchronized fun enabled(binding:DisplayBinding):Boolean {
        val previous=storage { store.value }
        time(previous)
        return previous?.enabled==true && previous.binding==binding
    }
    @Synchronized fun enable(binding:DisplayBinding) {
        check(notifications.permitted()) { "Enable system notification permission and channel first" }
        val previous=storage { store.value }
        val at=time(previous)
        // The wire envelope binds device/generation, not connector subscription.
        // Renewed consent after endpoint rotation must not revive old ciphertext.
        val sameDevice=previous?.binding?.let { it.localId==binding.localId &&
            it.deviceId==binding.deviceId && it.generation==binding.generation }==true
        val retained=if (sameDevice) checkNotNull(previous).receipts.filter { it.expiresAt>at } else emptyList()
        storage { store.value=DisplayState(binding,true,at,retained) }
    }
    @Synchronized fun disable() {
        try { storage {
            val previous=store.value
            if (previous!=null) store.value=previous.copy(enabled=false)
        } } finally { notifications.cancel() }
    }
    @Synchronized fun disableInstance(instance:String) {
        val previous=storage { store.value } ?: return
        if (previous.binding.instance==instance) disable()
    }
    @Synchronized fun message(binding:DisplayBinding, event:DisplayEvent) {
        val previous=storage { store.value } ?: return
        val at=time(previous)
        if (!previous.enabled || previous.binding!=binding || event.deviceId!=binding.deviceId ||
            event.generation!=binding.generation || at<event.issuedAt || at>=event.expiresAt ||
            !notifications.permitted()) return
        val retained=previous.receipts.filter { it.expiresAt>at }
        if (retained.any { it.receiptId==event.receiptId }) return
        // Never evict a live receipt to make room for a replay.
        if (retained.size>=128) return
        storage { store.value=previous.copy(highWater=at,receipts=retained+DisplayReceipt(event.receiptId,event.expiresAt)) }
        notifications.post()
    }
}
