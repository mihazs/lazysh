import XCTest
import Foundation

func isolatedUiLocale(_ test: XCTestCase, languages: @escaping () -> [String] = { ["en-GB"] }, bundle: Bundle = .main) -> (NativeUiLocale, UserDefaults) {
  let name = "app.lazysh.locale-test.\(UUID().uuidString.lowercased())"
  let defaults = UserDefaults(suiteName: name)!
  test.addTeardownBlock { defaults.removePersistentDomain(forName: name) }
  return (NativeUiLocale(defaults: defaults, bundle: bundle, languages: languages), defaults)
}

final class NativeUiLocaleTests: XCTestCase {
  func testColdReadNeverWritesAndChoiceSurvivesNewProvider() throws {
    let (locale, defaults) = isolatedUiLocale(self)
    let initial = try locale.status()
    XCTAssertEqual(initial["choice"] as? String, "system")
    XCTAssertEqual(initial["resolvedLocale"] as? String, "en-GB")
    XCTAssertNil(defaults.object(forKey: "lazysh.uiLocale.v1"))
    let next = try locale.set("pt-BR", expectedRevision: "0")
    let restored = NativeUiLocale(defaults: defaults)
    XCTAssertEqual(try restored.status()["choice"] as? String, "pt-BR")
    XCTAssertEqual(try restored.status()["revision"] as? String, next["revision"] as? String)
    XCTAssertThrowsError(try locale.set("es", expectedRevision: "0"))
    XCTAssertThrowsError(try locale.set("../es", expectedRevision: next["revision"] as! String))
    defaults.set("corrupt", forKey: "lazysh.uiLocale.v1")
    XCTAssertThrowsError(try locale.status())
    XCTAssertThrowsError(try locale.set("en", expectedRevision: "0"))
    XCTAssertEqual(locale.text("resume.title"), "lazysh is locked")
    XCTAssertEqual(defaults.string(forKey: "lazysh.uiLocale.v1"), "corrupt")
  }
  func testSystemResolutionRetainsRegionsAndHasBoundedFallback() {
    for (requested, expected) in [(["ja", "es-MX"], "es-MX"), (["pt-PT"], "pt-BR"), (["en-GB"], "en-GB"), (["es--MX", "../en", "ja"], "en")] {
      XCTAssertEqual(NativeUiLocale.resolve("system", requested), expected)
    }
    XCTAssertEqual(NativeUiLocale.resolve("system", Array(repeating: "ja", count: 16) + ["es"]), "en")
    XCTAssertEqual(NativeUiLocale.resolve("es", ["en"]), "es")
  }
  func testExplicitBundleLookupPreservesFailurePresentationWithoutRewritingChoice() throws {
    let root = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString).appendingPathExtension("bundle")
    try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
    addTeardownBlock { try? FileManager.default.removeItem(at: root) }
    let info = try PropertyListSerialization.data(fromPropertyList: ["CFBundleIdentifier": "app.lazysh.locale-fixture", "CFBundlePackageType": "BNDL"], format: .xml, options: 0)
    try info.write(to: root.appendingPathComponent("Info.plist"))
    let folder = root.appendingPathComponent("es.lproj")
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    try "\"resume.failure\" = \"Fallo de prueba\";".write(to: folder.appendingPathComponent("NativeUI.strings"), atomically: true, encoding: .utf8)
    let (locale, _) = isolatedUiLocale(self, bundle: Bundle(path: root.path)!)
    _ = try locale.set("es", expectedRevision: "0")
    XCTAssertEqual(locale.text("resume.failure"), "Fallo de prueba")
    XCTAssertEqual(locale.text("resume.title"), "lazysh is locked")
  }
}
