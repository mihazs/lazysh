import Foundation
import UIKit
import UserNotifications
import WebKit
import ObjectiveC
import Tauri

struct PushControl: Decodable { let operationEpoch: UInt64 }
struct PushConfiguration: Decodable { let apnsEnabled: Bool? }

/// Tao creates its delegate class before Tauri initializes plugins. Add only
/// absent callbacks, before UIApplicationMain assigns/caches its delegate.
/// Never replace an implementation or the notification-center delegate.
private final class APNsBridge {
  static let shared = APNsBridge()
  let state = APNsRegistrationState()
  private(set) var installed = false
  private var delegateClass: AnyClass?
  var configuredByBuild = false
  private let preferences = UserDefaults.standard
  private let consentKey = "app.lazysh.push.apns-consent"

  func install() {
    guard Thread.isMainThread, !installed,
          let cls = NSClassFromString("AppDelegate"),
          let parent = class_getSuperclass(cls),
          ObjectIdentifier(parent) == ObjectIdentifier(UIResponder.self) else { return }
    let success = NSSelectorFromString("application:didRegisterForRemoteNotificationsWithDeviceToken:")
    let failure = NSSelectorFromString("application:didFailToRegisterForRemoteNotificationsWithError:")
    guard class_getInstanceMethod(cls, success) == nil, class_getInstanceMethod(cls, failure) == nil else { return }
    let received: @convention(block) (AnyObject, UIApplication, NSData) -> Void = { _, _, data in
      let context = APNsBridge.shared.state.callbackContext()
      APNsBridge.deliver {
        if !APNsBridge.shared.state.registered(data as Data, context: context) && !APNsBridge.shared.state.enabled {
          UIApplication.shared.unregisterForRemoteNotifications()
        }
      }
    }
    let rejected: @convention(block) (AnyObject, UIApplication, NSError) -> Void = { _, _, _ in
      let context = APNsBridge.shared.state.callbackContext()
      APNsBridge.deliver {
        if APNsBridge.shared.state.callbackFailed(context) { APNsBridge.shared.finishFailure() }
      }
    }
    let receivedIMP = imp_implementationWithBlock(received as Any)
    guard class_addMethod(cls, success, receivedIMP, "v@:@@") else { imp_removeBlock(receivedIMP); return }
    let rejectedIMP = imp_implementationWithBlock(rejected as Any)
    guard class_addMethod(cls, failure, rejectedIMP, "v@:@@") else { imp_removeBlock(rejectedIMP); return }
    delegateClass = cls; installed = true
  }

  private static func deliver(_ action: @escaping @MainActor () -> Void) {
    if Thread.isMainThread {
      // Swift 6.2 emits this check into the client for older iOS runtimes.
      MainActor.assumeIsolated { action() }
    } else {
      DispatchQueue.main.async { action() }
    }
  }

  @MainActor private var matchesDelegate: Bool {
    guard installed, let expected = delegateClass,
          let delegate = UIApplication.shared.delegate,
          let actual = object_getClass(delegate) else { return false }
    return ObjectIdentifier(actual) == ObjectIdentifier(expected)
  }
  @MainActor private var configured: Bool { configuredByBuild && matchesDelegate }

  @MainActor func status() -> JsonObject {
    let reason: String
    if !installed || !matchesDelegate { reason = "This runtime cannot safely receive APNs callbacks; remote registration is unavailable." }
    else if !configuredByBuild { reason = "APNs is not enabled in this build. A signed release needs its push entitlement and explicit APNs configuration." }
    else if state.busy { reason = "Waiting for Apple's actual APNs registration callback." }
    else if state.enabled && state.token != nil { reason = "APNs returned this device's token. No delivery service is configured by this control." }
    else { reason = "APNs registration is off. Signing configuration is confirmed only when Apple returns a token." }
    return ["provider": "apns", "supported": installed && matchesDelegate,
            "configured": configured, "enabled": state.enabled,
            "tokenPresent": state.token != nil, "busy": state.busy, "reason": reason]
  }

  @MainActor func restoreConsent() {
    // Called after UIKit has launched, never from plugin initialization.
    guard preferences.bool(forKey: consentKey) else { return }
    guard configured else { _ = disable(0); return }
    register(0) { _ in }
  }

  @MainActor func register(_ epoch: UInt64, completion: @escaping (Bool) -> Void) {
    guard configured else { completion(false); return }
    guard state.begin(epoch, completion: completion) else { return }
    preferences.set(true, forKey: consentKey)
    UNUserNotificationCenter.current().getNotificationSettings { settings in
      DispatchQueue.main.async {
        guard self.state.isPending(epoch) else { return }
        guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
          self.registrationFailed(); return
        }
        guard self.state.markDispatched(epoch) else { return }
        UIApplication.shared.registerForRemoteNotifications()
      }
    }
    DispatchQueue.main.asyncAfter(deadline: .now() + 30) {
      if self.state.timedOut(epoch) {
        self.preferences.set(false, forKey: self.consentKey)
        UIApplication.shared.unregisterForRemoteNotifications()
      }
    }
  }

  @MainActor private func registrationFailed() {
    state.failed(); finishFailure()
  }
  @MainActor private func finishFailure() {
    preferences.set(false, forKey: consentKey)
    UIApplication.shared.unregisterForRemoteNotifications()
  }

  @MainActor @discardableResult func disable(_ epoch: UInt64) -> Bool {
    guard state.disable(epoch) else { return false }
    preferences.set(false, forKey: consentKey)
    UIApplication.shared.unregisterForRemoteNotifications()
    return true
  }
}

class PushPlugin: Plugin {
  override init() {
    super.init()
    // Do not access UIApplication.shared here: Tao has not called UIApplicationMain.
    APNsBridge.shared.install()
  }
  override func load(webview: WKWebView) {
    let enabled = (try? parseConfig(PushConfiguration.self))?.apnsEnabled == true
    DispatchQueue.main.async {
      APNsBridge.shared.configuredByBuild = enabled
      APNsBridge.shared.restoreConsent()
    }
  }
  @objc public func status(_ invoke: Invoke) {
    DispatchQueue.main.async { invoke.resolve(APNsBridge.shared.status()) }
  }
  @objc public func register(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PushControl.self)
    DispatchQueue.main.async {
      APNsBridge.shared.register(args.operationEpoch) { success in
        if success { invoke.resolve(APNsBridge.shared.status()) }
        else { invoke.reject("APNs registration failed, was cancelled, or timed out. Verify notification permission and signed push configuration.") }
      }
    }
  }
  @objc public func disable(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PushControl.self)
    DispatchQueue.main.async {
      if APNsBridge.shared.disable(args.operationEpoch) { invoke.resolve(APNsBridge.shared.status()) }
      else { invoke.reject("A newer registration operation superseded this pause") }
    }
  }
}

@_cdecl("init_plugin_lazysh_push") public func initPlugin() -> Plugin { PushPlugin() }
