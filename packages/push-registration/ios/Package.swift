// swift-tools-version:5.7
import PackageDescription

let package = Package(
  name: "tauri-plugin-lazysh-push",
  platforms: [.iOS(.v16)],
  products: [.library(name: "tauri-plugin-lazysh-push", type: .static, targets: ["tauri-plugin-lazysh-push"])],
  dependencies: [.package(name: "Tauri", path: "../.tauri/tauri-api")],
  targets: [.target(name: "tauri-plugin-lazysh-push", dependencies: [.byName(name: "Tauri")], path: ".", exclude: ["Tests", "Package.swift"], sources: ["Sources", "Shared"])]
)
