import Foundation
import XCTest

final class PermissionLocalizationTests: XCTestCase {
  func testActualAppContainsEveryNativeLocalizationWithoutFallbackMaskingMissingFiles() throws {
    XCTAssertEqual(Bundle.main.bundleIdentifier, "app.lazysh.client")
    XCTAssertEqual(Bundle.main.object(forInfoDictionaryKey: "CFBundleDevelopmentRegion") as? String, "en")
    for (name, keys) in [
      ("InfoPlist", Set(["NSFaceIDUsageDescription", "NSMicrophoneUsageDescription", "NSCameraUsageDescription"])),
      ("NativeUI", Set(["resume.title", "resume.message", "resume.unlock", "resume.failure", "auth.unlock", "auth.protect", "action.cancel"]))
    ] {
    for locale in ["en", "pt-BR", "es"] {
      let directory = Bundle.main.bundleURL.appendingPathComponent(locale + ".lproj", isDirectory: true)
      let file = try FileHandle(forReadingFrom: directory.appendingPathComponent(name + ".strings"))
      defer { try? file.close() }
      let data = try XCTUnwrap(try file.read(upToCount: 16 * 1024 + 1))
      XCTAssertLessThanOrEqual(data.count, 16 * 1024)
      guard data.count <= 16 * 1024 else { return }
      let table = try XCTUnwrap(PropertyListSerialization.propertyList(from: data, format: nil) as? [String: String])
      XCTAssertEqual(Set(table.keys), keys)
      let localized = try XCTUnwrap(Bundle(url: directory))
      for key in keys {
        let text = try XCTUnwrap(table[key])
        XCTAssertFalse(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        XCTAssertEqual(localized.localizedString(forKey: key, value: "missing", table: name), text)
        if name == "InfoPlist" {
          let fallback = try XCTUnwrap(Bundle.main.infoDictionary?[key] as? String)
          if locale == "en" { XCTAssertEqual(text, fallback) }
          else { XCTAssertNotEqual(text, fallback) }
        }
      }
    }
    }
  }
}
