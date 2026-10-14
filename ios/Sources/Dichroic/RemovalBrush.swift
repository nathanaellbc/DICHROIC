import SwiftUI

/// Brush for Remove Object and Refine Edge: strokes in photo coordinates
/// (0..1), radius as a fraction of the photo width (web Remove.tsx,
/// RefineEdge.tsx). Erase strokes cut away what was painted before.
@MainActor @Observable
final class RemovalBrush {
    struct Stroke {
        var radius: CGFloat
        var erase: Bool
        var points: [CGPoint]
    }
    var strokes: [Stroke] = []
    var diameter: Double
    let defaultDiameter: Double
    /// Brush (or Erase) rather than Move.
    var painting = true
    /// New strokes erase (Refine Edge "Erase").
    var erase = false
    private var active = false
    var isEmpty: Bool { strokes.isEmpty }

    init(diameter: Double = 32) { self.diameter = diameter; defaultDiameter = diameter }

    func begin(_ point: CGPoint, radius: CGFloat) { strokes.append(Stroke(radius: radius, erase: erase, points: [point])); active = true }
    func add(_ point: CGPoint) { if active, !strokes.isEmpty { strokes[strokes.count - 1].points.append(point) } }
    func end() { active = false }
    func cancel() { if active { strokes.removeLast() }; active = false }
    func undo() { if !strokes.isEmpty { strokes.removeLast() } }
    func clear() { strokes.removeAll(); active = false }

    /// The strokes in a canvas of `size`: path, line width (0 = a dot), erase.
    func paths(in size: CGSize) -> [(path: Path, width: CGFloat, erase: Bool)] {
        strokes.map { stroke in
            var path = Path()
            let points = stroke.points.map { CGPoint(x: $0.x * size.width, y: $0.y * size.height) }
            let r = stroke.radius * size.width
            if points.count == 1 {
                path.addEllipse(in: CGRect(x: points[0].x - r, y: points[0].y - r, width: r * 2, height: r * 2))
                return (path, 0, stroke.erase)
            }
            path.addLines(points)
            return (path, r * 2, stroke.erase)
        }
    }

    /// Draws the strokes (erase strokes clear) in `context` of `size`.
    func draw(in context: CGContext, size: CGSize) {
        context.setLineCap(.round); context.setLineJoin(.round)
        for item in paths(in: size) {
            context.setBlendMode(item.erase ? .clear : .normal)
            context.addPath(item.path.cgPath)
            if item.width == 0 { context.fillPath() } else { context.setLineWidth(item.width); context.strokePath() }
        }
        context.setBlendMode(.normal)
    }

    /// Binary mask of the strokes. Remove Object: long edge 1024, alpha ≥ 128
    /// (web painted mask; antialiasing cannot select outside it). Refine Edge:
    /// `maxEdge` the preview size and alpha > 32 (web canvas threshold).
    func mask(width: Int, height: Int, maxEdge: Int = 1024, threshold: UInt8 = 128, value: UInt8 = 255) -> (pixels: Data, width: Int, height: Int) {
        let scale = min(1, Double(maxEdge) / Double(max(width, height)))
        let w = max(1, Int((Double(width) * scale).rounded())), h = max(1, Int((Double(height) * scale).rounded()))
        var alpha = Data(count: w * h)
        alpha.withUnsafeMutableBytes { raw in
            guard let context = CGContext(data: raw.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return }
            context.translateBy(x: 0, y: CGFloat(h)); context.scaleBy(x: 1, y: -1)
            context.setFillColor(gray: 1, alpha: 1); context.setStrokeColor(gray: 1, alpha: 1)
            draw(in: context, size: CGSize(width: w, height: h))
        }
        for i in 0..<alpha.count { alpha[i] = alpha[i] > threshold || (threshold == 128 && alpha[i] == 128) ? value : 0 }
        return (alpha, w, h)
    }
}
