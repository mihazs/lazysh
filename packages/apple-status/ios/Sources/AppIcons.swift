import Foundation
import Tauri
import UIKit

private struct IconArgs: Decodable { let icon: String }
private final class UIKitIcons: AppIconApplication {
  var supportsIcons: Bool { UIApplication.shared.supportsAlternateIcons }
  var active: Bool { UIApplication.shared.applicationState == .active }
  var alternateName: String? { UIApplication.shared.alternateIconName }
  var configured: Bool {
    let keys = UIDevice.current.userInterfaceIdiom == .pad ? ["CFBundleIcons", "CFBundleIcons~ipad"] : ["CFBundleIcons"]
    return keys.allSatisfy { key in
      guard let icons = Bundle.main.object(forInfoDictionaryKey: key) as? [String: Any],
        let alternates = icons["CFBundleAlternateIcons"] as? [String: Any],
        let amber = alternates["LazyshAmber"] as? [String: Any] else { return false }
      return amber["CFBundleIconName"] as? String == "LazyshAmber"
    }
  }
  func setIcon(_ name: String?, completion: @escaping (Error?) -> Void) {
    UIApplication.shared.setAlternateIconName(name) { error in
      DispatchQueue.main.async { completion(error) }
    }
  }
}
extension AppleStatusPlugin {
  @objc public func appIconStatus(_ invoke: Invoke) {
    DispatchQueue.main.async { self.resolveIcon(self.icons.status(), invoke) }
  }
  @objc public func setAppIcon(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(IconArgs.self)
    DispatchQueue.main.async {
      self.icons.choose(args.icon) { result in
        switch result {
        case .success(let status): self.resolveIcon(status, invoke)
        case .failure(let error): invoke.reject(error.localizedDescription)
        }
      }
    }
  }
  private func resolveIcon(_ status: AppIconStatus, _ invoke: Invoke) {
    invoke.resolve(["available": status.available, "current": status.current, "reason": status.reason])
  }
}
func makeAppIconController() -> AppIconController { AppIconController(UIKitIcons()) }
