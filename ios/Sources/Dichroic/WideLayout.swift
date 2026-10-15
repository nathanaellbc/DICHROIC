import SwiftUI

/// Regular layout (web `WideLayout`): iPad, and a phone held sideways. A
/// toolbar across the top, the Film/Paper source list on the left, the photo
/// with a status bar in the middle, and the parameter inspector (or Remove
/// Object / Refine Edge controls) on the right.
extension EditorView {
    func wideLayout(scopes: ScopePrefs, landscape: Bool, size: CGSize) -> some View {
        // Web panel widths (styles.css: narrower on a phone held sideways).
        let sidebar: CGFloat = landscape ? 200 : 260, inspector: CGFloat = landscape ? 264 : 300
        let removing = model.erasing || model.refining
        return VStack(spacing: 0) {
            wideToolbar(scopes: scopes)
                .frame(height: 52)
                .background(.bar)
                .overlay(alignment: .bottom) { Divider() }
            HStack(spacing: 0) {
                StockSidebar(model: model, tab: $sidebarTab, reveal: sidebarReveal)
                    .frame(width: sidebar)
                    .background(.bar)
                    .overlay(alignment: .trailing) { Divider() }
                    .disabled(removing)
                    .opacity(removing ? 0.45 : 1)
                VStack(spacing: 0) {
                    photoView(compareButton: false)
                    statusBar
                }
                wideInspector(scopes: scopes, width: inspector, windowHeight: size.height)
                    .frame(width: inspector)
                    .background(.bar)
                    .overlay(alignment: .leading) { Divider() }
            }
        }
    }

