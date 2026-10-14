import SwiftUI
import DichroicEngine

/// Scope settings, as the web ScopePrefs (src/ui/model/vectorscope.ts), kept
/// per device class. The traces come from the same web scope code in the
/// canonical host; the graticules are the web SVGs (Vectorscope.tsx, Waveform.tsx).
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
    var zoom: Int { values.int("zoom") ?? 1 }
    var style: String { values.string("style") ?? "standard" }
    var targets: Int { values.int("targets") ?? 75 }
    var waveChannels: [Bool] {
        let raw = values["waveChannels"] as? [Any] ?? []
        let out = raw.map { ($0 as? NSNumber)?.boolValue ?? ($0 as? Bool) ?? true }
        return out.count == 3 ? out : [true, true, true]
    }

    /// Lane channels of the waveform or parade (web `waveformLayout`/`paradeLayout`).
    var channels: (ids: [String], lanes: Bool) {
        if kind == "parade" {
            switch values.string("paradeMode") {
            case "yrgb": return (["y", "r", "g", "b"], true)
            case "ycbcr": return (["y", "cb", "cr"], true)
            default: return (["r", "g", "b"], true)
            }
        }
        switch values.string("waveMode") {
        case "y": return (["y"], false)
        case "cbcr": return (["cb", "cr"], false)
        default:
            let on = zip(["r", "g", "b"], waveChannels).filter { $0.1 }.map { $0.0 }
            return (on.isEmpty ? ["r", "g", "b"] : on, false)
        }
    }

    func update(_ patch: JSON) {
        values.merge(patch) { _, new in new }
        if let data = try? JSONSerialization.data(withJSONObject: values) {
            UserDefaults.standard.set(String(decoding: data, as: UTF8.self), forKey: "DichroicScope.\(layout)")
        }
    }
}

// MARK: - Traces

/// One trace from the canonical host, refreshed on each new preview frame.
private struct ScopeTrace: ViewModifier {
    @Bindable var model: EditorModel
    let prefs: ScopePrefs
    let pixelWidth: Int
    let pixelHeight: Int
    @Binding var trace: UIImage?
    func body(content: Content) -> some View {
        // The key covers every preference the trace depends on.
        let key = "\(model.frames)|\(pixelWidth)x\(pixelHeight)|" + ["kind", "zoom", "colorize", "range", "waveMode", "paradeMode", "waveColorize", "lowPass", "extents"]
            .map { "\(prefs.values[$0] ?? "")" }.joined(separator: ",") + "\(prefs.waveChannels)"
        content.task(id: key) {
            trace = try? await model.engine.scope(prefs.values, width: pixelWidth, height: pixelHeight)
        }
    }
}

/// Rec.709 Cb/Cr of an RGB colour (web `toCbCr`).
private func cbcr(_ r: Double, _ g: Double, _ b: Double) -> (cb: Double, cr: Double) {
    let y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return ((b - y) / (2 * (1 - 0.0722)), (r - y) / (2 * (1 - 0.2126)))
}

/// Colour bar targets (web `scopeTargets`).
private let primaries: [(label: String, rgb: (Double, Double, Double), color: Color)] = [
    ("R", (1, 0, 0), Color(hex: "#ff453a")!), ("Mg", (1, 0, 1), Color(hex: "#ff4fd8")!), ("B", (0, 0, 1), Color(hex: "#4d7dff")!),
    ("Cy", (0, 1, 1), Color(hex: "#3ee0ff")!), ("G", (0, 1, 0), Color(hex: "#3ddc63")!), ("Yl", (1, 1, 0), Color(hex: "#ffd23a")!),
]

/// Vectorscope in the style of DaVinci Resolve (web Vectorscope.tsx): circle
/// with 10° ticks, 75 % or 100 % target boxes, skin tone line at 123°, zoom 2×.
struct VectorscopeView: View {
    @Bindable var model: EditorModel
    let prefs: ScopePrefs
    let size: CGFloat
    var onToggleZoom: (() -> Void)?
    @State private var trace: UIImage?
    /// Graticule radius (|C| 0.5) as a fraction of half the side.
    private let radiusFraction = 0.8

