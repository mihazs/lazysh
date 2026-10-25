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
    let mirrorPresent = ProcessInfo.processInfo.environment["OS_ACTIVITY_DT_MODE"] != nil
    let mirrorDisabledMarker = ProcessInfo.processInfo.environment["IDE_DISABLED_OS_ACTIVITY_DT_MODE"] == "1"
    let loggingDiagnostic = "lazysh.hosted logging mirrorPresent=\(mirrorPresent) mirrorDisabledMarker=\(mirrorDisabledMarker)"
    print(loggingDiagnostic)
    let loggingAttachment = XCTAttachment(string: loggingDiagnostic)
    loggingAttachment.name = "Hosted logging controls"
    loggingAttachment.lifetime = .keepAlways
    add(loggingAttachment)
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let view = self.appWebView(), let url = view.url else { return false }
      return url.scheme != "about" && !view.isLoading
    }, object: nil)
    wait(for: [ready], timeout: 30)
    let view = try XCTUnwrap(appWebView(), "The actual app must own its WKWebView")
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

  private func resumeVisibility(_ view: WKWebView) -> String {
    // Traverse only native siblings, never the WKWebView or its accessibility contents.
    let allowed = [
      "lazysh is locked",
      "Unlock with this device's biometrics to continue.",
      "Unlock failed or was cancelled. lazysh remains locked. Check device biometrics and retry.",
    ]
    func overlayLabels(_ node: UIView) -> [String] {
      if node is WKWebView { return [] }
      if let label = node as? UILabel, let text = label.text, allowed.contains(text) { return [text] }
      return node.subviews.flatMap(overlayLabels)
    }
    let labels = view.superview?.subviews.filter { $0 !== view }.flatMap(overlayLabels) ?? []
    let root = view.window?.rootViewController?.view
    return "hidden=\(view.isHidden), parentIsController=\(view.superview != nil && view.superview === root), controllerIsWebView=\(root === view), overlayLabels=\(labels)"
  }

  func testActualNativeResumeBootstrapResolvesDisabledPolicyBeforeRevealingWorkspace() throws {
    let loaded = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let view = self.appWebView(), let url = view.url else { return false }
      return url.scheme != "about" && !view.isLoading
    }, object: nil)
    wait(for: [loaded], timeout: 30)
    let view = try XCTUnwrap(appWebView(), "The actual app must own its WKWebView")
    let resolved = expectation(description: "Actual native resume authority initializes")
    let bootstrapDeadline = Date().addingTimeInterval(30)
    var alive = true
    var finished = false
    var last = (initialized: false, enabled: false, locked: true, reason: "Native resume status has not replied")
    var lastBootstrap = "unavailable"
    // Poll natively: hidden WKWebView timers must not control the bootstrap deadline.
    // This clean installed-app fixture has never opted into resume protection.
    func poll() {
      guard alive && !finished && bootstrapDeadline.timeIntervalSinceNow > 0 else { return }
      var answered = false
      // Project only allowed diagnostics: the nonce/full status never leaves the page.
      view.callAsyncJavaScript("""
        let state;
        try { state = await window.__TAURI_INTERNALS__.invoke('app_lock_status'); }
        catch { return {initialized: false, enabled: false, locked: true, reason: 'Native resume status IPC failed'}; }
        const phases = ['pending', 'running', 'succeeded', 'failed'];
        const stages = ['registration', 'capability', 'policyProof', 'authority', 'worker'];
        const failures = ['location', 'storage', 'credentialInspection', 'credentialService', 'other'];
        const trace = state?.debugBootstrap;
        // Copy fixed diagnostic fields only; never attach the full response or nonce.
        const bootstrap = trace ? JSON.stringify({
          registration: phases.includes(trace.registration) ? trace.registration : 'unknown',
          readyReceived: trace.readyReceived === true,
          capability: phases.includes(trace.capability) ? trace.capability : 'unknown',
          policyProof: phases.includes(trace.policyProof) ? trace.policyProof : 'unknown',
          authority: phases.includes(trace.authority) ? trace.authority : 'unknown',
          worker: phases.includes(trace.worker) ? trace.worker : 'unknown',
          firstFailure: stages.includes(trace.firstFailure) ? trace.firstFailure : null,
          policyFailure: failures.includes(trace.policyFailure) ? trace.policyFailure : null
        }) : 'unavailable';
        return {
          initialized: state?.initialized === true,
          enabled: state?.enabled === true,
          locked: state?.locked !== false,
          reason: typeof state?.reason === 'string' ? state.reason.slice(0, 160) : 'Native resume status unavailable',
          bootstrap
        };
        """, arguments: [:], in: nil, in: .page) { result in
          DispatchQueue.main.async {
            guard alive && !finished && !answered else { return }
            answered = true
            if bootstrapDeadline.timeIntervalSinceNow <= 0 {
              finished = true
              resolved.fulfill()
              return
            }
            switch result {
            case .success(let response):
              if let state = response as? [String: Any] {
                lastBootstrap = String((state["bootstrap"] as? String ?? "unavailable").prefix(512))
                last = (state["initialized"] as? Bool == true,
                        state["enabled"] as? Bool == true,
                        state["locked"] as? Bool != false,
                        String((state["reason"] as? String ?? "Native resume status unavailable").prefix(160)))
              } else {
                last.reason = "Native resume status projection unavailable"
              }
            case .failure:
              last.reason = "Native resume status callback failed"
            }
            if last.initialized || bootstrapDeadline.timeIntervalSinceNow <= 0 {
              finished = true
              resolved.fulfill()
            } else {
              DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { poll() }
            }
          }
        }
    }
    poll()
    let completed = XCTWaiter.wait(for: [resolved], timeout: max(0, bootstrapDeadline.timeIntervalSinceNow)) == .completed
    alive = false
    if completed && last.initialized && view.isHidden && bootstrapDeadline.timeIntervalSinceNow > 0 {
      let revealed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !view.isHidden }, object: nil)
      _ = XCTWaiter.wait(for: [revealed], timeout: max(0, bootstrapDeadline.timeIntervalSinceNow))
    }
    let mirrorPresent = ProcessInfo.processInfo.environment["OS_ACTIVITY_DT_MODE"] != nil
    let mirrorDisabledMarker = ProcessInfo.processInfo.environment["IDE_DISABLED_OS_ACTIVITY_DT_MODE"] == "1"
    let diagnostic = "initialized=\(last.initialized), enabled=\(last.enabled), locked=\(last.locked), reason=\(last.reason), \(resumeVisibility(view)), bootstrap=\(lastBootstrap), mirrorPresent=\(mirrorPresent), mirrorDisabledMarker=\(mirrorDisabledMarker)"
    let attachment = XCTAttachment(string: diagnostic)
    attachment.name = "Native resume bootstrap projection"
    attachment.lifetime = .keepAlways
    add(attachment)
    XCTAssertTrue(completed && last.initialized && !last.enabled && !last.locked && !view.isHidden, diagnostic)
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
