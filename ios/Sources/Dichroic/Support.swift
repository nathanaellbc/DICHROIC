import SwiftUI

typealias JSON = [String: Any]

extension Dictionary where Key == String, Value == Any {
    func string(_ key: String) -> String? { self[key] as? String }
    func double(_ key: String) -> Double? { (self[key] as? NSNumber)?.doubleValue ?? (self[key] as? Double) }
    func int(_ key: String) -> Int? { (self[key] as? NSNumber)?.intValue ?? (self[key] as? Int) }
    func bool(_ key: String) -> Bool { (self[key] as? NSNumber)?.boolValue ?? (self[key] as? Bool) ?? false }
    func list(_ key: String) -> [JSON] { self[key] as? [JSON] ?? [] }
    func object(_ key: String) -> JSON { self[key] as? JSON ?? [:] }
}

/// Equality of JSON values (parameters, snapshots) through Foundation.
func jsonEqual(_ a: Any?, _ b: Any?) -> Bool {
    switch (a, b) {
    case (nil, nil): return true
    case let (x as NSObject, y as NSObject): return x.isEqual(y)
    default: return false
    }
}

func jsonEqual(_ a: JSON, _ b: JSON) -> Bool { (a as NSDictionary).isEqual(to: b) }

// MARK: - Design tokens (DESIGN.md, web styles.css)

extension Color {
    /// Signal blue: selection, edited marks, prominent buttons.
    static let signal = Color(red: 0, green: 0x91 / 255, blue: 1)
    /// Apple blue of the start page's Choose Photo.
    static let appleBlue = Color(red: 0, green: 0x71 / 255, blue: 0xe3 / 255)
    static let secondaryText = Color(red: 0x8e / 255, green: 0x8e / 255, blue: 0x93 / 255)
    static let danger = Color(red: 1, green: 0x69 / 255, blue: 0x61 / 255)
    static let success = Color(red: 0x30 / 255, green: 0xd1 / 255, blue: 0x58 / 255)
    static let warning = Color(red: 1, green: 0x92 / 255, blue: 0x30 / 255)
    static let chip = Color(red: 0x78 / 255, green: 0x78 / 255, blue: 0x80 / 255).opacity(0.12)
}

/// Translucent glass surface: Liquid Glass on iOS 26, material before.
struct Glass: ViewModifier {
    var radius: CGFloat = 20
    var interactive = false
    func body(content: Content) -> some View {
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) {
            content.glassEffect(interactive ? .regular.interactive() : .regular, in: .rect(cornerRadius: radius))
        } else {
            content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        }
        #else
        content.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: radius, style: .continuous))
        #endif
    }
}

extension View {
    func glass(_ radius: CGFloat = 20, interactive: Bool = false) -> some View { modifier(Glass(radius: radius, interactive: interactive)) }
}

/// Round glass icon button (toolbar, Compare, Scopes).
struct GlassIconButton: View {
    let symbol: String
    let label: String
    var selected = false
    var prominent = false
    var size: CGFloat = 44
    var action: () -> Void
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(prominent ? Color.white : selected ? Color.signal : Color.primary)
                .frame(width: size, height: 44)
                .background {
                    if prominent { Capsule().fill(Color.signal) }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(PressStyle())
        .glass(22, interactive: true)
        .opacity(enabled ? 1 : 0.45)
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Spring press feedback (web `:active` scale 0.96).
struct PressStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .animation(.spring(response: 0.25, dampingFraction: 0.7), value: configuration.isPressed)
    }
}

/// Capsule text button (Remove Object controls, sheets).
struct CapsuleButton: View {
    let title: String
    var symbol: String?
    var selected = false
    var prominent = false
    var action: () -> Void
    @Environment(\.isEnabled) private var enabled
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                if let symbol { Image(systemName: symbol).font(.system(size: 14, weight: .semibold)) }
                if !title.isEmpty { Text(title).font(.system(size: 15, weight: .semibold)) }
            }
            .padding(.horizontal, title.isEmpty ? 13 : 16)
            .frame(height: 40)
            .foregroundStyle(prominent ? Color.white : selected ? Color.signal : Color.primary)
            .background(
                Capsule().fill(prominent ? Color.signal : selected ? Color.signal.opacity(0.18) : Color.chip)
            )
        }
        .buttonStyle(PressStyle())
        .opacity(enabled ? 1 : 0.45)
    }
}

