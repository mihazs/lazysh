package app.lazysh.push

internal interface ProviderStore {
    var selected: String?
    val legacyFcmActive: Boolean
}
internal class ProviderSelection(private val store:ProviderStore) {
    private var epoch=0L
    private val defaultProvider=if(store.legacyFcmActive)"fcm" else "unifiedpush"
    @Synchronized fun provider():String = store.selected?.takeIf { it=="fcm" || it=="unifiedpush" }
        ?: defaultProvider
    @Synchronized fun change(provider:String,expected:Long,inactive:()->Boolean):Boolean {
        if(provider !in listOf("unifiedpush","fcm") || expected<epoch || !inactive())return false
        epoch=expected
        store.selected=provider
        return true
    }
    @Synchronized fun control(expected:Long,action:(String)->Unit):Boolean {
        if(expected<epoch)return false
        epoch=expected
        action(provider())
        return true
    }
}

/** A previous transport is never cleaned up implicitly while the selected one owns state. */
internal data class PreviousFcmCleanup(val pending:Boolean,val retryFcm:Boolean)
internal fun previousFcmCleanup(selected:String,unifiedActive:Boolean,fcm:FcmPresence,fcmBusy:Boolean):PreviousFcmCleanup {
    val pending=selected=="unifiedpush" && (fcm.enabled || fcm.tokenPresent || fcmBusy)
    return PreviousFcmCleanup(pending,pending && !unifiedActive)
}
