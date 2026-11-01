import CoreGraphics
import Dispatch
import XCTest

private enum IconConfirmationOwner: String, Hashable, Encodable { case springboard, app }
private enum IconWaitPhase: String, Encodable { case exists, snapshot, hittability, tap, readback }
private enum IconReadback: String, Encodable { case defaultIcon = "Default", amber = "Amber", unknown }

private final class IconWaitTiming: Encodable {
  private struct Sample: Encodable {
    let owner: IconConfirmationOwner
    let phase: IconWaitPhase
    let elapsedMs: UInt64
    let durationMs: UInt64
    let clamped: Bool
    let result: Bool?
  }
  private enum CodingKeys: String, CodingKey { case expected, count, saturated, first, last, slowest }
  private let start: UInt64
  private let expected: IconReadback
  private var count = 0
  private var saturated = false
  private var first: Sample?
  private var last: Sample?
  private var slowest: Sample?
  init(start: UInt64, expected: String) { self.start = start; self.expected = IconReadback(rawValue: expected) ?? .unknown }
  func record(_ owner: IconConfirmationOwner, _ phase: IconWaitPhase, from: UInt64, to: UInt64, result: Bool?) {
    let elapsed = to >= start ? (to - start) / 1_000_000 : 0
    let duration = to >= from ? (to - from) / 1_000_000 : 0
    let sample = Sample(owner: owner, phase: phase, elapsedMs: min(elapsed, 120_000),
      durationMs: min(duration, 120_000), clamped: elapsed > 120_000 || duration > 120_000, result: result)
    if count < 1_000 { count += 1 } else { saturated = true }
    if first == nil { first = sample }
    last = sample
    if slowest == nil || sample.durationMs > slowest!.durationMs { slowest = sample }
  }
  func measure<T>(_ owner: IconConfirmationOwner, _ phase: IconWaitPhase, _ action: () -> T,
    result: (T) -> Bool? = { _ in nil }) -> T {
    let before = DispatchTime.now().uptimeNanoseconds
    let value = action()
    record(owner, phase, from: before, to: DispatchTime.now().uptimeNanoseconds, result: result(value))
    return value
  }
  func report() -> String? {
    guard let data = try? JSONEncoder().encode(self), data.count <= 1_024 else { return nil }
    return String(data: data, encoding: .utf8)
  }
}

private func iconConfirmationRecord(owner: IconConfirmationOwner, frame: CGRect?) -> String {
  let prefix = "LAZYSH_ICON_CONFIRM owner=\(owner.rawValue) stage=before_hittability"
  guard let frame else { return prefix + " snapshot=unavailable" }
  let finite = !frame.isInfinite && [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height].allSatisfy { $0.isFinite }
  let positive = finite && frame.size.width > 0 && frame.size.height > 0
  return prefix + " snapshot=available frame_finite=\(finite) frame_positive=\(positive)"
}

