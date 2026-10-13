import SwiftUI

/// Lossy default, as on the web: no visible artefacts, far smaller than 100.
let defaultQuality = 92

/// Export settings kept between sessions (web export preferences).
struct ExportPreferences: Codable, Equatable {
    var format = "png8"
    var longEdge: Int?
    /// 1..100, lossy formats only.
    var quality = defaultQuality
    var lut = false
    var cubeSize = 33

    static let key = "DichroicExportPreferences"
    static func load() -> ExportPreferences {
        guard let text = UserDefaults.standard.string(forKey: key),
              var p = try? JSONDecoder().decode(ExportPreferences.self, from: Data(text.utf8)) else { return ExportPreferences() }
        if formats[p.format] == nil { p.format = "png8" }
        if ![nil, 2048, 4096, 8192].contains(p.longEdge) { p.longEdge = nil }
        p.quality = min(100, max(1, p.quality))
        if ![17, 33, 65].contains(p.cubeSize) { p.cubeSize = 33 }
        return p
    }
    func save() {
        if let data = try? JSONEncoder().encode(self) { UserDefaults.standard.set(String(decoding: data, as: UTF8.self), forKey: Self.key) }
    }

    /// Name, hint and extension per format (web `FORMAT_INFO`).
    static let formats: [String: (name: String, hint: String, ext: String)] = [
        "png8": ("PNG 8-bit", "Lossless · every pixel as rendered", "png"),
        "png16": ("PNG 16-bit", "Lossless · smooth gradients", "png"),
        "tiff16": ("TIFF 16-bit", "Uncompressed · for further editing", "tif"),
        "jpeg": ("JPEG", "Lossy · smallest widely compatible file", "jpg"),
        "webp": ("WebP", "Lossy · smaller than JPEG at like quality", "webp"),
        "avif": ("AVIF", "Lossy · smallest file, slowest to encode", "avif"),
    ]
    static func lossy(_ format: String) -> Bool { ["jpeg", "webp", "avif"].contains(format) }
}

/// Export, as the web sheet: opening it renders nothing; Develop renders at
/// the chosen size, then the button becomes "Save to Photos · 12.3 MB".
/// Format and quality changes encode again on their own; a new size or bit
/// depth needs Develop again. A LUT builds as soon as it is chosen.
struct ExportSheet: View {
    @Bindable var model: EditorModel
    @Environment(\.dismiss) private var dismiss
    @State private var p = ExportPreferences.load()
    @State private var file: (url: URL, bytes: Int, key: String)?
    @State private var developedFor: String?
    @State private var hasDeveloped = false
    @State private var working = false
    @State private var failure: String?
    @State private var limitedTo: CGSize?
    @State private var ticket = 0
    @State private var running: Task<Void, Never>?
    @State private var reencode: Task<Void, Never>?
    @State private var sharing = false
    @State private var started = Date()

    private var formats: [String] { model.catalog["exportFormats"] as? [String] ?? ["png8", "png16", "tiff16", "jpeg"] }
    private var source: (w: Int, h: Int) { (model.photo?.sourceWidth ?? 1, model.photo?.sourceHeight ?? 1) }

    private struct Detent: Equatable { let edge: Int?; let label: String; let w: Int; let h: Int }
    /// Long-edge detents that really shrink the photo, plus "Source · N".
    private var detents: [Detent] {
        let (w, h) = source, long = max(w, h)
        var out = [2048, 4096, 8192].filter { $0 < long }.map { d in
            Detent(edge: d, label: "\(d)", w: Int((Double(w) * Double(d) / Double(long)).rounded()), h: Int((Double(h) * Double(d) / Double(long)).rounded()))
        }
        out.append(Detent(edge: nil, label: "Source · \(long)", w: w, h: h))
        return out
    }
    private var selected: Detent { detents.first { $0.edge == p.longEdge } ?? detents.last! }
    private var bits: Int { ["png16", "tiff16"].contains(p.format) ? 16 : 8 }
    private var requestKey: String { "\(selected.edge.map(String.init) ?? "source")|\(bits)" }
    private var encodeKey: String {
        p.lut ? "lut|\(p.cubeSize)" : "\(requestKey)|\(p.format)|\(ExportPreferences.lossy(p.format) ? p.quality : 100)"
    }
    private var needsDevelop: Bool { !p.lut && developedFor != requestKey }
    private var ready: Bool { file != nil && file!.key == encodeKey && !working }