    var body: some View {
        ZStack {
            if let trace { Image(uiImage: trace).resizable().interpolation(.medium) }
            Canvas { context, canvasSize in drawGraticule(context, canvasSize.width / 100) }
        }
        .frame(width: size, height: size)
        .modifier(ScopeTrace(model: model, prefs: prefs, pixelWidth: Int(size * 2), pixelHeight: Int(size * 2), trace: $trace))
        .onTapGesture(count: 2) { onToggleZoom?() }
        .accessibilityElement()
        .accessibilityLabel("Vectorscope, Rec.709, \(prefs.values.string("range") == "all" ? "all levels" : "\(prefs.values.string("range") ?? "") levels"), \(prefs.targets)% targets\(prefs.zoom == 2 ? ", 2x zoom" : "")\(prefs.values.bool("skinTone") ? ", skin tone line" : "")")
    }

    /// The web SVG in its 100 × 100 view box, scaled by `k`.
    private func drawGraticule(_ context: GraphicsContext, _ k: CGFloat) {
        let c = 50.0, R = 50 * radiusFraction, scale = R * Double(prefs.zoom) / 0.5, style = prefs.style
        func p(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: x * k, y: y * k) }
        func line(_ a: CGPoint, _ b: CGPoint, _ color: Color, _ width: Double) {
            context.stroke(Path { $0.move(to: a); $0.addLine(to: b) }, with: .color(color), lineWidth: width * k)
        }
        let faint = Color.white.opacity(0.32)
        if style != "off" {
            context.stroke(Path(ellipseIn: CGRect(x: (c - R) * k, y: (c - R) * k, width: 2 * R * k, height: 2 * R * k)), with: .color(faint), lineWidth: 0.5 * k)
        }
        if style == "standard" {
            for deg in stride(from: 0, to: 360, by: 10) {
                let a = Double(deg) * .pi / 180, r0 = R - (deg % 30 == 0 ? 2.2 : 1.2)
                line(p(c + cos(a) * r0, c - sin(a) * r0), p(c + cos(a) * R, c - sin(a) * R), faint, 0.4)
            }
        }
        if style == "standard" || style == "simplified" {
            line(p(c - R, c), p(c + R, c), .white.opacity(0.14), 0.35)
            line(p(c, c - R), p(c, c + R), .white.opacity(0.14), 0.35)
        }
        var clipped = context
        clipped.clip(to: Path(CGRect(x: 0, y: 0, width: 100 * k, height: 100 * k)))
        if style == "hueVectors" {
            for t in primaries {
                let v = cbcr(t.rgb.0, t.rgb.1, t.rgb.2), a = atan2(v.cr, v.cb)
                var lineContext = clipped
                lineContext.opacity = 0.5
                lineContext.stroke(Path { $0.move(to: p(c, c)); $0.addLine(to: p(c + cos(a) * R, c - sin(a) * R)) }, with: .color(t.color), lineWidth: 0.4 * k)
                clipped.draw(Text(t.label).font(.system(size: 4.2 * k, weight: .semibold)).foregroundStyle(t.color.opacity(0.9)),
                             at: p(c + cos(a) * (R + 4.5), c - sin(a) * (R + 4.5)))
            }
        }
        if prefs.values.bool("skinTone") {
            let skin = 123.0 * .pi / 180
            clipped.stroke(Path { $0.move(to: p(c, c)); $0.addLine(to: p(c + cos(skin) * R * 1.05, c - sin(skin) * R * 1.05)) },
                           with: .color(Color(red: 1, green: 196 / 255, blue: 150 / 255).opacity(0.85)), lineWidth: 0.55 * k)
        }
        if style == "standard" || style == "simplified" {
            let level = prefs.targets == 75 ? 0.75 : 1, box = 0.03 * scale
            for t in primaries {
                let v = cbcr(t.rgb.0 * level, t.rgb.1 * level, t.rgb.2 * level)
                let x = c + v.cb * scale, y = c - v.cr * scale
                if style == "simplified" {
                    clipped.fill(Path(ellipseIn: CGRect(x: (x - 0.9) * k, y: (y - 0.9) * k, width: 1.8 * k, height: 1.8 * k)), with: .color(t.color.opacity(0.85)))
                    continue
                }
                clipped.stroke(Path(CGRect(x: (x - box) * k, y: (y - box) * k, width: 2 * box * k, height: 2 * box * k)), with: .color(t.color.opacity(0.9)), lineWidth: 0.5 * k)
                let tx = x + (v.cb >= 0 ? box + 1.2 : -box - 1.2), ty = y + (v.cr >= 0 ? -box - 0.6 : box + 3.2)
                clipped.draw(Text(t.label).font(.system(size: 4.2 * k, weight: .semibold)).foregroundStyle(t.color.opacity(0.9)),
                             at: p(tx, ty - 1.5), anchor: v.cb >= 0 ? .leading : .trailing)
            }
        }
        context.fill(Path(ellipseIn: CGRect(x: (c - 0.5) * k, y: (c - 0.5) * k, width: k, height: k)), with: .color(.white.opacity(0.5)))
    }
}

