import XCTest

/// Runs against the real, preinstalled simulator application, not a test host.
final class WorkspaceUITests: XCTestCase {
    @MainActor
    func testHostSaveSurvivesRelaunchAndCanBeDeleted() throws {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.lazysh.client")
        // The UI runner launches a separate app, outside the hosted test scheme.
        app.launchEnvironment["IDE_DISABLED_OS_ACTIVITY_DT_MODE"] = "1"
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
        attach(app.screenshot(), named: "Opened native host drawer")
    }

    private func attach(_ screenshot: XCUIScreenshot, named name: String) {
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    @MainActor
    private func enter(_ text: String, label: String, placeholder: String, in app: XCUIApplication) {
        func resolve() -> XCUIElement {
            app.webViews.textFields.matching(
                NSPredicate(format: "label == %@ OR placeholderValue == %@", label, placeholder)
            ).firstMatch
        }
        let field = resolve()
        XCTAssertTrue(field.waitForExistence(timeout: 10), "Host form field must exist: " + label)
        XCTAssertTrue(field.isHittable, "Host form field must accept real input: " + label)
        // Each action waits for XCTest's idle notification; when it never arrives the call blocks for
        // 60 s while the app, WebContent and keyboard host sit idle (run 43391171381, Username, #298).
        // Keep the screen of such a stall without adding any element query that would wait again.
        func timed(_ action: String, _ body: () -> Void) {
            let began = ProcessInfo.processInfo.systemUptime
            body()
            let elapsedMs = Int(max(0, min(120, ProcessInfo.processInfo.systemUptime - began)) * 1000)
            guard let record = inputStallRecord(field: label, action: action, elapsedMs: elapsedMs) else { return }
            print(record)
            attach(XCUIScreen.main.screenshot(), named: "Stalled native input: " + inputFieldName(label) + " " + action)
        }
        timed("tap") { field.tap() }
        timed("typeText") { field.typeText(text) }
        let original = NSPredicate(format: "value == %@", text)
        let start = ProcessInfo.processInfo.systemUptime
        var samples: [[String: Any]] = []
        func beforeDeadline() -> Bool { ProcessInfo.processInfo.systemUptime - start < 5 }
        func observed(_ value: Any?) -> [String: Any] {
            var result = typingValueObservation(value, expected: text, placeholder: placeholder)
            result["atMs"] = Int(min(60, max(0, ProcessInfo.processInfo.systemUptime - start)) * 1000)
            return result
        }
        let traced = NSPredicate { candidate, _ in
            // Only the original equality predicate can fulfill the expectation.
            let matches = original.evaluate(with: candidate)
            guard !matches && samples.count < 2 && beforeDeadline() else { return matches }
            var sample: [String: Any] = ["originalMatches": matches, "retained": observed(field.value)]
            // Public XCTest reads are synchronous: skip later reads at the old
            // deadline, but cannot forcibly cancel an in-flight framework call.
            if beforeDeadline() {
                do { sample["snapshot"] = observed(try field.snapshot().value) }
                catch { sample["snapshot"] = ["kind": "unavailable"] }
            } else { sample["snapshot"] = ["kind": "deadline"] }
            if beforeDeadline() { sample["fresh"] = observed(resolve().value) }
            else { sample["fresh"] = ["kind": "deadline"] }
            samples.append(sample)
            return matches
        }
        let settled = XCTNSPredicateExpectation(predicate: traced, object: field)
        let result = XCTWaiter.wait(for: [settled], timeout: 5)
        // The rendered pixels at the failed poll share the XCTest clock that the AX samples use.
        if result != .completed { attach(XCUIScreen.main.screenshot(), named: "Typing settle failure: " + inputFieldName(label)) }
        if !samples.isEmpty {
            let fields: [String: Any] = ["field": inputFieldName(label), "completed": result == .completed, "samples": samples]
            let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
            let payload = data.flatMap { $0.count <= 4096 ? String(data: $0, encoding: .utf8) : nil }
            let attachment = XCTAttachment(string: payload ?? "Typing value observation unavailable")
            attachment.name = "Typing value observations"
            attachment.lifetime = .keepAlways
            add(attachment)
        }
        XCTAssertEqual(result, .completed, "Native keyboard input must settle in field: " + label)
    }

    func testTypingValueObservationsAreFiniteAndDoNotExposeInput() throws {
        let expected = "PRIVATE-EXPECTED", placeholder = "PRIVATE-PLACEHOLDER", actual = "PRIVATE-ACTUAL"
        let values: [Any?] = [nil, NSNull(), actual, expected, placeholder, String(repeating: "x", count: 4096)]
        let rows = values.map { typingValueObservation($0, expected: expected, placeholder: placeholder) }
        XCTAssertEqual(rows[0]["kind"] as? String, "missing")
        XCTAssertEqual(rows[1]["kind"] as? String, "other")
        XCTAssertEqual(rows[2]["matchesExpected"] as? Bool, false)
        XCTAssertEqual(rows[3]["matchesExpected"] as? Bool, true)
        XCTAssertEqual(rows[4]["matchesPlaceholder"] as? Bool, true)
        XCTAssertEqual(rows[5]["utf16Length"] as? Int, 256)
        XCTAssertEqual(rows[5]["lengthCapped"] as? Bool, true)
        let data = try JSONSerialization.data(withJSONObject: rows)
        let payload = try XCTUnwrap(String(data: data, encoding: .utf8))
        for secret in [actual, expected, placeholder] { XCTAssertFalse(payload.contains(secret)) }
        XCTAssertLessThan(data.count, 2048)
    }

    func testInputStallRecordIsBoundedAndOmitsPrivateText() throws {
        XCTAssertNil(inputStallRecord(field: "Username", action: "tap", elapsedMs: 9_999))
        XCTAssertNil(inputStallRecord(field: "Username", action: "tap", elapsedMs: -1))
        XCTAssertEqual(inputStallRecord(field: "Username", action: "typeText", elapsedMs: 60_050),
                       #"LAZYSH_INPUT_STALL {"action":"typeText","elapsedMs":60050,"field":"Username"}"#)
        XCTAssertEqual(inputStallRecord(field: "Hostname or IP", action: "tap", elapsedMs: 10_000),
                       #"LAZYSH_INPUT_STALL {"action":"tap","elapsedMs":10000,"field":"Hostname or IP"}"#)
        let capped = try XCTUnwrap(inputStallRecord(field: "PRIVATE-LABEL", action: "PRIVATE-ACTION", elapsedMs: Int.max))
        XCTAssertEqual(capped, #"LAZYSH_INPUT_STALL {"action":"other","elapsedMs":120000,"field":"other"}"#)
        XCTAssertFalse(capped.contains("PRIVATE"))
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

private func typingValueObservation(_ value: Any?, expected: String, placeholder: String) -> [String: Any] {
    guard let text = value as? String else { return ["kind": value == nil ? "missing" : "other"] }
    let length = text.utf16.prefix(257).count
    return ["kind": "string", "utf16Length": min(length, 256), "lengthCapped": length > 256,
            "matchesExpected": text == expected, "matchesPlaceholder": text == placeholder]
}

private func inputFieldName(_ label: String) -> String {
    ["Name", "Hostname or IP", "Username"].contains(label) ? label : "other"
}

/// One bounded log line for a native input action that blocked, else nil. Carries no typed text.
private func inputStallRecord(field label: String, action: String, elapsedMs: Int) -> String? {
    guard elapsedMs >= 10_000 else { return nil }
    let fields: [String: Any] = ["field": inputFieldName(label), "elapsedMs": min(elapsedMs, 120_000),
                                 "action": ["tap", "typeText"].contains(action) ? action : "other"]
    let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    return data.flatMap { String(data: $0, encoding: .utf8) }.map { "LAZYSH_INPUT_STALL " + $0 }
}