    var body: some View {
        let info = ExportPreferences.formats[p.format]!, lossy = ExportPreferences.lossy(p.format)
        let size = file.map { formatBytes($0.bytes) } ?? ""
        let out = model.params.string("outputColorSpace") ?? "sRGB"
        NavigationStack {
            List {
                Section {
                    Picker("Kind", selection: Binding(get: { p.lut ? 1 : 0 }, set: { v in change { p.lut = v == 1 } })) {
                        Text("Image").tag(0)
                        Text("LUT (.cube)").tag(1)
                    }
                    .pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                }
                if !p.lut {
                    Section {
                        ForEach(formats, id: \.self) { f in
                            Button { change { p.format = f } } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(ExportPreferences.formats[f]?.name ?? f).foregroundStyle(Color.primary)
                                        Text(ExportPreferences.formats[f]?.hint ?? "").font(.system(size: 13)).foregroundStyle(Color.secondaryText)
                                    }
                                    Spacer()
                                    if f == p.format { Image(systemName: "checkmark").fontWeight(.semibold).foregroundStyle(Color.signal) }
                                }
                            }
                        }
                    }
                    if lossy {
                        Section {
                            DetailSlider(value: Double(p.quality), range: 1...100, step: 1, label: "Quality",
                                         onEnd: { change {} }, onChange: { p.quality = Int($0) },
                                         onReset: { change { p.quality = defaultQuality } })
                        } header: {
                            HStack { Text("Quality"); Spacer(); Text("\(p.quality) · \(working ? "measuring…" : size.isEmpty ? "—" : size)").monospacedDigit() }
                        } footer: {
                            Text("The size is measured, not estimated: the file is encoded again as the slider settles.")
                        }
                    }
                    Section {
                        if detents.count > 1 {
                            Picker("Long edge", selection: Binding(get: { detents.firstIndex(of: selected) ?? 0 },
                                                                   set: { i in change { p.longEdge = detents[i].edge } })) {
                                ForEach(detents.indices, id: \.self) { Text(detents[$0].label).tag($0) }
                            }
                            .pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                        } else {
                            LabeledContent(selected.label, value: "No smaller sizes")
                        }
                    } header: {
                        HStack { Text("Long edge"); Spacer(); Text("\(selected.w) × \(selected.h) px").monospacedDigit() }
                    } footer: {
                        Text("Grain, halation and diffusion are physical sizes, so a smaller export is developed again at its own pixel pitch rather than resized.")
                    }
                    Section {
                        LabeledContent("Color Space", value: out)
                    } footer: {
                        Text("Embeds the \(out) ICC profile, and the camera EXIF when the original has it. Change the color space in Color › Output.")
                    }
                } else {
                    Section("Cube size") {
                        Picker("Cube size", selection: Binding(get: { p.cubeSize }, set: { v in change { p.cubeSize = v } })) {
                            ForEach([17, 33, 65], id: \.self) { Text("\($0)").tag($0) }
                        }
                        .pickerStyle(.segmented).listRowBackground(Color.clear).listRowInsets(EdgeInsets())
                    }
                    Section {
                        LabeledContent("Converts", value: "\(model.params.string("inputColorSpace") ?? "") → \(out)")
                    }
                    Section {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "info.circle").foregroundStyle(Color.warning)
                            Text("A LUT carries color only. Grain, halation, glare, diffusion, lens blur and sharpening are left out, and film and print exposure are ignored.")
                                .font(.system(size: 15))
                        }
                        .listRowBackground(Color.warning.opacity(0.15))
                    }
                }
            }
            .listStyle(.insetGrouped)
            .safeAreaInset(edge: .bottom) { footer(info: info, lossy: lossy, size: size) }
            .navigationTitle("Export")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear {
            if !formats.contains(p.format) { p.format = "png8" }
            if p.lut { make() }
        }
        .onDisappear {
            reencode?.cancel()
            // Closing abandons pending work, as on the web.
            if working { model.cancelExport() }
            discard()
        }
        .sheet(isPresented: $sharing) {
            if let file { ShareSheet(items: [file.url]) { completed in if completed { shared() } } }
        }
    }

    @ViewBuilder private func footer(info: (name: String, hint: String, ext: String), lossy: Bool, size: String) -> some View {
        let rendering = working && model.progressTotal > 0 && model.progressDone < model.progressTotal
        let steps = [
            "Developing \(selected.w) × \(selected.h) on the GPU"
                + (rendering && model.progressTotal > 1 ? " · tile \(min(max(model.progressDone + 1, 1), model.progressTotal)) of \(model.progressTotal)" : ""),
            "Encoding \(info.name)\(lossy ? " · quality \(p.quality)" : "")",
        ]
        let busy = working || (!needsDevelop && !ready && failure == nil)
        VStack(alignment: .leading, spacing: 4) {
            if let failure {
                Text(failure).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color.danger)
                if let error = model.exportError { Text(error).font(.system(size: 12)).foregroundStyle(Color.secondaryText) }
            }
            if !p.lut && hasDeveloped && !needsDevelop && failure == nil {
                ForEach(0..<2, id: \.self) { i in
                    let done = ready || (i == 0 && working && !rendering && model.progressTotal > 0)
                    let active = working && (i == 0 ? rendering || model.progressTotal == 0 : !rendering && model.progressTotal > 0)
                    HStack(spacing: 6) {
                        Group {
                            if done { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(Color.success) }
                            else if active { ProgressView().controlSize(.mini) }
                            else { Color.clear }
                        }
                        .frame(width: 16, height: 16)
                        Text(steps[i]).font(.system(size: 13)).monospacedDigit()
                            .foregroundStyle(active ? Color.primary : Color.secondaryText)
                    }
                }
            }
            if !p.lut && needsDevelop && failure == nil {
                Text(hasDeveloped ? "The export settings changed. Press Develop to prepare this size." : "Press Develop to prepare your file.")
                    .font(.system(size: 13)).foregroundStyle(Color.secondaryText)
            }
            if ready, let file { Text(file.url.lastPathComponent).font(.system(size: 13)).foregroundStyle(Color.secondaryText).lineLimit(1) }
            primaryButton(busy: !needsDevelop && busy, size: size, rendering: rendering)
                .padding(.top, 6)
        }
        .padding(.horizontal, 20).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
    }

    private func primaryButton(busy: Bool, size: String, rendering: Bool) -> some View {
        let busyLabel = p.lut ? "Building LUT" : rendering || model.progressTotal == 0 ? "Developing" : "Encoding"
        let label = needsDevelop ? "Develop" : "\(p.lut ? "Save" : "Save to Photos")\(size.isEmpty ? "" : " · \(size)")"
        return Button {
            if needsDevelop { develop() } else if ready { sharing = true }
        } label: {
            HStack(spacing: 8) {
                if busy {
                    ProgressView().tint(.white)
                    Text(busyLabel)
                    TimelineView(.periodic(from: started, by: 0.1)) { context in
                        Text(formatElapsed(context.date.timeIntervalSince(started))).font(.system(size: 15)).monospacedDigit()
                            .foregroundStyle(.white.opacity(0.7))
                    }
                } else {
                    Text(label)
                }
            }
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity).frame(height: 50)
            .background(Capsule().fill(Color.signal))
        }
        .buttonStyle(PressStyle())
        .disabled(busy || (!needsDevelop && !ready))
        .opacity(!busy && !needsDevelop && !ready ? 0.5 : 1)
        .onChange(of: busy) { _, now in if now { started = Date() } }
    }

    // MARK: - Work

    private func discard() {
        if let old = file?.url { try? FileManager.default.removeItem(at: old.deletingLastPathComponent()) }
        file = nil
    }

    /// A setting changed: re-encode on its own when the render still fits,
    /// otherwise wait for Develop.
    private func change(_ action: () -> Void) {
        action()
        p.save()
        reencode?.cancel()
        if file?.key == encodeKey { return }
        if p.lut || (!needsDevelop && hasDeveloped) {
            reencode = Task {
                try? await Task.sleep(for: .milliseconds(200))
                if !Task.isCancelled { make() }
            }
        }
    }

    private func develop() {
        hasDeveloped = true
        developedFor = requestKey
        make()
    }

    private func make() {
        ticket += 1
        let ticket = self.ticket, previous = running
        running = Task {
            // A newer request supersedes the running one; wait for it to stop.
            if let previous { model.cancelExport(); await previous.value }
            guard ticket == self.ticket else { return }
            await run(ticket)
        }
    }

    private func run(_ ticket: Int) async {
        let key = encodeKey
        working = true
        failure = nil
        discard()
        let quality = ExportPreferences.lossy(p.format) ? Double(p.format == "avif" ? min(p.quality, 99) : p.quality) / 100 : 1
        let result = await model.export(format: p.format, longEdge: selected.edge, quality: quality, cubeSize: p.lut ? p.cubeSize : nil)
        var actual: CGSize?
        if result != nil && !p.lut { actual = await model.exportSize(longEdge: selected.edge) }
        guard ticket == self.ticket, key == encodeKey else {
            if let result { try? FileManager.default.removeItem(at: result) }
            return
        }
        guard let result else {
            working = false
            if model.exportError != nil {
                failure = p.lut ? "Couldn’t build the LUT. Try a smaller cube size."
                    : "Couldn’t prepare the file. Try a smaller long edge or another format; your edits are kept."
                developedFor = nil
            }
            return
        }
        // `<photo> - <film> on <paper>.<ext>`, in its own folder so the name
        // is free to reuse.
        let stocks = Stocks(catalog: model.catalog, params: model.params)
        let name = p.lut ? stocks.fileName(model.sourceStem, "cube", suffix: "\(p.cubeSize)")
            : stocks.fileName(model.sourceStem, ExportPreferences.formats[p.format]!.ext)
        var url = result
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("DICHROIC-\(UUID().uuidString)")
        if (try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)) != nil {
            let target = folder.appendingPathComponent(name)
            if (try? FileManager.default.moveItem(at: result, to: target)) != nil { url = target }
        }
        let bytes = (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        working = false
        file = (url, bytes, key)
        if let actual, actual.width < CGFloat(selected.w) || actual.height < CGFloat(selected.h) { limitedTo = actual } else { limitedTo = nil }
    }

    private func shared() {
        let recipe = Stocks(catalog: model.catalog, params: model.params).exportRecipe
        let limited = limitedTo.map { " at \(Int($0.width)) × \(Int($0.height)) (memory limit for lens blur or diffusion)" } ?? ""
        dismiss()
        model.showToast("Exported · \(recipe)\(limited)")
    }
}
