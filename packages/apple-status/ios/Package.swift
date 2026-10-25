// swift-tools-version:5.7
import PackageDescription
let package = Package(
  name: "tauri-plugin-lazysh-apple-status",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-lazysh-apple-status", type: .static, targets: ["tauri-plugin-lazysh-apple-status"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-lazysh-apple-status", dependencies: [.byName(name: "Tauri")], path: ".", exclude: ["Tests", "Package.swift"], sources: ["Sources", "Shared"], linkerSettings: [.linkedFramework("WatchConnectivity")])]
)
