import XCTest
import UIKit

@MainActor
final class DisplayIdleApplicationTests: XCTestCase {
  func testRealIdleTimerOwnershipAndInvalidation() throws {
    XCTAssertTrue(Thread.isMainThread)
    let application = UIApplication.shared
    let previous = application.isIdleTimerDisabled
    defer { application.isIdleTimerDisabled = previous }
    let state = DisplayIdleState(set: { application.isIdleTimerDisabled = $0 }, read: { application.isIdleTimerDisabled })
    let epoch = state.epoch; let first = try state.issue(); let second = try state.issue()
    try state.acquire(epoch: epoch, ticket: first, ready: true)
    XCTAssertTrue(application.isIdleTimerDisabled)
    try state.acquire(epoch: epoch, ticket: second, ready: true)
    try state.release(epoch: epoch, ticket: first); XCTAssertTrue(application.isIdleTimerDisabled)
    try state.invalidate(); XCTAssertFalse(application.isIdleTimerDisabled)
  }
}
