import SwiftUI
import DichroicEngine

/// The editor's state. The canonical host owns all photographic parameter
/// rules (`controls`/`patch`); this model serializes edits, coalesces slider
/// samples, keeps one render in flight, and holds undo history (web Editor).
@MainActor @Observable
final class EditorModel {
    let engine = PhotoEngine()

    // Photo and images
    var photo: OpenedPhoto?
    var preview: UIImage?
    var original: UIImage?
    var focusMask: UIImage?
    var detail: DetailTile?
    /// Previews displayed so far; scopes trace each new one.
    var frames = 0

    // Canonical model
    var catalog: JSON = [:]
    var params: JSON = [:]
    var groups: [JSON] = []

    // Activity
    var loading = false
    var exporting = false
    var rendering = false
    var detailRendering = false
    var openingName: String?
    var status: String?
    var progressDone = 0
    var progressTotal = 0
    var error: String?
    var errorTitle = "Something Went Wrong"
    var exportError: String?
    var toast: String?

    /// Name of the opened file without its extension ("photo" when unknown).
    var sourceStem = "photo"
    var fileName: String?

    // Lens blur depth: idle, needs-download, working, ready, error. The model
    // is downloaded only after the user taps Download.
    var depthState = "idle"
    var depthPhase = "Measuring depth"
    var depthError: String?
    var depthBytes = 27_258_801
    var depthSeconds = 0.0
    private var depthAllowed = false
    private var depthStarted: Date?

    // Remove Object
    var erasing = false
    var removing = false
    var removalReady = false
    var removalStatus = ""
    var removalError: String?
    private(set) var removalCursor = 0
    var canUndoRemoval: Bool { removalCursor > 0 }

