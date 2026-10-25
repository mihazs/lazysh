import XCTest

final class ResumeGateTests: XCTestCase {
  func testUnknownStartsCoveredAndDisabledPolicyPreservesDefaults() {
    var gate = ResumeGate()
    XCTAssertTrue(gate.covered)
    XCTAssertTrue(gate.apply(covered: false, enabled: false, generation: 1, nativeGeneration: 0))
    gate.pause(); gate.background()
    XCTAssertFalse(gate.covered)
  }
  func testDisabledStartupCanResolveInBackgroundButProtectedRevealCannot() {
    var gate = ResumeGate(); gate.background()
    XCTAssertFalse(gate.apply(covered: false, enabled: true, generation: 1, nativeGeneration: 1))
    XCTAssertTrue(gate.apply(covered: false, enabled: false, generation: 1, nativeGeneration: 1))
    XCTAssertFalse(gate.covered)
    XCTAssertTrue(gate.apply(covered: true, enabled: true, generation: 2, nativeGeneration: 0))
    XCTAssertTrue(gate.covered)
  }
  func testNativeBackgroundRejectsProofBeforeRustObservesBackground() {
    var gate = ResumeGate()
    XCTAssertTrue(gate.apply(covered: false, enabled: true, generation: 2, nativeGeneration: 0))
    gate.background(); gate.resume()
    XCTAssertTrue(gate.covered)
    XCTAssertFalse(gate.apply(covered: false, enabled: true, generation: 3, nativeGeneration: 0))
    XCTAssertTrue(gate.covered)
    XCTAssertTrue(gate.apply(covered: false, enabled: true, generation: 3, nativeGeneration: 1))
    XCTAssertFalse(gate.apply(covered: true, enabled: true, generation: 2, nativeGeneration: 1))
    XCTAssertFalse(gate.covered)
  }
  func testTemporarySystemPanelDoesNotInvalidateAuthenticatedAccess() {
    var gate = ResumeGate()
    XCTAssertTrue(gate.apply(covered: false, enabled: true, generation: 2, nativeGeneration: 0))
    gate.pause(); XCTAssertTrue(gate.covered)
    XCTAssertTrue(gate.apply(covered: false, enabled: true, generation: 3, nativeGeneration: 0))
    XCTAssertTrue(gate.covered)
    gate.resume(); XCTAssertFalse(gate.covered); XCTAssertEqual(gate.nativeGeneration, 0)
  }
}
