import Tauri
import UIKit
import WebKit

private struct DisplayIdleTicket: Decodable { let epoch: String; let ticket: UInt64 }
private final class DisplayIdleView: UIView {
  var moved: (() -> Void)?
  override func didMoveToWindow() { super.didMoveToWindow(); moved?() }
}

class DisplayIdlePlugin: Plugin {
  private weak var webview: WKWebView?
  private var sentinel: DisplayIdleView?
  private var observations: [NSKeyValueObservation] = []
  private var observers: [NSObjectProtocol] = []
  private var lifecycleError: Error?
  private let state = DisplayIdleState(set: { UIApplication.shared.isIdleTimerDisabled = $0 }, read: { UIApplication.shared.isIdleTimerDisabled })
  override init() {
    super.init()
    for name in [UIApplication.willResignActiveNotification, UIApplication.didEnterBackgroundNotification,
                 UIScene.willDeactivateNotification, UIScene.didDisconnectNotification, UIWindow.didResignKeyNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] notification in
        guard let owner = self else { return }
        if let window = notification.object as? UIWindow, window !== owner.webview?.window { return }
        if let scene = notification.object as? UIScene, scene !== owner.webview?.window?.windowScene { return }
        owner.invalidateLifecycle()
      })
    }
  }
  deinit {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    let state = state
    let release = {
      do { try state.invalidate() }
      catch { NSLog("DisplayIdle: teardown release failed: %@", String(describing: error)) }
    }
    if Thread.isMainThread { release() } else { DispatchQueue.main.async(execute: release) }
  }
  override func load(webview: WKWebView) {
    DispatchQueue.main.async {
      self.invalidateLifecycle(); self.observations.removeAll()
      self.sentinel?.moved = nil; self.sentinel?.removeFromSuperview()
      self.webview = webview
      let sentinel = DisplayIdleView(frame: .zero)
      sentinel.isUserInteractionEnabled = false; sentinel.isAccessibilityElement = false
      sentinel.moved = { [weak self] in self?.invalidateLifecycle() }
      webview.addSubview(sentinel); self.sentinel = sentinel
      self.observations = [
        webview.observe(\.isLoading, options: [.new]) { [weak self] _, change in
          if change.newValue == true { self?.invalidateLifecycle() }
        },
        webview.observe(\.isHidden, options: [.new]) { [weak self] _, change in
          if change.newValue == true { self?.invalidateLifecycle() }
        },
        webview.observe(\.alpha, options: [.new]) { [weak self] _, change in
          if change.newValue == 0 { self?.invalidateLifecycle() }
        }
      ]
    }
  }
  private var ready: Bool {
    guard UIApplication.shared.applicationState == .active, let view = webview,
          !view.isLoading, let window = view.window, window.isKeyWindow,
          window.windowScene?.activationState == .foregroundActive else { return false }
    var ancestor: UIView? = view
    while let current = ancestor {
      if current.isHidden || current.alpha <= 0 { return false }; ancestor = current.superview
    }
    return view.bounds.width > 0 && view.bounds.height > 0 && sentinel?.window === window
  }
  private func invalidateLifecycle() {
    do { try state.invalidate(); lifecycleError = nil }
    catch { lifecycleError = error; NSLog("DisplayIdle: native display release failed: %@", String(describing: error)) }
  }
  private func result(_ ticket: UInt64) throws -> JsonObject {
    if let error = lifecycleError { throw error }
    let available = ready
    return ["available": available, "reason": available ? "Native display owner is ready" : "Native display owner is not foreground and focused",
            "active": state.active, "epoch": state.epoch, "ticket": ticket]
  }
  private func command(_ invoke: Invoke, _ action: @escaping () throws -> JsonObject?) {
    DispatchQueue.main.async {
      do { if let result = try action() { invoke.resolve(result) } else { invoke.resolve() } }
      catch { invoke.reject("Native display operation failed: \(error)") }
    }
  }
  private func ticket(_ invoke: Invoke) throws -> DisplayIdleTicket {
    let args = try invoke.parseArgs(DisplayIdleTicket.self)
    guard args.epoch.utf8.count == 36, UUID(uuidString: args.epoch) != nil,
          args.ticket > 0, args.ticket <= DisplayIdleState.maxTicket else { throw DisplayIdleError.invalidTicket }
    return args
  }
  @objc public func status(_ invoke: Invoke) {
    command(invoke) { try self.result(self.state.issue()) }
  }
  @objc public func acquire(_ invoke: Invoke) {
    command(invoke) {
      let args = try self.ticket(invoke)
      if let error = self.lifecycleError { throw error }
      try self.state.acquire(epoch: args.epoch, ticket: args.ticket, ready: self.ready)
      return try self.result(args.ticket)
    }
  }
  @objc public func release(_ invoke: Invoke) {
    command(invoke) {
      let args = try self.ticket(invoke); try self.state.release(epoch: args.epoch, ticket: args.ticket)
      return try self.result(args.ticket)
    }
  }
  @objc public func invalidate(_ invoke: Invoke) {
    command(invoke) { try self.state.invalidate(); self.lifecycleError = nil; return nil }
  }
}

@_cdecl("init_plugin_display_idle") public func initPlugin() -> Plugin { DisplayIdlePlugin() }
