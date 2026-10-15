import SwiftUI
import DichroicEngine
import UniformTypeIdentifiers

/// The editor (web Editor.tsx, phone layout): toolbar, photo, and the glass
/// panel with the selected tool, the group's tool strip and the group tabs.
struct EditorView: View {
    @State var model = EditorModel()
    @State var brush = RemovalBrush()
    @State var refineBrush = RemovalBrush(diameter: 40)
    @State var compactScopes = ScopePrefs("compact")
    @State var wideScopes = ScopePrefs("wide")
    @AppStorage("DichroicAppearance") var appearance = "system"

    /// The web editor opens on Film, with these tools first in each group.
    @State var groupId = "film"
    @State var selections: [String: String] = [
        "camera": "cameraWhiteBalanceK", "lens": "lensBlur", "film": "printExposureEv",
        "color": "filterC", "darkroom": "dirCouplersAmount", "texture": "halationAmount",
    ]
    @State var compare = false
    /// Sidebar list (Film or Paper) and the recipe path's reveal (wide layout).
    @State var sidebarTab = "film"
    @State var sidebarReveal = 0
    /// The regular (wide) layout is showing; scopes are kept per layout.
    @State var regularLayout = false
    @State var beforeRemoval = false
    @State var reveal = 0

    // Sheets and dialogs
    @State var chooser = false
    @State var photoPicker = false
    @State var fileImporter = false
    @State var stockSheet = false
    @State var exportSheet = false
    @State var lightbox = false
    @State var discardDialog = false

    var body: some View {
        GeometryReader { geo in
            // Size classes of the web (hooks.ts): regular from 1080 x 560, and
            // a phone held sideways; otherwise compact.
            let phoneLandscape = geo.size.width > geo.size.height && geo.size.height < 560
            let regular = (geo.size.width >= 1080 && geo.size.height >= 560) || phoneLandscape
            let scopes = regular ? wideScopes : compactScopes
            Group {
                if regular && model.photo != nil {

                    wideLayout(scopes: scopes, landscape: phoneLandscape, size: geo.size)
                } else {
                    VStack(spacing: 0) {
                        topBar(wide: false)
                        viewport(scopes: scopes, landscape: phoneLandscape)
                        if model.photo != nil {
                            panel
                                .frame(maxWidth: 560)
                                .glass(24)
                                .padding(.horizontal, 8)
                                .padding(.bottom, 4)
                        }
                    }
                }
            }
            .onAppear { regularLayout = regular }
            .onChange(of: regular) { _, now in regularLayout = now }
        }
        .background(Color(uiColor: .systemBackground).ignoresSafeArea())
        .overlay { if model.openingName != nil { openingCard } }
        .overlay(alignment: .top) { toastView }
        .alert(model.errorTitle, isPresented: Binding(get: { model.error != nil }, set: { if !$0 { model.clearError() } })) {
            Button("OK", role: .cancel) { model.clearError() }
        } message: { Text(model.error ?? "") }
        .confirmationDialog("Open Photo", isPresented: $chooser, titleVisibility: .hidden) {
            Button("Photo Library") { photoPicker = true }
            Button("Choose File") { fileImporter = true }
        }
        .confirmationDialog("Discard your edits to this photo?", isPresented: $discardDialog, titleVisibility: .visible) {
            Button("Discard Edits", role: .destructive) { Task { await model.closePhoto() } }
        }
        .sheet(isPresented: $photoPicker) {
            PhotoPicker { provider in
                photoPicker = false
                if let provider { importProvider(provider) }
            }
            .ignoresSafeArea()
        }
        .fileImporter(isPresented: $fileImporter, allowedContentTypes: [.image, .rawImage, .data]) { result in
            do { open(try PhotoImport.copy(try result.get())) }
            catch { model.fail("Can’t Open This File", error) }
        }
        .sheet(isPresented: $stockSheet) {
            StockSheet(model: model).presentationDetents([.fraction(0.56), .large])
        }
        .sheet(isPresented: $exportSheet) {
            ExportSheet(model: model).presentationDetents([.fraction(0.76), .large])
        }
        .fullScreenCover(isPresented: $lightbox) { PhotoLightbox(model: model) }
        .preferredColorScheme(appearance == "light" ? .light : appearance == "dark" ? .dark : nil)
        .tint(.signal)
        .background(shortcuts)
    }

