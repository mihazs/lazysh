import Foundation

/// The colours of the composition proof of concept, as the host draws them: the native surface, the DOM
/// overlay box that overlaps it, and the window behind the web view (what shows where nothing is drawn).
struct PocColor: Equatable {
    let red: Int, green: Int, blue: Int

    static let surface = PocColor(red: 30, green: 200, blue: 80)
    static let overlay = PocColor(red: 224, green: 32, blue: 32)
    static let backdrop = PocColor(red: 32, green: 32, blue: 32)

    func isNear(_ other: PocColor, tolerance: Int) -> Bool {
        abs(red - other.red) <= tolerance && abs(green - other.green) <= tolerance && abs(blue - other.blue) <= tolerance
    }
}

/// An RGBA8 raster read from a screenshot: row-major, origin at the top left, one byte per channel.
struct PocRaster {
    let width: Int, height: Int
    let rgba: [UInt8]

    func color(x: Int, y: Int) -> PocColor? {
        guard x >= 0, y >= 0, x < width, y < height, rgba.count >= (y * width + x) * 4 + 3 else { return nil }
        let at = (y * width + x) * 4
        return PocColor(red: Int(rgba[at]), green: Int(rgba[at + 1]), blue: Int(rgba[at + 2]))
    }

    /// The smallest rectangle, in pixels, holding every pixel of `region` within `tolerance` of `target`; nil when none is.
    func bounds(of target: PocColor, tolerance: Int, in region: CGRect) -> CGRect? {
        // A region partly or wholly outside the raster is clamped to it; an empty range finds nothing.
        func span(_ low: CGFloat, _ high: CGFloat, within limit: Int) -> Range<Int> {
            let start = max(0, Int(low.rounded(.down))), end = min(limit, Int(high.rounded(.up)))
            return start..<max(start, end)
        }
        let columns = span(region.minX, region.maxX, within: width), rows = span(region.minY, region.maxY, within: height)
        var low = (x: Int.max, y: Int.max), high = (x: -1, y: -1)
        for y in rows {
            for x in columns where color(x: x, y: y)?.isNear(target, tolerance: tolerance) == true {
                low = (min(low.x, x), min(low.y, y))
                high = (max(high.x, x), max(high.y, y))
            }
        }
        guard high.x >= 0 else { return nil }
        return CGRect(x: low.x, y: low.y, width: high.x - low.x + 1, height: high.y - low.y + 1)
    }
}

/// The largest distance between matching edges of two rectangles, in the units they share.
func pocMaxEdgeError(_ a: CGRect, _ b: CGRect) -> CGFloat {
    [(a.minX, b.minX), (a.minY, b.minY), (a.maxX, b.maxX), (a.maxY, b.maxY)].map { abs($0.0 - $0.1) }.max() ?? 0
}

/// Whether two rectangles are the same place to within `tolerance` on every edge.
func pocRectsAgree(_ a: CGRect, _ b: CGRect, tolerance: CGFloat) -> Bool {
    pocMaxEdgeError(a, b) <= tolerance
}
