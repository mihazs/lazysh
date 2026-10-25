import UIKit
import WebKit
import XCTest

@MainActor
final class AppIconIntegrationTests: XCTestCase {
  private func webView(_ view: UIView) -> WKWebView? {
    if let web = view as? WKWebView { return web }
    return view.subviews.lazy.compactMap { self.webView($0) }.first
  }
  private func appWebView() -> WKWebView? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows).lazy.compactMap { self.webView($0) }.first
  }
  private func readyAppView() throws -> WKWebView {
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let view = self.appWebView(), let url = view.url else { return false }
      return UIApplication.shared.applicationState == .active && url.scheme != "about" && !view.isLoading
    }, object: nil)
    let result = XCTWaiter.wait(for: [ready], timeout: 30)
    let view = appWebView()
    let scheme = view?.url?.scheme ?? "none"
    let fields: [String: Any] = ["completed": result == .completed, "viewPresent": view != nil,
      "loading": view?.isLoading ?? false, "hidden": view?.isHidden ?? true,
      "scheme": ["tauri", "http", "https", "about", "none"].contains(scheme) ? scheme : "other"]
    let attachment = XCTAttachment(string: String(data: try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), encoding: .utf8) ?? "Native readiness unavailable")
    attachment.name = "Icon hosted app navigation readiness"
    attachment.lifetime = .keepAlways
    add(attachment)
    return try XCTUnwrap(result == .completed ? view : nil, "Icon IPC requires completed native app navigation within 30 seconds")
  }
  private func record(_ stage: String, received: Bool, status: [String: Any]? = nil) {
    var fields: [String: Any] = ["stage": stage, "received": received,
      "mirrorPresent": ProcessInfo.processInfo.environment["OS_ACTIVITY_DT_MODE"] != nil,
      "mirrorDisabledMarker": ProcessInfo.processInfo.environment["IDE_DISABLED_OS_ACTIVITY_DT_MODE"] == "1"]
    if let available = status?["available"] as? Bool { fields["available"] = available }
    if let current = status?["current"] as? String, ["default", "amber", "unknown"].contains(current) { fields["current"] = current }
    let data = try? JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys])
    let attachment = XCTAttachment(string: data.flatMap { String(data: $0, encoding: .utf8) } ?? stage)
    attachment.name = "Icon acceptance: " + stage
    attachment.lifetime = .keepAlways
    add(attachment)
  }
  private func prepareAccess(_ view: WKWebView) throws {
    let ready = expectation(description: "Original native icon access lease")
    let deadline = Date().addingTimeInterval(30)
    var alive = true
    var finished = false
    var prepared = false
    func poll() {
      guard alive && !finished && deadline.timeIntervalSinceNow > 0 else { return }
      view.callAsyncJavaScript("""
        if (window.__lazyshIconInvoke) return true;
        const state = await window.__TAURI_INTERNALS__.invoke('app_lock_status');
        if (!state.initialized) return false;
        if (state.enabled || state.locked || (state.nonce !== undefined &&
            (typeof state.nonce !== 'string' || !/^[a-f0-9]{64}$/.test(state.nonce)))) {
          throw new Error('Clean icon fixture requires initialized unlocked access');
        }
        const headers = {'X-Lazysh-Access': state.nonce ?? ''};
        await window.__TAURI_INTERNALS__.invoke('app_lock_ready', {generation: state.generation});
        // Capture once in the page. Never export, refresh or retry a protected request's nonce.
        window.__lazyshIconInvoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args, {headers});
        return true;
        """, arguments: [:], in: nil, in: .page) { response in
          DispatchQueue.main.async {
            guard alive && !finished else { return }
            switch response {
            case .success(let value):
              if value as? Bool == true { prepared = true; finished = true; ready.fulfill() }
              else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { poll() } }
            case .failure:
              finished = true; ready.fulfill()
            }
          }
        }
    }
    poll()
    let result = XCTWaiter.wait(for: [ready], timeout: 30)
    alive = false
    record("access-prepared", received: prepared)
    XCTAssertEqual(result, .completed)
    guard prepared else { throw IconAccessFailure.unavailable }
  }
  private enum IconAccessFailure: Error { case unavailable }
  private func preflight(_ view: WKWebView) throws {
    let replied = expectation(description: "Actual native icon status preflight")
    var status: [String: Any]?
    var received = false
    record("status-requested", received: false)
    view.callAsyncJavaScript("return await window.__lazyshIconInvoke('app_icon_status');",
      arguments: [:], in: nil, in: .page) { response in
        received = true
        switch response {
        case .success(let value): status = value as? [String: Any]
        case .failure(let error): XCTFail("Native icon status preflight failed: \(error)")
        }
        replied.fulfill()
      }
    wait(for: [replied], timeout: 20)
    record("status-completed", received: received, status: status)
    let actual = try XCTUnwrap(status, "Icon mutation requires a working native status roundtrip first")
    XCTAssertEqual(actual["available"] as? Bool, UIApplication.shared.supportsAlternateIcons)
    let current = UIApplication.shared.alternateIconName.map { $0 == "LazyshAmber" ? "amber" : "unknown" } ?? "default"
    XCTAssertEqual(actual["current"] as? String, current)
  }
  func testBundledPhoneAndPadIconsAndRealIPCReadback() throws {
    // Inspect literal compiled declarations, before Bundle applies device qualifiers.
    let plist = Bundle.main.bundleURL.appendingPathComponent("Info.plist")
    let file = try FileHandle(forReadingFrom: plist)
    defer { try? file.close() }
    let data = try XCTUnwrap(try file.read(upToCount: 256 * 1024 + 1))
    XCTAssertLessThanOrEqual(data.count, 256 * 1024, "Compiled Info.plist exceeds the inspection bound")
    guard data.count <= 256 * 1024 else { return }
    let declarations = try XCTUnwrap(try PropertyListSerialization.propertyList(from: data, options: [], format: nil) as? [String: Any])
    for key in ["CFBundleIcons", "CFBundleIcons~ipad"] {
      let icons = try XCTUnwrap(declarations[key] as? [String: Any])
      let alternates = try XCTUnwrap(icons["CFBundleAlternateIcons"] as? [String: Any])
      let amber = try XCTUnwrap(alternates["LazyshAmber"] as? [String: Any])
      XCTAssertEqual(amber["CFBundleIconName"] as? String, "LazyshAmber")
      let diagnostics: [String: Any] = ["idiomKey": key, "declarationKeys": amber.keys.sorted(),
        "iconName": amber["CFBundleIconName"] as? String ?? "missing",
        "files": amber["CFBundleIconFiles"] as? [String] ?? []]
      let attachment = XCTAttachment(string: String(data: try JSONSerialization.data(withJSONObject: diagnostics, options: [.sortedKeys]), encoding: .utf8) ?? key)
      attachment.name = "Compiler-generated icon declaration: " + key
      attachment.lifetime = .keepAlways
      add(attachment)
      if let declared = amber["CFBundleIconFiles"] {
        let files = try XCTUnwrap(declared as? [String], "Declared icon files must be an array for " + key)
        XCTAssertFalse(files.isEmpty, "Declared icon files must not be empty")
        let resources = Bundle.main.paths(forResourcesOfType: "png", inDirectory: nil)
        for file in files {
          let images = resources.filter { URL(fileURLWithPath: $0).lastPathComponent.hasPrefix(file) }
          XCTAssertFalse(images.isEmpty, "Compiled icon resource must exist: " + file)
          XCTAssertTrue(images.contains { UIImage(contentsOfFile: $0) != nil }, "Compiled icon must decode: " + file)
        }
      } else {
        // Xcode 26.6 emits Name-only references to compiled phone/pad catalog renditions.
        let catalog = try XCTUnwrap(Bundle.main.url(forResource: "Assets", withExtension: "car"),
          "A catalog-backed icon declaration requires the actual compiled catalog")
        let bytes = try XCTUnwrap(try catalog.resourceValues(forKeys: [.fileSizeKey]).fileSize)
        XCTAssertGreaterThan(bytes, 0, "The compiled icon catalog must not be empty")
      }
    }
    let view = try readyAppView()
    try prepareAccess(view)
    try preflight(view)
    let replied = expectation(description: "Real icon IPC and invalid selection")
    view.callAsyncJavaScript("""
      const status = await window.__lazyshIconInvoke('app_icon_status');
      let rejected = false;
      try { await window.__lazyshIconInvoke('set_app_icon', {icon: '../unbundled'}); }
      catch { rejected = true; }
      const after = await window.__lazyshIconInvoke('app_icon_status');
      return {status, after, rejected};
      """, arguments: [:], in: nil, in: .page) { response in
        switch response {
        case .failure(let error): XCTFail("Native icon IPC failed: \(error)")
        case .success(let value):
          let result = value as? [String: Any]
          let status = result?["status"] as? [String: Any]
          let after = result?["after"] as? [String: Any]
          XCTAssertEqual(result?["rejected"] as? Bool, true)
          XCTAssertEqual(status?["available"] as? Bool, UIApplication.shared.supportsAlternateIcons)
          let actual = UIApplication.shared.alternateIconName.map { $0 == "LazyshAmber" ? "amber" : "unknown" } ?? "default"
          XCTAssertEqual(status?["current"] as? String, actual)
          XCTAssertEqual(after?["current"] as? String, actual)
        }
        replied.fulfill()
      }
    wait(for: [replied], timeout: 20)
  }
}
