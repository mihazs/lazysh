import Foundation
import LocalAuthentication
import Security
import XCTest

final class KeychainAvailabilityTests: XCTestCase {
  func testNoninteractiveMissingAccountsReachTheHostKeychain() throws {
    let identifier = try XCTUnwrap(Bundle.main.bundleIdentifier)
    guard identifier == "app.lazysh.client" else {
      XCTFail("Keychain availability must be inspected inside the actual lazysh app host")
      return
    }

    // These accounts are never created. This inspects access to the test host's
    // services, independently of the production resume proof and its policy.
    let account = "lazysh-ci-probe-" + UUID().uuidString
    for namespace in ["biometric-credentials", "credentials"] {
      let context = LAContext()
      context.interactionNotAllowed = true
      let query: [String: Any] = [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: identifier + "." + namespace,
        kSecAttrAccount as String: account,
        kSecAttrSynchronizable as String: false,
        kSecMatchLimit as String: kSecMatchLimitOne,
        kSecReturnAttributes as String: true,
        kSecUseAuthenticationContext as String: context,
        kSecUseAuthenticationUI as String: kSecUseAuthenticationUIFail
      ]
      // No return-data request or output object: never retrieve credentials.
      let status = SecItemCopyMatching(query as CFDictionary, nil)
      context.invalidate()

      let diagnostic = "namespace=\(namespace) OSStatus=\(status)"
      let attachment = XCTAttachment(string: diagnostic)
      attachment.name = "Noninteractive host keychain availability: " + namespace
      attachment.lifetime = .keepAlways
      add(attachment)
      XCTAssertEqual(status, errSecItemNotFound, diagnostic)
    }
  }
}
