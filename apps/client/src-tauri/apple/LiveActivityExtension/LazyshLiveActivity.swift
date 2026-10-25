import ActivityKit
import SwiftUI
import WidgetKit

@main
struct LazyshLiveActivity: Widget {
  var body: some WidgetConfiguration {
    ActivityConfiguration(for: AgentActivityAttributes.self) { context in
      HStack {
        Image(systemName: "terminal")
        Text(context.isStale ? "Open lazysh to refresh" : "\(context.state.running) running · \(context.state.waiting) waiting")
      }
      .padding().privacySensitive()
      .widgetURL(URL(string: "lazysh://agents"))
    } dynamicIsland: { context in
      DynamicIsland {
        DynamicIslandExpandedRegion(.leading) { Label("lazysh", systemImage: "terminal") }
        DynamicIslandExpandedRegion(.trailing) { Text(context.isStale ? "Stale" : "\(context.state.waiting) waiting") }
        DynamicIslandExpandedRegion(.bottom) { Text(context.isStale ? "Open lazysh to refresh" : "\(context.state.running) agents running").privacySensitive() }
      } compactLeading: { Image(systemName: "terminal") }
        compactTrailing: { Text(context.isStale ? "—" : "\(context.state.waiting)") }
        minimal: { Image(systemName: context.isStale ? "clock" : "terminal") }
      .widgetURL(URL(string: "lazysh://agents"))
    }
  }
}
