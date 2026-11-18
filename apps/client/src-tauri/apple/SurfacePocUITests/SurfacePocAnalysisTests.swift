import XCTest

/// The pixel reading the composition proof of concept relies on, checked on a synthetic raster so a wrong
/// verdict about the simulator's screen can only come from the screen, not from this arithmetic.
final class SurfacePocAnalysisTests: XCTestCase {
    private func raster(width: Int, height: Int, painting rects: [(CGRect, PocColor)]) -> PocRaster {
        var bytes = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let colour = rects.last { $0.0.contains(CGPoint(x: x, y: y)) }?.1 ?? PocColor.backdrop
                bytes.replaceSubrange((y * width + x) * 4..<(y * width + x) * 4 + 4, with: [UInt8(colour.red), UInt8(colour.green), UInt8(colour.blue), 255])
            }
        }
        return PocRaster(width: width, height: height, rgba: bytes)
    }

    func testBoundsFindTheExactRectangleOfTheSurfaceColourBehindAnOverlappingBox() {
        let surface = CGRect(x: 10, y: 20, width: 40, height: 30)
        let overlay = CGRect(x: 40, y: 40, width: 30, height: 30)
        let pixels = raster(width: 100, height: 100, painting: [(surface, .surface), (overlay, .overlay)])
        let found = pixels.bounds(of: .surface, tolerance: 8, in: CGRect(x: 0, y: 0, width: 100, height: 100))
        XCTAssertEqual(found, surface, "a box over the corner leaves the surface's bounding rectangle unchanged")
        XCTAssertEqual(pixels.color(x: 45, y: 45), .overlay, "the overlapping box wins where it covers the surface")
        XCTAssertEqual(pixels.color(x: 12, y: 22), .surface)
    }

    func testBoundsStayInsideTheRegionAndAreNilWhenTheColourIsAbsent() {
        let pixels = raster(width: 60, height: 60, painting: [(CGRect(x: 30, y: 30, width: 20, height: 20), .surface)])
        XCTAssertEqual(pixels.bounds(of: .surface, tolerance: 8, in: CGRect(x: 0, y: 0, width: 40, height: 40)),
                       CGRect(x: 30, y: 30, width: 10, height: 10), "pixels beyond the region are not counted")
        XCTAssertNil(pixels.bounds(of: .overlay, tolerance: 8, in: CGRect(x: 0, y: 0, width: 60, height: 60)))
        XCTAssertNil(pixels.bounds(of: .surface, tolerance: 8, in: CGRect(x: 500, y: 500, width: 5, height: 5)), "a region outside the raster is empty")
        XCTAssertNil(pixels.color(x: 60, y: 0))
    }

    func testRectsAgreeComparesEveryEdgeAgainstTheTolerance() {
        let base = CGRect(x: 40, y: 110, width: 200, height: 434)
        XCTAssertTrue(pocRectsAgree(base, base.offsetBy(dx: 1, dy: -1), tolerance: 1))
        XCTAssertFalse(pocRectsAgree(base, base.offsetBy(dx: 0, dy: 2), tolerance: 1))
        XCTAssertFalse(pocRectsAgree(base, CGRect(x: 40, y: 110, width: 200, height: 400), tolerance: 1), "a resize alone is a disagreement")
    }
}
