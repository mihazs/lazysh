import CoreGraphics
import XCTest

private enum IconConfirmationOwner: String, Hashable { case springboard, app }

private func iconConfirmationRecord(owner: IconConfirmationOwner, frame: CGRect?) -> String {
  let prefix = "LAZYSH_ICON_CONFIRM owner=\(owner.rawValue) stage=before_hittability"
  guard let frame else { return prefix + " snapshot=unavailable" }
  let finite = !frame.isInfinite && [frame.origin.x, frame.origin.y, frame.size.width, frame.size.height].allSatisfy { $0.isFinite }
  let positive = finite && frame.size.width > 0 && frame.size.height > 0
  return prefix + " snapshot=available frame_finite=\(finite) frame_positive=\(positive)"
}

/// Valid UIKit mutations run out-of-process so SpringBoard confirmation remains controllable.
final class AppIconUITests: XCTestCase {
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
    let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      for (name, owner) in [(IconConfirmationOwner.springboard, springboard), (.app, app)] {
        let ok = owner.alerts.buttons["OK"].firstMatch
        if ok.exists {
          // One extra throwing snapshot per owner, never a new wait or retry.
          // Do not print labels, values, coordinates, hierarchy or raw errors.
          if observed.insert(name).inserted {
            print("LAZYSH_ICON_CONFIRM owner=\(name.rawValue) stage=before_snapshot")
            print(iconConfirmationRecord(owner: name, frame: try? ok.snapshot().frame))
          }
          if ok.isHittable { ok.tap() }
        }
      }
      return current.exists
    }, object: nil)
    let result = XCTWaiter.wait(for: [completed], timeout: 20)
    let attachment = XCTAttachment(screenshot: app.screenshot())
    attachment.name = "Actual icon readback: " + value
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertEqual(result, .completed, "Real UIKit completion/readback must report " + value)
    return result == .completed
  }
}