    // MARK: - Opening

    func importProvider(_ provider: NSItemProvider) {
        Task {
            do { open(try await PhotoImport.copy(provider)) }
            catch { model.fail("Can’t Open This File", error) }
        }
    }

    func open(_ url: URL) {
        Task {
            await model.open(url)
            if model.photo != nil, model.error == nil { PhotoImport.purge(keeping: url) }
        }
    }

    /// "Open Photo…": the same choice iOS gives a web page's file input.
    func openPhoto() { if !model.busy { chooser = true } }

    /// "Close Photo": asks first when anything is edited.
    func closePhoto() {
        if model.edited { discardDialog = true } else { Task { await model.closePhoto() } }
    }

    func startRemoval() {
        brush.clear()
        Task { await model.beginRemoval() }
    }

    /// "Done": leaves Remove Object; the photo sweeps from original to film.
    func doneRemoval() {
        Task {
            await model.finishRemoval(apply: false)
            reveal += 1
            beforeRemoval = false
        }
    }

    func cycleAppearance() {
        let modes = ["system", "light", "dark"]
        appearance = modes[((modes.firstIndex(of: appearance) ?? 0) + 1) % modes.count]
    }

    // MARK: - Toolbar

    var stocks: Stocks { Stocks(catalog: model.catalog, params: model.params) }

