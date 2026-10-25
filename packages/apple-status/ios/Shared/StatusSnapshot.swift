import Foundation

struct StatusApproval: Codable, Equatable, Identifiable {
  let id: String
  let expiresAt: UInt64
}
struct StatusSnapshot: Codable, Equatable {
  let subscriptionId: String
  let sessionId: String
  let sequence: UInt64
  let observedAt: UInt64
  let expiresAt: UInt64
  let running: UInt16
  let waiting: UInt16
  let totalTokens: UInt64?
  let approvals: [StatusApproval]
  func valid(now: UInt64) -> Bool {
    guard UUID(uuidString: subscriptionId)?.uuidString.lowercased() == subscriptionId,
          UUID(uuidString: sessionId)?.uuidString.lowercased() == sessionId,
          sequence > 0 && sequence <= 9_007_199_254_740_991,
          now <= UInt64.max - 5, observedAt <= now + 5 && observedAt <= UInt64.max - 60,
          observedAt + 60 >= now && expiresAt > now && expiresAt > observedAt,
          expiresAt <= observedAt + 60, running <= 1000 && waiting <= 1000,
          (totalTokens ?? 0) <= 9_007_199_254_740_991,
          approvals.count <= 8, Set(approvals.map(\.id)).count == approvals.count,
          approvals.allSatisfy({ UUID(uuidString: $0.id)?.uuidString.lowercased() == $0.id && $0.expiresAt > now }),
          let data = try? JSONEncoder().encode(self), data.count <= 3500 else { return false }
    return true
  }
}
struct StatusEnvelope: Codable {
  let snapshot: StatusSnapshot?
  let deliveryId: String
  let deliverySequence: UInt64
}
struct StatusInbox: Codable {
  private(set) var snapshot: StatusSnapshot?
  private(set) var deliveryId: String?
  private(set) var deliverySequence: UInt64 = 0
  private var retired: [String] = []
  func validCache() -> Bool {
    retired.count <= 64 && retired.allSatisfy { UUID(uuidString: $0)?.uuidString.lowercased() == $0 }
      && (deliveryId == nil || UUID(uuidString: deliveryId!)?.uuidString.lowercased() == deliveryId)
      && deliverySequence <= 9_007_199_254_740_991
  }
  mutating func receive(_ envelope: StatusEnvelope, now: UInt64) -> Bool {
    guard UUID(uuidString: envelope.deliveryId)?.uuidString.lowercased() == envelope.deliveryId,
          envelope.deliverySequence > 0 && envelope.deliverySequence <= 9_007_199_254_740_991 else { return false }
    if deliveryId == envelope.deliveryId {
      guard envelope.deliverySequence > deliverySequence else { return false }
    } else {
      guard !retired.contains(envelope.deliveryId) else { return false }
      if let previous = deliveryId { retired.append(previous) }
      // shortcut: retain 64 retired native-process IDs; revisit for a long-lived remote relay.
      if retired.count > 64 { retired.removeFirst(retired.count - 64) }
    }
    deliveryId = envelope.deliveryId; deliverySequence = envelope.deliverySequence
    snapshot = envelope.snapshot.flatMap { $0.valid(now: now) ? $0 : nil }
    return true
  }
}
struct StatusReview: Codable {
  let sessionId: String
  let approvalId: String?
}
struct StatusCursor {
  private(set) var subscriptionId: String?
  private(set) var sequence: UInt64 = 0
  private var retired: [String] = []
  private mutating func retire(_ id: String) {
    if !retired.contains(id) { retired.append(id) }
    // shortcut: one active publisher; retain 128 retired IDs until multi-window status publishing is supported.
    if retired.count > 128 { retired.removeFirst(retired.count - 128) }
  }
  mutating func configure(_ id: String, enabled: Bool) -> Bool {
    if enabled {
      guard !retired.contains(id) else { return false }
      if subscriptionId == id { return true }
      if let previous = subscriptionId { retire(previous) }
      subscriptionId = id; sequence = 0
    } else {
      retire(id)
      if subscriptionId == id { subscriptionId = nil; sequence = 0 }
    }
    return true
  }
  mutating func accept(_ snapshot: StatusSnapshot, now: UInt64) -> Bool {
    guard subscriptionId == snapshot.subscriptionId, snapshot.sequence > sequence, snapshot.valid(now: now) else { return false }
    sequence = snapshot.sequence; return true
  }
}
