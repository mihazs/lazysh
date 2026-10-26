import Foundation

final class NativeUiLocale {
  static let shared = NativeUiLocale()
  private static let key = "lazysh.uiLocale.v1"
  private struct Stored: Codable { let choice: String; let revision: String }
  private let defaults: UserDefaults
  private let bundle: Bundle
  private let languages: () -> [String]
  private let lock = NSLock()
  init(defaults: UserDefaults = .standard, bundle: Bundle = .main, languages: @escaping () -> [String] = { Locale.preferredLanguages }) {
    self.defaults = defaults; self.bundle = bundle; self.languages = languages
  }
  static func validChoice(_ choice: String) -> Bool { ["system", "en", "pt-BR", "es"].contains(choice) }
  static func resolve(_ choice: String, _ requested: [String]) -> String {
    if choice != "system" { return choice }
    for candidate in requested.prefix(16) {
      let parts = candidate.split(separator: "-", omittingEmptySubsequences: false)
      guard !candidate.isEmpty && candidate.utf8.count <= 80,
        parts.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 8 }),
        candidate.utf8.allSatisfy({ (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0) || $0 == 45 }) else { continue }
      let tag = Locale.canonicalLanguageIdentifier(from: candidate)
      let locale = Locale(identifier: tag)
      let language = locale.languageCode?.lowercased()
      if language == "pt" { return "pt-BR" }
      if language == "en" || language == "es" { return tag }
    }
    return "en"
  }
  private func load() throws -> Stored {
    guard let value = defaults.object(forKey: Self.key) else { return Stored(choice: "system", revision: "0") }
    guard let encoded = value as? String, encoded.utf8.count <= 256,
      let data = encoded.data(using: .utf8), let stored = try? JSONDecoder().decode(Stored.self, from: data),
      Self.validChoice(stored.choice), stored.revision.utf8.count == 36,
      stored.revision == stored.revision.lowercased(), UUID(uuidString: stored.revision) != nil else {
      throw NSError(domain: "lazysh.uiLocale", code: 1)
    }
    return stored
  }
  private func snapshot(_ stored: Stored) -> [String: Any] {
    ["nativeAuthority": true, "choice": stored.choice, "resolvedLocale": Self.resolve(stored.choice, languages()), "revision": stored.revision]
  }
  func status() throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    return snapshot(try load())
  }
  func set(_ choice: String, expectedRevision: String) throws -> [String: Any] {
    lock.lock(); defer { lock.unlock() }
    guard Self.validChoice(choice), expectedRevision.utf8.count <= 36 else { throw NSError(domain: "lazysh.uiLocale", code: 2) }
    let current = try load()
    guard current.revision == expectedRevision else { throw NSError(domain: "lazysh.uiLocale", code: 3) }
    if current.choice == choice { return snapshot(current) }
    let next = Stored(choice: choice, revision: UUID().uuidString.lowercased())
    let data = try JSONEncoder().encode(next)
    defaults.set(String(decoding: data, as: UTF8.self), forKey: Self.key)
    return snapshot(next)
  }
  func text(_ key: String) -> String {
    let fallback = Self.english[key] ?? key
    let status = try? status()
    let tag = status?["resolvedLocale"] as? String ?? "en"
    let language = tag.lowercased().hasPrefix("pt") ? "pt-BR" : (tag.lowercased().hasPrefix("es") ? "es" : "en")
    guard let path = bundle.path(forResource: language, ofType: "lproj"), let localized = Bundle(path: path) else { return fallback }
    return localized.localizedString(forKey: key, value: fallback, table: "NativeUI")
  }
  private static let english = [
    "resume.title": "lazysh is locked",
    "resume.message": "Unlock with this device's biometrics to continue.",
    "resume.unlock": "Unlock lazysh",
    "resume.failure": "Unlock failed or was cancelled. lazysh remains locked. Check device biometrics and retry.",
    "auth.unlock": "Unlock lazysh credentials",
    "auth.protect": "Protect lazysh credentials",
    "action.cancel": "Cancel",
  ]
}
