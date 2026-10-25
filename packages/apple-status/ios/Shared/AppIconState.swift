import Foundation

struct AppIconStatus: Equatable {
  let available: Bool
  let current: String
  let reason: String
}
protocol AppIconApplication: AnyObject {
  var supportsIcons: Bool { get }
  var configured: Bool { get }
  var active: Bool { get }
  var alternateName: String? { get }
  func setIcon(_ name: String?, completion: @escaping (Error?) -> Void)
}
final class AppIconController {
  private let app: AppIconApplication
  private var changing = false
  init(_ app: AppIconApplication) { self.app = app }
  func status() -> AppIconStatus {
    // LaunchServices getters can wait behind the pending icon mutation queue.
    guard !changing else {
      return AppIconStatus(available: false, current: "unknown", reason: "An iOS icon change is in progress. Refresh after it finishes.")
    }
    let current = app.alternateName.map { $0 == "LazyshAmber" ? "amber" : "unknown" } ?? "default"
    let available = app.supportsIcons && app.configured
    return AppIconStatus(available: available, current: current,
      reason: available ? "The Home Screen icon is managed by iOS on this device."
        : "Alternate Home Screen icons are unavailable on this device or app build.")
  }
  func choose(_ icon: String, completion: @escaping (Result<AppIconStatus, Error>) -> Void) {
    guard icon == "default" || icon == "amber" else { completion(.failure(IconFailure.invalid)); return }
    guard !changing else { completion(.failure(IconFailure.busy)); return }
    guard status().available, app.active else { completion(.failure(IconFailure.unavailable)); return }
    if status().current == icon { completion(.success(status())); return }
    changing = true
    app.setIcon(icon == "default" ? nil : "LazyshAmber") { error in
      self.changing = false
      if error != nil { completion(.failure(IconFailure.rejected)); return }
      let actual = self.status()
      guard actual.current == icon else { completion(.failure(IconFailure.unchanged)); return }
      completion(.success(actual))
    }
  }
}
enum IconFailure: Error, LocalizedError {
  case invalid, unavailable, busy, rejected, unchanged
  var errorDescription: String? {
    switch self {
    case .invalid: return "Choose a bundled lazysh app icon."
    case .unavailable: return "Icon changes require an active iOS app with alternate icons available."
    case .busy: return "An icon change is already in progress."
    case .rejected: return "iOS could not change the Home Screen icon. Refresh to read the current icon."
    case .unchanged: return "iOS did not report the requested icon. Refresh to read the current icon."
    }
  }
}
