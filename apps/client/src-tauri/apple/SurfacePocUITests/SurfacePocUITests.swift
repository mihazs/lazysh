import XCTest

/// The composition gate of the iOS native terminal surface (#1311): an `MTKView` below a transparent
/// `WKWebView`, in the standalone host `LazyshSurfacePoc` (see `SurfacePocHost`). Every placement and
/// overlap verdict compares three independent readings: the page's own accessibility frame for the DOM
/// anchor, the rectangle the host says it gave the surface, and the pixels the simulator composited.
/// Each test also writes a record of what it measured (an attachment, and a line of JSON in the file
/// named by `LAZYSH_SURFACE_POC_RESULTS` when the job sets it) for `docs/architecture/ios-surface-composition-poc.md`.
@MainActor
final class SurfacePocUITests: XCTestCase {
    /// Points, for rectangles that the page, the host and the screen all round differently.
    private let edge: CGFloat = 1.5
    private let channel = 16

    // MARK: Harness

    private func launch(order: String = "below") -> XCUIApplication {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "app.lazysh.client.surfacepoc")
        // The same logging control the workspace acceptance passes to its separately launched app.
        app.launchEnvironment["IDE_DISABLED_OS_ACTIVITY_DT_MODE"] = "1"
        app.launchEnvironment["LAZYSH_SURFACE_POC_ORDER"] = order
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30), "The host's WKWebView must launch")
        return app
    }

    /// Leaves the shared simulator upright for the next test class.
    private func finish(_ app: XCUIApplication) {
        XCUIDevice.shared.orientation = .portrait
        app.terminate()
    }

    private func state(_ app: XCUIApplication) -> [String: Any] {
        let probe = app.descendants(matching: .any).matching(identifier: "surface-poc-state").firstMatch
        XCTAssertTrue(probe.waitForExistence(timeout: 20), "The host must expose its state as the accessibility element surface-poc-state")
        let parsed = probe.label.data(using: .utf8).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        return parsed ?? [:]
    }

    @discardableResult
    private func waitFor(_ app: XCUIApplication, _ what: String, timeout: TimeInterval = 20, _ holds: ([String: Any]) -> Bool) -> [String: Any] {
        let deadline = Date().addingTimeInterval(timeout)
        var latest = state(app)
        while !holds(latest) && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            latest = state(app)
        }
        XCTAssertTrue(holds(latest), "Timed out waiting for " + what + "; last state " + String(describing: latest))
        return latest
    }

    /// The host's state once it has not changed for `quiet` seconds: the page has reported its last rectangle.
    private func settled(_ app: XCUIApplication, quiet: TimeInterval = 1) -> [String: Any] {
        var latest = state(app), since = Date()
        let deadline = Date().addingTimeInterval(30)
        while Date().timeIntervalSince(since) < quiet && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.25)
            let next = state(app)
            if !NSDictionary(dictionary: next).isEqual(to: latest) { latest = next; since = Date() }
        }
        return latest
    }

    private func domElement(_ app: XCUIApplication, _ label: String) -> XCUIElement {
        let element = app.webViews.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        XCTAssertTrue(element.waitForExistence(timeout: 20), "The page must expose " + label + " to accessibility")
        return element
    }

    private func rect(_ value: Any?) -> CGRect? {
        guard let box = value as? [String: Double], let x = box["x"], let y = box["y"], let width = box["width"], let height = box["height"] else { return nil }
        return CGRect(x: x, y: y, width: width, height: height)
    }

    private func sizes(_ state: [String: Any]) -> [[Double]] { state["sizes"] as? [[Double]] ?? [] }

    private func count(_ state: [String: Any], _ key: String) -> Int { state[key] as? Int ?? 0 }

    private func safeInsets(_ state: [String: Any]) -> [String: Double] { state["safe"] as? [String: Double] ?? [:] }

    /// The simulator's composited pixels for the app, and how many of them make one point.
    private func capture(_ app: XCUIApplication, _ name: String) throws -> (pixels: PocRaster, scale: CGFloat) {
        let shot = app.screenshot()
        let attachment = XCTAttachment(screenshot: shot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
        let image = try XCTUnwrap(shot.image.cgImage, "The screenshot must have pixels")
        let space = try XCTUnwrap(CGColorSpace(name: CGColorSpace.sRGB))
        var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
        let drawn = bytes.withUnsafeMutableBytes { buffer -> Bool in
            guard let context = CGContext(data: buffer.baseAddress, width: image.width, height: image.height, bitsPerComponent: 8,
                                          bytesPerRow: image.width * 4, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else { return false }
            context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
            return true
        }
        XCTAssertTrue(drawn, "The screenshot must be readable as RGBA")
        let scale = CGFloat(image.width) / app.frame.width
        XCTAssertEqual(CGFloat(image.height) / app.frame.height, scale, accuracy: 0.05, "The screenshot must share the app's orientation")
        return (PocRaster(width: image.width, height: image.height, rgba: bytes), scale)
    }

    private func colour(_ shot: (pixels: PocRaster, scale: CGFloat), at point: CGPoint) -> PocColor? {
        shot.pixels.color(x: Int(point.x * shot.scale), y: Int(point.y * shot.scale))
    }

    /// The rectangle of surface-coloured pixels near `expected`, in points.
    private func surfacePixels(_ shot: (pixels: PocRaster, scale: CGFloat), near expected: CGRect) -> CGRect? {
        let area = expected.insetBy(dx: -12, dy: -12)
        let scaled = CGRect(x: area.minX * shot.scale, y: area.minY * shot.scale, width: area.width * shot.scale, height: area.height * shot.scale)
        return shot.pixels.bounds(of: .surface, tolerance: channel, in: scaled)
            .map { CGRect(x: $0.minX / shot.scale, y: $0.minY / shot.scale, width: $0.width / shot.scale, height: $0.height / shot.scale) }
    }

    private func assertColour(_ found: PocColor?, _ expected: PocColor, _ message: String) {
        XCTAssertTrue(found?.isNear(expected, tolerance: channel) == true, message + "; the pixel is " + String(describing: found))
    }

    /// The anchor as the page, the host and the screen each place it, with the worst disagreement in points.
    private func assertSurfaceAtAnchor(_ app: XCUIApplication, _ host: [String: Any], _ name: String) throws -> [String: Any] {
        let anchor = domElement(app, "Surface anchor").frame
        let shot = try capture(app, name)
        let reported = try XCTUnwrap(rect(host["surface"]), "The host has no surface to place")
        let visible = anchor.intersection(app.frame)
        let drawn = try XCTUnwrap(surfacePixels(shot, near: visible), "No surface-coloured pixel near the DOM anchor " + String(describing: anchor))
        XCTAssertTrue(pocRectsAgree(reported, anchor, tolerance: edge), "The host placed the surface at \(reported), the page's anchor is at \(anchor)")
        XCTAssertTrue(pocRectsAgree(drawn, visible, tolerance: edge), "The screen shows the surface at \(drawn), the page's anchor is at \(visible)")
        return ["anchor": anchor.debugDescription, "reported": reported.debugDescription, "drawn": drawn.debugDescription,
                "reportedError": Double(pocMaxEdgeError(reported, anchor)), "drawnError": Double(pocMaxEdgeError(drawn, visible))]
    }

    private func record(_ item: String, _ fields: [String: Any]) {
        var line = fields
        line["item"] = item
        // data(withJSONObject:) raises an Objective-C exception, not a Swift error, for a value JSON cannot hold.
        guard JSONSerialization.isValidJSONObject(line), let data = try? JSONSerialization.data(withJSONObject: line, options: [.sortedKeys]),
              data.count <= 4096, let text = String(data: data, encoding: .utf8) else { return }
        let attachment = XCTAttachment(string: text)
        attachment.name = "surface-poc " + item
        attachment.lifetime = .keepAlways
        add(attachment)
        if let path = ProcessInfo.processInfo.environment["LAZYSH_SURFACE_POC_RESULTS"], let file = FileHandle(forWritingAtPath: path) {
            _ = try? file.seekToEnd()
            try? file.write(contentsOf: Data((text + "\n").utf8))
            try? file.close()
        }
    }

    // MARK: Placement, overlap and touch routing

    func testMetalDeviceIsAvailableAndDrawsTheSurface() {
        let app = launch()
        defer { finish(app) }
        let host = settled(app)
        record("metal", ["available": host["metal"] ?? false, "device": host["device"] ?? "none", "frames": count(host, "frames")])
        XCTAssertEqual(host["metal"] as? Bool, true, "No Metal device on this host: the surface is a flat layer and only the view hierarchy is measured")
        XCTAssertGreaterThan(count(host, "frames"), 0, "The MTKView must have drawn a frame")
    }

    func testSurfaceBelowTheWebViewFollowsTheAnchorAndDomOverlaysAndTouchesStayAbove() throws {
        let app = launch()
        defer { finish(app) }
        let host = settled(app)
        var result = try assertSurfaceAtAnchor(app, host, "Surface below the web view")
        let anchor = domElement(app, "Surface anchor").frame, box = domElement(app, "Overlap box").frame
        let shot = try capture(app, "Surface below the web view, overlap")
        let both = anchor.intersection(box)
        XCTAssertFalse(both.isNull || both.isEmpty, "The fixture's DOM box must overlap the anchor")
        // The opaque DOM box over the surface's corner is the menu, toolbar or selection handle of the real app.
        assertColour(colour(shot, at: CGPoint(x: both.midX, y: both.midY)), .overlay, "The DOM box must be drawn above the surface")
        assertColour(colour(shot, at: CGPoint(x: anchor.minX + 10, y: anchor.minY + 10)), .surface, "The surface must show through the transparent page")
        domElement(app, "Surface anchor").tap()
        let touched = waitFor(app, "the page to receive the tap") { self.count($0, "domTaps") >= 1 }
        XCTAssertEqual(count(touched, "surfaceTouches"), 0, "A touch over a surface below the web view must reach the page, not the surface")
        result["domTaps"] = count(touched, "domTaps")
        result["surfaceTouches"] = count(touched, "surfaceTouches")
        result["overlapPixel"] = "DOM box"
        record("placement-overlap-touch", result)
    }

    func testSurfaceAboveTheWebViewHidesTheDomBoxAndTakesTheTouches() throws {
        let app = launch(order: "above")
        defer { finish(app) }
        _ = settled(app)
        let anchor = domElement(app, "Surface anchor").frame, box = domElement(app, "Overlap box").frame
        let shot = try capture(app, "Surface above the web view")
        let both = anchor.intersection(box)
        XCTAssertFalse(both.isNull || both.isEmpty, "The fixture's DOM box must overlap the anchor")
        assertColour(colour(shot, at: CGPoint(x: both.midX, y: both.midY)), .surface, "A surface above the web view must hide the DOM box (the comparison that shows the overlap check can fail)")
        domElement(app, "Surface anchor").tap()
        let touched = waitFor(app, "the surface to receive the tap") { self.count($0, "surfaceTouches") >= 1 }
        XCTAssertEqual(count(touched, "domTaps"), 0, "A touch over a surface above the web view must not reach the page")
        record("surface-above", ["overlapPixel": "surface", "domTaps": count(touched, "domTaps"), "surfaceTouches": count(touched, "surfaceTouches")])
    }

    func testScrollingMovesTheWebViewAndTheSurfaceFollowsTheAnchor() throws {
        let app = launch()
        defer { finish(app) }
        let start = settled(app)
        let startAnchor = domElement(app, "Surface anchor").frame
        let web = app.webViews.firstMatch
        // Over the page beside the anchor, as a finger on the terminal's neighbour would be.
        web.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.7))
            .press(forDuration: 0.1, thenDragTo: web.coordinate(withNormalizedOffset: CGVector(dx: 0.85, dy: 0.55)))
        waitFor(app, "the web view to scroll") { ($0["scrollY"] as? Double ?? 0) > 20 }
        let scrolled = settled(app)
        let moved = domElement(app, "Surface anchor").frame
        XCTAssertLessThan(moved.minY, startAnchor.minY - 20, "The anchor must move with the page")
        var result = try assertSurfaceAtAnchor(app, scrolled, "Surface after scrolling")
        result["scrollY"] = scrolled["scrollY"] ?? 0
        result["sizeChanges"] = sizes(scrolled).count - sizes(start).count
        record("scroll-follow", result)
        XCTAssertEqual(sizes(scrolled).count, sizes(start).count, "Scrolling moves the surface and must not resize it")
    }

    // MARK: Keyboard, safe areas and rotation

    func testKeyboardResizesTheSurfaceOnce() throws {
        let app = launch()
        defer { finish(app) }
        let initial = sizes(settled(app))
        domElement(app, "Surface field").tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 20), "The soft keyboard must appear (a connected hardware keyboard would hide it)")
        let shown = settled(app, quiet: 2)
        var result = try assertSurfaceAtAnchor(app, shown, "Surface with the keyboard up")
        XCTAssertEqual(sizes(shown).count, initial.count + 1, "Showing the keyboard must resize the surface exactly once, sizes: " + String(describing: sizes(shown)))
        XCTAssertLessThan(sizes(shown).last?[1] ?? .infinity, (initial.last?[1] ?? 0) - 100, "The pane must shrink to the space above the keyboard")
        result["sizesAfterShow"] = sizes(shown)
        let toolbarDone = app.toolbars.buttons["Done"].firstMatch
        let done = toolbarDone.exists ? toolbarDone : app.keyboards.buttons["Done"].firstMatch
        XCTAssertTrue(done.waitForExistence(timeout: 10), "The native keyboard must offer Done")
        done.tap()
        let hidden = settled(app, quiet: 2)
        XCTAssertFalse(app.keyboards.firstMatch.exists, "Done must dismiss the keyboard")
        XCTAssertEqual(sizes(hidden).count, initial.count + 2, "Hiding the keyboard must resize the surface exactly once, sizes: " + String(describing: sizes(hidden)))
        XCTAssertEqual(sizes(hidden).last, initial.last, "The pane must return to its size from before the keyboard")
        _ = try assertSurfaceAtAnchor(app, hidden, "Surface with the keyboard down")
        result["sizesAfterHide"] = sizes(hidden)
        record("keyboard-resize", result)
    }

    func testSurfaceStaysInsideTheSafeAreaAndFollowsRotation() throws {
        let app = launch()
        defer { finish(app) }
        let portrait = settled(app)
        let inset = safeInsets(portrait)
        let anchor = domElement(app, "Surface anchor").frame
        XCTAssertGreaterThan(inset["top"] ?? 0, 0, "The iPhone 16 Pro simulator has a top safe area (the Dynamic Island)")
        XCTAssertEqual(anchor.minY, (inset["top"] ?? 0) + 48, accuracy: edge, "CSS env(safe-area-inset-top) must equal the native inset")
        var result = try assertSurfaceAtAnchor(app, portrait, "Surface in portrait")
        let reported = try XCTUnwrap(rect(portrait["surface"]))
        XCTAssertGreaterThanOrEqual(reported.minY, inset["top"] ?? 0, "The surface must not sit under the Dynamic Island")
        XCTAssertLessThanOrEqual(reported.maxY, app.frame.height - (inset["bottom"] ?? 0), "The surface must not sit under the home indicator")
        result["portraitInsets"] = inset
        XCUIDevice.shared.orientation = .landscapeLeft
        waitFor(app, "the page to lay out in landscape") { host in
            let size = host["viewport"] as? [Double] ?? []
            return size.count == 2 && size[0] > size[1]
        }
        let landscape = settled(app)
        let landscapeInset = safeInsets(landscape)
        XCTAssertGreaterThan(max(landscapeInset["left"] ?? 0, landscapeInset["right"] ?? 0), 0, "Landscape has a side safe area")
        XCTAssertEqual(domElement(app, "Surface anchor").frame.minX, (landscapeInset["left"] ?? 0) + 40, accuracy: edge,
                       "CSS env(safe-area-inset-left) must equal the native inset after rotation")
        _ = try assertSurfaceAtAnchor(app, landscape, "Surface in landscape")
        result["landscapeInsets"] = landscapeInset
        XCUIDevice.shared.orientation = .portrait
        waitFor(app, "the page to lay out in portrait again") { host in
            let size = host["viewport"] as? [Double] ?? []
            return size.count == 2 && size[0] < size[1]
        }
        _ = try assertSurfaceAtAnchor(app, settled(app), "Surface back in portrait")
        record("safe-area-rotation", result)
    }

    // MARK: Lifecycle

    func testSurfaceSurvivesBackgroundAndForeground() throws {
        let app = launch()
        defer { finish(app) }
        let before = settled(app)
        XCUIDevice.shared.press(.home)
        let deadline = Date().addingTimeInterval(20)
        while app.state == .runningForeground && Date() < deadline { Thread.sleep(forTimeInterval: 0.25) }
        XCTAssertNotEqual(app.state, .runningForeground, "The home button must background the host")
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 20), "The host must return to the foreground")
        let after = waitFor(app, "the host to report the background and foreground transitions") { self.count($0, "background") >= 1 && self.count($0, "foreground") >= 1 }
        XCTAssertGreaterThan(count(after, "frames"), count(before, "frames"), "The surface must draw again when the app becomes active")
        var result = try assertSurfaceAtAnchor(app, settled(app), "Surface after returning to the foreground")
        result["framesBefore"] = count(before, "frames")
        result["framesAfter"] = count(after, "frames")
        result["skippedWhileBackgrounded"] = count(after, "skipped")
        record("background-foreground", result)
    }

    func testSurfaceCanBeRemovedAndRecreatedFromTheSameSession() throws {
        let app = launch()
        defer { finish(app) }
        let before = settled(app)
        domElement(app, "Remove surface").tap()
        let removed = waitFor(app, "the surface to be removed") { self.count($0, "destroyed") >= 1 }
        XCTAssertTrue(removed["surface"] is NSNull, "A removed surface must leave no view behind")
        let anchor = domElement(app, "Surface anchor").frame
        let empty = try capture(app, "Surface removed")
        assertColour(colour(empty, at: CGPoint(x: anchor.midX, y: anchor.midY)), .backdrop, "Nothing may be left on screen where the surface was")
        domElement(app, "Recreate surface").tap()
        waitFor(app, "a new surface to be created") { self.count($0, "created") >= 2 }
        let again = settled(app)
        var result = try assertSurfaceAtAnchor(app, again, "Surface recreated")
        XCTAssertGreaterThan(count(again, "frames"), count(before, "frames"), "The recreated surface must draw")
        result["created"] = count(again, "created")
        result["destroyed"] = count(again, "destroyed")
        record("remove-recreate", result)
    }

    func testSurfaceIsPlacedAgainAfterTheProcessRestarts() throws {
        let app = launch()
        defer { finish(app) }
        _ = settled(app)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30), "The host's WKWebView must launch again")
        let host = settled(app)
        XCTAssertEqual(count(host, "created"), 1, "A new process starts with one surface")
        var result = try assertSurfaceAtAnchor(app, host, "Surface after a process restart")
        result["created"] = count(host, "created")
        record("process-restart", result)
    }
}