/// Waveform (Y' Rec.709) and RGB parade in the style of DaVinci Resolve (web
/// Waveform.tsx): graticule at the 10-bit levels 0, 128 … 1023, labels left.
struct WaveformView: View {
    @Bindable var model: EditorModel
    let prefs: ScopePrefs
    let width: CGFloat
    let height: CGFloat
    var labels = true
    @State private var trace: UIImage?

    private static let laneLabel = ["y": "Y", "r": "R", "g": "G", "b": "B", "cb": "Cb", "cr": "Cr"]
    private static let laneColor = ["y": "#e8e8ea", "r": "#ff5a50", "g": "#4be06a", "b": "#6f8dff", "cb": "#7f9dff", "cr": "#ff7a8a"]

    var body: some View {
        let gutter: CGFloat = labels ? 28 : 0, pad: CGFloat = 4
        let plotWidth = max(32, width - gutter), plotHeight = max(32, height - pad * 2)
        let layout = prefs.channels
        ZStack(alignment: .topLeading) {
            Group {
                if let trace { Image(uiImage: trace).resizable().interpolation(.medium) } else { Color.clear }
            }
            .frame(width: plotWidth, height: plotHeight)
            .offset(x: gutter, y: pad)
            Canvas { context, _ in
                func y(_ code: Double) -> CGFloat { pad + (1 - code / 1023) * (plotHeight - 1) + 0.5 }
                for code in [0.0, 128, 256, 384, 512, 640, 768, 896, 1023] {
                    let edge = code == 0 || code == 1023
                    context.stroke(Path { $0.move(to: CGPoint(x: gutter, y: y(code))); $0.addLine(to: CGPoint(x: width, y: y(code))) },
                                   with: .color(.white.opacity(edge ? 0.3 : 0.13)), lineWidth: 1)
                    if labels && (Int(code) % 256 == 0 || code == 1023) {
                        context.draw(Text("\(Int(code))").font(.system(size: 9)).monospacedDigit().foregroundStyle(.white.opacity(0.5)),
                                     at: CGPoint(x: gutter - 4, y: y(code)), anchor: .trailing)
                    }
                }
                guard layout.lanes else { return }
                let lanes = (0..<layout.ids.count).map { laneBox(plotWidth, layout.ids.count, $0) }
                for i in 1..<max(1, lanes.count) {
                    let x = gutter + lanes[i].x - (lanes[i].x - (lanes[i - 1].x + lanes[i - 1].width)) / 2
                    context.stroke(Path { $0.move(to: CGPoint(x: x, y: pad)); $0.addLine(to: CGPoint(x: x, y: pad + plotHeight)) },
                                   with: .color(.white.opacity(0.18)), lineWidth: 1)
                }
                if labels {
                    let colorize = prefs.values.bool("waveColorize")
                    for (i, box) in lanes.enumerated() {
                        let id = layout.ids[i]
                        context.draw(Text(Self.laneLabel[id] ?? id).font(.system(size: 9, weight: .bold))
                            .foregroundStyle(colorize ? Color(hex: Self.laneColor[id]) ?? .white : .white.opacity(0.6)),
                                     at: CGPoint(x: gutter + box.x + 4, y: pad + 7), anchor: .leading)
                    }
                }
            }
        }
        .frame(width: width, height: height)
        .modifier(ScopeTrace(model: model, prefs: prefs, pixelWidth: Int(plotWidth * 2), pixelHeight: Int(plotHeight * 2), trace: $trace))
        .accessibilityElement()
        .accessibilityLabel("\(layout.lanes ? "Parade" : "Waveform") \(layout.ids.map { Self.laneLabel[$0] ?? $0 }.joined()), Rec.709, 10-bit scale")
    }