    /// "DICHROIC" with a second line, in place of the toolbar buttons.
    func brand(_ line: String) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("gammā").font(.system(size: 17, weight: .bold)).tracking(0.2)
            Text(line).font(.system(size: 12)).foregroundStyle(Color.secondaryText)
        }
        .padding(.horizontal, 8)
    }

    /// The web "⋯" menu, in its order: Remove, Open, Redo and Reset when they
    /// apply, Appearance, Close.
    var moreMenu: some View {
        Menu {
            Button { startRemoval() } label: { Label("Remove Object…", systemImage: "eraser") }
            Button { openPhoto() } label: { Label("Open Photo…", systemImage: "folder") }
            if model.canRedo { Button { Task { await model.redo() } } label: { Label("Redo", systemImage: "arrow.uturn.forward") } }
            if model.edited { Button { model.resetAll() } label: { Label("Reset All Adjustments", systemImage: "arrow.counterclockwise") } }
            Button { cycleAppearance() } label: {
                Label("Appearance: \(appearance.capitalized)",
                      systemImage: appearance == "light" ? "sun.max" : appearance == "dark" ? "moon" : "circle.lefthalf.filled")
            }
            Button { closePhoto() } label: { Label("Close Photo", systemImage: "xmark") }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).foregroundStyle(Color.primary)
                .frame(width: 44, height: 44).contentShape(Circle())
        }
        .glass(22, interactive: true)
        .disabled(model.busy)
        .accessibilityLabel("More")
    }

    /// Phone toolbar (web `.mobile-toolbar`): More, the stock capsule, Undo
    /// and Export; the brand alone with no photo or in Remove Object.
    @ViewBuilder func topBar(wide: Bool) -> some View {
        if model.photo == nil || model.erasing || model.refining {
            HStack {
                brand(model.erasing ? "Original · grading paused" : model.refining ? "Original · Refine Edge" : "Your pocket darkroom")
                Spacer()
            }
            .frame(height: 52).padding(.horizontal, 12)
        } else {
            HStack(spacing: 8) {
                moreMenu
                Button { stockSheet = true } label: {
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(stocks.filmLine).font(.system(size: 15, weight: .semibold)).lineLimit(1)
                            Text(stocks.paperLine).font(.system(size: 12, weight: .medium)).foregroundStyle(Color.secondaryText).lineLimit(1)
                        }
                        Spacer(minLength: 4)
                        Image(systemName: "chevron.up.chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(Color.secondaryText)
                    }
                    .foregroundStyle(Color.primary)
                    .padding(.leading, 14).padding(.trailing, 12).frame(height: 44)
                    .contentShape(Capsule())
                }
                .buttonStyle(PressStyle())
                .glass(22, interactive: true)
                .accessibilityLabel("Stocks: \(stocks.filmLine), \(stocks.paperLine). Change")
                GlassIconButton(symbol: "arrow.uturn.backward", label: "Undo") { Task { await model.undo() } }
                    .disabled(!model.canUndo || model.busy)
                if wide {
                    GlassIconButton(symbol: "arrow.uturn.forward", label: "Redo") { Task { await model.redo() } }
                        .disabled(!model.canRedo || model.busy)
                }
                GlassIconButton(symbol: "square.and.arrow.up", label: "Export", prominent: true, size: 52) { exportSheet = true }
                    .disabled(model.busy)
            }
            .padding(EdgeInsets(top: 4, leading: 12, bottom: 4, trailing: 12))
        }
    }

    // MARK: - Photo

    @ViewBuilder func viewport(scopes: ScopePrefs, landscape: Bool) -> some View {
        if model.photo == nil {
            StartView(regular: false, enabled: !model.loading, onChoose: openPhoto, onDrop: importProvider)
        } else {
            ZStack {
                photoView
                if !model.erasing && !model.refining {
                    VStack {
                        HStack {
                            Spacer()
                            if scopes.open { ScopeOverlay(model: model, prefs: scopes, landscape: landscape).padding(.top, 46).padding(.trailing, 10) }
                        }
                        Spacer()
                        HStack {
                            Spacer()
                            GlassIconButton(symbol: "scope", label: "Scopes", selected: scopes.open) { scopes.update(["open": !scopes.open]) }
                                .padding(12)
                        }
                    }
                }
            }
        }
    }

    var photoView: some View { photoView(compareButton: true) }

    func photoView(compareButton: Bool) -> some View {
        let focusActive = !model.erasing && !model.refining && !model.rendering && groupId == "lens"
            && model.params.bool("lensBlurEnabled") && model.depthState == "ready"
        return PhotoViewport(
            model: model,
            brush: model.erasing ? brush : model.refining ? refineBrush : nil,
            showBrush: model.refining ? !model.refineBusy : !model.removalReady && !model.removing,
            brushColor: model.refining ? Color(red: 120 / 255, green: 200 / 255, blue: 1) : Color(red: 1, green: 0.27, blue: 0.31),
            brushOpacity: model.refining ? 0.5 : 0.45,
            matte: model.refining && model.showMatte ? model.matte : nil,
            showOriginal: (model.erasing && beforeRemoval) || model.refining,
            focus: focusActive ? CGPoint(x: model.params.double("lensFocusX") ?? 0.5, y: model.params.double("lensFocusY") ?? 0.5) : nil,
            reveal: reveal,
            compare: $compare,
            compareButton: compareButton
        ) {
            if !model.erasing && !model.refining { lightbox = true }
        }
    }

    // MARK: - Panel

    /// Tools of the current group, and the one shown: the remembered tool,
    /// else its namesake in this process mode, else the first (Editor.tsx).
    var currentTools: (tools: [JSON], selected: JSON?) {
        let tools = model.groups.first { $0.string("id") == groupId }?.list("tools") ?? []
        let wanted = selections[groupId]
        var selected = tools.first { $0.string("id") == wanted }
        if selected == nil, let wanted {
            var label: String?
            for group in model.catalog.list("groups") { for tool in group.list("tools") where tool.string("id") == wanted { label = tool.string("label") } }
            selected = tools.first { $0.string("label") == label }
        }
        return (tools, selected ?? tools.first)
    }

    @ViewBuilder var panel: some View {
        if model.erasing { removalControls } else if model.refining { refineControls } else { adjustments }
    }

    var adjustments: some View {
        let current = currentTools
        return VStack(spacing: 0) {
            if let tool = current.selected {
                ScrollView {
                    ToolPanel(tool: tool, model: model).id(tool.string("id"))
                }
                .scrollBounceBehavior(.basedOnSize)
                .frame(maxHeight: 220)
                .fixedSize(horizontal: false, vertical: true)
                .animation(.timingCurve(0.22, 1, 0.36, 1, duration: 0.38), value: tool.string("id"))
            }
            ToolStrip(tools: current.tools, selected: current.selected?.string("id"), params: model.params) { id in
                selections[groupId] = id
            }
            .padding(.top, 4)
            GroupTabs(groups: model.groups, selected: $groupId)
        }
    }

    /// Remove Object panel (web RemoveContent controls).
    var removalControls: some View {
        let busy = model.busy, result = model.removalReady, strokes = !brush.isEmpty
        let status = model.removing && !(model.status ?? "").isEmpty ? model.status ?? "" : model.removalStatus
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Remove Object").font(.system(size: 17, weight: .semibold))
                    Text("Original · grading paused").font(.system(size: 12)).foregroundStyle(Color.secondaryText)
                }
                Spacer()
                CapsuleButton(title: "Done", prominent: true) { doneRemoval() }.disabled(busy)
            }
            HStack {
                Text("Brush size").font(.system(size: 13))
                Spacer()
                Text("\(Int(brush.diameter.rounded())) px").font(.system(size: 13)).monospacedDigit().foregroundStyle(Color.secondaryText)
            }
            DetailSlider(value: brush.diameter, range: 8...100, step: 1, label: "Brush size", enabled: !busy && !result,
                         onChange: { brush.diameter = $0 }, onReset: { brush.diameter = 32 })
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    CapsuleButton(title: "Brush", symbol: "eraser", selected: brush.painting) { brush.painting = true }.disabled(busy || result)
                    CapsuleButton(title: "Move", symbol: "arrow.up.and.down.and.arrow.left.and.right", selected: !brush.painting) { brush.painting = false }
                    CapsuleButton(title: "Undo", symbol: "arrow.uturn.backward") { brush.undo() }.disabled(busy || !strokes || result)
                    CapsuleButton(title: "Clear") {
                        brush.clear()
                        if result { Task { await model.restartRemoval() } }
                    }
                    .disabled(busy || (!strokes && !result))
                    if model.canUndoRemoval {
                        CapsuleButton(title: "Undo remove") { Task { await model.undoRemoval() } }.disabled(busy || result)
                    }
                    if result {
                        CapsuleButton(title: beforeRemoval ? "After" : "Before", symbol: "rectangle.split.2x1", selected: beforeRemoval) {
                            beforeRemoval.toggle()
                        }
                        .disabled(busy)
                        CapsuleButton(title: "Apply", prominent: true) {
                            beforeRemoval = false
                            brush.clear()
                            Task { await model.applyRemoval() }
                        }
                        .disabled(busy)
                    } else {
                        CapsuleButton(title: busy ? "Working…" : "Remove", symbol: busy ? "hourglass" : "eraser", prominent: true) {
                            guard let photo = model.photo else { return }
                            let mask = brush.mask(width: photo.width, height: photo.height)
                            Task { await model.previewRemoval(mask: mask.pixels, width: mask.width, height: mask.height) }
                        }
                        .disabled(busy || !strokes)
                    }
                }
                .padding(.vertical, 4)
            }
            Text(status).font(.system(size: 13)).foregroundStyle(Color.secondaryText)
                .accessibilityAddTraits(.updatesFrequently)
            if let error = model.removalError { Text(error).font(.system(size: 13)).foregroundStyle(Color.danger) }
        }
        .padding(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
        .accessibilityHint("Pinch with two fingers to zoom and move. On-device LaMa · first use downloads 62 MB.")
    }

    /// Refine Edge panel (web RefineEdge.tsx): brush the hair edge, ViTMatte
    /// works out the matte, Matte shows it black and white.
    var refineControls: some View {
        let busy = model.refineBusy, strokes = !refineBrush.isEmpty
        let mode = !refineBrush.painting ? "move" : refineBrush.erase ? "erase" : "brush"
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 1) {
                    Text("Refine Edge").font(.system(size: 17, weight: .semibold))
                    Text("Lens blur · hair and fine edges").font(.system(size: 12)).foregroundStyle(Color.secondaryText)
                }
                Spacer()
                CapsuleButton(title: "Done", prominent: true) {
                    refineBrush.clear()
                    model.closeRefine()
                }
                .disabled(busy)
            }
            HStack {
                Text("Brush size").font(.system(size: 13))
                Spacer()
                Text("\(Int(refineBrush.diameter.rounded())) px").font(.system(size: 13)).monospacedDigit().foregroundStyle(Color.secondaryText)
            }
            DetailSlider(value: refineBrush.diameter, range: 8...160, step: 1, label: "Brush size", enabled: !busy,
                         onChange: { refineBrush.diameter = $0 }, onReset: { refineBrush.diameter = 40 })
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    CapsuleButton(title: "Brush", symbol: "eraser", selected: mode == "brush") {
                        refineBrush.painting = true; refineBrush.erase = false
                    }
                    .disabled(busy)
                    CapsuleButton(title: "Erase", selected: mode == "erase") {
                        refineBrush.painting = true; refineBrush.erase = true
                    }
                    .disabled(busy)
                    CapsuleButton(title: "Move", symbol: "arrow.up.and.down.and.arrow.left.and.right", selected: mode == "move") {
                        refineBrush.painting = false
                    }
                    CapsuleButton(title: "Undo", symbol: "arrow.uturn.backward") { refineBrush.undo() }.disabled(busy || !strokes)
                    if model.refined && !strokes {
                        CapsuleButton(title: model.showMatte ? "Photo" : "Matte", selected: model.showMatte) { model.showMatte.toggle() }
                            .disabled(busy)
                    }
                    if model.refined {
                        CapsuleButton(title: "Remove") {
                            refineBrush.clear()
                            Task { await model.clearRefine() }
                        }
                        .disabled(busy)
                    }
                    if model.refineNeedsDownload {
                        CapsuleButton(title: "Download · \(Int((Double(model.matteModel.int("bytes") ?? 0) / 1_000_000).rounded())) MB", prominent: true) {
                            runRefine(allowDownload: true)
                        }
                        .disabled(busy)
                    } else {
                        CapsuleButton(title: busy ? "Working…" : "Refine", symbol: busy ? "hourglass" : "camera.aperture", prominent: true) {
                            runRefine(allowDownload: false)
                        }
                        .disabled(busy || !strokes)
                    }
                }
                .padding(.vertical, 4)
            }
            if model.refineNeedsDownload {
                Text("Refine Edge needs a one-time download of \(model.matteModel.string("name") ?? "the matting model"). It stays on this device; photos never leave it.")
                    .font(.system(size: 13))
            }
            if !model.refineStatus.isEmpty {
                Text(model.refineStatus).font(.system(size: 13)).foregroundStyle(Color.secondaryText).monospacedDigit()
                    .accessibilityAddTraits(.updatesFrequently)
            }
            if let error = model.refineError { Text(error).font(.system(size: 13)).foregroundStyle(Color.danger) }
        }
        .padding(EdgeInsets(top: 12, leading: 16, bottom: 12, trailing: 16))
        .onChange(of: refineBrush.strokes.count) { _, count in if count > 0 { model.showMatte = false } }
        .accessibilityHint("Cover the whole soft edge with the brush: inside the stroke the edge is worked out from the photo, outside it nothing changes. Pinch to zoom.")
    }

    func runRefine(allowDownload: Bool) {
        guard let photo = model.photo else { return }
        // The brush at the preview's resolution, 1 where painted (web canvas, alpha > 32).
        let mask = refineBrush.mask(width: photo.width, height: photo.height, maxEdge: max(photo.width, photo.height), threshold: 32, value: 1)
        Task {
            if await model.refine(mask: mask.pixels, width: mask.width, height: mask.height, allowDownload: allowDownload) {
                refineBrush.clear()
            }
        }
    }

    // MARK: - Overlays

    /// "Opening …" card with the decoder stage (web OpeningCard).
    var openingCard: some View {
        ZStack {
            Color.black.opacity(0.28).ignoresSafeArea()
            // Web OpeningCard: blue spinner, name, stage, Cancel.
            VStack(spacing: 14) {
                ProgressView().controlSize(.large).tint(.signal)
                VStack(spacing: 2) {
                    Text("Opening \(model.openingName ?? "photo")").font(.system(size: 17, weight: .semibold)).lineLimit(1).truncationMode(.tail)
                        .frame(maxWidth: 230)
                    Text(model.status ?? "Reading…").font(.system(size: 15)).foregroundStyle(Color.secondaryText).multilineTextAlignment(.center)
                }
                Button { model.cancelOpening() } label: {
                    Text("Cancel").font(.system(size: 17, weight: .medium)).frame(maxWidth: .infinity).frame(height: 44)
                        .background(Capsule().fill(Color.chip))
                }
                .buttonStyle(PressStyle())
                .keyboardShortcut(.cancelAction)
            }
            .padding(EdgeInsets(top: 24, leading: 16, bottom: 16, trailing: 16))
            .frame(width: 270)
            .glass(14)
            .transition(.scale(scale: 1.1).combined(with: .opacity))
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Opening photo")
        }
        .transition(.opacity)
    }

    /// Top-centre toast pill with a green check (web Toast).
    var toastView: some View {
        Group {
            if let toast = model.toast {
                HStack(spacing: 8) {
                    Image(systemName: "checkmark").font(.system(size: 14, weight: .bold)).foregroundStyle(Color.success)
                    Text(toast).font(.system(size: 15, weight: .medium)).lineLimit(1)
                }
                .padding(.horizontal, 16).frame(height: 40)
                .glass(20)
                .padding(.top, 60)
                .transition(.move(edge: .top).combined(with: .opacity))
                .id(toast)
            }
        }
        .animation(.snappy(duration: 0.22), value: model.toast)
        .allowsHitTesting(false)
    }

    /// Keyboard shortcuts of the web editor (iPad keyboards): ⌘Z, ⇧⌘Z, O,
    /// \, E and V. Ignored in Remove Object.
    var shortcuts: some View {
        let free = !model.erasing && !model.refining && !stockSheet && !exportSheet
        let photo = model.photo != nil
        return Group {
            Button("") { if free && model.canUndo && !model.busy { Task { await model.undo() } } }.keyboardShortcut("z", modifiers: .command)
            Button("") { if free && model.canRedo && !model.busy { Task { await model.redo() } } }.keyboardShortcut("z", modifiers: [.command, .shift])
            Button("") { if free { openPhoto() } }.keyboardShortcut("o", modifiers: [])
            Button("") { if free && photo { compare.toggle() } }.keyboardShortcut("\\", modifiers: [])
            Button("") { if free && photo && !model.busy { exportSheet = true } }.keyboardShortcut("e", modifiers: [])
            Button("") {
                if free && photo { let scopes = regularLayout ? wideScopes : compactScopes; scopes.update(["open": !scopes.open]) }
            }
            .keyboardShortcut("v", modifiers: [])
        }
        .opacity(0)
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}