// MARK: - Glyphs (web icon names → SF Symbols)

let sfSymbols: [String: String] = [
    "aperture": "camera.aperture", "auto": "a.circle", "blacks": "circle.fill", "blades": "hexagon",
    "camera": "camera", "catEye": "eye", "check": "checkmark", "chevronDown": "chevron.down",
    "chevronRight": "chevron.right", "close": "xmark", "compare": "rectangle.split.2x1",
    "contrast": "circle.lefthalf.filled", "couplers": "circle.hexagongrid", "curvature": "circle.dashed",
    "decode": "function", "diffusion": "camera.filters", "dot": "circle.fill", "edge": "square.split.diagonal",
    "enlargerFilter": "lamp.ceiling", "erase": "eraser", "exposure": "sun.max", "flash": "bolt",
    "focalLength": "plus.magnifyingglass", "focus": "viewfinder", "foreground": "square.on.square",
    "format": "film", "glare": "sparkles", "grain": "circle.grid.3x3.fill", "halation": "sun.haze",
    "hdr": "camera.metering.matrix", "highlights": "sun.max.fill", "info": "info.circle",
    "input": "arrow.right.to.line", "layers": "square.3.layers.3d", "lens": "camera.aperture",
    "loader": "hourglass", "lock": "lock", "minus": "minus", "more": "ellipsis",
    "move": "arrow.up.and.down.and.arrow.left.and.right", "nearSharp": "arrow.forward.to.line",
    "negative": "circle.righthalf.filled", "open": "folder", "output": "arrow.right.square", "photo": "photo",
    "plus": "plus", "print": "printer", "process": "arrow.left.arrow.right", "pushPull": "arrow.up.arrow.down",
    "redo": "arrow.uturn.forward", "reset": "arrow.counterclockwise", "saturation": "drop.halffull",
    "scope": "scope", "themeSystem": "circle.lefthalf.filled", "themeLight": "sun.max", "themeDark": "moon",
    "search": "magnifyingglass", "seed": "dice", "shadows": "moon", "share": "square.and.arrow.up",
    "sharpen": "triangle", "shuffle": "shuffle", "spread": "dot.radiowaves.left.and.right",
    "temperature": "thermometer.medium", "tint": "drop", "undo": "arrow.uturn.backward",
    "upDown": "chevron.up.chevron.down", "warning": "exclamationmark.triangle", "whites": "circle",
]

func sfSymbol(_ glyph: String?) -> String {
    guard let glyph, !glyph.isEmpty else { return "circle" }
    if let mapped = sfSymbols[glyph] { return mapped }
    return UIImage(systemName: glyph) == nil ? "circle" : glyph
}

extension Color {
    /// "#rrggbb" from the catalog (tool tints).
    init?(hex: String?) {
        guard let hex, hex.hasPrefix("#"), hex.count == 7, let value = Int(hex.dropFirst(), radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 255) / 255, green: Double((value >> 8) & 255) / 255, blue: Double(value & 255) / 255)
    }
}

// MARK: - Shared texts (web Editor.tsx, Stocks.tsx, share.ts)

/// Stock lookups over the canonical catalog (`filmSections`/`paperSections`).
struct Stocks {
    let catalog: JSON
    let params: JSON

    func info(_ kind: String, _ id: String?) -> JSON {
        for section in catalog.list("\(kind)Sections") {
            for stock in section.list("stocks") where stock.string("id") == id { return stock }
        }
        return ["id": id ?? "", "short": id ?? "", "name": id ?? "", "detail": ""]
    }

    static func isPrintLut(_ id: String?) -> Bool { id?.hasPrefix("lut_") ?? false }

    func isSlide(_ id: String?) -> Bool {
        catalog.list("filmSections").contains { $0.bool("scanOnly") && $0.list("stocks").contains { $0.string("id") == id } }
    }

