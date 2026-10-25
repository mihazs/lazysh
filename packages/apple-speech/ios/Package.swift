// swift-tools-version:5.7
import PackageDescription
let package = Package(
  name: "tauri-plugin-lazysh-apple-speech",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-lazysh-apple-speech", type: .static, targets: ["tauri-plugin-lazysh-apple-speech"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-lazysh-apple-speech", dependencies: [.byName(name: "Tauri")], path: "Sources", linkerSettings: [.linkedFramework("Speech"), .linkedFramework("AVFoundation")])]
)
