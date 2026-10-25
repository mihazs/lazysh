import XCTest
import UIKit
import WebKit

final class ResumeCoverTests: XCTestCase {
  @MainActor func testWebViewStartsHiddenUntilAuthorityExplicitlyResolvesPolicy() {
    let host = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    let webview = WKWebView(frame: host.bounds); host.addSubview(webview)
    let cover = ResumeCover(); cover.load(webview: webview, host: host)
    XCTAssertTrue(cover.ready); XCTAssertTrue(webview.isHidden); XCTAssertFalse(webview.isUserInteractionEnabled)
    XCTAssertEqual(host.subviews.count, 2)
    cover.failure(); XCTAssertTrue(webview.isHidden)
    let stack = host.subviews.last?.subviews.compactMap { $0 as? UIStackView }.first
    XCTAssertTrue(stack?.arrangedSubviews.contains { ($0 as? UILabel)?.text?.contains("remains locked") == true } == true)
    XCTAssertTrue(cover.apply(ResumeView(covered: false, enabled: false, generation: 1, nativeGeneration: 0)))
    XCTAssertFalse(webview.isHidden); XCTAssertTrue(webview.isUserInteractionEnabled)
  }
  @MainActor func testBackgroundCoversBeforeEventAndRejectsOldReveal() {
    let host = UIView(frame: CGRect(x: 0, y: 0, width: 320, height: 640))
    let webview = WKWebView(frame: host.bounds); host.addSubview(webview)
    let cover = ResumeCover(); cover.load(webview: webview, host: host)
    var messages: [(String, UInt64)] = []
    cover.register { kind, generation in
      if kind == "background" { XCTAssertTrue(webview.isHidden); XCTAssertFalse(webview.isUserInteractionEnabled) }
      messages.append((kind, generation))
    }
    XCTAssertTrue(cover.apply(ResumeView(covered: false, enabled: true, generation: 2, nativeGeneration: 0)))
    NotificationCenter.default.post(name: UIApplication.didEnterBackgroundNotification, object: nil)
    XCTAssertEqual(messages.last?.0, "background"); XCTAssertEqual(messages.last?.1, 1)
    NotificationCenter.default.post(name: UIApplication.didBecomeActiveNotification, object: nil)
    XCTAssertFalse(cover.apply(ResumeView(covered: false, enabled: true, generation: 3, nativeGeneration: 0)))
    XCTAssertTrue(webview.isHidden)
    XCTAssertTrue(cover.apply(ResumeView(covered: false, enabled: true, generation: 3, nativeGeneration: 1)))
    XCTAssertFalse(webview.isHidden)
  }
}
