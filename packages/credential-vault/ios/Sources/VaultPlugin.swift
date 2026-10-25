import Security
import LocalAuthentication
import Tauri
import UIKit
import WebKit

struct VaultItem: Decodable { let key: String; let value: String?; let biometric: Bool?; let authEpoch: UInt64? }
struct VaultCancellation: Decodable { let authEpoch: UInt64; let backgroundGeneration: UInt64? }
struct VaultLifecycle: Decodable { let background: Channel }
struct ResumeRegistration: Decodable { let events: Channel }

class VaultPlugin: Plugin {
  private let lock = NSLock()
  private let resumeCover = ResumeCover()
  override func load(webview: WKWebView) { resumeCover.load(webview: webview, host: manager.viewController?.view) }
  @objc public func resumeFailure(_ invoke: Invoke) { DispatchQueue.main.async { self.resumeCover.failure(); invoke.resolve() } }
  @objc public func resumeCapability(_ invoke: Invoke) {
    DispatchQueue.main.async {
      let context = LAContext(); var error: NSError?
      let available = self.resumeCover.ready && context.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
      context.invalidate()
      invoke.resolve(["available": available, "reason": available ? "Native biometric privacy cover is ready" : "Enrolled biometrics and a native privacy cover are required"])
    }
  }
  @objc public func registerResume(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ResumeRegistration.self)
    DispatchQueue.main.async {
      self.resumeCover.register { kind, generation in args.events.send(["kind": kind, "nativeGeneration": generation] as JsonObject) }
      invoke.resolve()
    }
  }
  @objc public func resumeView(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ResumeView.self)
    DispatchQueue.main.async {
      if self.resumeCover.apply(args) { invoke.resolve() } else { invoke.reject("Native privacy cover generation changed") }
    }
  }
  private var contexts: [UUID: (context: LAContext, authEpoch: UInt64)] = [:]
  private func registerContext(_ context: LAContext, id: UUID, expected: UInt64, started: UInt64) -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard contexts.isEmpty && expected >= epoch && started == lifecycle && foreground else { return false }
    contexts[id] = (context, expected)
    return true
  }
  private var epoch: UInt64 = 0
  private var lifecycle: UInt64 = 0
  private var foreground = true
  private var applicationActive = true
  private var acknowledgedBackground: UInt64 = 0
  private var backgroundChannel: Channel?
  private var backgroundObserver: NSObjectProtocol?
  private var foregroundObserver: NSObjectProtocol?
  override init() {
    super.init()
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      guard let owner = self else { return }; owner.lock.lock(); owner.applicationActive = false; owner.foreground = false; owner.lock.unlock(); owner.cancelContexts()
      owner.lock.lock(); owner.backgroundChannel?.send(["generation": owner.lifecycle] as JsonObject); owner.lock.unlock()
    }
    foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
      guard let owner = self else { return }; owner.lock.lock(); owner.applicationActive = true; owner.foreground = owner.acknowledgedBackground >= owner.lifecycle; owner.lock.unlock()
    }
  }
  deinit { if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }; if let observer = foregroundObserver { NotificationCenter.default.removeObserver(observer) }; cancelContexts() }
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
  private func cancelContexts(authEpoch: UInt64? = nil) {
    lock.lock()
    if let value = authEpoch { epoch = max(epoch, value) } else { lifecycle &+= 1 }
    let pending = contexts.values.filter { authEpoch == nil || $0.authEpoch < epoch }.map { $0.context }; lock.unlock()
    pending.forEach { $0.invalidate() }
  }
  private func begin(_ expected: UInt64) -> UInt64? { lock.lock(); defer { lock.unlock() }; return expected >= epoch && foreground ? lifecycle : nil }
  private func valid(_ expected: UInt64, _ started: UInt64) -> Bool { lock.lock(); defer { lock.unlock() }; return expected >= epoch && started == lifecycle && foreground }
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
  @objc public func registerLifecycle(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(VaultLifecycle.self)
    lock.lock(); backgroundChannel = args.background; args.background.send(["generation": lifecycle] as JsonObject); lock.unlock()
    invoke.resolve()
  }
  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(VaultCancellation.self); cancelContexts(authEpoch: args.authEpoch)
    if let generation = args.backgroundGeneration { lock.lock(); acknowledgedBackground = max(acknowledgedBackground, generation); foreground = applicationActive && acknowledgedBackground >= lifecycle; lock.unlock() }
    invoke.resolve()
  }
  @objc public func read(_ invoke: Invoke) throws {
    let args = try item(invoke)
    let expected = args.authEpoch ?? 0
    guard let started = begin(expected) else { invoke.reject("Credential authentication cancelled"); return }
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
          guard self.registerContext(context, id: id, expected: expected, started: started) else { invoke.reject("Credential authentication cancelled or another request is in progress"); return }
          lookup[kSecUseAuthenticationContext as String] = context
        }
        defer { context.invalidate(); self.lock.lock(); self.contexts.removeValue(forKey: id); self.lock.unlock() }
        var result: CFTypeRef?
        let status = SecItemCopyMatching(lookup as CFDictionary, &result)
        if !self.valid(expected, started) { invoke.reject("Credential authentication cancelled"); return }
        if status == errSecItemNotFound {
          if biometric { invoke.reject("Biometric enrollment changed. Forget saved credentials and enter them again.") }
          else { invoke.resolve([:] as JsonObject) }; return
        }
        guard status == errSecSuccess, let data = result as? Data else { invoke.reject("Credential authentication cancelled, locked or unavailable"); return }
        self.lock.lock()
        defer { self.lock.unlock() }
        guard expected >= self.epoch && started == self.lifecycle && self.foreground else { invoke.reject("Credential authentication cancelled"); return }
        guard let value = String(data: data, encoding: .utf8) else { invoke.reject("Invalid saved credential encoding"); return }
        invoke.resolve(["value": value])
      } catch { invoke.reject("Cannot read device credentials") }
    }
  }
  @objc public func write(_ invoke: Invoke) throws {
    let args = try item(invoke)
    guard let data = args.value?.data(using: .utf8) else { invoke.reject("Missing credentials"); return }
    let biometric = args.biometric == true
    let expected = args.authEpoch ?? 0
    guard let started = begin(expected) else { invoke.reject("Credential authentication cancelled"); return }
    let hasProtected = try exists(args.key, true)
    if !biometric && hasProtected { invoke.reject("Forget protected credentials before disabling biometrics"); return }
    let hasOrdinary = try exists(args.key, false)
    if biometric && hasOrdinary { invoke.reject("Forget ordinary credentials before enabling biometric protection"); return }
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
        guard self.registerContext(context, id: id, expected: expected, started: started) else { invoke.reject("Credential authentication cancelled or another request is in progress"); return }
        lookup[kSecUseAuthenticationContext as String] = context
      }
      defer { context.invalidate(); self.lock.lock(); self.contexts.removeValue(forKey: id); self.lock.unlock() }
      if biometric && hasProtected {
        var unlock = lookup; unlock[kSecReturnData as String] = true
        var discarded: CFTypeRef?
        let status = SecItemCopyMatching(unlock as CFDictionary, &discarded)
        discarded = nil
        guard status == errSecSuccess else { invoke.reject("Credential authentication cancelled or unavailable"); return }
      }
      context.interactionNotAllowed = true
      lookup[kSecUseAuthenticationUI as String] = kSecUseAuthenticationUIFail
      // Authentication happens before this lock. Commit cannot display UI and linearizes with cancellation.
      self.lock.lock()
      defer { self.lock.unlock() }
      guard expected >= self.epoch && started == self.lifecycle && self.foreground else { invoke.reject("Credential authentication cancelled"); return }
      var update = attributes
      // Preserve an existing access-control object; protection policy changes use a separate item.
      update.removeValue(forKey: kSecAttrAccessControl as String)
      var status = SecItemUpdate(lookup as CFDictionary, update as CFDictionary)
      if status == errSecItemNotFound {
        var insert = lookup; attributes.forEach { insert[$0.key] = $0.value }
        status = SecItemAdd(insert as CFDictionary, nil)
      }
      guard status == errSecSuccess else { invoke.reject("Cannot save device credentials"); return }
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
