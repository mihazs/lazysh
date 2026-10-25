import XCTest

private final class FakeIcons: AppIconApplication {
  var reads = 0
  private var supported = true
  private var declared = true
  private var name: String?
  var supportsIcons: Bool { get { reads += 1; return supported } set { supported = newValue } }
  var configured: Bool { get { reads += 1; return declared } set { declared = newValue } }
  var active = true
  var alternateName: String? { get { reads += 1; return name } set { name = newValue } }
  var calls = 0
  var completion: ((Error?) -> Void)?
  func setIcon(_ name: String?, completion: @escaping (Error?) -> Void) { calls += 1; self.completion = completion }
}
final class AppIconStateTests: XCTestCase {
  func testSupportRequiresUIKitAndConfiguredBundle() {
    let app = FakeIcons(), controller = AppIconController(FakeIcons())
    XCTAssertEqual(controller.status().current, "default")
    let icons = AppIconController(app)
    app.supportsIcons = false; XCTAssertFalse(icons.status().available)
    app.supportsIcons = true; app.configured = false; XCTAssertFalse(icons.status().available)
    app.configured = true; app.alternateName = "other"; XCTAssertEqual(icons.status().current, "unknown")
  }
  func testReadbackWinsAndFailureDoesNotInventSuccess() {
    let app = FakeIcons(), icons = AppIconController(app)
    var result: Result<AppIconStatus, Error>?
    icons.choose("amber") { result = $0 }
    XCTAssertNil(result); XCTAssertEqual(icons.status().current, "unknown")
    app.completion?(nil)
    guard case .failure? = result else { return XCTFail("Unchanged UIKit state must fail") }
    XCTAssertEqual(icons.status().current, "default")
    icons.choose("amber") { result = $0 }
    app.alternateName = "LazyshAmber"; app.completion?(nil)
    XCTAssertEqual(try? result?.get().current, "amber")
    icons.choose("default") { result = $0 }
    app.completion?(IconFailure.rejected)
    guard case .failure? = result else { return XCTFail("UIKit rejection must fail") }
    XCTAssertEqual(icons.status().current, "amber")
    icons.choose("default") { result = $0 }
    app.alternateName = nil; app.completion?(nil)
    XCTAssertEqual(try? result?.get().current, "default")
  }
  func testInvalidBackgroundAndConcurrentRequestsNeverReachUIKit() {
    let app = FakeIcons(), icons = AppIconController(app)
    icons.choose("../../icon") { _ in }; XCTAssertEqual(app.calls, 0)
    app.active = false; icons.choose("amber") { _ in }; XCTAssertEqual(app.calls, 0)
    app.active = true; icons.choose("amber") { _ in }; XCTAssertEqual(app.calls, 1)
    icons.choose("amber") { _ in }; XCTAssertEqual(app.calls, 1)
  }
  func testPendingMutationDoesNotQueryLaunchServicesBeforeCompletion() throws {
    let app = FakeIcons(), icons = AppIconController(app)
    var actual: Result<AppIconStatus, Error>?
    icons.choose("amber") { actual = $0 }
    let before = app.reads
    let pending = icons.status()
    XCTAssertFalse(pending.available)
    XCTAssertEqual(pending.current, "unknown")
    XCTAssertTrue(pending.reason.contains("in progress"))
    var concurrent: Result<AppIconStatus, Error>?
    icons.choose("default") { concurrent = $0 }
    guard case .failure? = concurrent else { return XCTFail("Concurrent mutation must fail") }
    XCTAssertEqual(app.calls, 1)
    XCTAssertEqual(app.reads, before, "Pending status and rejected mutations must not query LaunchServices")
    app.alternateName = "LazyshAmber"
    app.completion?(nil)
    XCTAssertEqual(try actual?.get().current, "amber")
    XCTAssertGreaterThan(app.reads, before, "Completion must query actual UIKit state")
  }
}
