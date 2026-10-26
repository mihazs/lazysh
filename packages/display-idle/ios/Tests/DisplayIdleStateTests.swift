import XCTest

final class DisplayIdleStateTests: XCTestCase {
  func testTicketOrderingCancellationAndEpoch() throws {
    var flag = false
    let state = DisplayIdleState(set: { flag = $0 }, read: { flag })
    XCTAssertEqual(state.epoch, state.epoch.lowercased())
    let epoch = state.epoch; let first = try state.issue(); let second = try state.issue()
    XCTAssertFalse(flag)
    try state.acquire(epoch: epoch, ticket: first, ready: true)
    _ = try state.issue(); XCTAssertTrue(state.active)
    try state.acquire(epoch: epoch, ticket: second, ready: true)
    try state.release(epoch: epoch, ticket: first); XCTAssertTrue(flag)
    try state.release(epoch: epoch, ticket: second); XCTAssertFalse(flag)
    XCTAssertThrowsError(try state.acquire(epoch: epoch, ticket: second, ready: true))
    let cancelled = try state.issue(); try state.release(epoch: epoch, ticket: cancelled)
    XCTAssertThrowsError(try state.acquire(epoch: epoch, ticket: cancelled, ready: true))
    let held = try state.issue(); try state.acquire(epoch: epoch, ticket: held, ready: true)
    try state.invalidate(); XCTAssertFalse(flag); XCTAssertNotEqual(epoch, state.epoch)
    XCTAssertEqual(state.epoch, state.epoch.lowercased())
    XCTAssertThrowsError(try state.acquire(epoch: epoch, ticket: held, ready: true))
  }
  func testUnavailableAndFailedSetterDoNotSucceed() throws {
    let state = DisplayIdleState(set: { _ in }, read: { false })
    let epoch = state.epoch
    XCTAssertThrowsError(try state.acquire(epoch: epoch, ticket: state.issue(), ready: false))
    XCTAssertThrowsError(try state.acquire(epoch: epoch, ticket: 0, ready: true))
    XCTAssertThrowsError(try state.acquire(epoch: epoch, ticket: DisplayIdleState.maxTicket + 1, ready: true))
    XCTAssertThrowsError(try state.acquire(epoch: epoch, ticket: state.issue(), ready: true))
    XCTAssertFalse(state.active)
  }
  func testFailedReleaseIsRetried() throws {
    var flag = false; var fail = false
    let state = DisplayIdleState(set: { if fail { throw DisplayIdleError.flagNotApplied }; flag = $0 }, read: { flag })
    let epoch = state.epoch; let ticket = try state.issue()
    try state.acquire(epoch: epoch, ticket: ticket, ready: true); fail = true
    XCTAssertThrowsError(try state.release(epoch: epoch, ticket: ticket)); XCTAssertTrue(state.active)
    fail = false; try state.release(epoch: epoch, ticket: ticket); XCTAssertFalse(flag)
  }
}
