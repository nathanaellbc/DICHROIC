import SwiftUI
import DichroicEngine

/// Scope settings, as the web ScopePrefs (src/ui/model/vectorscope.ts), kept
/// per device class. The traces come from the same web scope code in the
/// canonical host.
@MainActor @Observable
final class ScopePrefs {
    let layout: String
    private(set) var values: JSON

    static let defaults: JSON = [
        "open": false, "kind": "vectorscope", "zoom": 1, "skinTone": true, "colorize": true, "targets": 75,
        "range": "all", "style": "standard", "waveMode": "rgb", "waveChannels": [true, true, true],
        "paradeMode": "rgb", "waveColorize": true, "lowPass": false, "extents": false,
    ]
    static let kinds: [(id: String, name: String, short: String)] = [
        ("waveform", "Waveform", "Wave"), ("parade", "Parade", "Parade"), ("vectorscope", "Vectorscope", "Vector"),
    ]

    init(_ layout: String) {
        self.layout = layout
        var values = Self.defaults
        if let text = UserDefaults.standard.string(forKey: "DichroicScope.\(layout)"),
           let stored = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? JSON {
            for (key, value) in stored where Self.defaults[key] != nil { values[key] = value }
        }
        self.values = values
    }

    var open: Bool { values.bool("open") }
    var kind: String { values.string("kind") ?? "vectorscope" }

    func update(_ patch: JSON) {
        values.merge(patch) { _, new in new }
        if let data = try? JSONSerialization.data(withJSONObject: values) {
            UserDefaults.standard.set(String(decoding: data, as: UTF8.self), forKey: "DichroicScope.\(layout)")
        }
    }
}

/// Floating scope over the photo (phone layout): tap cycles Waveform,
/// Parade and Vectorscope. Each new preview is traced again.
struct ScopeOverlay: View {
    @Bindable var model: EditorModel
    @Bindable var prefs: ScopePrefs
    var landscape = false
    @State private var trace: UIImage?

    var body: some View {
        let kinds = ScopePrefs.kinds
        let index = kinds.firstIndex { $0.id == prefs.kind } ?? 2
        let kind = kinds[index], next = kinds[(index + 1) % kinds.count]
        let vector = prefs.kind == "vectorscope"
        let width: CGFloat = vector ? (landscape ? 116 : 132) : (landscape ? 176 : 200)
        let height: CGFloat = vector ? (landscape ? 116 : 132) : (landscape ? 100 : 112)
        Button { prefs.update(["kind": next.id]) } label: {
            ZStack(alignment: .bottom) {
                Group {
                    if let trace { Image(uiImage: trace).resizable().interpolation(.medium) } else { Color.clear }
                }
                .frame(width: width, height: height)
                .overlay { if vector { VectorGraticule() } else { WaveGraticule() } }
                HStack {
                    if vector && prefs.values.int("zoom") == 2 { badge("2×") }
                    Spacer()
                    badge(kind.short)
                }
                .padding(.horizontal, 6).padding(.bottom, 2)
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color(red: 0.04, green: 0.04, blue: 0.05).opacity(0.72)))
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("\(kind.name). Show \(next.name)")
        .task(id: "\(model.frames)|\(prefs.kind)|\(Int(width))") {
            trace = try? await model.engine.scope(prefs.values, width: Int(width * 2), height: Int(height * 2))
        }
    }

    private func badge(_ text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.72)).shadow(radius: 3)
    }
}

/// 0, 25, 50, 75 and 100 % lines.
private struct WaveGraticule: View {
    var body: some View {
        Canvas { context, size in
            for i in 0...4 {
                let y = size.height * CGFloat(i) / 4
                context.stroke(Path { $0.move(to: CGPoint(x: 0, y: y)); $0.addLine(to: CGPoint(x: size.width, y: y)) },
                               with: .color(.white.opacity(i == 0 || i == 4 ? 0.22 : 0.1)), lineWidth: 0.5)
            }
        }
        .allowsHitTesting(false)
    }
}

/// Ring, crosshair and the skin-tone line.
private struct VectorGraticule: View {
    var body: some View {
        Canvas { context, size in
            let c = CGPoint(x: size.width / 2, y: size.height / 2), r = min(size.width, size.height) / 2 * 0.8
            context.stroke(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)), with: .color(.white.opacity(0.18)), lineWidth: 0.5)
            context.stroke(Path { $0.move(to: CGPoint(x: c.x - r, y: c.y)); $0.addLine(to: CGPoint(x: c.x + r, y: c.y))
                $0.move(to: CGPoint(x: c.x, y: c.y - r)); $0.addLine(to: CGPoint(x: c.x, y: c.y + r)) },
                           with: .color(.white.opacity(0.1)), lineWidth: 0.5)
            // Skin tone line at 123° (Rec.709 I axis).
            let angle = -123.0 * .pi / 180
            context.stroke(Path { $0.move(to: c); $0.addLine(to: CGPoint(x: c.x + r * cos(angle), y: c.y + r * sin(angle))) },
                           with: .color(Color(red: 1, green: 0.8, blue: 0.6).opacity(0.35)), lineWidth: 0.5)
        }
        .allowsHitTesting(false)
    }
}
