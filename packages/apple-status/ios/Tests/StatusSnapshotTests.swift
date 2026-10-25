import XCTest

final class StatusSnapshotTests: XCTestCase {
  let id = "b11c6ca6-e4f7-4f63-859c-d08e66df2239"
  func snapshot(sequence: UInt64 = 1, subscription: String? = nil, expires: UInt64 = 1060) -> StatusSnapshot {
    StatusSnapshot(subscriptionId: subscription ?? id, sessionId: id, sequence: sequence, observedAt: 1000, expiresAt: expires, running: 1, waiting: 2, usage: nil, approvals: [])
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
    let corrected = StatusSnapshot(subscriptionId: id, sessionId: id, sequence: 2, observedAt: 900, expiresAt: 960, running: 2, waiting: 0, usage: nil, approvals: [])
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
  func testRecordedUsageRetainsSeparateCountersAndDegradesAtOriginalDeadline() throws {
    let report = StatusUsage(inputTokens: 10, outputTokens: nil, cacheReadTokens: 5, cacheWriteTokens: nil, recordedAt: 900, freshness: .fresh, freshUntil: 1800)
    XCTAssertTrue(report.valid(observedAt: 1000))
    XCTAssertEqual(report.freshnessAt(1700), .fresh)
    XCTAssertEqual(report.freshnessAt(1800), .stale)
    let decoded = try JSONDecoder().decode(StatusUsage.self, from: JSONEncoder().encode(report))
    XCTAssertEqual(decoded.recordedAt, 900)
    XCTAssertEqual(decoded.cacheReadTokens, 5)
    XCTAssertNil(decoded.outputTokens)
    XCTAssertEqual(decoded.freshnessAt(1900), .stale)
  }
  func testReviewRejectsColdLaunchAndWaitsForForegroundReceiver() {
    var gate = StatusReviewGate(); var cursor = StatusCursor()
    XCTAssertFalse(gate.capture(subscriptionId: id, cursor: cursor, snapshot: nil, now: 1001))
    XCTAssertTrue(cursor.configure(id, enabled: true))
    XCTAssertFalse(gate.capture(subscriptionId: "b11c6ca6-e4f7-4f63-859c-d08e66df2240", cursor: cursor, snapshot: snapshot(), now: 1001))
    XCTAssertTrue(gate.capture(subscriptionId: id, cursor: cursor, snapshot: snapshot(), now: 1001))
    XCTAssertNil(gate.take(cursor: cursor, snapshot: snapshot(), now: 1002, foreground: false, receiverReady: true))
    XCTAssertNil(gate.take(cursor: cursor, snapshot: snapshot(), now: 1002, foreground: true, receiverReady: false))
    let route = gate.take(cursor: cursor, snapshot: snapshot(), now: 1002, foreground: true, receiverReady: true)
    XCTAssertEqual(route?.subscriptionId, id); XCTAssertEqual(route?.sessionId, id); XCTAssertEqual(route?.expiresAt, 1060)
    XCTAssertNil(gate.take(cursor: cursor, snapshot: snapshot(), now: 1003, foreground: true, receiverReady: true))
  }
  func testReviewCannotBeFreshenedByLaterPublicationOrMovedToAnotherSession() {
    var gate = StatusReviewGate(); var cursor = StatusCursor(); XCTAssertTrue(cursor.configure(id, enabled: true))
    XCTAssertTrue(gate.capture(subscriptionId: id, cursor: cursor, snapshot: snapshot(), now: 1001))
    let newer = StatusSnapshot(subscriptionId: id, sessionId: id, sequence: 2, observedAt: 1050, expiresAt: 1110, running: 1, waiting: 1, usage: nil, approvals: [])
    XCTAssertNil(gate.take(cursor: cursor, snapshot: newer, now: 1061, foreground: true, receiverReady: true))
    XCTAssertTrue(gate.capture(subscriptionId: id, cursor: cursor, snapshot: snapshot(), now: 1001))
    let changedSession = StatusSnapshot(subscriptionId: id, sessionId: "b11c6ca6-e4f7-4f63-859c-d08e66df2240", sequence: 2, observedAt: 1000, expiresAt: 1060, running: 1, waiting: 1, usage: nil, approvals: [])
    XCTAssertNil(gate.take(cursor: cursor, snapshot: changedSession, now: 1002, foreground: true, receiverReady: true))
    XCTAssertTrue(gate.capture(subscriptionId: id, cursor: cursor, snapshot: snapshot(), now: 1001))
    XCTAssertTrue(cursor.configure(id, enabled: false))
    XCTAssertNil(gate.take(cursor: cursor, snapshot: snapshot(), now: 1002, foreground: true, receiverReady: true))
  }
  func testWatchReviewIsBoundToAnApprovalStillPendingAtDelivery() {
    var gate = StatusReviewGate(); var cursor = StatusCursor(); XCTAssertTrue(cursor.configure(id, enabled: true))
    let pending = StatusSnapshot(subscriptionId: id, sessionId: id, sequence: 1, observedAt: 1000, expiresAt: 1060, running: 1, waiting: 1, usage: nil, approvals: [StatusApproval(id: id, expiresAt: 1010)])
    XCTAssertTrue(gate.capture(subscriptionId: id, approvalId: id, cursor: cursor, snapshot: pending, now: 1001))
    XCTAssertNil(gate.take(cursor: cursor, snapshot: snapshot(), now: 1002, foreground: true, receiverReady: true))
    XCTAssertTrue(gate.capture(subscriptionId: id, approvalId: id, cursor: cursor, snapshot: pending, now: 1001))
    let route = gate.take(cursor: cursor, snapshot: pending, now: 1002, foreground: true, receiverReady: true)
    XCTAssertEqual(route?.approvalId, id); XCTAssertEqual(route?.expiresAt, 1010)
  }
}
