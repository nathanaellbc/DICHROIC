import SwiftUI
import UniformTypeIdentifiers

/// Empty state, as the web DropZone (src/ui/screens/Start.tsx): a two-tone
/// title fading in word by word, one breathing blue glow, "Choose Photo".
/// Only the button is pressable; a drop works anywhere (iPad).
struct StartView: View {
    var regular = false
    var enabled = true
    let onChoose: () -> Void
    let onDrop: (NSItemProvider) -> Void

    @Environment(\.colorScheme) private var scheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    @State private var breathe = false
    @State private var targeted = false

    var body: some View {
        GeometryReader { geo in
            let short = geo.size.width > geo.size.height && geo.size.height < 520
            let size = regular ? 48 : min(56, max(34, geo.size.width * 0.096))
            ZStack {
                glow(width: min(900, geo.size.width * 1.4))
                ScrollView {
                    VStack(spacing: 0) {
                        VStack(spacing: 0) {
                            words("Develop your photo", delay: 0, size: size, color: scheme == .dark ? Color(white: 0.96) : Color(red: 0.11, green: 0.11, blue: 0.12))
                            words("on real film.", delay: 0.18, size: size, color: Color(red: 0.525, green: 0.525, blue: 0.545))
                        }
                        .frame(maxWidth: size * 12)
                        if !short {
                            Text("Spectral simulation of real film and print stocks, right on this device.")
                                .font(.system(size: regular ? 15 : 17)).tracking(-0.17).lineSpacing(4)
                                .foregroundStyle(scheme == .dark ? Color(red: 0.63, green: 0.63, blue: 0.65) : Color(red: 0.43, green: 0.43, blue: 0.45))
                                .multilineTextAlignment(.center).frame(maxWidth: 510)
                                .padding(.top, 18)
                                .modifier(Rise(index: 0, shown: shown, reduce: reduceMotion))
                        }
                        Button(action: onChoose) {
                            Text("Choose Photo")
                                .font(.system(size: regular ? 15 : 17, weight: .medium)).tracking(-0.17)
                                .foregroundStyle(.white)
                                .padding(.horizontal, regular ? 22 : 26).frame(height: regular ? 40 : 48)
                                .background(Capsule().fill(Color.appleBlue))
                        }
                        .buttonStyle(PressStyle())
                        .disabled(!enabled).opacity(enabled ? 1 : 0.5)
                        .padding(.top, short ? 20 : 32)
                        .modifier(Rise(index: 1, shown: shown, reduce: reduceMotion))
                        if !short {
                            Text("RAW, JPEG, PNG, TIFF and OpenEXR. Nothing is uploaded.")
                                .font(.system(size: 12)).foregroundStyle(Color(red: 0.43, green: 0.43, blue: 0.45))
                                .multilineTextAlignment(.center).padding(.top, 44)
                                .modifier(Rise(index: 2, shown: shown, reduce: reduceMotion))
                        }
                    }
                    .padding(regular ? EdgeInsets(top: 32, leading: 24, bottom: 32, trailing: 24) : EdgeInsets(top: short ? 56 : 72, leading: 28, bottom: 28, trailing: 28))
                    .frame(maxWidth: .infinity, minHeight: short ? 0 : geo.size.height - 40, alignment: short ? .top : .center)
                }
                .scrollBounceBehavior(.basedOnSize)
            }
            .overlay {
                if targeted {
                    RoundedRectangle(cornerRadius: 28, style: .continuous).strokeBorder(Color.signal.opacity(0.6), lineWidth: 2)
                        .padding(12).allowsHitTesting(false)
                }
            }
        }
        .onDrop(of: [.image, .fileURL, .data], isTargeted: $targeted) { providers in
            guard let provider = providers.first else { return false }
            onDrop(provider)
            return true
        }
        .onAppear {
            withAnimation(.easeOut(duration: 1.0)) { shown = true }
            if !reduceMotion { withAnimation(.easeInOut(duration: 7).repeatForever(autoreverses: true)) { breathe = true } }
        }
    }

    /// One faint blue glow, breathing over 14 s.
    private func glow(width: CGFloat) -> some View {
        Ellipse()
            .fill(RadialGradient(colors: [Color.appleBlue.opacity(0.22), Color.appleBlue.opacity(0)], center: UnitPoint(x: 0.42, y: 0.5),
                                 startRadius: 0, endRadius: width * 0.5))
            .frame(width: width, height: width / 1.6)
            .blur(radius: 40)
            .scaleEffect(breathe ? 1.08 : 1)
            .offset(x: breathe ? width * 0.02 : -width * 0.02, y: breathe ? 30 : 50)
            .opacity((breathe ? 1 : 0.7) * 0.9)
            .allowsHitTesting(false)
    }

    /// Words rise 8 px out of an 8 px blur over 0.7 s, staggered.
    private func words(_ line: String, delay: Double, size: CGFloat, color: Color) -> some View {
        let parts = line.split(separator: " ").map(String.init)
        return HStack(spacing: size * 0.24) {
            ForEach(parts.indices, id: \.self) { i in
                Text(parts[i])
                    .font(.system(size: size, weight: .semibold)).tracking(-0.028 * size)
                    .foregroundStyle(color)
                    .opacity(shown ? 1 : 0)
                    .blur(radius: shown || reduceMotion ? 0 : 8)
                    .offset(y: shown || reduceMotion ? 0 : 8)
                    .animation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.7).delay(delay + Double(i) * 0.08), value: shown)
            }
        }
        .lineLimit(1).minimumScaleFactor(0.6)
    }
}

/// Staggered rise of the description, button and footnote.
private struct Rise: ViewModifier {
    let index: Int
    let shown: Bool
    let reduce: Bool
    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || reduce ? 0 : 8)
            .animation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.7).delay(0.35 + Double(index) * 0.09), value: shown)
    }
}
