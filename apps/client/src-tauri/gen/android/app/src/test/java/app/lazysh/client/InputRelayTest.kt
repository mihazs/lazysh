package app.lazysh.client

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class InputRelayTest {
    private val enter = TerminalKey(code = "Enter", key = "Enter")

    @Test fun whatWasTypedBeforeThePageAsksIsDeliveredOnceInOrder() {
        val relay = InputRelay()
        relay.text("ls"); relay.key(enter); relay.text("\u007f")
        val got = ArrayList<List<SurfaceInput>>()
        relay.take { got += it }
        relay.take { got += it }
        assertEquals(listOf(SurfaceInput.Text("ls"), SurfaceInput.Key(enter), SurfaceInput.Text("\u007f")), got[0])
        assertTrue("a second ask waits, nothing is repeated", got.size == 1)
    }

    @Test fun aWaitingPageGetsTheNextEventAtOnce() {
        val relay = InputRelay()
        val got = ArrayList<List<SurfaceInput>>()
        relay.take { got += it }
        relay.text("a")
        assertEquals(listOf(listOf<SurfaceInput>(SurfaceInput.Text("a"))), got)
    }

    @Test fun aNewerWaitEndsTheOlderWithNothingSoNoEventIsDeliveredTwice() {
        val relay = InputRelay()
        val old = ArrayList<List<SurfaceInput>>(); val new = ArrayList<List<SurfaceInput>>()
        relay.take { old += it }
        relay.take { new += it }
        relay.text("a")
        assertEquals(listOf(emptyList<SurfaceInput>()), old)
        assertEquals(listOf(listOf<SurfaceInput>(SurfaceInput.Text("a"))), new)
    }

    @Test fun composingTextIsReportedOnlyWhenItChanges() {
        val relay = InputRelay()
        relay.preedit("に"); relay.preedit("に"); relay.preedit(null); relay.preedit(null)
        val got = ArrayList<List<SurfaceInput>>()
        relay.take { got += it }
        assertEquals(listOf(SurfaceInput.Preedit("に"), SurfaceInput.Preedit(null)), got.single())
    }

    @Test fun aSurfaceThatEndedLeavesNothingForALaterPage() {
        val relay = InputRelay()
        relay.text("secret"); relay.clear()
        val got = ArrayList<List<SurfaceInput>>()
        relay.take { got += it }
        assertTrue(got.isEmpty())
    }

    @Test fun removingTheSurfaceCompletesItsPendingInputPollExactlyOnce() {
        val relay = InputRelay()
        val completions = ArrayList<List<SurfaceInput>>()
        relay.take { completions += it }
        relay.clear()
        relay.clear()
        relay.text("late")
        assertEquals(listOf(emptyList<SurfaceInput>()), completions)
    }

    @Test fun aToolbarBarrierFollowsEarlierCommitsAndPrecedesLaterCommits() {
        val relay = InputRelay()
        val got = ArrayList<List<SurfaceInput>>()
        relay.take { got += it }
        relay.text("a")
        relay.mark(12)
        relay.text("b")
        relay.take { got += it }
        assertEquals(listOf(SurfaceInput.Text("a"), SurfaceInput.Barrier(12), SurfaceInput.Text("b")), got.flatten())
    }

    @Test fun aPasteKeepsItsPlaceBetweenTypedText() {
        val relay = InputRelay()
        relay.text("a"); relay.paste("b\nc"); relay.text("d")
        val got = ArrayList<List<SurfaceInput>>()
        relay.take { got += it }
        assertEquals(listOf(SurfaceInput.Text("a"), SurfaceInput.Paste("b\nc"), SurfaceInput.Text("d")), got.single())
    }
}
