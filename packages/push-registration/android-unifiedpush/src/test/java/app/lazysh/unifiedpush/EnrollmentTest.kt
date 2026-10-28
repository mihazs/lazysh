package app.lazysh.unifiedpush

import java.util.ArrayDeque
import java.util.UUID
import java.util.concurrent.Executor
import org.junit.Assert.*
import org.junit.Test

class EnrollmentTest {
    @Test fun nativeOriginAndCapabilityAdmissionRejectsCredentialsPathsControlsAndOverflow() {
        assertEquals("https://relay.example",relayOrigin("https://RELAY.example:443/"))
        assertEquals("https://relay.example:8443",relayOrigin("https://relay.example:8443"))
        for (origin in listOf("http://relay.example","https://user:pass@relay.example","https://relay.example/path",
            "https://relay.example?secret=value","https://relay.example#fragment","https://relay.example/\n",
            "https://relay.example:0","https://"+"a".repeat(2049))) {
            try {relayOrigin(origin);fail("Unsafe origin must be rejected")} catch (_:Exception) {}
        }
        assertTrue(capability("d".repeat(64)))
        for (value in listOf("d".repeat(63),"d".repeat(65),"g".repeat(64),"d".repeat(63)+"\n")) assertFalse(capability(value))
    }
    @Test fun cancellationBeforeAndAfterCallInstallationRetiresExactlyTheOwnedAbort() {
        val early=EnrollmentCall()
        var earlyAborts=0
        early.cancel()
        early.install {earlyAborts++}
        assertFalse(early.active())
        assertEquals(1,earlyAborts)
        val admitted=EnrollmentCall()
        var admittedAborts=0
        admitted.install {admittedAborts++}
        admitted.cancel();admitted.cancel()
        assertFalse(admitted.active())
        assertEquals(1,admittedAborts)
        val failing=EnrollmentCall()
        failing.install {error("private driver failure")}
        failing.cancel()
        assertFalse(failing.active())
    }
    @Test fun privateRequestBodyIsOneShotAndRefusesASecondWrite() {
        val bytes="owned-body".toByteArray(Charsets.UTF_8)
        val body=PrivateRequestBody(bytes)
        assertTrue(body.isOneShot())
        val first=okio.Buffer()
        body.writeTo(first)
        assertTrue(first.readByteArray().contentEquals(bytes))
        val second=okio.Buffer()
        try {body.writeTo(second);fail("Must not replay a private body")} catch (_:IllegalStateException) {}
        assertEquals(0L,second.size)
    }
    private class Queue : Executor {
        val tasks=ArrayDeque<Runnable>()
        override fun execute(command:Runnable) { tasks.add(command) }
        fun next() { tasks.removeFirst().run() }
    }
    private class Fixture {
        var sequence=0L
        fun id()=UUID(1,++sequence).toString()
        val queue=Queue()
        var stored:EnrollmentState?=null
        var failStorage=false
        val store=object:EnrollmentStore {
            override var value:EnrollmentState?
                get()=stored
                set(value) { if (failStorage) error("private storage failure"); stored=value }
        }
        val calls=mutableListOf<String>()
        var duringBootstrap:(()->Unit)?=null
        var duringConfirm:(()->Unit)?=null
        var challengeId=id()
        val deviceId=id()
        val replies=mutableListOf<Boolean>()
        val registrationStore=object:RegistrationStore { override var value=Registration() }
        val requested=mutableListOf<String>()
        lateinit var enrollment:EnrollmentController
        val registration=RegistrationController(registrationStore,object:DistributorDriver {
            override fun register(instance:String) {
                assertEquals("B"+"A".repeat(86),enrollment.bind(instance))
                requested.add(instance)
            }
            override fun unregister(instance:String) { assertFalse(registrationStore.value.enabled) }
        },::id)
        val gate=RegistrationEnrollmentGate(registration)
        val relay=object:EnrollmentRelay {
            override fun bootstrap(state:EnrollmentState,call:EnrollmentCall):BootstrapReply {
                assertEquals(state,stored)
                calls.add("bootstrap")
                duringBootstrap?.invoke()
                return BootstrapReply(deviceId,7,"B"+"A".repeat(86))
            }
            override fun subscribe(state:EnrollmentState,call:EnrollmentCall):String {
                assertEquals(state,stored)
                calls.add("subscribe")
                return challengeId
            }
            override fun confirm(state:EnrollmentState,proof:Challenge,call:EnrollmentCall) {
                assertEquals(challengeId,proof.challengeId)
                calls.add("confirm")
                duringConfirm?.invoke()
            }
            override fun revoke(state:EnrollmentState,call:EnrollmentCall) { calls.add("revoke") }
        }
        init { enrollment=controller() }
        fun controller()=EnrollmentController(store,relay,gate,queue,::id,{ "e".repeat(64) })
        fun begin(epoch:Long=1) {
            assertTrue(registration.reserveEnrollment(epoch))
            enrollment.begin(epoch,"https://relay.example","d".repeat(64),replies::add)
        }
        fun registered():String {
            begin(); queue.next()
            assertEquals(listOf(true),replies)
            registration.register(1,{it(true)},{assertTrue(it)})
            return requested.single().also { registration.endpoint(it,true,false) }
        }
        fun endpoint(instance:String) {
            enrollment.endpoint(instance,EndpointKeys("https://push.example/up/owned?cap=A%2fB","B"+"A".repeat(86),"A".repeat(22)))
        }
        fun proof()=Challenge(deviceId,7,challengeId,"f".repeat(64))
        fun verified():String {
            val instance=registered()
            endpoint(instance); queue.next()
            enrollment.message(instance,proof()); queue.next()
            assertEquals(EnrollmentPhase.CONFIRMED,stored!!.phase)
            return instance
        }
        fun pause(epoch:Long=2) {
            assertTrue(registration.disable(epoch) {enrollment.cancel()})
            enrollment.pause()
        }
    }