    /// Web `.window-toolbar`.
    @ViewBuilder private func wideToolbar(scopes: ScopePrefs) -> some View {
        HStack(spacing: 4) {
            if model.erasing || model.refining {
                Text(model.erasing ? "Remove Object" : "Refine Edge").font(.system(size: 17, weight: .semibold))
                Text("Original · grading paused").font(.system(size: 13)).foregroundStyle(Color.secondaryText)
                Spacer()
            } else {
                HStack(alignment: .firstTextBaseline, spacing: 10) {
                    Text("gammā").font(.system(size: 15, weight: .bold)).tracking(0.2)
                    Text(model.fileName ?? "No photo").font(.system(size: 13)).foregroundStyle(Color.secondaryText).lineLimit(1).truncationMode(.tail)
                }
                .frame(minWidth: 120, maxWidth: 380, alignment: .leading)
                .fixedSize(horizontal: false, vertical: true)
                toolbarButton("folder", "Open Photo") { openPhoto() }
                toolbarButton("xmark", "Close Photo") { closePhoto() }.disabled(model.photo == nil)
                Spacer(minLength: 8)
                recipePath
                Spacer(minLength: 8)
                toolbarButton("arrow.uturn.backward", "Undo") { Task { await model.undo() } }.disabled(!model.canUndo || model.busy)
                toolbarButton("arrow.uturn.forward", "Redo") { Task { await model.redo() } }.disabled(!model.canRedo || model.busy)
                Divider().frame(height: 20).padding(.horizontal, 4)
                toolbarButton("rectangle.split.2x1", "Before / After", selected: compare) { compare.toggle() }.disabled(model.photo == nil)
                toolbarButton("scope", "Scopes", selected: scopes.open) { scopes.update(["open": !scopes.open]) }.disabled(model.photo == nil)
                toolbarButton("eraser", "Remove Object") { startRemoval() }.disabled(model.photo == nil || model.busy)
                toolbarButton(appearance == "light" ? "sun.max" : appearance == "dark" ? "moon" : "circle.lefthalf.filled",
                              "Appearance: \(appearance.capitalized)") { cycleAppearance() }
                Button { exportSheet = true } label: {
                    HStack(spacing: 5) {
                        Image(systemName: "square.and.arrow.up").font(.system(size: 13, weight: .semibold))
                        Text("Export").font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(.white)
                    .padding(.horizontal, 14).frame(height: 32)
                    .background(Capsule().fill(Color.signal))
                }
                .buttonStyle(PressStyle())
                .disabled(model.photo == nil || model.busy)
                .padding(.leading, 6)
            }
        }
        .padding(.horizontal, 12)
    }

    private func toolbarButton(_ symbol: String, _ label: String, selected: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 16, weight: .medium))
                .foregroundStyle(selected ? Color.signal : Color.primary)
                .frame(width: 34, height: 32)
                .background { if selected { RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.signal.opacity(0.16)) } }
                .contentShape(Rectangle())
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// "Portra 400 › Portra Endura": each part shows its list (web RecipePath).
    @ViewBuilder private var recipePath: some View {
        if model.photo != nil {
            let s = stocks
            let film = s.filmEnabled ? s.info("film", model.params.string("film")).string("name") ?? "" : "Film Off"
            let paper = !s.filmEnabled && !Stocks.isPrintLut(model.params.string("paper")) ? "Neutral negative"
                : s.scan ? "Scanned" : s.info("paper", model.params.string("paper")).string("name") ?? ""
            HStack(spacing: 4) {
                Button(film) { sidebarTab = "film"; sidebarReveal += 1 }
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.primary)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .bold)).foregroundStyle(Color.secondaryText)
                Button(paper) { sidebarTab = "paper"; sidebarReveal += 1 }
                    .font(.system(size: 13)).foregroundStyle(Color.secondaryText)
            }
            .lineLimit(1)
            .padding(.horizontal, 12).frame(height: 28)
            .background(Capsule().fill(Color.chip))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Recipe")
        }
    }

    /// Web `.status-bar`.
    private var statusBar: some View {
        HStack(spacing: 6) {
            if let preview = model.preview {
                Text("Preview \(Int(preview.size.width * preview.scale)) × \(Int(preview.size.height * preview.scale))").monospacedDigit()
            } else {
                Text("No photo open")
            }
            Text("·").foregroundStyle(.tertiary)
            let output = model.params.string("outputColorSpace") ?? "sRGB"
            Text(model.erasing || model.refining ? "Original · grading paused"
                 : output + (["sRGB", "Display P3"].contains(output) ? "" : ", shown without conversion"))
            if !(model.erasing || model.refining) && model.rendering && model.photo != nil {
                Text("·").foregroundStyle(.tertiary)
                Text("Developing…").foregroundStyle(Color.signal)
            }
            Spacer()
            Text("Developed on this device")
        }
        .font(.system(size: 11))
        .foregroundStyle(Color.secondaryText)
        .lineLimit(1)
        .padding(.horizontal, 12)
        .frame(height: 28)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    /// Web inspector: group tabs, the group's tools as rows, scopes, Reset All.
    @ViewBuilder private func wideInspector(scopes: ScopePrefs, width: CGFloat, windowHeight: CGFloat) -> some View {
        if model.erasing {
            ScrollView { removalControls }
        } else if model.refining {
            ScrollView { refineControls }
        } else {
            VStack(spacing: 0) {
                GroupTabs(groups: model.groups, selected: $groupId)
                    .overlay(alignment: .bottom) { Divider() }
                ScrollView {
                    let group = model.groups.first { $0.string("id") == groupId } ?? [:]
                    let tools = group.list("tools")
                    VStack(alignment: .leading, spacing: 0) {
                        Text(group.string("label") ?? "").font(.system(size: 17, weight: .semibold))
                            .padding(EdgeInsets(top: 12, leading: 12, bottom: 6, trailing: 12))
                        if groupId == "camera" {
                            Text("Before film · WB relative to the decoded image.").font(.system(size: 13)).foregroundStyle(Color.secondaryText)
                                .padding(.horizontal, 12).padding(.bottom, 4)
                        }
                        ForEach(tools.indices, id: \.self) { i in
                            let tool = tools[i]
                            if let section = tool.string("section"), section != (i > 0 ? tools[i - 1].string("section") : nil) {
                                HStack {
                                    Text(section).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.secondaryText)
                                    Spacer()
                                    if section == "White Balance" {
                                        CapsuleButton(title: "Reset WB") {
                                            model.edit("fields", "wb", ["cameraWhiteBalanceK": model.defaults["cameraWhiteBalanceK"] ?? 6500,
                                                                         "cameraTint": model.defaults["cameraTint"] ?? 0])
                                        }
                                    }
                                }
                                .padding(EdgeInsets(top: 12, leading: 12, bottom: 2, trailing: 12))
                            }
                            InspectorTool(tool: tool, model: model)
                        }
                    }
                    .padding(.bottom, 12)
                    .id(groupId)
                    .transition(.opacity)
                }
                .animation(.easeOut(duration: 0.14), value: groupId)
                if model.photo != nil && scopes.open {
                    ScopePanel(model: model, prefs: scopes, width: width - 24, windowHeight: windowHeight)
                        .padding(.horizontal, 8).padding(.bottom, 8)
                }
                HStack {
                    Spacer()
                    CapsuleButton(title: "Reset All") { model.resetAll() }.disabled(!model.edited || model.busy)
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                .overlay(alignment: .top) { Divider() }
            }
        }
    }
}

