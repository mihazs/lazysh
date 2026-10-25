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
    wait(for: [ready], timeout: 30)
    return try XCTUnwrap(appWebView())
  }
  private func icon(_ choice: String, in view: WKWebView) -> [String: Any]? {
    let replied = expectation(description: "Actual native icon change: " + choice)
    var status: [String: Any]?
    view.callAsyncJavaScript("return await window.__TAURI_INTERNALS__.invoke('set_app_icon', {icon: choice});",
      arguments: ["choice": choice], in: nil, in: .page) { response in
        switch response {
        case .success(let value): status = value as? [String: Any]
        case .failure(let error): XCTFail("Actual UIKit icon change failed: \(error)")
        }
        replied.fulfill()
      }
    wait(for: [replied], timeout: 20)
    return status
  }
  func testActualUIKitAmberRoundtripAndRestore() throws {
    let view = try readyAppView()
    guard UIApplication.shared.supportsAlternateIcons else {
      XCTFail("This simulator does not support alternate icons; valid-change acceptance remains unverified."); return
    }
    let original = UIApplication.shared.alternateIconName
    guard original == nil || original == "LazyshAmber" else { XCTFail("Unexpected preexisting icon: refusing to replace it"); return }
    // Always try UIKit restoration, even if the IPC request or readback fails.
    defer {
      if UIApplication.shared.alternateIconName != original {
        let restored = expectation(description: "Restore original UIKit icon")
        UIApplication.shared.setAlternateIconName(original) { error in
          XCTAssertNil(error, "UIKit cleanup must restore the original icon")
          restored.fulfill()
        }
        wait(for: [restored], timeout: 20)
      }
      XCTAssertEqual(UIApplication.shared.alternateIconName, original)
    }
    let changed = icon("amber", in: view)
    XCTAssertEqual(changed?["current"] as? String, "amber")
    XCTAssertEqual(UIApplication.shared.alternateIconName, "LazyshAmber")
    let resumed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      UIApplication.shared.applicationState == .active
    }, object: nil)
    wait(for: [resumed], timeout: 15)
    let restored = icon("default", in: view)
    XCTAssertEqual(restored?["current"] as? String, "default")
    XCTAssertNil(UIApplication.shared.alternateIconName)
  }
  func testBundledPhoneAndPadIconsAndRealIPCReadback() throws {
    for key in ["CFBundleIcons", "CFBundleIcons~ipad"] {
      let icons = try XCTUnwrap(Bundle.main.object(forInfoDictionaryKey: key) as? [String: Any])
      let alternates = try XCTUnwrap(icons["CFBundleAlternateIcons"] as? [String: Any])
      let amber = try XCTUnwrap(alternates["LazyshAmber"] as? [String: Any])
      XCTAssertEqual(amber["CFBundleIconName"] as? String, "LazyshAmber")
      let files = try XCTUnwrap(amber["CFBundleIconFiles"] as? [String])
      XCTAssertFalse(files.isEmpty, "actool must emit real icon resources for each idiom")
    }
    let view = try readyAppView()
    let replied = expectation(description: "Real icon IPC and invalid selection")
    view.callAsyncJavaScript("""
      const status = await window.__TAURI_INTERNALS__.invoke('app_icon_status');
      let rejected = false;
      try { await window.__TAURI_INTERNALS__.invoke('set_app_icon', {icon: '../unbundled'}); }
      catch { rejected = true; }
      const after = await window.__TAURI_INTERNALS__.invoke('app_icon_status');
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
