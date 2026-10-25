import CryptoKit
import Foundation
import UIKit
import WebKit
import XCTest

@MainActor
final class MoshAppIntegrationTests: XCTestCase {
  private func webView(in view: UIView) -> WKWebView? {
    if let webView = view as? WKWebView { return webView }
    return view.subviews.lazy.compactMap { self.webView(in: $0) }.first
  }

  private func appWebView() -> WKWebView? {
    UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows).lazy.compactMap { self.webView(in: $0) }.first
  }

  func testActualNativeIPCOffersMosh() throws {
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let view = self.appWebView(), let url = view.url else { return false }
      return url.scheme != "about" && !view.isLoading
    }, object: nil)
    let result = XCTWaiter.wait(for: [ready], timeout: 30)
    let candidate = appWebView()
    let scheme = candidate?.url?.scheme ?? "none"
    let fields: [String: Any] = ["completed": result == .completed, "viewPresent": candidate != nil,
      "loading": candidate?.isLoading ?? false, "hidden": candidate?.isHidden ?? true,
      "scheme": ["tauri", "http", "https", "about", "none"].contains(scheme) ? scheme : "other"]
    let attachment = XCTAttachment(string: String(data: try JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys]), encoding: .utf8) ?? "Native readiness unavailable")
    attachment.name = "Mosh hosted app navigation readiness"
    attachment.lifetime = .keepAlways
    add(attachment)
    let view = try XCTUnwrap(result == .completed ? candidate : nil,
      "Native IPC requires completed app navigation within 30 seconds")
    let replied = expectation(description: "Actual Tauri transport capabilities reply")
    view.callAsyncJavaScript("""
      if (document.readyState === 'loading') {
        await new Promise(resolve => document.addEventListener('DOMContentLoaded', resolve, {once: true}));
      }
      return await window.__TAURI_INTERNALS__.invoke('transport_capabilities');
      """, arguments: [:], in: nil, in: .page) { result in
        switch result {
        case .success(let response):
          let capabilities = response as? [String: Any]
          XCTAssertEqual(capabilities?["mosh"] as? Bool, true)
        case .failure(let error):
          XCTFail("Native transport capability IPC failed: \(error)")
        }
        replied.fulfill()
      }
    wait(for: [replied], timeout: 15)
  }

  func testAppEmbedsBothOriginalDependencyPrivacyManifests() throws {
    let expected = [
      ("LazyshMoshAbseilPrivacy", "f232217ae9edf2ab6a541a28eff50cfe05303c2b4756fff95cca72eccbc3b898"),
      ("LazyshMoshProtobufPrivacy", "521eb6ef8430773e5c010e1838fe9dd8fa5d62b7b76d1cea8d7d8daadcb144e2"),
    ]
    var embedded = Set<URL>()
    for (name, digest) in expected {
      let url = try XCTUnwrap(Bundle.main.url(forResource: name, withExtension: "bundle"))
      XCTAssertTrue(embedded.insert(url).inserted, "SDK resources must use distinct bundles")
      let bundle = try XCTUnwrap(Bundle(url: url))
      let manifest = try XCTUnwrap(bundle.url(forResource: "PrivacyInfo", withExtension: "xcprivacy"))
      let data = try Data(contentsOf: manifest)
      XCTAssertEqual(SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined(), digest,
                     "The embedded manifest must preserve the pinned upstream bytes")
      let properties = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: Any])
      XCTAssertEqual(properties["NSPrivacyTracking"] as? Bool, false)
      for key in ["NSPrivacyTrackingDomains", "NSPrivacyCollectedDataTypes", "NSPrivacyAccessedAPITypes"] {
        XCTAssertEqual((properties[key] as? [Any])?.count, 0)
      }
    }
  }
}