/// One inspector row (web `InspectorTool`): title with tint, edited dot and
/// lock; value, reset, stepper buttons, short choices and switch; then the
/// control.
struct InspectorTool: View {
    let tool: JSON
    @Bindable var model: EditorModel
    @State private var optionSheet = false

    private var id: String { tool.string("id") ?? "" }
    private var kind: String { tool.string("kind") ?? "" }
    private var title: String { tool.string("title") ?? "" }
    private var enabled: Bool { !model.busy && (tool["enabled"] as? Bool ?? true) }

    var body: some View {
        let p = model.params
        let switchField = (kind == "toggle" || kind == "lens") ? tool.string("field") : tool.string("enabledBy")
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                HStack(spacing: 7) {
                    if let tint = Color(hex: tool.string("tint")) { RoundedRectangle(cornerRadius: 2).fill(tint).frame(width: 7, height: 7) }
                    Text(title).font(.system(size: 15, weight: .medium)).lineLimit(1)
                    if tool.bool("modified") { Circle().fill(Color.signal).frame(width: 5, height: 5).accessibilityLabel("edited") }
                    if kind == "locked" { Image(systemName: "lock").font(.system(size: 11)) }
                }
                Spacer(minLength: 4)
                if kind == "stepper" || kind == "slider" {
                    Text(tool.string("valueText") ?? "").font(.system(size: 15)).monospacedDigit().foregroundStyle(Color.secondaryText).lineLimit(1)
                }
                if kind == "diffusion" {
                    Text(tool.string("strengthText") ?? "").font(.system(size: 15)).monospacedDigit().foregroundStyle(Color.secondaryText)
                }
                if tool.bool("resettable") {
                    Button { model.edit("reset", id, nil) } label: {
                        Image(systemName: "arrow.counterclockwise").font(.system(size: 12, weight: .semibold)).frame(width: 24, height: 24)
                    }
                    .buttonStyle(PressStyle()).disabled(model.busy).accessibilityLabel("Reset \(title)")
                }
                if kind == "stepper" {
                    if tool.string("field") == "grainSeed" {
                        stepButton("shuffle", "Random grain pattern") { model.edit("fields", id, ["grainSeed": Int.random(in: 1...9999)]) }
                            .disabled(!enabled)
                    }
                    stepButton("minus", "Decrease \(title)") { model.edit("step", id, -1) }.disabled(!enabled || tool.bool("atMin"))
                    stepButton("plus", "Increase \(title)") { model.edit("step", id, 1) }.disabled(!enabled || tool.bool("atMax"))
                }
                if kind == "choice" && tool.list("options").count <= 10 {
                    Menu {
                        Picker(title, selection: Binding(get: { p.string(tool.string("field") ?? "") ?? "" }, set: { model.edit("choice", id, $0) })) {
                            ForEach(tool.list("options").indices, id: \.self) { i in
                                let option = tool.list("options")[i]
                                Text(option.string("label") ?? "").tag(option.string("value") ?? "")
                            }
                        }
                    } label: {
                        HStack(spacing: 3) {
                            Text(tool.string("valueText") ?? "").lineLimit(1)
                            Image(systemName: "chevron.up.chevron.down").font(.system(size: 9, weight: .bold))
                        }
                        .font(.system(size: 13, weight: .medium))
                        .padding(.horizontal, 8).frame(height: 24)
                        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.chip))
                    }
                    .disabled(!enabled)
                    .accessibilityLabel(title)
                }
                if let switchField {
                    Toggle(title, isOn: Binding(get: { p.bool(switchField) }, set: { on in
                        var patch: JSON = [switchField: on]
                        if on, kind == "diffusion", let strength = tool.string("strengthField"), (p.double(strength) ?? 0) <= 0 { patch[strength] = 0.5 }
                        model.edit("fields", id, patch)
                    }))
                    .labelsHidden().tint(.signal).controlSize(.mini)
                    .disabled(model.busy || (kind == "toggle" && tool.string("field") == "inputCctfDecoding" && !enabled))
                }
            }
            .frame(minHeight: 22)
            control(p)
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
        .opacity(kind == "locked" ? 0.55 : 1)
        .sheet(isPresented: $optionSheet) {
            OptionSheet(title: title, options: tool.list("options"), value: p.string(tool.string("field") ?? "")) { model.edit("choice", id, $0) }
                .presentationDetents([.medium, .large])
        }
    }

    /// Web `ToolControl` dense.
    @ViewBuilder private func control(_ p: JSON) -> some View {
        let note = { (text: String?) in Text(text ?? "").font(.system(size: 12)).foregroundStyle(Color.secondaryText) }
        switch kind {
        case "slider":
            let range = tool.object("range")
            DetailSlider(value: tool.double("position") ?? 0, range: (range.double("min") ?? 0)...(range.double("max") ?? 1),
                         step: range.double("step") ?? 0, label: title, enabled: enabled,
                         onStart: model.beginGesture, onEnd: { Task { await model.endGesture() } },
                         onChange: { model.edit("position", id, $0) },
                         onReset: tool.double("defaultPosition").map { position -> () -> Void in { model.edit("position", id, position) } })
            if tool["note"] != nil && tool["section"] == nil { note(tool.string("note")) }
        case "stepper":
            if tool["hint"] != nil { note(tool.string("hint")) }
        case "choice":
            if tool.list("options").count > 10 {
                Button { optionSheet = true } label: {
                    HStack {
                        Text(tool.string("valueText") ?? "").font(.system(size: 15, weight: .medium)).lineLimit(1)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 13, weight: .semibold))
                    }
                    .padding(.horizontal, 12).frame(height: 32)
                    .background(Capsule().fill(Color.chip))
                }
                .buttonStyle(.plain).disabled(!enabled)
                .accessibilityLabel("\(title): \(tool.string("valueText") ?? ""). Change")
            } else if tool["note"] != nil { note(tool.string("note")) }
        case "toggle":
            note(tool.string("field") == "inputCctfDecoding" && !enabled ? "Not available for \(p.string("inputColorSpace") ?? "")." : tool.string("note"))
        case "diffusion":
            let family = tool.string("familyField") ?? "", strength = tool.string("strengthField") ?? "", enabledBy = tool.string("enabledBy") ?? ""
            let range = tool.object("strengthRange")
            OptionRow(label: "\(title) type", options: model.catalog.list("diffusionFamilies"), value: p.string(family),
                      onChange: model.busy ? nil : { value in
                          var patch: JSON = [family: value, enabledBy: true]
                          if (p.double(strength) ?? 0) <= 0 { patch[strength] = 0.5 }
                          model.edit("fields", id, patch)
                      })
            DetailSlider(value: p.double(strength) ?? 0, range: (range.double("min") ?? 0)...(range.double("max") ?? 2),
                         step: range.double("step") ?? 0.125, label: "\(title) strength", enabled: enabled,
                         onStart: model.beginGesture, onEnd: { Task { await model.endGesture() } },
                         onChange: { model.edit("fields", id, [strength: $0]) },
                         onReset: { model.edit("fields", id, [strength: tool["defaultStrength"] ?? 0]) })
        case "lens":
            LensCard(tool: tool, model: model)
        default:
            if tool["note"] != nil { note(tool.string("note")) }
        }
    }

    private func stepButton(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol).font(.system(size: 11, weight: .bold))
                .frame(width: 24, height: 22)
                .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.chip))
        }
        .buttonStyle(PressStyle())
        .accessibilityLabel(label)
    }
}

