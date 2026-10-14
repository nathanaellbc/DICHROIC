import SwiftUI

/// Decrypted Text (web DecryptedText.tsx, React Bits): scrambled characters
/// settle one by one from the start into the final text, 30 ms per step.
/// Spaces and "·" stay put so the width does not jump. Reduce Motion: plain.
struct DecryptedText: View {
    let text: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown: String = ""
    private static let characters = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%&*")

    var body: some View {
        Text(shown.isEmpty ? text : shown)
            .monospacedDigit()
            .accessibilityLabel(text)
            .task(id: text) {
                let chars = Array(text)
                guard !reduceMotion, !chars.isEmpty else { shown = text; return }
                var revealed = Set(chars.indices.filter { chars[$0] == " " || chars[$0] == "·" })
                func scramble() -> String {
                    String(chars.indices.map { revealed.contains($0) ? chars[$0] : Self.characters.randomElement()! })
                }
                shown = scramble()
                while revealed.count < chars.count {
                    try? await Task.sleep(for: .milliseconds(30))
                    if Task.isCancelled { return }
                    if let next = chars.indices.first(where: { !revealed.contains($0) }) { revealed.insert(next) }
                    shown = scramble()
                }
                shown = text
            }
    }
}

/// Thought Line steps (web ThoughtLine.tsx with `hideHead`): while working,
/// steps appear one under another (done ones ticked, the active one pulsing);
/// when finished the trace folds away.
struct ThoughtLine: View {
    let working: Bool
    let steps: [String]
    let activeStep: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulse = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            if working {
                ForEach(0..<max(1, min(steps.count, activeStep + 1)), id: \.self) { i in
                    let done = i < activeStep
                    HStack(spacing: 6) {
                        ZStack {
                            if done {
                                Image(systemName: "checkmark").font(.system(size: 11, weight: .heavy)).foregroundStyle(Color.success)
                            } else {
                                Circle().fill(Color.signal).frame(width: 6, height: 6)
                                    .scaleEffect(pulse ? 1 : 0.6).opacity(pulse ? 1 : 0.45)
                            }
                        }
                        .frame(width: 16, height: 16)
                        Text(steps[i]).font(.system(size: 13)).monospacedDigit()
                            .foregroundStyle(done ? Color.secondaryText : Color.primary)
                    }
                    .transition(.asymmetric(insertion: .move(edge: .top).combined(with: .opacity), removal: .opacity))
                }
            }
        }
        .animation(reduceMotion ? nil : .timingCurve(0.23, 1, 0.32, 1, duration: 0.3), value: activeStep)
        .animation(reduceMotion ? nil : .timingCurve(0.77, 0, 0.175, 1, duration: 0.35), value: working)
        .onAppear {
            guard !reduceMotion else { pulse = true; return }
            withAnimation(.timingCurve(0.77, 0, 0.175, 1, duration: 0.8).repeatForever(autoreverses: true)) { pulse = true }
        }
        .accessibilityElement(children: .combine)
    }
}
