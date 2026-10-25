import XCTest

/// Valid UIKit mutations run out-of-process so SpringBoard confirmation remains controllable.
final class AppIconUITests: XCTestCase {
  @MainActor
  func testActualHomeScreenIconRoundtripAndRelaunch() throws {
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
        do { try select(originalChoice, in: app); apply(in: app); _ = awaitIcon(originalChoice, app: app, springboard: springboard) }
        catch { XCTFail("Could not restore the original icon through the real UI: \(error)") }
      }
    }
    let applyButton = app.webViews.buttons["Apply app icon"].firstMatch
    XCTAssertTrue(applyButton.waitForExistence(timeout: 10))
    if originalChoice == "Amber" {
      try select("Default", in: app); apply(in: app); changed = true
      guard awaitIcon("Default", app: app, springboard: springboard) else { return }
    }
    try select("Amber", in: app); apply(in: app); changed = true
    guard awaitIcon("Amber", app: app, springboard: springboard) else { return }
    app.terminate(); app.launch()
    try openPreferences(app)
    guard awaitIcon("Amber", app: app, springboard: springboard) else { return }
    try select("Default", in: app); apply(in: app)
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
    // WebKit exposes native select menus as buttons or pop-up buttons depending on iOS.
    let popup = app.webViews.popUpButtons["Home Screen icon"].firstMatch
    let button = app.webViews.buttons["Home Screen icon"].firstMatch
    let control = popup.exists ? popup : button
    XCTAssertTrue(control.waitForExistence(timeout: 10), "The Home Screen icon selector must be accessible")
    XCTAssertTrue(control.isEnabled, "UIKit must report alternate icon support")
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
  private func apply(in app: XCUIApplication) {
    let button = app.webViews.buttons["Apply app icon"].firstMatch
    XCTAssertTrue(button.isEnabled, "Applying a different bundled icon must be available")
    button.tap()
  }
  @MainActor
  private func awaitIcon(_ value: String, app: XCUIApplication, springboard: XCUIApplication) -> Bool {
    let current = app.webViews.staticTexts["Current icon: " + value].firstMatch
    let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      for owner in [springboard, app] {
        let ok = owner.alerts.buttons["OK"].firstMatch
        if ok.exists && ok.isHittable { ok.tap() }
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
