import Foundation

enum StatusCache {
  static let group = "group.app.lazysh.client.status"
  static func read() -> StatusInbox? {
    guard let data = UserDefaults(suiteName: group)?.data(forKey: "status"), data.count <= 8192,
          let inbox = try? JSONDecoder().decode(StatusInbox.self, from: data), inbox.validCache() else { return nil }
    return inbox
  }
  static func write(_ envelope: StatusInbox) {
    guard let data = try? JSONEncoder().encode(envelope), data.count <= 8192 else { return }
    UserDefaults(suiteName: group)?.set(data, forKey: "status")
  }
}
