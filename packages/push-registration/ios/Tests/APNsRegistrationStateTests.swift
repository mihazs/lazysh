import Foundation
import XCTest

final class APNsRegistrationStateTests: XCTestCase {
  func testCallbackIsRequiredAndTokenIsEphemeral() {
    let state = APNsRegistrationState()
    var completed: Bool?
    XCTAssertTrue(state.begin(1) { completed = $0 })
    XCTAssertNil(completed); XCTAssertNil(state.token); XCTAssertTrue(state.busy)
    XCTAssertTrue(state.markDispatched(1))
    XCTAssertTrue(state.registered(Data([1, 2, 3]), context: state.callbackContext()))
    XCTAssertEqual(completed, true); XCTAssertFalse(state.busy)
    XCTAssertEqual(state.token, Data([1, 2, 3]))
    XCTAssertNil(APNsRegistrationState().token)
  }
  func testDisableSettlesPendingAndIgnoresLateToken() {
    let state = APNsRegistrationState()
    var completed: Bool?
    state.begin(1) { completed = $0 }
    XCTAssertTrue(state.disable(2)); XCTAssertEqual(completed, false)
    XCTAssertFalse(state.registered(Data([9]), context: state.callbackContext()))
    XCTAssertFalse(state.enabled); XCTAssertNil(state.token)
    XCTAssertFalse(state.begin(1) { XCTAssertFalse($0) })
  }
  func testTimeoutCannotCancelNewerExplicitConsent() {
    let state = APNsRegistrationState()
    state.begin(1) { XCTAssertFalse($0) }
    XCTAssertTrue(state.timedOut(1)); XCTAssertFalse(state.busy)
    state.begin(2) { XCTAssertTrue($0) }
    XCTAssertFalse(state.timedOut(1)); XCTAssertFalse(state.disable(1))
    XCTAssertTrue(state.isPending(2))
    XCTAssertTrue(state.markDispatched(2))
    XCTAssertTrue(state.registered(Data([7]), context: state.callbackContext()))
  }
  func testRotationOnlyUpdatesOptedInStateAndFailureClearsIt() {
    let state = APNsRegistrationState()
    XCTAssertFalse(state.registered(Data([1]), context: state.callbackContext()))
    state.begin(1) { XCTAssertTrue($0) }
    XCTAssertTrue(state.markDispatched(1))
    state.registered(Data([1]), context: state.callbackContext()); state.registered(Data([2]), context: state.callbackContext())
    XCTAssertEqual(state.token, Data([2]))
    state.failed(); XCTAssertNil(state.token); XCTAssertFalse(state.enabled)
  }
  func testQueuedOldCallbackCannotCompleteOrFailNewerUndispatchedRequest() {
    let state = APNsRegistrationState()
    state.begin(1) { XCTAssertFalse($0) }; XCTAssertTrue(state.markDispatched(1))
    let old = state.callbackContext()
    state.disable(2)
    var newest: Bool?
    state.begin(3) { newest = $0 }
    XCTAssertFalse(state.registered(Data([1]), context: old))
    XCTAssertFalse(state.callbackFailed(old))
    XCTAssertFalse(state.registered(Data([2]), context: state.callbackContext()))
    XCTAssertTrue(state.isPending(3)); XCTAssertNil(newest); XCTAssertNil(state.token)
    XCTAssertTrue(state.markDispatched(3))
    XCTAssertTrue(state.registered(Data([3]), context: state.callbackContext()))
    XCTAssertEqual(newest, true)
  }
}