    @Test fun bootstrapIsPersistedBeforeNetworkingAndEarlyChallengeWaitsForExactResponse() {
        val f=Fixture()
        f.begin()
        assertTrue(f.calls.isEmpty())
        assertEquals(EnrollmentPhase.BOOTSTRAP,f.stored!!.phase)
        assertFalse(f.stored.toString().contains("d".repeat(64)))
        f.queue.next()
        f.registration.register(1,{it(true)},{assertTrue(it)})
        val instance=f.requested.single()
        f.registration.endpoint(instance,true,false)
        f.endpoint(instance)
        f.enrollment.message(instance,f.proof())
        assertEquals(listOf("bootstrap"),f.calls)
        f.queue.next()
        assertEquals(listOf("bootstrap","subscribe"),f.calls)
        assertEquals(EnrollmentPhase.VERIFY,f.stored!!.phase)
        f.queue.next()
        assertEquals(listOf("bootstrap","subscribe","confirm"),f.calls)
        assertEquals(EnrollmentPhase.CONFIRMED,f.stored!!.phase)
        assertNull(f.stored!!.enrollment)
        assertNull(f.stored!!.challengeId)
    }
    @Test fun wrongDeviceGenerationChallengeAndInstanceNeverReachConfirmation() {
        val f=Fixture()
        val instance=f.registered()
        f.endpoint(instance); f.queue.next()
        val proof=f.proof()
        for (wrong in listOf(proof.copy(deviceId=f.id()),proof.copy(generation=8),proof.copy(challengeId=f.id())))
            f.enrollment.message(instance,wrong)
        f.enrollment.message(f.id(),proof)
        assertTrue(f.queue.tasks.isEmpty())
        assertEquals(EnrollmentPhase.VERIFY,f.stored!!.phase)
        assertEquals(listOf("bootstrap","subscribe"),f.calls)
    }
    @Test fun pauseBeforeDequeueCancelsBootstrapWithoutSendingAndKeepsCleanupSingleFlight() {
        val f=Fixture()
        f.begin()
        f.pause()
        f.pause(3)
        f.queue.next()
        assertTrue(f.calls.isEmpty())
        assertEquals(listOf(false),f.replies)
        f.queue.next()
        assertEquals(listOf("revoke"),f.calls)
        assertNull(f.stored)
        assertEquals(Registration(),f.registration.registration)
        assertTrue(f.queue.tasks.isEmpty())
    }
    @Test fun newerReservedControlRetiresQueuedBootstrapBeforeNetworkAdmission() {
        val f=Fixture()
        f.begin()
        assertTrue(f.registration.reserveEnrollment(2))
        f.queue.next()
        assertTrue(f.calls.isEmpty())
        assertEquals(listOf(false),f.replies)
        assertEquals(EnrollmentPhase.FAILED,f.stored!!.phase)
    }
    @Test fun pauseDuringAdmittedBootstrapRejectsLatePublicationAndRevokesOriginalCredential() {
        val f=Fixture()
        f.begin()
        f.duringBootstrap={f.pause()}
        f.queue.next()
        assertEquals(listOf("bootstrap"),f.calls)
        assertEquals(listOf(false),f.replies)
        assertEquals(EnrollmentPhase.REVOKE_PENDING,f.stored!!.phase)
        assertNull(f.stored!!.deviceId)
        assertTrue(f.requested.isEmpty())
        f.queue.next()
        assertNull(f.stored)
    }
    @Test fun changedPrivateSnapshotCannotBeUsedByQueuedWorkOrLatePublication() {
        val f=Fixture()
        f.begin()
        f.stored=f.stored!!.copy(origin="https://replacement.example")
        f.queue.next()
        assertTrue(f.calls.isEmpty())
        assertEquals(listOf(false),f.replies)
        assertEquals("https://replacement.example",f.stored!!.origin)
    }
    @Test fun endpointRotationCannotUsePriorChallengeAndRestartDoesNotStartNetworking() {
        val f=Fixture()
        val instance=f.verified()
        val prior=f.proof()
        f.challengeId=f.id()
        f.enrollment.endpoint(instance,EndpointKeys("https://push.example/up/rotated","B"+"A".repeat(86),"A".repeat(22)))
        f.enrollment.message(instance,prior)
        f.queue.next()
        assertTrue(f.queue.tasks.isEmpty())
        assertEquals(EnrollmentPhase.VERIFY,f.stored!!.phase)
        f.enrollment.message(instance,f.proof()); f.queue.next()
        val count=f.calls.size
        val restored=f.controller()
        assertEquals(EnrollmentPhase.CONFIRMED,restored.state()!!.phase)
        assertEquals(count,f.calls.size)
        assertFalse(restored.busy())
        assertTrue(f.queue.tasks.isEmpty())
    }
    @Test fun keystoreWriteFailureHasNoPlaintextFallbackOrNetworkAndPoisonsFurtherAdmission() {
        val f=Fixture()
        f.failStorage=true
        try { f.begin(); fail("Expected unavailable storage") } catch (_:IllegalStateException) {}
        assertTrue(f.calls.isEmpty())
        assertTrue(f.queue.tasks.isEmpty())
        assertTrue(f.enrollment.unavailable())
        f.failStorage=false
        try { f.enrollment.state(); fail("Must not revive after storage failure") } catch (_:IllegalStateException) {}
        assertNull(f.stored)
    }
    @Test fun failedPersistenceAfterRemoteConfirmationCannotPublishNativeConfirmation() {
        val f=Fixture()
        val instance=f.registered()
        f.endpoint(instance); f.queue.next()
        f.duringConfirm={f.failStorage=true}
        f.enrollment.message(instance,f.proof()); f.queue.next()
        assertTrue(f.enrollment.unavailable())
        assertEquals(EnrollmentPhase.VERIFY,f.stored!!.phase)
        assertEquals(listOf("bootstrap","subscribe","confirm"),f.calls)
        assertFalse(f.enrollment.busy())
    }
    @Test fun displayAuthorityIsConfirmedCurrentAndCannotBeCapturedAcrossRotationOrPause() {
        val f=Fixture()
        val instance=f.registered()
        var admitted=0
        assertFalse(f.enrollment.withConfirmed(instance) {admitted++})
        f.endpoint(instance);f.queue.next()
        f.enrollment.message(instance,f.proof());f.queue.next()
        var original:DisplayBinding?=null
        assertTrue(f.enrollment.withConfirmed(instance) {original=it;admitted++})
        assertFalse(f.enrollment.withConfirmed(f.id()) {admitted++})
        f.challengeId=f.id()
        f.enrollment.endpoint(instance,EndpointKeys("https://push.example/up/new","B"+"A".repeat(86),"A".repeat(22)))
        assertFalse(f.enrollment.withConfirmed(instance) {admitted++})
        f.queue.next();f.enrollment.message(instance,f.proof());f.queue.next()
        assertTrue(f.enrollment.withConfirmed(instance) {assertNotEquals(original,it);admitted++})
        f.pause()
        assertFalse(f.enrollment.withConfirmed(instance) {admitted++})
        assertEquals(2,admitted)
    }
}
