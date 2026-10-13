import SwiftUI

/// Slider with web semantics: snapped steps, gesture start/end for one undo
/// step, double-tap to reset. While the finger is down the slider owns its
/// value, so the model's snapped echo cannot make the thumb stutter.
struct DetailSlider: View {
    let value: Double
    let range: ClosedRange<Double>
    let step: Double
    let label: String
    var enabled = true
    var onStart: (() -> Void)?
    var onEnd: (() -> Void)?
    let onChange: (Double) -> Void
    var onReset: (() -> Void)?
    @State private var live: Double?

    private func snap(_ v: Double) -> Double {
        guard step > 0 else { return v }
        return min(range.upperBound, max(range.lowerBound, range.lowerBound + ((v - range.lowerBound) / step).rounded() * step))
    }

    var body: some View {
        Slider(value: Binding(get: { live ?? value }, set: { next in
            let snapped = snap(next)
            if snapped != snap(live ?? value) { onChange(snapped) }
            live = next
        }), in: range, onEditingChanged: { editing in
            if editing { live = value; onStart?() } else { live = nil; onEnd?() }
        })
        .tint(.signal)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .simultaneousGesture(TapGesture(count: 2).onEnded { if enabled { onReset?() } })
    }
}

/// Horizontal capsule chips for a short choice (web choice row).
struct OptionRow: View {
    let label: String
    let options: [JSON]
    let value: String?
    let onChange: ((String) -> Void)?

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(options.indices, id: \.self) { i in
                        let option = options[i], id = option.string("value") ?? ""
                        CapsuleButton(title: option.string("label") ?? id, selected: id == value) { onChange?(id) }
                            .disabled(onChange == nil)
                            .id(id)
                    }
                }
                .padding(.vertical, 4)
            }
            .frame(height: 48)
            .onAppear { if let value { proxy.scrollTo(value, anchor: .center) } }
            .onChange(of: value) { _, next in
                withAnimation(.easeOut(duration: 0.26)) { if let next { proxy.scrollTo(next, anchor: .center) } }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(label)
    }
}

/// One tool, laid out like the web phone panel (Editor.tsx, ToolControls.tsx):
/// a heading with the title, value, reset and switch, then the control.
struct ToolPanel: View {
    let tool: JSON
    @Bindable var model: EditorModel
    @State private var optionSheet = false

    private var id: String { tool.string("id") ?? "" }
    private var kind: String { tool.string("kind") ?? "" }
    private var title: String { tool.string("title") ?? "" }
    private var enabled: Bool { !model.busy && (tool["enabled"] as? Bool ?? true) }