/// Valid UIKit mutations run out-of-process so SpringBoard confirmation remains controllable.
final class AppIconUITests: XCTestCase {
  func testIconWaitTimingIsFiniteBoundedAndUsesOnlyExistingResults() throws {
    let timing = IconWaitTiming(start: 1_000_000, expected: "Default")
    timing.record(.springboard, .exists, from: 1_000_000, to: 11_171_000_000, result: true)
    timing.record(.springboard, .snapshot, from: 11_171_000_000, to: 11_338_000_000, result: true)
    timing.record(.app, .readback, from: 13_000_000_000, to: 13_001_000_000, result: false)
    func decoded(_ value: IconWaitTiming) throws -> [String: Any] {
      try XCTUnwrap(JSONSerialization.jsonObject(with: Data(XCTUnwrap(value.report()).utf8)) as? [String: Any])
    }
    let report = try decoded(timing)
    XCTAssertEqual(Set(report.keys), Set(["expected", "count", "saturated", "first", "last", "slowest"]))
    XCTAssertEqual(report["expected"] as? String, "Default")
    XCTAssertEqual(report["count"] as? Int, 3)
    let slowest = try XCTUnwrap(report["slowest"] as? [String: Any])
    XCTAssertEqual(Set(slowest.keys), Set(["owner", "phase", "elapsedMs", "durationMs", "clamped", "result"]))
    XCTAssertEqual(slowest["phase"] as? String, "exists")
    XCTAssertEqual(slowest["durationMs"] as? Int, 11_170)
    XCTAssertEqual((report["last"] as? [String: Any])?["result"] as? Bool, false)
    let capped = IconWaitTiming(start: 1_000_000, expected: "private-label-sentinel")
    capped.record(.app, .tap, from: 0, to: UInt64.max, result: nil)
    for _ in 0..<1_001 { capped.record(.app, .readback, from: 2, to: 1, result: false) }
    let bound = try decoded(capped)
    XCTAssertEqual(bound["expected"] as? String, "unknown")
    XCTAssertFalse(try XCTUnwrap(capped.report()).contains("sentinel"))
    XCTAssertEqual(bound["count"] as? Int, 1_000); XCTAssertEqual(bound["saturated"] as? Bool, true)
    let maximum = try XCTUnwrap(bound["slowest"] as? [String: Any])
    XCTAssertEqual(maximum["elapsedMs"] as? Int, 120_000)
    XCTAssertEqual(maximum["durationMs"] as? Int, 120_000)
    XCTAssertEqual(maximum["clamped"] as? Bool, true)
    XCTAssertNil(maximum["result"]) // A completed tap call does not claim input delivery.
    XCTAssertEqual((bound["last"] as? [String: Any])?["durationMs"] as? Int, 0)
    XCTAssertLessThanOrEqual(try XCTUnwrap(capped.report()).utf8.count, 1_024)
    var calls = 0
    let measured = IconWaitTiming(start: DispatchTime.now().uptimeNanoseconds, expected: "Amber")
    XCTAssertFalse(measured.measure(.app, .readback, { calls += 1; return false }, result: { $0 }))
    XCTAssertEqual(calls, 1)
    XCTAssertEqual(try decoded(measured)["count"] as? Int, 1)
  }
  func testConfirmationProbeRetainsOnlyFiniteBoundedFields() {
    let prefix = "LAZYSH_ICON_CONFIRM owner=app stage=before_hittability"
    let cases: [(CGRect?, String)] = [
      (nil, " snapshot=unavailable"),
      (CGRect(x: -12345.5, y: 99.25, width: 16, height: 12), " snapshot=available frame_finite=true frame_positive=true"),
      (.zero, " snapshot=available frame_finite=true frame_positive=false"),
      (.infinite, " snapshot=available frame_finite=false frame_positive=false"),
      (CGRect(x: CGFloat.nan, y: 0, width: 10, height: 10), " snapshot=available frame_finite=false frame_positive=false"),
      (CGRect(x: 0, y: 0, width: -10, height: 10), " snapshot=available frame_finite=true frame_positive=false"),
    ]
    for (frame, suffix) in cases {
      let record = iconConfirmationRecord(owner: .app, frame: frame)
      XCTAssertEqual(record, prefix + suffix)
      XCTAssertLessThanOrEqual(record.utf8.count, 160)
    }
    XCTAssertEqual(iconConfirmationRecord(owner: .springboard, frame: nil),
      "LAZYSH_ICON_CONFIRM owner=springboard stage=before_hittability snapshot=unavailable")
  }
  @MainActor
  func testActualHomeScreenIconRoundtripAndRelaunch() throws {
    continueAfterFailure = false
    let app = XCUIApplication(bundleIdentifier: "app.lazysh.client")
    app.launchEnvironment["IDE_DISABLED_OS_ACTIVITY_DT_MODE"] = "1"
    let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
    let monitor = addUIInterruptionMonitor(withDescription: "Home Screen icon confirmation") { alert in
      let ok = alert.buttons["OK"].firstMatch
      guard ok.exists else { return false }
      ok.tap(); return true
    }
    defer { removeUIInterruptionMonitor(monitor); app.terminate() }
    app.launch()
    try openPreferences(app)
    let current = app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Current icon: ")).firstMatch
    let reported = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      current.exists && ["Current icon: Default", "Current icon: Amber"].contains(current.label)
    }, object: nil)
    let readback = XCTWaiter.wait(for: [reported], timeout: 20)
    XCTAssertEqual(readback, .completed,
      "A supported native icon readback must arrive before selection")
    guard readback == .completed else { return }
    let original = current.label
    guard ["Current icon: Default", "Current icon: Amber"].contains(original) else {
      XCTFail("Actual native icon is unavailable or unknown; valid-change acceptance did not run"); return
    }
    let originalChoice = original == "Current icon: Amber" ? "Amber" : "Default"
    var changed = false
    defer {
      // Attempt the original icon even after a failed roundtrip; never report an unverified cleanup.
      if changed {
        do { try select(originalChoice, in: app); try apply(in: app); _ = awaitIcon(originalChoice, app: app, springboard: springboard) }
        catch { XCTFail("Could not restore the original icon through the real UI: \(error)") }
      }
    }
    let applyButton = app.webViews.buttons["Apply app icon"].firstMatch
    XCTAssertTrue(applyButton.waitForExistence(timeout: 10))
    if originalChoice == "Amber" {
      try select("Default", in: app); try apply(in: app); changed = true
      guard awaitIcon("Default", app: app, springboard: springboard) else { return }
    }
    try select("Amber", in: app); try apply(in: app); changed = true
    guard awaitIcon("Amber", app: app, springboard: springboard) else { return }
    app.terminate(); app.launch()
    try openPreferences(app)
    guard awaitIcon("Amber", app: app, springboard: springboard) else { return }
    try select("Default", in: app); try apply(in: app)
    guard awaitIcon("Default", app: app, springboard: springboard) else { return }
    if originalChoice == "Default" { changed = false }
  }
  @MainActor
  private func openPreferences(_ app: XCUIApplication) throws {
    XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
    let preferences = app.webViews.buttons["Preferences"].firstMatch
    XCTAssertTrue(preferences.waitForExistence(timeout: 20))
    XCTAssertTrue(preferences.isHittable, "Preferences must accept a real touch")
    preferences.tap()
    let appearance = app.webViews.buttons["Appearance and fonts"].firstMatch
    try reveal(appearance, in: app)
    appearance.tap()
    XCTAssertTrue(app.webViews.buttons["Refresh app icon"].firstMatch.waitForExistence(timeout: 10))
  }
  @MainActor
  private func select(_ value: String, in app: XCUIApplication) throws {
    // Retained native WebKit AX exposes this select as Other, with its label/value.
    let control = app.webViews.otherElements["Home Screen icon"].firstMatch
    try reveal(control, in: app)
    XCTAssertTrue(control.isEnabled, "UIKit must report alternate icon support")
    guard control.isEnabled else { throw IconUIFailure.unavailable }
    control.tap()
    let wheel = app.pickerWheels.firstMatch
    if wheel.waitForExistence(timeout: 2) {
      wheel.adjust(toPickerWheelValue: value)
      let done = app.toolbars.buttons["Done"].firstMatch
      if done.exists { done.tap() }
    } else {
      let option = app.buttons[value].firstMatch
      XCTAssertTrue(option.waitForExistence(timeout: 10), "Native picker must offer " + value)
      option.tap()
    }
  }
  @MainActor
  private func apply(in app: XCUIApplication) throws {
    let button = app.webViews.buttons["Apply app icon"].firstMatch
    try reveal(button, in: app)
    XCTAssertTrue(button.isEnabled, "Applying a different bundled icon must be available")
    guard button.isEnabled else { throw IconUIFailure.unavailable }
    button.tap()
  }
  private enum IconUIFailure: Error { case unavailable }
  @MainActor
  private func reveal(_ element: XCUIElement, in app: XCUIApplication) throws {
    let exists = element.waitForExistence(timeout: 10)
    XCTAssertTrue(exists, "The actual app icon control must be accessible")
    guard exists else { throw IconUIFailure.unavailable }
    for _ in 0..<4 {
      if element.isHittable { break }
      if element.frame.midY < app.frame.midY { app.webViews.firstMatch.swipeDown() }
      else { app.webViews.firstMatch.swipeUp() }
    }
    XCTAssertTrue(element.isHittable, "The actual app icon control must accept a real touch")
    guard element.isHittable else { throw IconUIFailure.unavailable }
  }
  @MainActor
  private func awaitIcon(_ value: String, app: XCUIApplication, springboard: XCUIApplication) -> Bool {
    let current = app.webViews.staticTexts["Current icon: " + value].firstMatch
    var observed = Set<IconConfirmationOwner>()
    let timing = IconWaitTiming(start: DispatchTime.now().uptimeNanoseconds, expected: value)
    let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      for (name, owner) in [(IconConfirmationOwner.springboard, springboard), (.app, app)] {
        let ok = owner.alerts.buttons["OK"].firstMatch
        if timing.measure(name, .exists, { ok.exists }, result: { $0 }) {
          // One extra throwing snapshot per owner, never a new wait or retry.
          // Do not print labels, values, coordinates, hierarchy or raw errors.
          if observed.insert(name).inserted {
            print("LAZYSH_ICON_CONFIRM owner=\(name.rawValue) stage=before_snapshot")
            let frame = timing.measure(name, .snapshot, { try? ok.snapshot().frame }, result: { $0 != nil })
            print(iconConfirmationRecord(owner: name, frame: frame))
          }
          if timing.measure(name, .hittability, { ok.isHittable }, result: { $0 }) {
            timing.measure(name, .tap, { ok.tap() })
          }
        }
      }
      return timing.measure(.app, .readback, { current.exists }, result: { $0 })
    }, object: nil)
    let result = XCTWaiter.wait(for: [completed], timeout: 20)
    // Reuse existing observations; never add an accessibility query to time one.
    if let record = timing.report() { print("LAZYSH_ICON_WAIT " + record) }
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Actual icon readback: " + value
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertEqual(result, .completed, "Real UIKit completion/readback must report " + value)
    return result == .completed
  }
}
