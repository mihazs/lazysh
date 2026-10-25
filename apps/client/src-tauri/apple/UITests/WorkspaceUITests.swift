import XCTest

/// Runs against the real, preinstalled simulator application, not a test host.
final class WorkspaceUITests: XCTestCase {
    @MainActor
    func testHostSaveSurvivesRelaunchAndCanBeDeleted() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.lazysh.client")
        let name = "uitest-" + UUID().uuidString.lowercased()
        app.launch()
        defer { app.terminate() }

        openHosts(in: app)
        let add = app.webViews.buttons["Add host"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 30), "Native workspace must offer Add host")
        XCTAssertTrue(add.isEnabled, "Add host must be backed by the native application")
        XCTAssertTrue(add.isHittable, "Add host must be reachable in the opened drawer")
        add.tap()

        enter(name, label: "Name", placeholder: "Home workstation", in: app)
        enter("instrumentation.invalid", label: "Hostname or IP", placeholder: "workstation.local", in: app)
        enter("test", label: "Username", placeholder: "Your SSH username", in: app)

        let save = app.webViews.buttons["Save host"].firstMatch
        reveal(save, in: app)
        save.tap()
        let row = app.webViews.buttons["Connect to " + name].firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 30), "Saving through the real form must persist a native host")

        app.terminate()
        app.launch()
        openHosts(in: app)
        XCTAssertTrue(row.waitForExistence(timeout: 30), "Saved host must survive full process relaunch")

        let remove = app.webViews.buttons["Delete " + name].firstMatch
        XCTAssertTrue(remove.waitForExistence(timeout: 10), "Saved host must expose its Delete action")
        XCTAssertTrue(remove.isHittable, "Delete must be accessible through actual touch interaction")
        remove.tap()
        let confirm = app.webViews.buttons["Delete host"].firstMatch
        XCTAssertTrue(confirm.waitForExistence(timeout: 10), "Deletion must require the real confirmation dialog")
        confirm.tap()
        let removed = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: row)
        XCTAssertEqual(XCTWaiter.wait(for: [removed], timeout: 10), .completed, "Deleting through native IPC must remove the saved host")
    }

    @MainActor
    private func openHosts(in app: XCUIApplication) {
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30), "Bundled WKWebView must launch")
        let open = app.webViews.buttons["Open hosts"].firstMatch
        XCTAssertTrue(open.waitForExistence(timeout: 30), "Workspace must expose the Hosts navigation")
        XCTAssertTrue(open.isHittable, "Hosts navigation must accept touch below the safe area")
        open.tap()
        let close = app.webViews.buttons["Close hosts"].firstMatch
        let drawer = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "exists == true AND hittable == true"), object: close
        )
        XCTAssertEqual(XCTWaiter.wait(for: [drawer], timeout: 10), .completed,
                       "The drawer must finish opening before interacting with its controls")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "Opened native host drawer"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    @MainActor
    private func enter(_ text: String, label: String, placeholder: String, in app: XCUIApplication) {
        let field = app.webViews.textFields.matching(
            NSPredicate(format: "label == %@ OR placeholderValue == %@", label, placeholder)
        ).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), "Host form field must exist: " + label)
        XCTAssertTrue(field.isHittable, "Host form field must accept real input: " + label)
        field.tap()
        field.typeText(text)
        let settled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        XCTAssertEqual(XCTWaiter.wait(for: [settled], timeout: 5), .completed, "Native keyboard input must settle in field: " + label)
    }

    @MainActor
    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(element.waitForExistence(timeout: 10), "Form must expose Save host")
        if app.keyboards.firstMatch.exists {
            // WKWebView's form accessory is a toolbar above the keyboard,
            // rather than a child of XCUIElementTypeKeyboard.
            let toolbarDone = app.toolbars.buttons["Done"].firstMatch
            let keyboardDone = app.keyboards.buttons["Done"].firstMatch
            let done = toolbarDone.exists ? toolbarDone : keyboardDone
            XCTAssertTrue(done.waitForExistence(timeout: 10), "The native keyboard must offer Done")
            XCTAssertTrue(done.isHittable, "Keyboard Done must accept an actual touch")
            done.tap()
            let dismissed = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch
            )
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 10), .completed,
                           "Dismiss the native keyboard before scrolling the host form")
        }
        // Scroll the actual form using touch; never force a hidden button or DOM value.
        for _ in 0..<4 {
            if element.isHittable { break }
            app.webViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(element.isHittable, "Save host must be reachable through the real form")
    }
}
