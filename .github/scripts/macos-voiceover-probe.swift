import AppKit
import Carbon
import CoreGraphics
import Foundation

let environment = ProcessInfo.processInfo.environment
guard environment["GITHUB_ACTIONS"] == "true", environment["RUNNER_ENVIRONMENT"] == "github-hosted" else {
    fatalError("Use a disposable GitHub-hosted desktop")
}

let workspace = NSWorkspace.shared
guard !workspace.isVoiceOverEnabled else { fatalError("VoiceOver is already enabled") }
guard CGPreflightPostEventAccess() else { fatalError("The runner cannot post the VoiceOver shortcut") }

func key(_ code: Int, flags: CGEventFlags = []) {
    for down in [true, false] {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else {
            fatalError("Could not create a keyboard event")
        }
        event.flags = flags
        event.post(tap: .cghidEventTap)
    }
}

func waitForVoiceOver(_ state: Bool) -> Bool {
    let deadline = Date().addingTimeInterval(8)
    while workspace.isVoiceOverEnabled != state && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return workspace.isVoiceOverEnabled == state
}

func probe() -> Bool {
    print("VoiceOver before: false")
    defer {
        if workspace.isVoiceOverEnabled {
            key(kVK_F5, flags: .maskCommand)
            if !waitForVoiceOver(false) { print("VoiceOver cleanup did not finish") }
        }
    }
    key(kVK_F5, flags: .maskCommand)
    if !waitForVoiceOver(true) {
        if workspace.frontmostApplication?.bundleIdentifier?.hasPrefix("com.apple.VoiceOver") == true {
            key(kVK_Return)
        }
        guard waitForVoiceOver(true) else { return false }
    }
    print("VoiceOver active: true")
    key(kVK_F5, flags: .maskCommand)
    guard waitForVoiceOver(false) else { return false }
    print("VoiceOver after: false")
    return true
}

guard probe() else { fatalError("VoiceOver did not follow the expected state transitions") }
