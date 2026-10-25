import Foundation

/// UIKit mutations occur on main; the lock also permits a callback arriving off
/// main to capture its handoff context without reading mutable state unsafely.
final class APNsRegistrationState {
  struct CallbackContext: Equatable { let epoch: UInt64; let dispatched: Bool }
  private let lock = NSRecursiveLock()
  private var currentEpoch: UInt64 = 0
  private var active = false
  private var payload: Data?
  private var dispatchedEpoch: UInt64?
  private var pending: (UInt64, (Bool) -> Void)?
  private func locked<T>(_ action: () -> T) -> T { lock.lock(); defer { lock.unlock() }; return action() }
  var epoch: UInt64 { locked { currentEpoch } }
  var enabled: Bool { locked { active } }
  var token: Data? { locked { payload } }
  var busy: Bool { locked { pending != nil } }

  @discardableResult func begin(_ expected: UInt64, completion: @escaping (Bool) -> Void) -> Bool {
    locked {
      guard expected >= currentEpoch, pending == nil else { completion(false); return false }
      currentEpoch = expected; active = true; payload = nil; dispatchedEpoch = nil
      pending = (expected, completion)
      return true
    }
  }
  func isPending(_ expected: UInt64) -> Bool { locked { active && pending?.0 == expected } }
  @discardableResult func markDispatched(_ expected: UInt64) -> Bool {
    locked {
      guard active, pending?.0 == expected else { return false }
      dispatchedEpoch = expected; return true
    }
  }
  func callbackContext() -> CallbackContext {
    locked { CallbackContext(epoch: currentEpoch, dispatched: dispatchedEpoch == currentEpoch) }
  }
  private func accepts(_ context: CallbackContext) -> Bool {
    active && context.epoch == currentEpoch && context.dispatched && dispatchedEpoch == currentEpoch
  }
  @discardableResult func registered(_ value: Data, context: CallbackContext) -> Bool {
    locked {
      guard accepts(context), !value.isEmpty else { return false }
      payload = value
      let completion = pending?.1; pending = nil
      completion?(true); return true
    }
  }
  @discardableResult func callbackFailed(_ context: CallbackContext) -> Bool {
    locked {
      guard accepts(context) else { return false }
      return disable(currentEpoch)
    }
  }
  @discardableResult func disable(_ expected: UInt64) -> Bool {
    locked {
      guard expected >= currentEpoch else { return false }
      currentEpoch = expected; active = false; payload = nil; dispatchedEpoch = nil
      let completion = pending?.1; pending = nil
      completion?(false); return true
    }
  }
  @discardableResult func timedOut(_ expected: UInt64) -> Bool {
    locked {
      guard active, pending?.0 == expected else { return false }
      return disable(expected)
    }
  }
  func failed() { locked { _ = disable(currentEpoch) } }
}
