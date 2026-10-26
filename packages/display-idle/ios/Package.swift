// swift-tools-version:5.7
import PackageDescription
let package = Package(
  name: "tauri-plugin-lazysh-display-idle",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-lazysh-display-idle", type: .static, targets: ["tauri-plugin-lazysh-display-idle"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-lazysh-display-idle", dependencies: [.byName(name: "Tauri")], path: "Sources", linkerSettings: [.linkedFramework("UIKit")])]
)
