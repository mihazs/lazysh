import SwiftUI
import WidgetKit

private struct StatusEntry: TimelineEntry { let date: Date; let snapshot: StatusSnapshot? }
private struct StatusProvider: TimelineProvider {
  func placeholder(in context: Context) -> StatusEntry { StatusEntry(date: .now, snapshot: nil) }
  func getSnapshot(in context: Context, completion: @escaping (StatusEntry) -> Void) { completion(StatusEntry(date: .now, snapshot: StatusCache.read()?.snapshot)) }
  func getTimeline(in context: Context, completion: @escaping (Timeline<StatusEntry>) -> Void) {
    let snapshot = StatusCache.read()?.snapshot
    let now = Date(); var entries = [StatusEntry(date: now, snapshot: snapshot)]
    if let snapshot = snapshot, Double(snapshot.expiresAt) > now.timeIntervalSince1970 { entries.append(StatusEntry(date: Date(timeIntervalSince1970: Double(snapshot.expiresAt)), snapshot: nil)) }
    completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(60))))
  }
}
@main
struct LazyshWatchWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "lazysh-status", provider: StatusProvider()) { entry in
      VStack {
        Image(systemName: "terminal")
        if let snapshot = entry.snapshot, snapshot.valid(now: UInt64(entry.date.timeIntervalSince1970)) { Text("\(snapshot.waiting) waiting") }
        else { Text("Open lazysh") }
      }.containerBackground(.fill.tertiary, for: .widget).privacySensitive()
    }
    .configurationDisplayName("lazysh agents")
    .description("Latest agent attention count from your iPhone.")
    .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
  }
}