    // History and scheduling
    private var undoStack: [JSON] = []
    private var redoStack: [JSON] = []
    private var gestureBefore: JSON?
    private var pending: [(key: String, action: String, id: String, value: Any?, history: Bool)] = []
    private var editTask: Task<Void, Never>?
    private var renderTask: Task<Void, Never>?
    private var detailTask: Task<Void, Never>?
    private var revision = 0
    private var rendered = -1
    private var generation = 0
    private var exportCancelled = false
    private var focusQueued: JSON?
    private var focusWorking = false
    private var toastTask: Task<Void, Never>?
    private typealias DetailRequest = (rect: CGRect, edge: Int)
    private var detailQueued: DetailRequest?
    private var detailWish: DetailRequest?
    private var detailAttempt: DetailRequest?
    private var detailHighWater = 0

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }
    var busy: Bool { loading || exporting || removing }
    var currentRevision: Int { revision }

    init() {
        engine.onPreview = { [weak self] image in self?.preview = image }
        engine.onOriginal = { [weak self] image in self?.original = image }
        engine.onFocus = { [weak self] image in self?.focusMask = image }
        engine.onStatus = { [weak self] text, done, total in
            guard let self else { return }
            status = text.isEmpty ? nil : text
            if let total { progressDone = done ?? 0; progressTotal = total }
            depthStatus(text)
        }
    }

    // MARK: - Toast and errors

    /// Toast pill, as on the web: shown for 2.2 s at the top of the editor.
    func showToast(_ text: String) {
        toastTask?.cancel()
        toast = text
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(2200))
            if !Task.isCancelled { self?.toast = nil }
        }
    }

    func clearError() { error = nil; errorTitle = "Something Went Wrong" }

    func fail(_ title: String, _ error: Error) {
        errorTitle = title
        self.error = error.localizedDescription
    }

    private func message(_ error: Error) -> String { error.localizedDescription }

    // MARK: - Depth

    private func depthStatus(_ message: String) {
        guard depthState != "ready" else { return }
        if message.hasPrefix("Preparing depth") {
            depthState = "working"; depthPhase = "Measuring depth"
            if depthStarted == nil { depthStarted = Date() }
        } else if message.hasPrefix("Downloading depth") {
            depthState = "working"; depthPhase = "Downloading the depth model"
        }
    }

    private func resetDepth() { depthState = "idle"; depthError = nil; depthStarted = nil }

    /// Checks the model before lens blur renders; without it, asks first.
    private func checkDepth() {
        guard params.bool("lensBlurEnabled"), depthState != "ready", !depthAllowed else { return }
        let model = engine.depthModel()
        depthBytes = model.bytes
        if model.stored { depthAllowed = true } else { depthState = "needs-download" }
    }

    /// "Download" in the lens card: allows the one-time depth model download.
    func downloadDepth() {
        depthAllowed = true
        depthState = "working"
        depthError = nil
        rendered = -1
        scheduleRender()
    }

    /// Parameters sent to the renderer: lens blur waits for the depth model.
    private var renderParams: JSON {
        var p = params
        if params.bool("lensBlurEnabled") && !depthAllowed { p["lensBlurEnabled"] = false }
        return p
    }

    // MARK: - Defaults and history

    /// This file's defaults: the baseline with the decoder's input settings.
    var defaults: JSON {
        var base = catalog.object("baseline")
        if let photo, params["inputColorSpace"] != nil {
            base["inputColorSpace"] = photo.inputColorSpace
            base["inputCctfDecoding"] = photo.encoding == "encoded"
            base["autoExposure"] = photo.encoding == "linear"
        }
        return base
    }

    /// Any setting differs from this file's defaults (web `isEdited`).
    var edited: Bool {
        guard photo != nil else { return false }
        let base = defaults
        return params.contains { key, value in base[key] != nil && !jsonEqual(base[key], value) } || removalCursor > 0
    }

    private func snapshot() -> JSON {
        var s = params
        s["_retouchCursor"] = removalCursor
        return s
    }

    private func pushUndo(_ before: JSON) {
        undoStack.append(before)
        redoStack.removeAll()
        if undoStack.count > 80 { undoStack.removeFirst() }
    }

    func beginGesture() { if gestureBefore == nil { gestureBefore = snapshot() } }

    func endGesture() async {
        await editTask?.value
        let before = gestureBefore
        gestureBefore = nil
        if let before, !jsonEqual(before, snapshot()) { pushUndo(before) }
    }

    private func refreshControls() async throws {
        let aspect = photo.map { $0.height == 0 ? 1.5 : Double($0.width) / Double($0.height) } ?? 1.5
        var request = params
        request["viewAspect"] = aspect
        groups = try await engine.controls(request)
    }

    private func settle() async {
        await editTask?.value
        await renderTask?.value
        await detailTask?.value
    }

    // MARK: - Open and close

    func open(_ url: URL) async {
        guard !busy else { return }
        loading = true
        openingName = stemOf(url)
        error = nil
        generation += 1
        let generation = generation
        defer { loading = false; openingName = nil }
        do {
            await settle()
            pending.removeAll()
            if catalog.isEmpty { catalog = try await engine.catalog() }
            let next = try await engine.open(url)
            guard generation == self.generation else { return }
            photo = next
            sourceStem = stemOf(url)
            fileName = url.pathExtension.isEmpty ? sourceStem : "\(sourceStem).\(url.pathExtension)"
            // As on the web: film, paper, adjustments and lens settings carry
            // over to the next photo; input color space, auto exposure and the
            // focus point belong to the file.
            if params.isEmpty { params = catalog.object("baseline") }
            if params["inputColorSpace"] != nil {
                params["inputColorSpace"] = next.inputColorSpace
                params["inputCctfDecoding"] = next.encoding == "encoded"
                params["autoExposure"] = next.encoding == "linear"
            }
            if params["lensFocusX"] != nil { params["lensFocusX"] = 0.5; params["lensFocusY"] = 0.5 }
            resetDepth()
            undoStack.removeAll(); redoStack.removeAll(); gestureBefore = nil
            removalCursor = 0
            resetDetail()
            erasing = false; removalReady = false
            revision += 1
            rendered = -1
            try await refreshControls()
        } catch {
            fail("Can’t Open “\(stemOf(url))”", error)
            return
        }
        loading = false
        checkDepth()
        scheduleRender()
    }

    /// Closes the photo and releases the renderer (web "Close Photo"). The
    /// look stays for the next photo.
    func closePhoto() async {
        guard !busy, photo != nil else { return }
        loading = true
        await settle()
        await engine.close()
        photo = nil; preview = nil; original = nil; focusMask = nil
        groups = []; fileName = nil
        undoStack.removeAll(); redoStack.removeAll(); gestureBefore = nil
        removalCursor = 0; erasing = false; removalReady = false
        resetDetail()
        status = nil
        resetDepth()
        revision += 1; rendered = -1
        loading = false
    }

    // MARK: - Edits

    /// Queues one control action; each tool keeps its newest value.
    func edit(_ action: String, _ id: String, _ value: Any?) {
        guard photo != nil, !busy, !erasing else { return }
        let key = "\(action):\(id)"
        let entry = (key: key, action: action, id: id, value: value, history: gestureBefore == nil)
        if let index = pending.firstIndex(where: { $0.key == key }) { pending[index] = entry } else { pending.append(entry) }
        if editTask == nil { editTask = Task { await drainEdits() } }
    }

    private func drainEdits() async {
        defer { editTask = nil; scheduleDetail() }
        do {
            while !pending.isEmpty {
                let edit = pending.removeFirst()
                let before = snapshot()
                let next = try await engine.patch(params, action: edit.action, id: edit.id, value: edit.value)
                guard !jsonEqual(next, params) else { continue }
                if edit.history { pushUndo(before) }
                let lensOn = next.bool("lensBlurEnabled") && !params.bool("lensBlurEnabled")
                params = next
                revision += 1
                invalidateDetail()
                error = nil
                if lensOn { checkDepth() }
                try await refreshControls()
                scheduleRender()
            }
        } catch {
            pending.removeAll()
            self.error = message(error)
        }
    }

    func undo() async { await history(fromUndo: true) }
    func redo() async { await history(fromUndo: false) }

    private func history(fromUndo: Bool) async {
        guard !busy, !erasing else { return }
        loading = true
        error = nil
        defer { loading = false; scheduleRender() }
        await settle()
        guard let target = fromUndo ? undoStack.last : redoStack.last else { return }
        let before = snapshot()
        do {
            try await restore(target)
            if fromUndo { undoStack.removeLast(); redoStack.append(before) }
            else { redoStack.removeLast(); undoStack.append(before) }
            revision += 1
            try await refreshControls()
        } catch { self.error = message(error) }
    }

    private func restore(_ snapshot: JSON) async throws {
        var restored = snapshot
        let cursor = restored.removeValue(forKey: "_retouchCursor") as? Int ?? 0
        if removalCursor != cursor {
            try await engine.restoreRemoval(cursor)
            removalCursor = cursor
            resetDepth()
        }
        params = restored
        invalidateDetail()
    }

    func resetAll() {
        guard let photo else { return }
        var base = catalog.object("baseline")
        if params["inputColorSpace"] != nil {
            base["inputColorSpace"] = photo.inputColorSpace
            base["inputCctfDecoding"] = photo.encoding == "encoded"
            base["autoExposure"] = photo.encoding == "linear"
        }
        edit("fields", "all", base)
    }

    // MARK: - Render

    private func scheduleRender() {
        guard !busy, !erasing, !rendering, !detailRendering, renderTask == nil else { return }
        renderTask = Task { await drainRender() }
    }

    private func drainRender() async {
        rendering = true
        defer { rendering = false; renderTask = nil; scheduleDetail() }
        while !busy && !erasing && photo != nil && rendered != revision {
            let revision = revision
            let depth = params.bool("lensBlurEnabled") && depthAllowed
            do {
                try await engine.develop(renderParams)
            } catch {
                if depth && depthState != "ready" { depthState = "error"; depthError = message(error) }
                self.error = message(error)
                return
            }
            if depth && depthState != "ready" {
                depthState = "ready"
                depthSeconds = depthStarted.map { Date().timeIntervalSince($0) } ?? 0
            }
            rendered = revision
            frames += 1
        }
    }

    // MARK: - Lens focus

    func previewFocus(_ point: CGPoint) async {
        var next = params
        next["lensFocusX"] = Double(point.x); next["lensFocusY"] = Double(point.y)
        focusQueued = next
        guard !focusWorking else { return }
        focusWorking = true
        defer { focusWorking = false }
        while let queued = focusQueued {
            focusQueued = nil
            do { try await engine.focusPreview(queued) } catch { self.error = message(error); return }
        }
    }

    func commitFocus(_ point: CGPoint) async {
        edit("fields", "focus", ["lensFocusX": Double(point.x), "lensFocusY": Double(point.y)])
        await endGesture()
    }

    // MARK: - Zoom detail

    private func resetDetail() {
        detail = nil; detailQueued = nil; detailWish = nil; detailAttempt = nil; detailHighWater = 0
    }

    private func invalidateDetail() {
        detail = nil
        detailAttempt = nil
        detailQueued = detailWish
    }

    private static func contains(_ outer: CGRect, _ inner: CGRect) -> Bool {
        outer.minX <= inner.minX + 1e-6 && outer.minY <= inner.minY + 1e-6
            && outer.maxX >= inner.maxX - 1e-6 && outer.maxY >= inner.maxY - 1e-6
    }

    /// Full resolution for the zoomed area (normalized rect, long edge in px).
    func requestDetail(_ rect: CGRect, longEdge: Int) {
        guard let photo, !busy, !erasing, !rect.isEmpty else { return }
        let edge = min(max(longEdge, 1), max(photo.sourceWidth, photo.sourceHeight))
        guard edge > 1600 else { return }
        if edge < detailHighWater, detail != nil, let cached = detailAttempt?.rect, Self.contains(rect, cached) {
            // Pure zoom-out keeps the current high-resolution overlay.
            return
        }
        detailHighWater = max(detailHighWater, edge)
        if let attempt = detailAttempt, attempt.edge >= detailHighWater, Self.contains(attempt.rect, rect) { return }
        detailWish = (rect, detailHighWater)
        detailQueued = detailWish
        scheduleDetail()
    }

    private func scheduleDetail() {
        guard !busy, !erasing, !rendering, !detailRendering, editTask == nil, detailQueued != nil, rendered == revision else { return }
        detailTask = Task { await renderDetail() }
    }

    private func renderDetail() async {
        guard let request = detailQueued else { return }
        detailQueued = nil
        let revision = revision
        detailRendering = true
        defer {
            detailRendering = false
            detailTask = nil
            if rendered != self.revision { scheduleRender() }
            scheduleDetail()
        }
        do {
            let tile = try await engine.detail(params, rect: request.rect, longEdge: request.edge)
            if revision == self.revision { detail = tile; detailAttempt = request }
        } catch {
            self.error = message(error)
            detailAttempt = request
        }
    }

    // MARK: - Remove Object

    func beginRemoval() async {
        guard !busy, !erasing, photo != nil else { return }
        loading = true
        error = nil
        defer { loading = false }
        await settle()
        do {
            try await engine.beginRemoval()
            detail = nil; detailQueued = nil
            erasing = true
            removalReady = false
            removalStatus = "Brush over the object, then choose Remove."
            removalError = nil
        } catch { self.error = message(error) }
    }

    func previewRemoval(mask: Data, width: Int, height: Int) async {
        guard !busy, erasing else { return }
        removing = true
        removalError = nil
        removalStatus = "Preparing the selected area…"
        removalReady = false
        defer { removing = false }
        do {
            try await engine.previewRemoval(mask: mask, width: width, height: height)
            removalReady = true
            removalStatus = "Preview ready. Apply to keep this removal."
        } catch { removalError = message(error) }
    }

    func finishRemoval(apply: Bool) async {
        guard !busy, erasing, !apply || removalReady else { return }
        removing = true
        do {
            if apply {
                let before = snapshot()
                removalCursor = try await engine.applyRemoval()
                resetDepth()
                pushUndo(before)
                revision += 1
            } else {
                try await engine.cancelRemoval()
            }
            erasing = false
            removalReady = false
            invalidateDetail()
            rendered = -1
        } catch { self.error = message(error) }
        removing = false
        scheduleRender()
    }

    /// Apply keeps the previewed removal and stays in Remove Object.
    func applyRemoval() async {
        guard !busy, erasing, removalReady else { return }
        removalStatus = "Applying removal…"
        removalError = nil
        await finishRemoval(apply: true)
        await renderTask?.value
        await beginRemoval()
        removalStatus = "Applied. Film and export use the retouched photo."
    }

    /// "Undo remove": steps back over the last applied removal.
    func undoRemoval() async {
        guard !busy, erasing, !removalReady, canUndoRemoval else { return }
        removing = true
        removalStatus = "Undoing removal…"
        removalError = nil
        defer { removing = false }
        do {
            try await engine.cancelRemoval()
            let before = snapshot()
            try await engine.restoreRemoval(removalCursor - 1)
            removalCursor -= 1
            resetDepth()
            pushUndo(before)
            revision += 1
            rendered = -1
            try await engine.beginRemoval()
            removalStatus = "Removal undone."
        } catch { removalError = message(error) }
    }

    func restartRemoval() async {
        guard !busy, erasing else { return }
        removing = true
        defer { removing = false }
        do {
            try await engine.cancelRemoval()
            try await engine.beginRemoval()
            removalReady = false
            removalStatus = "Brush over the object, then choose Remove."
        } catch { removalError = message(error) }
    }

    // MARK: - Export

    func export(format: String = "png8", longEdge: Int? = nil, quality: Double = 1, cubeSize: Int? = nil) async -> URL? {
        guard photo != nil, !busy, !erasing else { return nil }
        exporting = true
        exportCancelled = false
        exportError = nil
        progressDone = 0; progressTotal = 0
        defer {
            status = nil
            exporting = false
            if rendered != revision { scheduleRender() }
        }
        await settle()
        if exportCancelled { return nil }
        do {
            if let cubeSize { return try await engine.exportCube(renderParams, size: cubeSize) }
            return try await engine.export(renderParams, format: format, longEdge: longEdge, quality: quality)
        } catch {
            // Shown inside the export sheet, as on the web; never an alert.
            if !exportCancelled { exportError = message(error) }
            return nil
        }
    }

    func exportSize(longEdge: Int?) async -> CGSize? {
        try? await engine.exportSize(params, longEdge: longEdge)
    }

    func cancelExport() {
        guard exporting else { return }
        exportCancelled = true
        status = "Stopping…"
        engine.cancelExport()
    }
}
