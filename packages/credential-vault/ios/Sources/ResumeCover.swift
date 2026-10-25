import UIKit
import WebKit

final class ResumeCover: NSObject {
  private var gate = ResumeGate()
  private weak var webview: WKWebView?
  private var overlay: UIView?
  private var button: UIButton?
  private var status: UILabel?
  private var events: ((String, UInt64) -> Void)?
  private var observers: [NSObjectProtocol] = []
  var ready: Bool { overlay != nil && webview != nil }
  override init() {
    super.init()
    let center = NotificationCenter.default
    observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let owner = self else { return }; owner.gate.pause(); owner.render()
    })
    observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      guard let owner = self else { return }; owner.gate.background(); owner.render(); owner.send("background")
    })
    observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let owner = self else { return }; owner.gate.resume(); owner.render(); owner.send("foreground")
    })
  }
  deinit { observers.forEach { NotificationCenter.default.removeObserver($0) } }
  func load(webview: WKWebView, host: UIView?) {
    precondition(Thread.isMainThread)
    self.webview = webview
    webview.isHidden = true
    guard let host = host, host !== webview else { return }
    let panel = UIView(frame: host.bounds); panel.backgroundColor = UIColor(red: 0.07, green: 0.08, blue: 0.09, alpha: 1)
    panel.autoresizingMask = [.flexibleWidth, .flexibleHeight]; panel.accessibilityViewIsModal = true
    let title = UILabel(); title.text = "lazysh is locked"; title.textColor = .white; title.font = .preferredFont(forTextStyle: .title1)
    let detail = UILabel(); detail.text = "Unlock with this device's biometrics to continue."; detail.textColor = .white; detail.numberOfLines = 0; status = detail
    let unlock = UIButton(type: .system); unlock.setTitle("Unlock lazysh", for: .normal); unlock.tintColor = .white
    unlock.isEnabled = events != nil; unlock.addTarget(self, action: #selector(unlockRequested), for: .touchUpInside); button = unlock
    let stack = UIStackView(arrangedSubviews: [title, detail, unlock]); stack.axis = .vertical; stack.spacing = 24; stack.alignment = .center
    stack.translatesAutoresizingMaskIntoConstraints = false; panel.addSubview(stack)
    NSLayoutConstraint.activate([stack.centerXAnchor.constraint(equalTo: panel.centerXAnchor), stack.centerYAnchor.constraint(equalTo: panel.centerYAnchor), stack.widthAnchor.constraint(lessThanOrEqualTo: panel.widthAnchor, constant: -48)])
    host.addSubview(panel); overlay = panel; render(); if events != nil { send("ready") }
  }
  func register(_ callback: @escaping (String, UInt64) -> Void) { events = callback; button?.isEnabled = true; if ready { send("ready") } }
  func apply(_ args: ResumeView) -> Bool {
    guard ready, gate.apply(covered: args.covered, enabled: args.enabled, generation: args.generation, nativeGeneration: args.nativeGeneration) else { return false }
    render(); return true
  }
  func failure() { if gate.covered { status?.text = "Unlock failed or was cancelled. lazysh remains locked. Check device biometrics and retry." } }
  @objc private func unlockRequested() { if gate.covered { send("unlock") } }
  private func send(_ kind: String) { events?(kind, gate.nativeGeneration) }
  private func render() {
    let covered = gate.covered
    webview?.isHidden = covered; webview?.isUserInteractionEnabled = !covered; webview?.accessibilityElementsHidden = covered
    overlay?.isHidden = !covered
    if covered { webview?.endEditing(true); if let panel = overlay { panel.superview?.bringSubviewToFront(panel) } }
  }
}
