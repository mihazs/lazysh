import SwiftUI
import WatchConnectivity
import WidgetKit

@main
struct LazyshWatchApp: App {
  @StateObject private var store = WatchStatusStore()
  var body: some Scene { WindowGroup { StatusView().environmentObject(store) } }
}
final class WatchStatusStore: NSObject, ObservableObject, WCSessionDelegate {
  @Published var snapshot: StatusSnapshot? = StatusCache.read()?.snapshot
  @Published var message = ""
  @Published var busy = false
  private var inbox = StatusCache.read() ?? StatusInbox()
  override init() { super.init(); if WCSession.isSupported() { WCSession.default.delegate = self; WCSession.default.activate() } }
  func session(_ session: WCSession, activationDidCompleteWith activationState: WCSessionActivationState, error: Error?) {}
  func session(_ session: WCSession, didReceiveApplicationContext applicationContext: [String: Any]) {
    guard let data = applicationContext["status"] as? Data, data.count <= 4096,
          let envelope = try? JSONDecoder().decode(StatusEnvelope.self, from: data) else { return }
    DispatchQueue.main.async {
      guard self.inbox.receive(envelope, now: UInt64(Date().timeIntervalSince1970)) else { return }
      self.snapshot = self.inbox.snapshot
      StatusCache.write(self.inbox)
      WidgetCenter.shared.reloadAllTimelines()
    }
  }
  func action(_ action: String, approval: StatusApproval? = nil) {
    guard !busy, let snapshot = snapshot, snapshot.valid(now: UInt64(Date().timeIntervalSince1970)), WCSession.default.isReachable else { message = "Open lazysh on iPhone to reconnect."; return }
    busy = true; message = ""
    var payload: [String: Any] = ["action": action, "subscriptionId": snapshot.subscriptionId]
    if let approval = approval { payload["approvalId"] = approval.id }
    WCSession.default.sendMessage(payload, replyHandler: { response in
      DispatchQueue.main.async { self.busy = false; self.message = response["ok"] as? Bool == true ? (action == "review" ? "Review opened on iPhone." : "Latest phone snapshot requested.") : "Open lazysh on iPhone to refresh and review." }
    }, errorHandler: { _ in DispatchQueue.main.async { self.busy = false; self.message = "iPhone unavailable. Nothing was approved." } })
  }
}
private struct StatusView: View {
  @EnvironmentObject var store: WatchStatusStore
  var body: some View {
    NavigationStack {
      TimelineView(.periodic(from: .now, by: 1)) { context in
        List {
          if let snapshot = store.snapshot {
            let fresh = snapshot.valid(now: UInt64(context.date.timeIntervalSince1970))
            Section("Agents") {
              Text("\(snapshot.running) running · \(snapshot.waiting) waiting")
              Text(fresh ? "Updated \(Date(timeIntervalSince1970: Double(snapshot.observedAt)), style: .relative) ago" : "Stale · Open lazysh on iPhone").font(.caption)
            }
            Section("Inspected usage report") {
              if let usage = snapshot.usage {
                Text(usage.freshnessAt(UInt64(context.date.timeIntervalSince1970)) == .fresh ? "Recently recorded" : usage.freshness == .unknown ? "Freshness unknown" : "Stale record").font(.caption)
                if let recorded = usage.recordedAt {
                  Text(Date(timeIntervalSince1970: Double(recorded)), style: .date).font(.caption)
                  Text(Date(timeIntervalSince1970: Double(recorded)), style: .time).font(.caption)
                }
                if let value = usage.inputTokens { Text("Input: \(value)") }
                if let value = usage.outputTokens { Text("Output: \(value)") }
                if let value = usage.cacheReadTokens { Text("Cache read: \(value)") }
                if let value = usage.cacheWriteTokens { Text("Cache write: \(value)") }
              } else { Text("Usage unavailable") }
            }
            Section("Inbox") {
              if snapshot.approvals.isEmpty { Text("No pending approvals") }
              ForEach(snapshot.approvals) { approval in
                Button("Review on iPhone") { store.action("review", approval: approval) }
                  .disabled(!fresh || approval.expiresAt <= UInt64(context.date.timeIntervalSince1970) || store.busy)
              }
            }
            Button("Refresh from iPhone") { store.action("refresh") }.disabled(!fresh || store.busy)
          } else { Text("Enable Apple status in lazysh on iPhone.") }
          if !store.message.isEmpty { Text(store.message).font(.caption) }
        }.privacySensitive()
      }.navigationTitle("lazysh")
    }
  }
}
