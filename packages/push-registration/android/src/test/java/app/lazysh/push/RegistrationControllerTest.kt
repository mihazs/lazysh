package app.lazysh.push

import org.junit.Assert.*
import org.junit.Test

class RegistrationControllerTest {
    private class Store : RegistrationStore { override var enabled = false; override var tokenPresent = false }
    private class Driver : MessagingDriver {
        var auto = false
        var tokenRequests = 0
        var deletions = 0
        lateinit var tokenDone: (Boolean) -> Unit
        lateinit var deleteDone: (Boolean) -> Unit
        override fun autoInit(enabled: Boolean) { auto = enabled }
        override fun token(done: (Boolean) -> Unit) { tokenRequests++; tokenDone = done }
        override fun delete(done: (Boolean) -> Unit) { deletions++; deleteDone = done }
    }
    @Test fun unconfiguredBuildRetainsConservativeFcmMarkersWithoutStartingRequests() {
        for(enabled in listOf(false,true))for(token in listOf(false,true)) {
            assertEquals(FcmPresence(enabled,token),fcmPresence(null,enabled,token))
        }
        val store=Store();val driver=Driver();val controller=RegistrationController(store,driver)
        assertEquals(FcmPresence(false,false),fcmPresence(controller,true,true))
        assertEquals(0,driver.tokenRequests);assertEquals(0,driver.deletions)
    }
    @Test fun registerRequiresExplicitCallAndTracksNativeRotation() {
        val store = Store(); val driver = Driver(); val controller = RegistrationController(store, driver)
        assertFalse(controller.enabled); assertEquals(0, driver.tokenRequests)
        var result = false
        controller.register { result = it }; assertTrue(driver.auto); assertTrue(controller.busy)
        driver.tokenDone(true); assertTrue(result); assertTrue(controller.tokenPresent)
        controller.rotated(); assertTrue(controller.tokenPresent); assertEquals(0, driver.deletions)
    }
    @Test fun disableDuringTokenCreationWaitsThenDeletesLateToken() {
        val store = Store(); val driver = Driver(); val controller = RegistrationController(store, driver)
        var registered: Boolean? = null; var disabled: Boolean? = null
        controller.register { registered = it }; controller.disable { disabled = it }
        assertFalse(driver.auto); assertFalse(controller.enabled); assertNull(disabled); assertEquals(0, driver.deletions)
        controller.register { assertFalse(it) }; assertEquals(1, driver.tokenRequests)
        driver.tokenDone(true); assertEquals(false, registered); assertEquals(1, driver.deletions); assertNull(disabled)
        driver.deleteDone(true); assertEquals(true, disabled); assertFalse(controller.tokenPresent); assertFalse(controller.busy)
    }
    @Test fun failedRevocationRetainsRetryMarkerAndAllowsExplicitRetry() {
        val store = Store(); val driver = Driver(); val controller = RegistrationController(store, driver)
        controller.disable { assertFalse(it) }; driver.deleteDone(false)
        assertTrue(controller.tokenPresent); assertFalse(controller.enabled)
        controller.disable { assertTrue(it) }; driver.deleteDone(true)
        assertFalse(controller.tokenPresent); assertEquals(2, driver.deletions)
    }
    @Test fun rotationAfterCompletedPauseRetainsFailedDeletionUntilExplicitRetry() {
        val store=Store();val driver=Driver();val controller=RegistrationController(store,driver)
        controller.disable(1){assertTrue(it)};driver.deleteDone(true)
        assertFalse(controller.tokenPresent)
        controller.rotated();assertTrue(controller.busy);driver.deleteDone(false)
        assertFalse(controller.enabled);assertTrue(controller.tokenPresent);assertFalse(controller.busy)
        val choice=ProviderSelection(object:ProviderStore {
            override var selected:String?="unifiedpush"
            override val legacyFcmActive=true
        })
        fun cleanup(active:Boolean)=previousFcmCleanup(choice.provider(),active,fcmPresence(controller,false,false),controller.busy)
        assertEquals(PreviousFcmCleanup(true,false),cleanup(true))
        assertEquals(2,driver.deletions) // inspecting/pausing UP never deletes previous FCM
        assertEquals(PreviousFcmCleanup(true,true),cleanup(false))
        controller.disable(2){assertFalse(it)};driver.deleteDone(false)
        assertTrue(controller.tokenPresent);assertTrue(cleanup(false).pending)
        controller.disable(3){assertTrue(it)};driver.deleteDone(true)
        assertFalse(controller.tokenPresent);assertFalse(cleanup(false).pending)
        assertEquals("unifiedpush",choice.provider());assertEquals(0,driver.tokenRequests)
    }
    @Test fun unsolicitedRotationWhilePausedIsRevokedWithoutOptingIn() {
        val store = Store(); val driver = Driver(); val controller = RegistrationController(store, driver)
        controller.rotated(); assertFalse(controller.enabled); assertEquals(1, driver.deletions)
        driver.deleteDone(true); assertFalse(controller.tokenPresent); assertFalse(driver.auto)
    }
    @Test fun rotationDuringRevocationMustBeDeletedBeforeAcknowledgement() {
        val store = Store(); val driver = Driver(); val controller = RegistrationController(store, driver)
        var done = false
        controller.disable { done = it }; controller.rotated(); driver.deleteDone(true)
        assertFalse(done); assertEquals(2, driver.deletions)
        driver.deleteDone(true); assertTrue(done); assertFalse(controller.tokenPresent)
    }
    @Test fun delayedRegisterCannotUndoNewerPauseAndOldPauseCannotUndoNewConsent() {
        val store = Store(); val driver = Driver(); val controller = RegistrationController(store, driver)
        controller.disable(2) { assertTrue(it) }; driver.deleteDone(true)
        controller.register(1) { assertFalse(it) }; assertEquals(0, driver.tokenRequests)
        controller.register(3) { assertTrue(it) }; driver.tokenDone(true)
        controller.disable(2) { assertFalse(it) }; assertTrue(controller.enabled); assertEquals(1, driver.deletions)
    }
}