/// Film & Paper source list in the sidebar (web `StockBrowser` dense): dense
/// rows, the chosen row filled blue, the recipe path reveals the chosen row.
struct StockSidebar: View {
    @Bindable var model: EditorModel
    @Binding var tab: String
    let reveal: Int
    @State private var query = ""

    var body: some View {
        let p = model.params, s = Stocks(catalog: model.catalog, params: p)
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        let chosen = p.string(tab)
        let sections: [(JSON, [JSON])] = model.catalog.list("\(tab)Sections").compactMap { section in
            let stocks = section.list("stocks").filter { q.isEmpty || "\($0.string("name") ?? "") \($0.string("detail") ?? "")".lowercased().contains(q) }
            return stocks.isEmpty ? nil : (section, stocks)
        }
        VStack(spacing: 8) {
            Picker("List", selection: $tab) {
                Text("Film").tag("film")
                Text("Paper").tag("paper")
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 10)
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Process").font(.system(size: 13, weight: .semibold))
                    Text(!s.filmEnabled ? "Neutral negative" : s.scan ? "The film itself" : "Film onto paper")
                        .font(.system(size: 11)).foregroundStyle(Color.secondaryText).lineLimit(1)
                }
                Spacer()
                Picker("Process", selection: Binding(get: { p.string("process") == "scanNegative" ? 1 : 0 },
                                                     set: { model.edit("choice", "process", $0 == 0 ? "printSimulation" : "scanNegative") })) {
                    Text("Print").tag(0)
                    Text("Scan").tag(1)
                }
                .pickerStyle(.segmented).frame(width: 112)
            }
            .padding(.horizontal, 10)
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Color.secondaryText)
                TextField("Search", text: $query).font(.system(size: 13)).textInputAutocapitalization(.never).autocorrectionDisabled()
            }
            .padding(.horizontal, 8).frame(height: 28)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.chip))
            .padding(.horizontal, 10)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 1) {
                        if tab == "film" && q.isEmpty {
                            row(id: "off", name: "Off", meta: "Neutral negative", selected: !s.filmEnabled, disabled: false, locked: false,
                                tooltip: "Off · Neutral negative · controls active") { model.edit("film", "film", "off") }
                        }
                        if sections.isEmpty {
                            Text("No stocks match “\(query)”.").font(.system(size: 13)).foregroundStyle(Color.secondaryText).padding(8)
                        }
                        ForEach(sections.indices, id: \.self) { i in
                            let section = sections[i].0, stocks = sections[i].1
                            let title = section.string("title") ?? "", locked = section.bool("locked")
                            Text(title).font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.secondaryText)
                                .padding(EdgeInsets(top: 10, leading: 8, bottom: 2, trailing: 8))
                            ForEach(stocks.indices, id: \.self) { j in
                                let stock = stocks[j], id = stock.string("id") ?? ""
                                let paperOff = tab == "paper" && (s.scan || !s.filmEnabled || s.isSlide(p.string("film"))) && !Stocks.isPrintLut(id)
                                let selected = !locked && id == chosen && !paperOff && (tab != "film" || s.filmEnabled)
                                let name = (tab == "film" && locked) || !(title == "Kodak" || title == "Fujifilm")
                                    ? stock.string("name") ?? id : stock.string("short") ?? id
                                row(id: id, name: name, meta: (stock.string("detail") ?? "").components(separatedBy: " · ").last ?? "",
                                    selected: selected, disabled: locked || paperOff, locked: locked,
                                    tooltip: "\(stock.string("name") ?? "") · \(stock.string("detail") ?? "")") { model.edit(tab, tab, id) }
                            }
                        }
                    }
                    .padding(.horizontal, 6).padding(.bottom, 16)
                }
                .onChange(of: reveal) { _, _ in
                    query = ""
                    let target = tab == "film" && !s.filmEnabled ? "off" : chosen ?? ""
                    withAnimation(.easeOut(duration: 0.3)) { proxy.scrollTo(target, anchor: .center) }
                }
            }
        }
        .padding(.top, 10)
    }

    private func row(id: String, name: String, meta: String, selected: Bool, disabled: Bool, locked: Bool, tooltip: String,
                     action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text(name).font(.system(size: 13)).lineLimit(1)
                    .foregroundStyle(selected ? Color.white : disabled ? Color.secondaryText.opacity(0.6) : Color.primary)
                Spacer(minLength: 4)
                if locked { Image(systemName: "lock").font(.system(size: 10)).foregroundStyle(Color.secondaryText) }
                else {
                    Text(meta).font(.system(size: 11)).monospacedDigit().lineLimit(1)
                        .foregroundStyle(selected ? Color(red: 0.85, green: 0.9, blue: 1) : Color.secondaryText)
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(selected ? Color(red: 0.04, green: 0.52, blue: 1) : Color.clear))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(disabled)
        .id(id)
        .help(tooltip)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