    private func fields(_ value: JSON) { model.edit("fields", id, value) }
    private func note(_ text: String?, size: CGFloat = 13) -> some View {
        Text(text ?? "").font(.system(size: size)).foregroundStyle(Color.secondaryText).lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    var body: some View {
        let p = model.params
        // Switch in the heading: toggles, lens blur, and tools with their own.
        let switchField = (kind == "toggle" || kind == "lens") ? tool.string("field") : tool.string("enabledBy")
        let decodeBlocked = kind == "toggle" && tool.string("field") == "inputCctfDecoding" && !enabled
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(title).font(.system(size: 17, weight: .semibold))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .id(id).transition(.opacity)
                if kind == "slider" || kind == "stepper" {
                    Text(tool.string("valueText") ?? "").font(.system(size: 20, weight: .semibold)).monospacedDigit()
                        .contentTransition(.numericText())
                }
                if tool.bool("resettable") {
                    Button { model.edit("reset", id, nil) } label: {
                        Image(systemName: "arrow.counterclockwise").font(.system(size: 15, weight: .semibold))
                            .frame(width: 32, height: 32).background(Circle().fill(Color.chip))
                    }
                    .buttonStyle(PressStyle()).disabled(model.busy).accessibilityLabel("Reset \(title)")
                }
                if let switchField {
                    Toggle(title, isOn: Binding(get: { p.bool(switchField) }, set: { on in
                        var patch: JSON = [switchField: on]
                        if on, kind == "diffusion", let strength = tool.string("strengthField"), (p.double(strength) ?? 0) <= 0 { patch[strength] = 0.5 }
                        fields(patch)
                    }))
                    .labelsHidden().tint(.signal).disabled(model.busy || decodeBlocked)
                }
            }
            controlBody(p)
        }
        .padding(EdgeInsets(top: 12, leading: 16, bottom: 4, trailing: 16))
        .sheet(isPresented: $optionSheet) {
            OptionSheet(title: title, options: tool.list("options"), value: p.string(tool.string("field") ?? "")) { model.edit("choice", id, $0) }
                .presentationDetents([.medium, .large])
        }
    }

    @ViewBuilder private func controlBody(_ p: JSON) -> some View {
        switch kind {
        case "slider":
            let range = tool.object("range")
            VStack(alignment: .leading, spacing: 4) {
                DetailSlider(value: tool.double("position") ?? 0,
                             range: (range.double("min") ?? 0)...(range.double("max") ?? 1),
                             step: range.double("step") ?? 0, label: title, enabled: enabled,
                             onStart: model.beginGesture, onEnd: { Task { await model.endGesture() } },
                             onChange: { model.edit("position", id, $0) },
                             onReset: tool.double("defaultPosition").map { position -> () -> Void in { model.edit("position", id, position) } })
                if tool["note"] != nil { note(tool.string("note")) }
            }
        case "stepper":
            HStack(spacing: 8) {
                CapsuleButton(title: "", symbol: "minus") { model.edit("step", id, -1) }
                    .disabled(!enabled || tool.bool("atMin")).accessibilityLabel("Decrease \(title)")
                VStack(spacing: 2) {
                    Text(tool.string("valueText") ?? "").font(.system(size: 17, weight: .semibold)).monospacedDigit()
                        .contentTransition(.numericText())
                    if tool["hint"] != nil { Text(tool.string("hint") ?? "").font(.system(size: 13)).foregroundStyle(Color.secondaryText) }
                }
                .frame(maxWidth: .infinity)
                CapsuleButton(title: "", symbol: "plus") { model.edit("step", id, 1) }
                    .disabled(!enabled || tool.bool("atMax")).accessibilityLabel("Increase \(title)")
                if tool.string("field") == "grainSeed" {
                    CapsuleButton(title: "", symbol: "shuffle") { fields(["grainSeed": Int.random(in: 1...9999)]) }
                        .disabled(!enabled).accessibilityLabel("Random grain pattern")
                }
            }
        case "choice":
            let options = tool.list("options")
            if options.count > 10 {
                // Long lists (color spaces) open a list sheet, as on the web.
                Button { optionSheet = true } label: {
                    HStack {
                        Text(tool.string("valueText") ?? "").font(.system(size: 17, weight: .medium)).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 14, weight: .semibold))
                    }
                    .padding(.horizontal, 14).frame(height: 44)
                    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.chip))
                }
                .buttonStyle(.plain).disabled(!enabled)
                .accessibilityLabel("\(title): \(tool.string("valueText") ?? ""). Change")
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    OptionRow(label: title, options: options, value: p.string(tool.string("field") ?? ""),
                              onChange: enabled ? { model.edit("choice", id, $0) } : nil)
                    if tool["note"] != nil { note(tool.string("note")) }
                }
            }
        case "diffusion":
            let family = tool.string("familyField") ?? "", strength = tool.string("strengthField") ?? "", enabledBy = tool.string("enabledBy") ?? ""
            let range = tool.object("strengthRange")
            VStack(alignment: .leading, spacing: 4) {
                OptionRow(label: "\(title) type", options: model.catalog.list("diffusionFamilies"), value: p.string(family),
                          onChange: model.busy ? nil : { value in
                              var patch: JSON = [family: value, enabledBy: true]
                              if (p.double(strength) ?? 0) <= 0 { patch[strength] = 0.5 }
                              fields(patch)
                          })
                HStack(spacing: 8) {
                    DetailSlider(value: p.double(strength) ?? 0,
                                 range: (range.double("min") ?? 0)...(range.double("max") ?? 2),
                                 step: range.double("step") ?? 0.125, label: "\(title) strength", enabled: enabled,
                                 onStart: model.beginGesture, onEnd: { Task { await model.endGesture() } },
                                 onChange: { fields([strength: $0]) },
                                 onReset: { fields([strength: tool["defaultStrength"] ?? 0]) })
                    Text(tool.string("strengthText") ?? "").font(.system(size: 15, weight: .semibold)).monospacedDigit()
                }
                if tool["note"] != nil { note(tool.string("note")) }
            }
        case "lens":
            LensCard(tool: tool, model: model)
        default: // toggle, locked
            if tool["note"] != nil { note(tool.string("note"), size: 15) }
        }
    }
}

