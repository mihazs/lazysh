import Security
import LocalAuthentication
import Tauri
import UIKit
import WebKit

struct VaultItem: Decodable { let key: String; let value: String?; let biometric: Bool? }

class VaultPlugin: Plugin {
  private let lock = NSLock()
  private var contexts: [UUID: LAContext] = [:]
  private var epoch: UInt64 = 0
  private var backgroundObserver: NSObjectProtocol?
  override init() {
    super.init()
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.cancelContexts() }
  }
  deinit { if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }; cancelContexts() }
  private func query(_ key: String, _ biometric: Bool = false) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword,
     kSecAttrService as String: (Bundle.main.bundleIdentifier ?? "app.lazysh.client") + (biometric ? ".biometric-credentials" : ".credentials"),
     kSecAttrAccount as String: key, kSecAttrSynchronizable as String: false]
  }
  private func item(_ invoke: Invoke) throws -> VaultItem {
    let args = try invoke.parseArgs(VaultItem.self)
    guard !args.key.isEmpty && args.key.utf8.count <= 1024 && (args.value?.utf8.count ?? 0) <= 131072 else { throw NSError(domain: "lazysh.vault", code: 1) }
    return args
  }
  private func exists(_ key: String, _ biometric: Bool) throws -> Bool {
    var lookup = query(key, biometric); lookup[kSecReturnAttributes as String] = true
    lookup[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
    let status = SecItemCopyMatching(lookup as CFDictionary, nil)
    if status == errSecItemNotFound { return false }
    guard status == errSecSuccess || status == errSecInteractionNotAllowed else { throw NSError(domain: "lazysh.vault", code: Int(status)) }
    return true
  }
  private func cancelContexts() {
    lock.lock(); epoch &+= 1; let pending = Array(contexts.values); lock.unlock()
    pending.forEach { $0.invalidate() }
  }
  private func currentEpoch() -> UInt64 { lock.lock(); defer { lock.unlock() }; return epoch }
  @objc public func capability(_ invoke: Invoke) {
    let context = LAContext(); var error: NSError?
    let available = context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    context.invalidate()
    invoke.resolve(["available": available, "reason": available ? "Current biometrics protect each credential read" : "Enroll supported biometrics to enable this option"])
  }
  @objc public func exists(_ invoke: Invoke) throws {
    let args = try item(invoke)
    do { invoke.resolve(["exists": try exists(args.key, true) || exists(args.key, false)]) }
    catch { invoke.reject("Cannot inspect device credentials") }
  }
  @objc public func cancel(_ invoke: Invoke) { cancelContexts(); invoke.resolve() }
  @objc public func read(_ invoke: Invoke) throws {
    let args = try item(invoke)
    let expected = currentEpoch()
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        let biometric = try self.exists(args.key, true)
        if args.biometric == true && !biometric { invoke.reject("Credentials require re-entry to enable biometric protection"); return }
        var lookup = self.query(args.key, biometric)
        lookup[kSecReturnData as String] = true; lookup[kSecMatchLimit as String] = kSecMatchLimitOne
        let id = UUID(); let context = LAContext()
        if biometric {
          context.touchIDAuthenticationAllowableReuseDuration = 0
          context.localizedReason = "Unlock lazysh credentials"
          self.lock.lock()
          if !self.contexts.isEmpty || self.epoch != expected { self.lock.unlock(); invoke.reject("Credential authentication cancelled or another request is in progress"); return }
          self.contexts[id] = context; self.lock.unlock()
          lookup[kSecUseAuthenticationContext as String] = context
        }
        defer { context.invalidate(); self.lock.lock(); self.contexts.removeValue(forKey: id); self.lock.unlock() }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if self.currentEpoch() != expected { invoke.reject("Credential authentication cancelled"); return }
        if status == errSecItemNotFound {
          if biometric { invoke.reject("Biometric enrollment changed. Forget saved credentials and enter them again.") }
          else { invoke.resolve([:] as JsonObject) }; return
        }
        guard status == errSecSuccess, let data = result as? Data, let value = String(data: data, encoding: .utf8) else { invoke.reject("Credential authentication cancelled, locked or unavailable"); return }
        invoke.resolve(["value": value])
      } catch { invoke.reject("Cannot read device credentials") }
    }
  }
  @objc public func write(_ invoke: Invoke) throws {
    let args = try item(invoke)
    guard let data = args.value?.data(using: .utf8) else { invoke.reject("Missing credentials"); return }
    let biometric = args.biometric == true
    let expected = currentEpoch()
    let hasProtected = try exists(args.key, true)
    if !biometric && hasProtected { invoke.reject("Forget protected credentials before disabling biometrics"); return }
    var attributes: [String: Any] = [kSecValueData as String: data]
    if biometric {
      let context = LAContext(); var error: NSError?
      guard context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { invoke.reject("Biometrics are unavailable or not enrolled"); return }
      guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, .biometryCurrentSet, nil) else { invoke.reject("Cannot create biometric protection"); return }
      attributes[kSecAttrAccessControl as String] = access
    } else { attributes[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly }
    DispatchQueue.global(qos: .userInitiated).async {
      let id = UUID(); let context = LAContext()
      var lookup = self.query(args.key, biometric)
      if biometric {
        context.touchIDAuthenticationAllowableReuseDuration = 0
        context.localizedReason = "Protect lazysh credentials"
        self.lock.lock()
        if !self.contexts.isEmpty || self.epoch != expected { self.lock.unlock(); invoke.reject("Credential authentication cancelled or another request is in progress"); return }
        self.contexts[id] = context; self.lock.unlock()
        lookup[kSecUseAuthenticationContext as String] = context
      }
      defer { context.invalidate(); self.lock.lock(); self.contexts.removeValue(forKey: id); self.lock.unlock() }
      if self.currentEpoch() != expected { invoke.reject("Credential authentication cancelled"); return }
      var update = attributes
      // Preserve an existing access-control object; protection policy changes use a separate item.
      update.removeValue(forKey: kSecAttrAccessControl as String)
      var status = SecItemUpdate(lookup as CFDictionary, update as CFDictionary)
      if status == errSecItemNotFound {
        var insert = self.query(args.key, biometric); attributes.forEach { insert[$0.key] = $0.value }
        status = SecItemAdd(insert as CFDictionary, nil)
      }
      guard status == errSecSuccess else { invoke.reject("Cannot save device credentials"); return }
      if biometric {
        let removed = SecItemDelete(self.query(args.key, false) as CFDictionary)
        guard removed == errSecSuccess || removed == errSecItemNotFound else { invoke.reject("Protection saved but previous credentials could not be removed. Forget saved credentials and try again."); return }
      }
      if self.currentEpoch() != expected { invoke.reject("Credential authentication cancelled"); return }
      invoke.resolve()
    }
  }
  @objc public func remove(_ invoke: Invoke) throws {
    let args = try item(invoke)
    for biometric in [false, true] {
      let status = SecItemDelete(query(args.key, biometric) as CFDictionary)
      guard status == errSecSuccess || status == errSecItemNotFound else { invoke.reject("Cannot delete device credentials"); return }
    }
    invoke.resolve()
  }
}
@_cdecl("init_plugin_lazysh_vault") public func initPlugin() -> Plugin { VaultPlugin() }
