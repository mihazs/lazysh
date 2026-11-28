// swift-tools-version:5.7
import PackageDescription
let package = Package(
  name: "tauri-plugin-lazysh-auth-tab",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-lazysh-auth-tab", type: .static, targets: ["tauri-plugin-lazysh-auth-tab"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-lazysh-auth-tab", dependencies: [.byName(name: "Tauri")], path: "Sources", linkerSettings: [.linkedFramework("SafariServices"), .linkedFramework("UIKit")])]
)
