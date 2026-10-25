import XCTest

private final class FakeIcons: AppIconApplication {
  var supportsIcons = true
  var configured = true
  var active = true
  var alternateName: String?
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
    XCTAssertNil(result); XCTAssertEqual(icons.status().current, "default")
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
}
