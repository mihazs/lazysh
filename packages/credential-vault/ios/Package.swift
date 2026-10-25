// swift-tools-version:5.7
import PackageDescription

let package = Package(
  name: "tauri-plugin-lazysh-vault",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-lazysh-vault", type: .static, targets: ["tauri-plugin-lazysh-vault"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-lazysh-vault", dependencies: [.byName(name: "Tauri")], path: "Sources")]
)
