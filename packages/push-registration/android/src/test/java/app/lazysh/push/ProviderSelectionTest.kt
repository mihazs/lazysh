package app.lazysh.push

import org.junit.Assert.*
import org.junit.Test

class ProviderSelectionTest {
    private class Store(override var selected:String?=null,override var legacyFcmActive:Boolean=false):ProviderStore
    @Test fun defaultNeverRegistersAndPreservesActiveLegacyFcm() {
        val fresh=Store()
        assertEquals("unifiedpush",ProviderSelection(fresh).provider())
        assertNull(fresh.selected)
        assertEquals("fcm",ProviderSelection(Store(legacyFcmActive=true)).provider())
        assertEquals("unifiedpush",ProviderSelection(Store("unifiedpush",true)).provider())
    }
    @Test fun legacyDefaultDoesNotSwitchUnderAnExistingConsentScreenWhenRegistrationChanges() {
        val store=Store(legacyFcmActive=true);val choice=ProviderSelection(store)
        assertEquals("fcm",choice.provider())
        store.legacyFcmActive=false
        assertEquals("fcm",choice.provider())
        val fresh=Store();val unified=ProviderSelection(fresh)
        fresh.legacyFcmActive=true
        assertEquals("unifiedpush",unified.provider())
    }
    @Test fun acceptedDefaultControlSurvivesLateFcmMarkersAndRestart() {
        val store=Store();val selection=ProviderSelection(store);val actions=mutableListOf<String>()
        assertEquals("unifiedpush",selection.provider());assertNull(store.selected)
        assertTrue(selection.control(1){actions.add(it)})
        store.legacyFcmActive=true
        assertEquals("unifiedpush",ProviderSelection(store).provider())
        assertEquals(listOf("unifiedpush"),actions)
    }
    @Test fun failedControlPersistenceNeverStartsTheAction() {
        var actions=0
        val selection=ProviderSelection(object:ProviderStore {
            override val legacyFcmActive=false
            override var selected:String?
                get()=null
                set(value){throw IllegalStateException("private-store-failure")}
        })
        try {selection.control(1){actions++};fail("must reject failed persistence")}
        catch(_:IllegalStateException){}
        assertFalse(selection.control(0){actions++})
        assertEquals(0,actions)
    }
    @Test fun previousFcmCleanupRequiresSeparatePauseAndKeepsSelectedProvider() {
        val choice=ProviderSelection(Store("unifiedpush"))
        val pending=FcmPresence(false,true)
        // The first Pause belongs exclusively to the active selected transport.
        assertEquals(PreviousFcmCleanup(true,false),previousFcmCleanup(choice.provider(),true,pending,false))
        // Only a later explicit action, after all UP state is gone, retries FCM deletion.
        assertEquals(PreviousFcmCleanup(true,true),previousFcmCleanup(choice.provider(),false,pending,false))
        assertEquals("unifiedpush",choice.provider())
        assertFalse(choice.change("fcm",1){!previousFcmCleanup(choice.provider(),false,pending,false).pending})
        assertEquals(PreviousFcmCleanup(true,true),previousFcmCleanup(choice.provider(),false,pending,true))
        assertEquals(PreviousFcmCleanup(false,false),previousFcmCleanup(choice.provider(),false,FcmPresence(false,false),false))
        assertTrue(choice.change("fcm",2){true})
        assertEquals(PreviousFcmCleanup(false,false),previousFcmCleanup(choice.provider(),false,pending,false))
    }
    @Test fun compiledGoogleLibraryContainsBothTransportsInsteadOfTheOldExclusiveChoice() {
        val loader=javaClass.classLoader
        val google=Class.forName("app.lazysh.push.PushPlugin",false,loader)!=null
        val unified=Class.forName("app.lazysh.unifiedpush.RegistrationService",false,loader)!=null
        assertTrue(google && unified)
        assertFalse(google != unified)
    }
    @Test fun activePendingOrUnknownProviderCannotSwitch() {
        val store=Store();val choice=ProviderSelection(store)
        assertFalse(choice.change("fcm",1){false});assertNull(store.selected)
        var inspected=false
        assertFalse(choice.change("private-invalid",2){inspected=true;true})
        assertFalse(inspected);assertNull(store.selected)
        assertTrue(choice.change("fcm",3){true});assertEquals("fcm",choice.provider())
    }
    @Test fun supersededControlsCannotRegisterOrChangeProvider() {
        val choice=ProviderSelection(Store());val calls=mutableListOf<String>()
        assertTrue(choice.control(8){calls.add(it)})
        assertFalse(choice.change("fcm",7){true})
        assertTrue(choice.change("fcm",9){true})
        assertFalse(choice.control(8){calls.add("stale")})
        assertTrue(choice.control(10){calls.add(it)})
        assertEquals(listOf("unifiedpush","fcm"),calls)
    }
    @Test fun failedDurableChoiceDoesNotReportSuccess() {
        val choice=ProviderSelection(object:ProviderStore {
            override val legacyFcmActive=false
            override var selected:String?
                get()=null
                set(value){throw IllegalStateException("private-write-error")}
        })
        try {choice.change("fcm",1){true};fail("must reject failed persistence")}
        catch(_:IllegalStateException){}
        assertEquals("unifiedpush",choice.provider())
    }
}
