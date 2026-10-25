import Foundation

struct ResumeView: Decodable { let covered: Bool; let enabled: Bool; let generation: UInt64; let nativeGeneration: UInt64 }

struct ResumeGate {
  private(set) var nativeGeneration: UInt64 = 0
  private var authorityGeneration: UInt64 = 0
  private var enabled: Bool? = nil
  private var locked = true
  private var privacy = false
  private var foreground = true
  var covered: Bool { enabled != false && (locked || privacy || !foreground) }
  mutating func pause() { privacy = true }
  mutating func background() { nativeGeneration &+= 1; foreground = false; privacy = true; if enabled != false { locked = true } }
  mutating func resume() { foreground = true; privacy = false }
  mutating func apply(covered: Bool, enabled: Bool, generation: UInt64, nativeGeneration: UInt64) -> Bool {
    guard generation >= authorityGeneration, (covered && enabled) || nativeGeneration == self.nativeGeneration, !enabled || covered || foreground else { return false }
    authorityGeneration = generation; self.enabled = enabled; locked = covered; return true
  }
}