    /// Start column and width of lane `index` of `count` (web `laneBox`).
    private func laneBox(_ width: CGFloat, _ count: Int, _ index: Int) -> (x: CGFloat, width: CGFloat) {
        guard count > 1 else { return (0, width) }
        let gap = max(2, (width * 0.012).rounded())
        let lane = ((width - CGFloat(count - 1) * gap) / CGFloat(count)).rounded(.down)
        return (CGFloat(index) * (lane + gap), lane)
    }
}

// MARK: - Phone overlay

/// Floating scope over the photo (phone layout): tap cycles Waveform,
/// Parade and Vectorscope. Each new preview is traced again.
struct ScopeOverlay: View {
    @Bindable var model: EditorModel
    @Bindable var prefs: ScopePrefs
    var landscape = false

    var body: some View {
        let kinds = ScopePrefs.kinds
        let index = kinds.firstIndex { $0.id == prefs.kind } ?? 2
        let kind = kinds[index], next = kinds[(index + 1) % kinds.count]
        let vector = prefs.kind == "vectorscope"
        Button { prefs.update(["kind": next.id]) } label: {
            ZStack(alignment: .bottom) {
                if vector {
                    VectorscopeView(model: model, prefs: prefs, size: landscape ? 116 : 132)
                } else {
                    WaveformView(model: model, prefs: prefs, width: landscape ? 176 : 200, height: landscape ? 100 : 112, labels: false)
                }
                HStack {
                    if vector && prefs.zoom == 2 { badge("2×") }
                    Spacer()
                    badge(kind.short)
                }
                .padding(.horizontal, 8).padding(.bottom, 2)
            }
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 22, style: .continuous).fill(Color(red: 0.04, green: 0.04, blue: 0.05).opacity(0.72)))
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 22, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 22, style: .continuous).strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
            .environment(\.colorScheme, .dark)
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel("\(kind.name). Show \(next.name)")
    }

    private func badge(_ text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .bold)).foregroundStyle(.white.opacity(0.72)).shadow(radius: 3)
    }
}

// MARK: - Inspector panel

/// Scopes in the inspector (web ScopePanel): kind tabs, the options of each
/// kind, and the scope at the inspector's width.
struct ScopePanel: View {
    @Bindable var model: EditorModel
    @Bindable var prefs: ScopePrefs
    let width: CGFloat
    let windowHeight: CGFloat