    var filmEnabled: Bool { (params["filmEnabled"] as? NSNumber)?.boolValue ?? true }
    var scan: Bool { params.string("process") == "scanNegative" && !Self.isPrintLut(params.string("paper")) }
    private func short(_ kind: String) -> String { info(kind, params.string(kind)).string("short") ?? "" }

    var offOutput: String { Self.isPrintLut(params.string("paper")) ? "on \(short("paper"))" : "Neutral negative" }
    /// Toolbar capsule, first line.
    var filmLine: String { filmEnabled ? short("film") : "Film Off" }
    /// Toolbar capsule, second line.
    var paperLine: String { !filmEnabled ? offOutput : scan ? "Scanned" : "on \(short("paper"))" }
    /// "Portra 400 → Portra Endura".
    var recipe: String {
        if !filmEnabled { return "Film Off · \(offOutput)" }
        return scan ? "\(short("film")), scanned" : "\(short("film")) → \(short("paper"))"
    }
    /// Export toast: "Portra 400 on Portra Endura".
    var exportRecipe: String {
        if !filmEnabled { return "Film Off · \(offOutput)" }
        return scan ? "\(short("film")), scanned" : "\(short("film")) on \(short("paper"))"
    }
    /// `<photo> - <film> on <paper>.<ext>`.
    func fileName(_ stem: String, _ ext: String, suffix: String = "") -> String {
        let film = asciiName(info("film", params.string("film")).string("name") ?? "")
        let look = scan ? "\(film) scan" : "\(film) on \(asciiName(info("paper", params.string("paper")).string("name") ?? ""))"
        let base = asciiName(stem)
        return "\(base.isEmpty ? "photo" : base) - \(look)\(suffix.isEmpty ? "" : " \(suffix)").\(ext)"
    }
}

/// Plain-ASCII file name part (web `asciiName`).
func asciiName(_ value: String) -> String {
    let folded = value.applyingTransform(.stripDiacritics, reverse: false) ?? value
    var out = folded.replacingOccurrences(of: "[^A-Za-z0-9 ._()+-]+", with: "-", options: .regularExpression)
    out = out.replacingOccurrences(of: "-{2,}", with: "-", options: .regularExpression)
    return out.replacingOccurrences(of: "^[\\s.-]+|[\\s.-]+$", with: "", options: .regularExpression)
}

/// Hint above the stock list, while the search is empty (Stocks.tsx).
func stockHint(_ kind: String, filmEnabled: Bool, scan: Bool) -> String {
    if !filmEnabled && kind == "paper" {
        return "Film Off keeps exposure, develop and texture active. Film print LUTs work with this neutral negative; photographic paper requires a film stock."
    }
    if kind == "film" {
        if !filmEnabled { return "Film and paper are off. Camera and Lens adjustments remain active." }
        return scan
            ? "Scanning shows the film itself. Slides come out as positives; color negatives come out orange and inverted."
            : "Every negative is printed to a neutral grey, so films differ subtly: in color, contrast and grain. For a bigger change in look, try Paper."
    }
    return scan
        ? "Nothing is printed while Process is set to Scan. Set Process to Print above to use paper."
        : "The paper sets contrast, color and the depth of the blacks. Cinema print films give the strongest look."
}

func formatBytes(_ n: Int) -> String {
    if n < 1024 { return "\(n) B" }
    if n < 1024 * 1024 { return String(format: "%.1f KB", Double(n) / 1024) }
    return String(format: "%.1f MB", Double(n) / (1024 * 1024))
}

/// "0.0s", "1m 3.0s" (web `formatElapsed`).
func formatElapsed(_ seconds: Double) -> String {
    let s = (seconds * 10).rounded(.down) / 10
    if s < 60 { return String(format: "%.1fs", s) }
    let m = Int(s / 60)
    return String(format: "%dm %.1fs", m, s - Double(m * 60))
}

/// File stem for export names; picker copies carry the original after "--".
func stemOf(_ url: URL) -> String {
    var name = url.deletingPathExtension().lastPathComponent
    if name.hasPrefix("Dichroic-import-") {
        if let mark = name.range(of: "--") { name = String(name[mark.upperBound...]) } else { name = "" }
    }
    let trimmed = name.trimmingCharacters(in: .whitespaces)
    return trimmed.isEmpty ? "photo" : trimmed
}
