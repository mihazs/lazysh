import Foundation

enum DisplayIdleError: Error { case invalidTicket, unavailable, flagNotApplied, ticketLimit }

final class DisplayIdleState {
  static let maxTicket: UInt64 = 9_007_199_254_740_991
  private(set) var epoch = UUID().uuidString.lowercased()
  private var issued: UInt64 = 0
  private var highwater: UInt64 = 0
  private var owner: UInt64?
  private let set: (Bool) throws -> Void
  private let read: () -> Bool
  init(set: @escaping (Bool) throws -> Void, read: @escaping () -> Bool) { self.set = set; self.read = read }
  var active: Bool { owner != nil && read() }
  func issue() throws -> UInt64 {
    guard issued < Self.maxTicket else { throw DisplayIdleError.ticketLimit }
    issued += 1; return issued
  }
  private func valid(_ epoch: String, _ ticket: UInt64) -> Bool { epoch == self.epoch && ticket > 0 && ticket <= issued }
  func acquire(epoch: String, ticket: UInt64, ready: Bool) throws {
    guard valid(epoch, ticket), ticket > highwater else { throw DisplayIdleError.invalidTicket }
    highwater = ticket
    guard ready else { throw DisplayIdleError.unavailable }
    owner = ticket
    do { try set(true); guard read() else { throw DisplayIdleError.flagNotApplied } }
    catch { try clear(); throw error }
  }
  func release(epoch: String, ticket: UInt64) throws {
    guard valid(epoch, ticket) else { return }
    highwater = max(highwater, ticket)
    if owner == ticket { try clear() }
  }
  func invalidate() throws { epoch = UUID().uuidString.lowercased(); issued = 0; highwater = 0; try clear() }
  private func clear() throws {
    guard owner != nil else { return }
    try set(false); guard !read() else { throw DisplayIdleError.flagNotApplied }; owner = nil
  }
}
