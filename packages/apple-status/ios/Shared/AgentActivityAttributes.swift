import ActivityKit
import Foundation

@available(iOS 16.2, *)
struct AgentActivityAttributes: ActivityAttributes {
  struct ContentState: Codable, Hashable {
    let running: UInt16
    let waiting: UInt16
    let observedAt: Date
  }
  let subscriptionId: String
}