    var body: some View {
        let vectorSize = max(140, min(width, windowHeight * 0.38).rounded(.down))
        let waveWidth = max(160, width)
        let waveHeight = max(96, min(waveWidth * 0.62, windowHeight * 0.3).rounded(.down))
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                segmented(ScopePrefs.kinds.map { ($0.id, $0.name) }, prefs.kind) { prefs.update(["kind": $0]) }
                Spacer(minLength: 8)
                Text("Rec.709").font(.system(size: 11)).foregroundStyle(.tertiary)
            }
            options
            secondRow
            HStack {
                Spacer()
                if prefs.kind == "vectorscope" {
                    VectorscopeView(model: model, prefs: prefs, size: vectorSize) { prefs.update(["zoom": prefs.zoom == 2 ? 1 : 2]) }
                } else {
                    WaveformView(model: model, prefs: prefs, width: waveWidth, height: waveHeight)
                }
                Spacer()
            }
        }
        .padding(12)
        .background(Color(red: 28 / 255, green: 28 / 255, blue: 30 / 255).opacity(0.58), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
        .environment(\.colorScheme, .dark)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Scopes")
    }

    @ViewBuilder private var options: some View {
        HStack(spacing: 6) {
            switch prefs.kind {
            case "waveform":
                segmented([("y", "Y"), ("rgb", "RGB"), ("cbcr", "CbCr")], prefs.values.string("waveMode") ?? "rgb") { prefs.update(["waveMode": $0]) }
                if prefs.values.string("waveMode") == "rgb" {
                    ForEach(0..<3, id: \.self) { i in
                        chip(["R", "G", "B"][i], prefs.waveChannels[i]) {
                            var next = prefs.waveChannels
                            next[i].toggle()
                            if next.contains(true) { prefs.update(["waveChannels": next]) }
                        }
                    }
                }
            case "parade":
                segmented([("rgb", "RGB"), ("yrgb", "YRGB"), ("ycbcr", "YCbCr")], prefs.values.string("paradeMode") ?? "rgb") { prefs.update(["paradeMode": $0]) }
            default:
                segmented([("all", "All"), ("low", "Low"), ("mid", "Mid"), ("high", "High")], prefs.values.string("range") ?? "all") { prefs.update(["range": $0]) }
            }
        }
    }

    @ViewBuilder private var secondRow: some View {
        if prefs.kind == "vectorscope" {
            let styles = [("standard", "Standard"), ("simplified", "Simplified"), ("hueVectors", "Hue Vectors"), ("off", "Off")]
            let index = styles.firstIndex { $0.0 == prefs.style } ?? 0
            // Buttons that cycle a value, then switches: two spaced groups.
            HStack(spacing: 14) {
                HStack(spacing: 6) {
                    chip(styles[index].1, false) { prefs.update(["style": styles[(index + 1) % styles.count].0]) }
                    chip("\(prefs.targets)%", false) { prefs.update(["targets": prefs.targets == 75 ? 100 : 75]) }
                }
                HStack(spacing: 6) {
                    chip("2×", prefs.zoom == 2) { prefs.update(["zoom": prefs.zoom == 2 ? 1 : 2]) }
                    chip("Skin", prefs.values.bool("skinTone")) { prefs.update(["skinTone": !prefs.values.bool("skinTone")]) }
                    chip("Colorize", prefs.values.bool("colorize")) { prefs.update(["colorize": !prefs.values.bool("colorize")]) }
                }
            }
        } else {
            HStack(spacing: 6) {
                chip("Colorize", prefs.values.bool("waveColorize")) { prefs.update(["waveColorize": !prefs.values.bool("waveColorize")]) }
                chip("Low Pass", prefs.values.bool("lowPass")) { prefs.update(["lowPass": !prefs.values.bool("lowPass")]) }
                chip("Extents", prefs.values.bool("extents")) { prefs.update(["extents": !prefs.values.bool("extents")]) }
            }
        }
    }

    /// Web `.scope-chip`: 24 px, Blue Wash when pressed.
    private func chip(_ label: String, _ pressed: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label).font(.system(size: 11, weight: .semibold))
                .padding(.horizontal, 9).frame(height: 24)
                .foregroundStyle(pressed ? Color.signal : Color.primary)
                .background(Capsule().fill(pressed ? Color.signal.opacity(0.2) : Color.chip))
        }
        .buttonStyle(PressStyle())
        .accessibilityAddTraits(pressed ? .isSelected : [])
    }

    /// Web `.scope-tabs`: segmented, 26 px.
    private func segmented(_ items: [(String, String)], _ value: String, onChange: @escaping (String) -> Void) -> some View {
        HStack(spacing: 0) {
            ForEach(items.indices, id: \.self) { i in
                let item = items[i]
                Button { onChange(item.0) } label: {
                    Text(item.1).font(.system(size: 11, weight: .medium))
                        .frame(maxWidth: .infinity).frame(height: 22)
                        .background { if item.0 == value { Capsule().fill(Color.white.opacity(0.16)) } }
                        .foregroundStyle(item.0 == value ? Color.primary : Color.secondaryText)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(item.0 == value ? .isSelected : [])
            }
        }
        .padding(2)
        .frame(height: 26)
        .background(Capsule().fill(Color.chip))
    }
}
