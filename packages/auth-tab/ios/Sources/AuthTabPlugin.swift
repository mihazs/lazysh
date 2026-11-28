import SafariServices
import Tauri
import UIKit

private struct PresentArguments: Decodable { let url: URL }

/// Presents the sign-in page in an `SFSafariViewController` and keeps the one reference, so the tab can be dismissed
/// when the sign-in tunnel closes. lazysh stays the active app while it shows, which keeps its loopback listener alive.
class AuthTabPlugin: Plugin {
  private weak var tab: SFSafariViewController?

  @objc public func present(_ invoke: Invoke) {
    do {
      let url = try invoke.parseArgs(PresentArguments.self).url
      guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
        invoke.reject("The sign-in tab opens only http and https pages")
        return
      }
      DispatchQueue.main.async {
        guard let host = self.manager.viewController else { invoke.reject("lazysh has no view to present over"); return }
        let show = {
          // A tab already on screen belongs to this plugin or to the opener plugin; present over the top-most controller.
          var top: UIViewController = host
          while let next = top.presentedViewController, !next.isBeingDismissed { top = next }
          let tab = SFSafariViewController(url: url)
          self.tab = tab
          top.present(tab, animated: true) { invoke.resolve() }
        }
        if let old = self.tab, old.presentingViewController != nil { old.dismiss(animated: false, completion: show) } else { show() }
      }
    } catch { invoke.reject("The sign-in tab could not read its arguments: \(error)") }
  }

  @objc public func dismiss(_ invoke: Invoke) {
    DispatchQueue.main.async {
      if let tab = self.tab, tab.presentingViewController != nil { tab.dismiss(animated: true) }
      self.tab = nil
      invoke.resolve()
    }
  }
}

@_cdecl("init_plugin_auth_tab") public func initPlugin() -> Plugin { AuthTabPlugin() }
