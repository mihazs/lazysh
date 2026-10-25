import XCTest

final class StatusSnapshotTests: XCTestCase {
  let id = "b11c6ca6-e4f7-4f63-859c-d08e66df2239"
  func snapshot(sequence: UInt64 = 1, subscription: String? = nil, expires: UInt64 = 1060) -> StatusSnapshot {
    StatusSnapshot(subscriptionId: subscription ?? id, sessionId: id, sequence: sequence, observedAt: 1000, expiresAt: expires, running: 1, waiting: 2, totalTokens: 50, approvals: [])
  }
  func testCancellationAndReenableRejectQueuedOldSubscription() {
    var cursor = StatusCursor(); XCTAssertTrue(cursor.configure(id, enabled: true))
    XCTAssertTrue(cursor.accept(snapshot(), now: 1001))
    XCTAssertFalse(cursor.accept(snapshot(), now: 1001))
    XCTAssertTrue(cursor.configure(id, enabled: false))
    XCTAssertFalse(cursor.accept(snapshot(sequence: 2), now: 1001))
    XCTAssertTrue(cursor.configure("b11c6ca6-e4f7-4f63-859c-d08e66df2240", enabled: true))
    XCTAssertTrue(cursor.configure(id, enabled: false))
    XCTAssertEqual(cursor.subscriptionId, "b11c6ca6-e4f7-4f63-859c-d08e66df2240")
    XCTAssertFalse(cursor.configure(id, enabled: true))
    XCTAssertFalse(cursor.accept(snapshot(sequence: 3), now: 1001))
  }
  func testExpiryClockAndSequence() {
    XCTAssertFalse(snapshot().valid(now: 1060))
    XCTAssertFalse(snapshot().valid(now: 990))
    XCTAssertFalse(snapshot(expires: 1061).valid(now: 1001))
    var cursor = StatusCursor(); XCTAssertTrue(cursor.configure(id, enabled: true))
    XCTAssertTrue(cursor.accept(snapshot(sequence: 2), now: 1001))
    XCTAssertFalse(cursor.accept(snapshot(), now: 1001))
  }
  func testDeliveryOrderingSurvivesClockRollbackAndClears() {
    var inbox = StatusInbox()
    XCTAssertTrue(inbox.receive(StatusEnvelope(snapshot: snapshot(), deliveryId: id, deliverySequence: 1), now: 1001))
    let corrected = StatusSnapshot(subscriptionId: id, sessionId: id, sequence: 2, observedAt: 900, expiresAt: 960, running: 2, waiting: 0, totalTokens: nil, approvals: [])
    XCTAssertTrue(inbox.receive(StatusEnvelope(snapshot: corrected, deliveryId: id, deliverySequence: 2), now: 901))
    XCTAssertEqual(inbox.snapshot?.running, 2)
    XCTAssertTrue(inbox.receive(StatusEnvelope(snapshot: nil, deliveryId: id, deliverySequence: 3), now: 890))
    XCTAssertNil(inbox.snapshot)
    XCTAssertFalse(inbox.receive(StatusEnvelope(snapshot: snapshot(), deliveryId: id, deliverySequence: 2), now: 1001))
  }
  func testProcessRestartRejectsLatePreviousProcessAndPersistsOrdering() throws {
    var inbox = StatusInbox()
    XCTAssertTrue(inbox.receive(StatusEnvelope(snapshot: snapshot(), deliveryId: id, deliverySequence: 10), now: 1001))
    let newer = "b11c6ca6-e4f7-4f63-859c-d08e66df2240"
    XCTAssertTrue(inbox.receive(StatusEnvelope(snapshot: nil, deliveryId: newer, deliverySequence: 1), now: 1001))
    inbox = try JSONDecoder().decode(StatusInbox.self, from: JSONEncoder().encode(inbox))
    XCTAssertFalse(inbox.receive(StatusEnvelope(snapshot: snapshot(), deliveryId: id, deliverySequence: 11), now: 1001))
    XCTAssertNil(inbox.snapshot)
  }
}
