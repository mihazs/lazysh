import ActivityKit
import Foundation
import Tauri
import UIKit
import WatchConnectivity

private struct ConfigureArgs: Decodable { let subscriptionId: String; let enabled: Bool }
private struct PublishArgs: Decodable { let snapshot: StatusSnapshot; let startActivity: Bool }
private struct ReviewArgs: Decodable { let review: Channel }
private struct OpenReviewArgs: Decodable { let subscriptionId: String }

class AppleStatusPlugin: Plugin, WCSessionDelegate {
  // Native operations serialize on main, including final delivery and disabling a subscription.
  lazy var icons = makeAppIconController()
  private var cursor = StatusCursor()
  private var latest: StatusSnapshot?
  private var review: Channel?
  private var reviewGate = StatusReviewGate()
  private var foregroundObserver: NSObjectProtocol?
  private var activityTask: Task<Void, Never>?
  private let deliveryId = UUID().uuidString.lowercased()
  private var deliverySequence: UInt64 = 0
  private var enabled: Bool { cursor.subscriptionId != nil }
  override init() {
    super.init()
    foregroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in _ = self?.deliverReview() }
    if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() }
  }
  deinit { if let observer = foregroundObserver { NotificationCenter.default.removeObserver(observer) } }
  @objc public func registerReview(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ReviewArgs.self)
    DispatchQueue.main.async { self.review = args.review; _ = self.deliverReview(); invoke.resolve() }
  }
  @objc public func openReview(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(OpenReviewArgs.self)
    guard UUID(uuidString: args.subscriptionId)?.uuidString.lowercased() == args.subscriptionId else { invoke.reject("Invalid review subscription"); return }
    DispatchQueue.main.async {
      guard self.reviewGate.capture(subscriptionId: args.subscriptionId, cursor: self.cursor, snapshot: self.latest, now: UInt64(Date().timeIntervalSince1970)) else { invoke.reject("Review subscription is stale or unavailable"); return }
      _ = self.deliverReview(); invoke.resolve()
    }
  }
  private func deliverReview() -> Bool {
    guard let request = reviewGate.take(cursor: cursor, snapshot: latest, now: UInt64(Date().timeIntervalSince1970), foreground: UIApplication.shared.applicationState == .active, receiverReady: review != nil), let review = review else { return false }
    var payload: JsonObject = ["subscriptionId": request.subscriptionId, "sessionId": request.sessionId, "expiresAt": request.expiresAt]
    if let id = request.approvalId { payload["approvalId"] = id }
    review.send(payload); return true
  }
  @objc public func capability(_ invoke: Invoke) {
    DispatchQueue.main.async {
      var activities = false
      if #available(iOS 16.2, *) { activities = ActivityAuthorizationInfo().areActivitiesEnabled }
      let session = WCSession.default
      invoke.resolve(["liveActivities": activities, "watchPaired": WCSession.isSupported() && session.isPaired,
        "watchInstalled": WCSession.isSupported() && session.isWatchAppInstalled,
        "watchReachable": WCSession.isSupported() && session.isReachable,
        "reason": "Local updates require an active iPhone connection. Approvals are reviewed on iPhone."])
    }
  }
  @objc public func configure(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ConfigureArgs.self)
    guard UUID(uuidString: args.subscriptionId)?.uuidString.lowercased() == args.subscriptionId else { invoke.reject("Invalid status subscription"); return }
    DispatchQueue.main.async {
      let previousId = self.cursor.subscriptionId
      guard self.cursor.configure(args.subscriptionId, enabled: args.enabled) else { invoke.reject("Status subscription cancelled"); return }
      if previousId == self.cursor.subscriptionId { invoke.resolve(); return }
      self.reviewGate.clear()
      self.latest = nil
      self.sendWatch(nil)
      if #available(iOS 16.2, *) {
        let previous = self.activityTask
        self.activityTask = Task { @MainActor in
          await previous?.value
          for activity in Activity<AgentActivityAttributes>.activities { await activity.end(nil, dismissalPolicy: .immediate) }
          invoke.resolve()
        }
      } else { invoke.resolve() }
    }
  }
  @objc public func publish(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(PublishArgs.self)
    DispatchQueue.main.async {
      guard UIApplication.shared.applicationState == .active,
            self.cursor.accept(args.snapshot, now: UInt64(Date().timeIntervalSince1970)) else { invoke.reject("Stale, background or disabled status subscription"); return }
      self.latest = args.snapshot; self.sendWatch(args.snapshot)
      if #available(iOS 16.2, *) {
        let previous = self.activityTask
        self.activityTask = Task { @MainActor in
          await previous?.value
          let snapshot = args.snapshot
          guard self.cursor.subscriptionId == snapshot.subscriptionId, self.latest?.sequence == snapshot.sequence else { invoke.reject("Status update superseded or disabled"); return }
          let content = ActivityContent(state: AgentActivityAttributes.ContentState(running: snapshot.running, waiting: snapshot.waiting, observedAt: Date(timeIntervalSince1970: Double(snapshot.observedAt))), staleDate: Date(timeIntervalSince1970: Double(snapshot.expiresAt)))
          if let existing = Activity<AgentActivityAttributes>.activities.first(where: { $0.attributes.subscriptionId == snapshot.subscriptionId }) {
            await existing.update(content)
          } else if args.startActivity {
            guard ActivityAuthorizationInfo().areActivitiesEnabled, UIApplication.shared.applicationState == .active else { invoke.reject("Live Activity start requires an active app and authorization."); return }
            do { _ = try Activity.request(attributes: AgentActivityAttributes(subscriptionId: snapshot.subscriptionId), content: content, pushType: nil) }
            catch { invoke.reject("Live Activity could not start; device limits or authorization may prevent it."); return }
          }
          invoke.resolve()
        }
      } else { invoke.resolve() }
    }
  }
  private func sendWatch(_ snapshot: StatusSnapshot?) {
    guard WCSession.isSupported(), WCSession.default.activationState == .activated, deliverySequence < 9_007_199_254_740_991 else { return }
    deliverySequence += 1
    guard let data = try? JSONEncoder().encode(StatusEnvelope(snapshot: snapshot, deliveryId: deliveryId, deliverySequence: deliverySequence)) else { return }
    do { try WCSession.default.updateApplicationContext(["status": data]) } catch { /* Stale dates remain authoritative if delivery is unavailable. */ }
  }
  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {
    DispatchQueue.main.async { self.sendWatch(self.latest) }
  }
  func sessionDidBecomeInactive(_ session: WCSession) {}
  func sessionDidDeactivate(_ session: WCSession) { session.activate() }
  func session(_ session: WCSession, didReceiveMessage message: [String: Any], replyHandler: @escaping ([String: Any]) -> Void) {
    DispatchQueue.main.async {
      guard self.enabled, let latest = self.latest, latest.valid(now: UInt64(Date().timeIntervalSince1970)),
            message["subscriptionId"] as? String == latest.subscriptionId else { replyHandler(["ok": false]); return }
      if message["action"] as? String == "refresh" { self.sendWatch(latest); replyHandler(["ok": true]); return }
      guard message["action"] as? String == "review", let id = message["approvalId"] as? String,
            UIApplication.shared.applicationState == .active, self.review != nil,
            self.reviewGate.capture(subscriptionId: latest.subscriptionId, approvalId: id, cursor: self.cursor, snapshot: latest, now: UInt64(Date().timeIntervalSince1970)) else { replyHandler(["ok": false]); return }
      replyHandler(["ok": self.deliverReview()])
    }
  }
}
@_cdecl("init_plugin_lazysh_apple_status") public func initPlugin() -> Plugin { AppleStatusPlugin() }
