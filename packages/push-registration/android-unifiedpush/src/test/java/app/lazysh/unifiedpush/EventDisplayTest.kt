package app.lazysh.unifiedpush

import java.util.UUID
import org.junit.Assert.*
import org.junit.Test

class EventDisplayTest {
    @Test fun dialogShowFailureReleasesLifecycleAndCompletesOnceDespiteDismissFailure() {
        var released=0
        val results=mutableListOf<Boolean>()
        val lifetime=ConsentDialogLifetime({released++},results::add)
        lifetime.show({error("Owned show failure")},{error("Owned dismiss failure")})
        lifetime.finish(true)
        assertEquals(1,released)
        assertEquals(listOf(false),results)
        var cleanupAttempted=0
        val cleanupFailure=ConsentDialogLifetime({cleanupAttempted++;error("Owned lifecycle cleanup failure")},results::add)
        try {cleanupFailure.finish(false)} catch (_:IllegalStateException) {}
        cleanupFailure.finish(true)
        assertEquals(1,cleanupAttempted)
        assertEquals(listOf(false,false),results)
    }
    private class Fixture {
        fun id(value:Long)=UUID(1,value).toString()
        val binding=DisplayBinding(id(1),2,id(3),id(4),5,id(6))
        var at=1000L
        var state:DisplayState?=null
        var unavailable=false
        var permission=true
        var posted=0
        var attempted=0
        var postFailure=false
        var cancelled=0
        val store=object:DisplayStore {
            override var value:DisplayState?
                get() { check(!unavailable); return state }
                set(value) { check(!unavailable); state=value }
        }
        val notifications=object:DisplayNotifications {
            override fun permitted()=permission
            override fun post() {
                assertTrue(state!!.receipts.isNotEmpty())
                attempted++
                check(!postFailure)
                posted++
            }
            override fun cancel() { cancelled++ }
        }
        fun controller()=EventDisplayController(store,notifications) { at }
        val display=controller()
        fun event(receipt:Long=7, event:Long=8, issued:Long=1000, expires:Long=1300)=
            DisplayEvent(binding.deviceId,binding.generation,id(receipt),id(event),"done",issued,expires)
    }
    @Test fun explicitConsentPersistsAdmissionBeforePostAndRestartAndDisableCannotReplay() {
        val f=Fixture()
        val event=f.event()
        f.display.message(f.binding,event)
        assertEquals(0,f.posted)
        f.display.enable(f.binding)
        f.display.message(f.binding,event)
        assertEquals(1,f.posted)
        f.controller().message(f.binding,event)
        assertEquals(1,f.posted)
        f.display.disable()
        assertEquals(1,f.cancelled)
        assertFalse(f.state!!.enabled)
        f.display.enable(f.binding)
        f.display.message(f.binding,event)
        f.display.message(f.binding,f.event(receipt=9))
        f.display.message(f.binding,f.event(event=10))
        // Different sources may legitimately reuse an event UUID; the wire has
        // no source ID, whereas each server receipt is globally unique.
        assertEquals(2,f.posted)
        f.display.message(f.binding,f.event(receipt=9,event=10))
        assertEquals(2,f.posted)
        f.display.message(f.binding,f.event(receipt=11))
        assertEquals(3,f.posted)
    }
    @Test fun originalBindingPermissionAndAbsoluteFreshnessAreRequiredWithoutRefreshingExpiry() {
        val f=Fixture()
        f.display.enable(f.binding)
        f.display.message(f.binding.copy(subscriptionId=f.id(20)),f.event())
        f.display.message(f.binding.copy(instance=f.id(21)),f.event())
        f.display.message(f.binding,DisplayEvent(f.id(22),5,f.id(7),f.id(8),"done",1000,1300))
        f.display.message(f.binding,DisplayEvent(f.binding.deviceId,6,f.id(7),f.id(8),"done",1000,1300))
        f.display.message(f.binding,f.event(issued=1001,expires=1301))
        f.permission=false
        f.display.message(f.binding,f.event())
        f.permission=true
        f.at=1300
        f.display.message(f.binding,f.event())
        assertEquals(0,f.posted)
        assertTrue(f.state!!.receipts.isEmpty())
    }
    @Test fun renewedConsentAfterConnectorRotationPreservesOriginalDeviceGenerationReplayHistory() {
        val f=Fixture()
        f.display.enable(f.binding)
        f.display.message(f.binding,f.event())
        val rotated=f.binding.copy(instance=f.id(30),subscriptionId=f.id(31),epoch=4)
        assertFalse(f.display.enabled(rotated))
        f.display.enable(rotated)
        f.controller().message(rotated,f.event())
        assertEquals(1,f.posted)
        assertEquals(1,f.state!!.receipts.size)
        f.display.message(rotated,f.event(receipt=32,event=33))
        assertEquals(2,f.posted)
    }
    @Test fun fullLiveCacheRefusesAdmissionThenOnlyExpiredEntriesCanBePruned() {
        val f=Fixture()
        f.display.enable(f.binding)
        for (index in 1L..128) f.display.message(f.binding,f.event(receipt=index+100,event=index+1000))
        assertEquals(128,f.posted)
        f.display.message(f.binding,f.event())
        assertEquals(128,f.posted)
        assertEquals(128,f.state!!.receipts.size)
        f.at=1300
        f.display.message(f.binding,f.event(issued=1300,expires=1600))
        assertEquals(129,f.posted)
        assertEquals(1,f.state!!.receipts.size)
    }
    @Test fun deniedPermissionDoesNotPoisonStorageAndLaterExplicitConsentCanSucceed() {
        val f=Fixture()
        f.permission=false
        try {f.display.enable(f.binding);fail("Permission is required")}
        catch (_:IllegalStateException) {}
        assertNull(f.state)
        f.permission=true
        f.display.enable(f.binding)
        f.display.message(f.binding,f.event())
        assertEquals(1,f.posted)
    }
    @Test fun uncertainPostFailureRetainsAdmissionAndCannotRetryAfterControllerRestart() {
        val f=Fixture()
        f.display.enable(f.binding)
        f.postFailure=true
        try {f.display.message(f.binding,f.event());fail("Owned post failure required")}
        catch (_:IllegalStateException) {}
        f.postFailure=false
        f.controller().message(f.binding,f.event())
        assertEquals(1,f.attempted)
        assertEquals(0,f.posted)
        f.display.message(f.binding,f.event(receipt=9,event=10))
        assertEquals(2,f.attempted)
        assertEquals(1,f.posted)
    }
    @Test fun rollbackAndStorageFailureCannotReviveAdmissionOrDiscardReceiptState() {
        val f=Fixture()
        f.display.enable(f.binding)
        f.display.message(f.binding,f.event())
        val retained=f.state
        f.at=999
        try {f.controller().message(f.binding,f.event(receipt=9,event=10));fail("Clock rollback must fail closed")}
        catch (_:IllegalStateException) {}
        assertEquals(retained,f.state)
        f.at=1000
        f.unavailable=true
        val poisoned=f.controller()
        try {poisoned.message(f.binding,f.event(receipt=9,event=10));fail("Storage failure must fail closed")}
        catch (_:IllegalStateException) {}
        f.unavailable=false
        try {poisoned.enable(f.binding);fail("A failed controller must remain unavailable")}
        catch (_:IllegalStateException) {}
        assertEquals(retained,f.state)
        assertEquals(1,f.posted)
    }
}
