import SwiftUI

/// Remove Object brush: strokes in photo coordinates (0..1), radius as a
/// fraction of the photo width (web Remove.tsx).
@MainActor @Observable
final class RemovalBrush {
    struct Stroke {
        var radius: CGFloat
        var points: [CGPoint]
    }
    var strokes: [Stroke] = []
    var diameter: Double = 32
    var painting = true
    private var active = false
    var isEmpty: Bool { strokes.isEmpty }

    func begin(_ point: CGPoint, radius: CGFloat) { strokes.append(Stroke(radius: radius, points: [point])); active = true }
    func add(_ point: CGPoint) { if active, !strokes.isEmpty { strokes[strokes.count - 1].points.append(point) } }
    func end() { active = false }
    func cancel() { if active { strokes.removeLast() }; active = false }
    func undo() { if !strokes.isEmpty { strokes.removeLast() } }
    func clear() { strokes.removeAll(); active = false }

    /// The strokes in a canvas of `size`.
    func path(in size: CGSize) -> [(Path, CGFloat)] {
        strokes.map { stroke in
            var path = Path()
            let points = stroke.points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
            if points.count == 1 {
                let r = stroke.radius * size.width
                path.addEllipse(in: CGRect(x: points[0].x - r, y: points[0].y - r, width: r * 2, height: r * 2))
                return (path, 0)
            }
            path.addLines(points)
            return (path, stroke.radius * size.width * 2)
        }
    }

    /// Binary mask (long edge 1024), as the web's painted mask; antialiasing
    /// cannot select outside it.
    func mask(width: Int, height: Int) -> (pixels: Data, width: Int, height: Int) {
        let scale = 1024 / Double(max(width, height))
        let w = min(1024, max(1, Int((Double(width) * scale).rounded()))), h = min(1024, max(1, Int((Double(height) * scale).rounded())))
        var alpha = Data(count: w * h)
        alpha.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            context.translateBy(x: 0, y: CGFloat(h)); context.scaleBy(x: 1, y: -1)
            context.setFillColor(gray: 1, alpha: 1); context.setStrokeColor(gray: 1, alpha: 1)
            context.setLineCap(.round); context.setLineJoin(.round)
            for (stroke, lineWidth) in self.path(in: CGSize(width: w, height: h)) {
                context.addPath(stroke.cgPath)
                if lineWidth == 0 { context.fillPath() } else { context.setLineWidth(lineWidth); context.strokePath() }
            }
        }
        for i in 0..<alpha.count { alpha[i] = alpha[i] >= 128 ? 255 : 0 }
        return (alpha, w, h)
    }
}
