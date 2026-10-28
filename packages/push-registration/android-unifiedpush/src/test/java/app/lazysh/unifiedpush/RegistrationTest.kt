package app.lazysh.unifiedpush

import org.junit.Assert.*
import org.junit.Test

class RegistrationTest {
    private class Fixture(initial: Registration = Registration()) {
        val store = object : RegistrationStore { override var value = initial }
        val requested = mutableListOf<String>()
        val removed = mutableListOf<String>()
        var removalFails = false
        var next = 0
        var choose: ((Boolean) -> Unit)? = null
        val replies = mutableListOf<Boolean>()
        val driver = object : DistributorDriver {
            override fun register(instance: String) { requested.add(instance) }
            override fun unregister(instance: String) {
                assertFalse(store.value.enabled)
                assertEquals(Phase.REVOKE_PENDING, store.value.phase)
                if (removalFails) throw IllegalStateException("private driver error")
                removed.add(instance)
            }
        }
        val controller = controller()
        fun controller() = RegistrationController(store, driver) { "instance-${++next}" }
        fun start(epoch: Long = 1) {
            controller.register(epoch, { choose = it }, replies::add)
        }
        fun ready(): String {
            start()
            choose!!(true)
            val instance = requested.single()
            controller.endpoint(instance, true, false)
            return instance
        }
    }

    @Test fun explicitSelectionIsRequiredBeforeRegisterAndEndpointIsNotDelivery() {
        val f = Fixture()
        assertEquals(Registration(), f.controller.registration)
        f.start()
        assertTrue(f.controller.busy)
        assertTrue(f.requested.isEmpty())
        f.choose!!(true)
        assertEquals(listOf("instance-1"), f.requested)
        assertEquals(listOf(true), f.replies)
        assertEquals(Phase.REQUESTED, f.controller.registration.phase)
        f.controller.endpoint("instance-1", true, false)
        assertEquals(Registration("instance-1", true, Phase.READY), f.controller.registration)
        assertFalse(f.controller.busy)
    }

    @Test fun disableDuringSelectionPreventsTheLateRegisterAndStaleEpoch() {
        val f = Fixture()
        f.start(1)
        assertTrue(f.controller.disable(2))
        f.choose!!(true)
        assertTrue(f.requested.isEmpty())
        assertEquals(listOf(false), f.replies)
        f.start(1)
        assertEquals(listOf(false, false), f.replies)
        assertEquals(Registration(), f.controller.registration)
    }

    @Test fun selectionCancellationAndOverlappingControlDoNotGrantRegistration() {
        val f = Fixture()
        f.start()
        f.start(2)
        assertEquals(listOf(false), f.replies)
        f.choose!!(false)
        assertEquals(listOf(false, false), f.replies)
        assertTrue(f.requested.isEmpty())
        assertFalse(f.controller.busy)
        assertEquals(Registration(), f.controller.registration)
    }

    @Test fun localRevocationFailureStaysOffAndRequiresCleanupBeforeRegister() {
        val f = Fixture()
        val instance = f.ready()
        f.removalFails = true
        assertFalse(f.controller.disable(2))
        assertEquals(Registration(instance, false, Phase.REVOKE_PENDING), f.controller.registration)
        f.controller.endpoint(instance, true, false)
        f.start(3)
        assertEquals(1, f.requested.size)
        assertEquals(Phase.REVOKE_PENDING, f.controller.registration.phase)
        f.removalFails = false
        assertTrue(f.controller.disable(4))
        assertEquals(listOf(instance), f.removed)
        assertEquals(Registration(), f.controller.registration)
    }

    @Test fun oldInstanceCannotReviveOrRemoveNewConsent() {
        val f = Fixture()
        val old = f.ready()
        assertTrue(f.controller.disable(2))
        f.start(3)
        f.choose!!(true)
        f.controller.endpoint(old, true, false)
        f.controller.unregistered(old)
        f.controller.failed(old)
        f.controller.unavailable(old)
        assertEquals(Registration("instance-2", true, Phase.REQUESTED), f.controller.registration)
        assertEquals(listOf(old, "instance-2"), f.requested)
    }

    @Test fun duplicatePickerCallbacksCannotDispatchOrConsumeAnotherSelection() {
        val f = Fixture()
        f.start()
        val original = f.choose!!
        original(true)
        original(true)
        f.start(2)
        original(false)
        assertTrue(f.controller.busy)
        assertEquals(listOf("instance-1"), f.requested)
        f.choose!!(true)
        assertEquals(listOf("instance-1", "instance-1"), f.requested)
        assertEquals(listOf(true, true), f.replies)
    }

    @Test fun refreshReusesTheInstanceAndFiniteEndpointLifecycle() {
        val f = Fixture()
        val instance = f.ready()
        f.start(2)
        f.choose!!(true)
        assertEquals(listOf(instance, instance), f.requested)
        for ((usable, temporary, expected) in listOf(
            Triple(true, true, Phase.UNAVAILABLE), Triple(false, false, Phase.FAILED), Triple(true, false, Phase.READY),
        )) {
            f.controller.endpoint(instance, usable, temporary)
            assertEquals(expected, f.controller.registration.phase)
        }
        f.controller.failed(instance)
        assertEquals(Phase.FAILED, f.controller.registration.phase)
        f.controller.unavailable(instance)
        assertEquals(Phase.UNAVAILABLE, f.controller.registration.phase)
        f.controller.unregistered(instance)
        assertEquals(Registration(), f.controller.registration)
    }

    @Test fun restartRestoresConsentWithoutIssuingAutomaticRegistration() {
        val f = Fixture()
        val instance = f.ready()
        val restarted = f.controller()
        assertEquals(f.controller.registration, restarted.registration)
        assertEquals(listOf(instance), f.requested)
        assertFalse(restarted.busy)
        assertTrue(restarted.disable(1))
        assertEquals(Registration(), restarted.registration)
    }

    @Test fun endpointBoundsDoNotStripOpaqueQueryOrPermitCredentialsAndFragments() {
        val base = "https://push.example/"
        assertTrue(usableEndpoint(base + "x".repeat(1000 - base.length), true))
        val unicode = base + "é".repeat((1000 - base.length) / 2)
        assertTrue(usableEndpoint(unicode, true))
        assertFalse(usableEndpoint(unicode + "é", true))
        assertTrue(usableEndpoint(base + "opaque?capability=private", true))
        for (url in listOf(base + "x".repeat(1001 - base.length), "http://push.example/x",
            "https://user:password@push.example/x", base + "x#fragment", "https:///missing-host", base + "x\n")) {
            assertFalse(usableEndpoint(url, true))
        }
        assertFalse(usableEndpoint(base, false))
    }
}