/// Depth state, model download, focus hint and depth of field (LensCard).
struct LensCard: View {
    let tool: JSON
    @Bindable var model: EditorModel
    private func foot(_ text: String) -> some View {
        Text(text).font(.system(size: 13)).foregroundStyle(Color.secondaryText)
    }
    var body: some View {
        if !model.params.bool("lensBlurEnabled") {
            foot(tool.string("note") ?? "")
        } else {
            VStack(alignment: .leading, spacing: 8) {
                switch model.depthState {
                case "needs-download":
                    Text("Lens blur needs a one-time download of the depth model. It stays on this device, and your photos never leave it.")
                        .font(.system(size: 15))
                    CapsuleButton(title: "Download · \(Int((Double(model.depthBytes) / 1_000_000).rounded())) MB") { model.downloadDepth() }
                        .disabled(model.busy)
                case "error":
                    Text("Couldn’t measure depth: \(model.depthError ?? "")").font(.system(size: 15))
                    CapsuleButton(title: "Try Again") { model.downloadDepth() }.disabled(model.busy)
                case "ready":
                    foot("Depth ready · CPU · \(String(format: "%.1f", model.depthSeconds)) s")
                    foot("Drag the focus pin on the photo to focus.")
                default:
                    HStack(spacing: 8) {
                        ProgressView().controlSize(.small)
                        Text("\(model.depthPhase)…").font(.system(size: 15))
                    }
                }
                if let readout = tool.string("readout") { foot(readout).monospacedDigit() }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

/// Long choice list (color spaces) in a sheet.
struct OptionSheet: View {
    let title: String
    let options: [JSON]
    let value: String?
    let onSelect: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        NavigationStack {
            List(options.indices, id: \.self) { i in
                let option = options[i], id = option.string("value") ?? ""
                Button {
                    onSelect(id); dismiss()
                } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(option.string("label") ?? id).foregroundStyle(Color.primary)
                            if let group = option.string("group") { Text(group).font(.footnote).foregroundStyle(Color.secondaryText) }
                        }
                        Spacer()
                        if id == value { Image(systemName: "checkmark").foregroundStyle(Color.signal) }
                    }
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } } }
        }
    }
}

/// The group's tools as a horizontal strip of icon chips (web ToolChips):
/// blue wash when selected, inset ring when edited, lock badge when locked.
struct ToolStrip: View {
    let tools: [JSON]
    let selected: String?
    let params: JSON
    let onSelect: (String) -> Void

    private func dimmed(_ tool: JSON) -> Bool {
        tool["enabled"] as? Bool == false || (tool.string("kind") == "toggle" && !params.bool(tool.string("field") ?? ""))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 2) {
                    ForEach(tools.indices, id: \.self) { i in
                        chip(tools[i]).id(tools[i].string("id"))
                    }
                }
                .padding(.horizontal, 8).padding(.vertical, 4)
            }
            .frame(height: 96)
            .onChange(of: selected) { _, next in withAnimation { proxy.scrollTo(next, anchor: .center) } }
        }
    }

    private func chip(_ tool: JSON) -> some View {
        let id = tool.string("id") ?? "", active = id == selected
        let color: Color = active ? .signal : dimmed(tool) ? Color.secondaryText.opacity(0.5) : .secondaryText
        return Button { onSelect(id) } label: {
            VStack(spacing: 4) {
                ZStack(alignment: .bottomTrailing) {
                    Image(systemName: sfSymbol(tool.string("icon")))
                        .font(.system(size: 19))
                        .foregroundStyle(Color(hex: tool.string("tint")) ?? color)
                        .frame(width: 46, height: 46)
                        .background(RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(active ? Color.signal.opacity(0.18) : Color.chip))
                        .overlay {
                            if tool.bool("modified") {
                                RoundedRectangle(cornerRadius: 14, style: .continuous).strokeBorder(Color.signal.opacity(0.7), lineWidth: 1.5)
                            }
                        }
                    if tool.string("kind") == "locked" {
                        Image(systemName: "lock.fill").font(.system(size: 10)).foregroundStyle(Color.secondaryText).offset(x: 2, y: 2)
                    }
                }
                Text(tool.string("label") ?? "")
                    .font(.system(size: 11)).lineLimit(2).multilineTextAlignment(.center)
                    .foregroundStyle(active ? Color.primary : color)
            }
            .frame(width: 66)
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(tool.string("title") ?? "")
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// Icon-only group tabs with an "edited" dot (web GroupTabs).
struct GroupTabs: View {
    let groups: [JSON]
    @Binding var selected: String
    var body: some View {
        HStack(spacing: 0) {
            ForEach(groups.indices, id: \.self) { i in
                let group = groups[i], id = group.string("id") ?? "", active = id == selected
                Button { withAnimation(.snappy(duration: 0.25)) { selected = id } } label: {
                    Image(systemName: sfSymbol(group.string("icon")))
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(active ? Color.signal : Color.secondaryText)
                        .frame(maxWidth: .infinity).frame(height: 36)
                        .background {
                            if active { Capsule().fill(Color.signal.opacity(0.16)) }
                        }
                        .overlay(alignment: .topTrailing) {
                            if group.bool("modified") { Circle().fill(Color.signal).frame(width: 5, height: 5).offset(x: -10, y: 6) }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(group.string("label") ?? id)
                .accessibilityAddTraits(active ? .isSelected : [])
            }
        }
        .padding(3)
        .background(Capsule().fill(Color.chip))
        .padding(EdgeInsets(top: 8, leading: 12, bottom: 12, trailing: 12))
    }
}
