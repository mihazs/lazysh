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

func postKey(_ code: Int, down: Bool, flags: CGEventFlags = []) {
    guard let event = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(code), keyDown: down) else {
        fatalError("Could not create a keyboard event")
    }
    event.flags = flags
    event.post(tap: .cghidEventTap)
}

func toggleVoiceOver() {
    postKey(kVK_Command, down: true, flags: .maskCommand)
    for down in [true, false] {
        postKey(kVK_F5, down: down, flags: .maskCommand)
    }
    postKey(kVK_Command, down: false)
}

func diagnostic(_ message: String) {
    FileHandle.standardError.write(Data((message + "\n").utf8))
}

func waitForVoiceOver(_ state: Bool) -> Bool {
    let deadline = Date().addingTimeInterval(8)
    while workspace.isVoiceOverEnabled != state && Date() < deadline {
        RunLoop.current.run(until: Date().addingTimeInterval(0.1))
    }
    return workspace.isVoiceOverEnabled == state
}

func probe() -> Bool {
    diagnostic("VoiceOver before: false")
    defer {
        if workspace.isVoiceOverEnabled {
            toggleVoiceOver()
            if !waitForVoiceOver(false) { diagnostic("VoiceOver cleanup did not finish") }
        }
    }
    toggleVoiceOver()
    if !waitForVoiceOver(true) {
        let welcomeVisible = workspace.frontmostApplication?.bundleIdentifier?.hasPrefix("com.apple.VoiceOver") == true
        diagnostic("VoiceOver welcome app in foreground: \(welcomeVisible)")
        if welcomeVisible {
            for down in [true, false] { postKey(kVK_Return, down: down) }
        }
        guard waitForVoiceOver(true) else {
            diagnostic("VoiceOver did not turn on")
            return false
        }
    }
    diagnostic("VoiceOver active: true")
    toggleVoiceOver()
    guard waitForVoiceOver(false) else {
        diagnostic("VoiceOver did not turn off")
        return false
    }
    diagnostic("VoiceOver after: false")
    return true
}

if !probe() { exit(1) }
