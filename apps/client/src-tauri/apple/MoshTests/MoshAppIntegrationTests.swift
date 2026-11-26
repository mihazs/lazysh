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

  private func loadedTerminalWebView() throws -> WKWebView {
    let ready = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
      guard let view = self.appWebView(), let url = view.url else { return false }
      return url.scheme != "about" && !view.isLoading
    }, object: nil)
    XCTAssertEqual(XCTWaiter.wait(for: [ready], timeout: 30), .completed)
    return try XCTUnwrap(appWebView())
  }

  func testNativeTerminalBuildAdmitsTheMetalRenderer() throws {
    let view = try loadedTerminalWebView()
    let replied = expectation(description: "Native terminal probe")
    view.callAsyncJavaScript("""
      const invoke = window.__TAURI_INTERNALS__.invoke;
      const core = await invoke('terminal_core_available');
      const probe = await invoke('native_terminal_probe');
      return {core: core.available, admitted: probe.available, backend: probe.adapter?.backend ?? '', reason: probe.reason};
      """, arguments: [:], in: nil, in: .page) { result in
        defer { replied.fulfill() }
        switch result {
        case .success(let response):
          let verdict = response as? [String: Any]
          XCTAssertEqual(verdict?["core"] as? Bool, true)
          XCTAssertEqual(verdict?["admitted"] as? Bool, true, verdict?["reason"] as? String ?? "Missing probe reply")
          XCTAssertEqual(verdict?["backend"] as? String, "Metal")
        case .failure(let error):
          XCTFail("Native terminal capability IPC failed: \(error)")
        }
      }
    wait(for: [replied], timeout: 15)
  }

  func testNativeTerminalAttachesAndHandsBackAnOwnedSshSession() throws {
    let environment = ProcessInfo.processInfo.environment
    let port = try XCTUnwrap(environment["LAZYSH_TERMINAL_FIXTURE_PORT"].flatMap(Int.init))
    let fingerprint = try XCTUnwrap(environment["LAZYSH_TERMINAL_FIXTURE_FINGERPRINT"])
    let password = try XCTUnwrap(environment["LAZYSH_TERMINAL_FIXTURE_PASSWORD"])
    let view = try loadedTerminalWebView()
    let completed = expectation(description: "Owned SSH Native terminal and handback")
    view.callAsyncJavaScript("""
      const ipc = window.__TAURI_INTERNALS__;
      const waitFor = async (label, read) => {
        for (let attempt = 0; attempt < 160; ++attempt) {
          const value = await read();
          if (value) return value;
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('Timed out waiting for ' + label);
      };
      const access = await waitFor('app access', async () => {
        const status = await ipc.invoke('app_lock_status');
        return status.initialized && !status.locked ? status : null;
      }).catch(() => null);
      if (!access) return {passed: false, stage: 'initialize app access', type: 'unavailable'};
      const invoke = (command, args) => ipc.invoke(command, args, {headers: {'X-Lazysh-Access': access.nonce ?? ''}});
      const host = 'Owned iOS terminal UI ' + port;
      const engineKey = 'lazysh.terminal.backend';
      const topBarKey = 'lazysh.show-top-bar.v1';
      const previousEngine = localStorage.getItem(engineKey);
      const previousTopBar = localStorage.getItem(topBarKey);
      const restore = (key, value) => {
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      };
      const visible = element => element.getClientRects().length && !element.closest('[aria-hidden=true]');
      const button = (scope, label) => [...scope.querySelectorAll('button')].find(element =>
        visible(element) && !element.disabled && (element.getAttribute('aria-label') || element.textContent.trim()) === label);
      const click = async (label, scope = document) => (await waitFor(label, () => button(scope, label))).click();
      const setField = async (selector, value) => {
        const input = await waitFor(selector, () => document.querySelector(selector));
        Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value').set.call(input, value);
        input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', {bubbles: true}));
      };
      const surface = () => document.querySelector('[data-terminal-surface=native]');
      const rows = () => [...document.querySelectorAll('.terminal-canvas .xterm-rows > div')].map(row => row.textContent);
      const sendInput = async selector => {
        const editor = await waitFor('terminal editor', () => document.querySelector(selector));
        editor.focus();
        const data = 'LAZYSH_IOS_INPUT';
        editor.value = data;
        editor.dispatchEvent(new InputEvent('input', {bubbles: true, data, inputType: 'insertText'}));
        const enter = {key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true};
        editor.dispatchEvent(new KeyboardEvent('keydown', enter));
        editor.dispatchEvent(new KeyboardEvent('keyup', enter));
      };
      let stage = 'open add-host form';
      try {
        localStorage.setItem(engineKey, 'native');
        localStorage.setItem(topBarKey, 'true');
        window.dispatchEvent(new Event('lazysh-show-top-bar'));
        button(document, 'Open hosts')?.click();
        await click('Add host');
        stage = 'save fixture host';
        await setField("input[placeholder='Home workstation']", host);
        await setField("input[placeholder='workstation.local']", '127.0.0.1');
        await setField("input[placeholder='Your SSH username']", 'terminal-fixture');
        await setField('.port-field input', String(port));
        await setField("[role=dialog] select:has(option[value='ssh'])", 'ssh');
        await click('Save host');
        stage = 'connect and verify host key';
        await click('Connect to ' + host);
        await setField("[role=dialog] input[type=password]", password);
        await click('Connect');
        await waitFor('the pinned host key', () => document.querySelector('.fingerprint code')?.textContent === fingerprint);
        await click('Trust key and connect');
        stage = 'show native terminal';
        await waitFor('the native terminal surface', surface);
        button(document, 'Skip')?.click();
        stage = 'type through native editor';
        await sendInput('[data-terminal-editor]');
        stage = 'switch engines through workspace tools';
        await click('Workspace tools');
        const tools = await waitFor('workspace tools', () => document.querySelector('[role=dialog]:has(.workspace-tools-content)'));
        const action = 'Switch this session to xterm.js';
        const control = await waitFor(action, () => [...tools.querySelectorAll('.workspace-tools-page button')].find(element => element.textContent.trim() === action));
        const page = control.closest('.workspace-tools-page');
        const tab = [...tools.querySelectorAll('[role=tab]')].find(item => item.getAttribute('aria-controls') === page.id);
        if (tab?.getAttribute('aria-selected') === 'false') tab.click();
        await click(action, tools);
        stage = 'show xterm.js after switching';
        await waitFor('native surface removed and xterm editor present', () =>
          !surface() && document.querySelector('.terminal-canvas .xterm-helper-textarea'));
        stage = 'read the replayed native frame';
        await waitFor('replayed frame', () => rows().some(row => row.includes('LAZYSH_IOS_FRAME')));
        stage = 'read the native input acknowledgement after switching';
        await waitFor('one replayed native input acknowledgement', () =>
          rows().filter(row => row.includes('LAZYSH_IOS_ACK')).length === 1);
        stage = 'type through the xterm.js editor';
        await sendInput('.xterm-helper-textarea');
        await waitFor('second acknowledgement over the same session', () =>
          rows().filter(row => row.includes('LAZYSH_IOS_ACK')).length === 2);
        stage = 'read the visible fallback reason';
        await click('Workspace tools');
        const note = await waitFor('engine switch reason', () => [...document.querySelectorAll('[role=note]')].find(note =>
          note.textContent.includes('xterm.js: you switched this session from the native engine')));
        const notePage = note.closest('.workspace-tools-page');
        const noteTab = [...document.querySelectorAll('[role=tab]')].find(item => item.getAttribute('aria-controls') === notePage?.id);
        if (noteTab?.getAttribute('aria-selected') === 'false') noteTab.click();
        await waitFor('visible engine switch reason', () => visible(note));
        return {passed: true};
      } catch (error) {
        return {passed: false, stage, type: error instanceof TypeError ? 'TypeError' : error instanceof Error ? 'Error' : typeof error};
      } finally {
        restore(engineKey, previousEngine);
        restore(topBarKey, previousTopBar);
        window.dispatchEvent(new Event('lazysh-show-top-bar'));
        button(document, 'Close Workspace tools')?.click();
        button(document, 'Disconnect ' + host)?.click();
        const saved = (await invoke('list_hosts')).find(entry => entry.name === host);
        if (saved) await invoke('delete_host', {hostId: saved.id});
      }
      """, arguments: ["port": port, "password": password, "fingerprint": fingerprint], in: nil, in: .page) { result in
      defer { completed.fulfill() }
      switch result {
      case .success(let value):
        let verdict = value as? [String: Any]
        let stage = verdict?["stage"] as? String ?? "unknown stage"
        let type = verdict?["type"] as? String ?? "unknown error"
        XCTAssertEqual(verdict?["passed"] as? Bool, true, "Owned iOS terminal failed at \(stage) (\(type))")
      case .failure(let error):
        let details = error as NSError
        let line = details.userInfo["WKJavaScriptExceptionLineNumber"] as? Int ?? 0
        XCTFail("Owned iOS terminal failed: \(error.localizedDescription) (script line \(line))")
      }
    }
    wait(for: [completed], timeout: 65)
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
