import UIKit
import ImageIO
import UniformTypeIdentifiers

/// The opened photo, as the editor sees it.
public struct OpenedPhoto: Equatable, Sendable {
    /// Preview size (long edge 1280).
    public let width: Int
    public let height: Int
    /// Decoded source size (oriented).
    public let sourceWidth: Int
    public let sourceHeight: Int
    /// The decoder's suggestion: input color space and "encoded" or "linear".
    public let inputColorSpace: String
    public let encoding: String
}

/// A full-resolution part of the photo for the zoomed viewport.
public struct DetailTile {
    public let image: UIImage
    public let original: UIImage
    /// Normalized photo rectangle (0..1) that the tile covers.
    public let rect: CGRect
    public let longEdge: Int
}

/// A measured lens blur depth map.
public struct DepthResult: Sendable {
    public let milliseconds: Int
    /// Core ML (GPU/Neural Engine) was requested.
    public let gpu: Bool
    public let model: String
}

public enum EngineError: LocalizedError {
    case message(String)
    case cancelled
    public var errorDescription: String? {
        switch self {
        case .message(let text): return text
        case .cancelled: return "Cancelled"
        }
    }
}

/// Native editor engine: the canonical web host (renderer.js) in
/// JavaScriptCore, the unchanged WGSL on Metal, and LibRaw/ImageIO decoding.
/// All work runs on one serial queue; images are published on the main queue
/// as color-managed `UIImage`s (sRGB or Display P3), composited by UIKit.
public final class PhotoEngine: @unchecked Sendable {
    /// Each new developed preview.
    public var onPreview: ((UIImage) -> Void)?
    /// The untouched original preview (Compare, hold to peek).
    public var onOriginal: ((UIImage) -> Void)?
    /// Lens blur focus overlay; nil clears it.
    public var onFocus: ((UIImage?) -> Void)?
    /// Status line ("Opening photo…") and export tile progress.
    public var onStatus: ((String, Int?, Int?) -> Void)?
    /// Lens blur depth and Refine Edge phases: phase, loaded, total (web `DepthProgress`).
    public var onDepthProgress: ((String, Int, Int) -> Void)?
    /// Refine Edge matte view (grey inside the band, clear outside) and its photo rect (0..1).
    public var onMatte: ((UIImage, CGRect) -> Void)?

    private let queue = DispatchQueue(label: "dichroic.render", qos: .userInitiated)
    private let cancellation = NativeCancellation()
    private let openCancel = NativeCancellation()
    private var graph: NativeGraphRuntime?
    private var photoURL: URL?
    private var preview: PhotoFrame?
    private var memoryObserver: NSObjectProtocol?
    private var cachedExportFormats: [String]?
    private var detailImages: (UIImage, UIImage)?

    public init() {
        memoryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil, queue: .main) { [weak self] _ in
            self?.queue.async { [weak self] in
                self?.preview = nil
                self?.graph?.hibernate()
            }
        }
    }

    deinit {
        if let observer = memoryObserver { NotificationCenter.default.removeObserver(observer) }
    }

    // MARK: - Queue helpers

    private func run<T>(_ work: @escaping () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async { continuation.resume(with: Result { try work() }) }
        }
    }

    /// Work that finishes in a graph completion (`finish` may be called from
    /// any thread, exactly once).
    private func runAsync<T>(_ work: @escaping (@escaping (Result<T, Error>) -> Void) throws -> Void) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                do { try work { continuation.resume(with: $0) } } catch { continuation.resume(throwing: error) }
            }
        }
    }

    private func status(_ text: String, done: Int? = nil, total: Int? = nil) {
        DispatchQueue.main.async { [weak self] in self?.onStatus?(text, done, total) }
    }

    private func graphRuntime() throws -> NativeGraphRuntime {
        if let graph { return graph }
        let graph = try NativeGraphRuntime(queue: queue, cancellation: cancellation)
        graph.onPublish = { [weak self] pixels, width, height, gamut in
            let image = try Self.image(pixels, width: width, height: height, gamut: gamut)
            DispatchQueue.main.async { self?.onPreview?(image) }
        }
        graph.onDetail = { [weak self] rgba, original, width, height, gamut, originalGamut in
            let graded = try Self.image(rgba, width: width, height: height, gamut: gamut)
            let untouched = try Self.image(original, width: width, height: height, gamut: originalGamut)
            self?.detailImages = (graded, untouched)
        }
        graph.onOriginal = { [weak self] rgba, width, height, gamut in
            let image = try Self.image(rgba, width: width, height: height, gamut: gamut)
            self?.preview = PhotoFrame(width: width, height: height, rgba: rgba)
            DispatchQueue.main.async {
                self?.onOriginal?(image)
                self?.onPreview?(image)
            }
        }
        graph.onProgress = { [weak self] done, total in self?.status("Developing…", done: done, total: total) }
        graph.onDepthProgress = { [weak self] phase, loaded, total in
            DispatchQueue.main.async { self?.onDepthProgress?(phase, loaded, total) }
        }
        graph.onnx.onDownload = { [weak self] loaded, total in
            DispatchQueue.main.async { self?.onDepthProgress?("model", loaded, total) }
        }
        graph.onMatte = { [weak self] rgba, meta in
            // Straight alpha (grey, opaque inside the band) is premultiplied as is.
            let image = try Self.image(rgba, width: Int(meta["width"] ?? 0), height: Int(meta["height"] ?? 0))
            let rect = CGRect(x: meta["x"] ?? 0, y: meta["y"] ?? 0, width: meta["w"] ?? 0, height: meta["h"] ?? 0)
            DispatchQueue.main.async { self?.onMatte?(image, rect) }
        }
        graph.onMask = { [weak self] rgba, width, height in
            let image = try Self.image(rgba, width: width, height: height)
            DispatchQueue.main.async { self?.onFocus?(image) }
        }
        self.graph = graph
        return graph
    }

    private func clearFocus() { DispatchQueue.main.async { [weak self] in self?.onFocus?(nil) } }

    /// Premultiplied 8-bit RGBA tagged sRGB or Display P3.
    static func image(_ rgba: Data, width: Int, height: Int, gamut: String = "srgb") throws -> UIImage {
        guard width > 0, height > 0, rgba.count == width * height * 4,
              let provider = CGDataProvider(data: rgba as CFData),
              let space = CGColorSpace(name: gamut == "display-p3" ? CGColorSpace.displayP3 : CGColorSpace.sRGB),
              let frame = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                  bytesPerRow: width * 4, space: space,
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                  provider: provider, decode: nil, shouldInterpolate: true, intent: .relativeColorimetric) else {
            throw EngineError.message("Could not create color-managed preview")
        }
        return UIImage(cgImage: frame)
    }

    // MARK: - Catalog and controls (canonical web model)

    /// Stocks, groups, baseline parameters and export formats.
    public func catalog() async throws -> [String: Any] {
        try await run { [self] in
            let graph = try graphRuntime()
            guard var catalog = try JSONSerialization.jsonObject(with: Data(graph.catalog.utf8)) as? [String: Any] else {
                throw EngineError.message("Native catalog is missing")
            }
            if cachedExportFormats == nil { cachedExportFormats = probeExportFormats(graph) }
            catalog["exportFormats"] = cachedExportFormats!
            return catalog
        }
    }

    private func probeExportFormats(_ graph: NativeGraphRuntime) -> [String] {
        let encoders = CGImageDestinationCopyTypeIdentifiers() as? [String] ?? []
        var formats = ["png8", "png16", "tiff16", "jpeg"]
        var candidates: [String] = []
        if encoders.contains(UTType.webP.identifier) { candidates.append("webp") }
        if let type = UTType(mimeType: "image/avif"), encoders.contains(type.identifier) { candidates.append("avif") }
        // Test real chromatic, non-square pixels at both quality endpoints.
        // Advertised identifiers and a white 4x4 encode miss Apple's
        // unsupported lossless AVIF quality.
        var pixels = Data(count: 24 * 18 * 4)
        for i in 0..<(24 * 18) {
            pixels[i * 4] = UInt8(i % 251); pixels[i * 4 + 1] = UInt8((i * 17) % 251)
            pixels[i * 4 + 2] = UInt8((i * 53) % 251); pixels[i * 4 + 3] = 255
        }
        for format in candidates {
            do {
                for quality in [0.1, 1.0] {
                    let probe = try Self.write(pixels, width: 24, height: 18, icc: try graph.icc("sRGB"), format: format, quality: quality)
                    try? FileManager.default.removeItem(at: probe)
                }
                formats.append(format)
            } catch {
                // Offer only formats that work across the editor's quality range.
            }
        }
        return formats
    }

    /// Tool groups as the web panel shows them (values, switches, resets).
    public func controls(_ params: [String: Any]) async throws -> [[String: Any]] {
        try await run { [self] in
            let text = try graphRuntime().controlState(params)
            guard let groups = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [[String: Any]] else {
                throw EngineError.message("Native controls are missing")
            }
            return groups
        }
    }

    /// Applies one control action with the web rules; returns all parameters.
    public func patch(_ params: [String: Any], action: String, id: String, value: Any?) async throws -> [String: Any] {
        try await run { [self] in
            let text = try graphRuntime().patch(["params": params, "action": action, "id": id, "value": value ?? NSNull()])
            guard let next = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any] else {
                throw EngineError.message("Native control update is missing")
            }
            return next
        }
    }

    // MARK: - Photo

    /// Cancel in the "Opening …" card: the open photo stays (web `cancelOpening`).
    public func cancelOpen() { openCancel.set(true) }

    /// The photo open was cancelled.
    public static func isCancelled(_ error: Error) -> Bool {
        if case EngineError.cancelled = error { return true }
        return false
    }

    public func open(_ url: URL) async throws -> OpenedPhoto {
        openCancel.set(false)
        return try await run { [self] in
            let graph = try graphRuntime()
            guard !graph.isBusy else { throw EngineError.message("Finish development before opening another photo") }
            graph.hibernate()
            status("Opening photo…")
            defer { status("") }
            let source: NativeSourceStore
            if NativeRawSource.extensions.contains(url.pathExtension.lowercased()) {
                status("Developing RAW with LibRaw…")
                source = try NativeRawSource.decode(url, lookup: graph.rawLookup())
            } else {
                source = try NativeRasterSource.decode(url, profileSpace: graph.profileSpace)
            }
            if openCancel.value { throw EngineError.cancelled }
            let previous = graph.sourceStore
            do {
                try graph.attachSource(source)
                let size = try graph.originalPreview(edge: 1280)
                if openCancel.value {
                    // The staged photo is discarded; the open one shows again.
                    graph.rollbackSource()
                    if previous != nil { _ = try? graph.originalPreview(edge: 1280) }
                    throw EngineError.cancelled
                }
                graph.commitSource()
                graph.clearDepth(); clearFocus()
                detailImages = nil
                photoURL = url
                return OpenedPhoto(width: size.width, height: size.height, sourceWidth: source.width, sourceHeight: source.height,
                                   inputColorSpace: source.colorSpace, encoding: source.encoding)
            } catch EngineError.cancelled {
                throw EngineError.cancelled
            } catch {
                graph.rollbackSource(); throw error
            }
        }
    }

    /// Releases the photo and the renderer (web "Close Photo").
    public func close() async {
        _ = try? await run { [self] in
            photoURL = nil; preview = nil; detailImages = nil
            graph = nil
            clearFocus()
        }
    }

    // MARK: - Develop

    /// Develops the preview at `longEdge` (the web `setPreviewLongEdge`: what
    /// the screen shows, within the preview memory budget); the image arrives
    /// through `onPreview`.
    public func develop(_ params: [String: Any], longEdge: Int = 1600) async throws {
        try await runAsync { [self] (finish: @escaping (Result<Void, Error>) -> Void) in
            let graph = try graphRuntime()
            guard let url = photoURL else { throw EngineError.message("Open a photo first") }
            guard !graph.isBusy else { throw EngineError.message("Native renderer is busy") }
            let frame = try previewFrame(graph, url: url, params: params, longEdge: longEdge)
            // UIKit composites the separately tagged sRGB/P3 image; preserve
            // the selected output profile through the graph.
            try graph.request(operation: "preview", params: params, width: frame.width, height: frame.height) { finish($0) }
        }
    }

    private func previewFrame(_ graph: NativeGraphRuntime, url: URL, params: [String: Any], longEdge: Int = 1600) throws -> PhotoFrame {
        let measured: PhotoFrame
        if let preview { measured = preview }
        else if let source = graph.sourceStore {
            let size = Self.scaled(source.width, source.height, edge: 1280)
            measured = PhotoFrame(width: size.width, height: size.height, rgba: Data())
        } else { measured = try Self.decode(url, longEdge: 1600) }
        preview = measured
        // File-backed sources render any size up to the source (the host caps it
        // to the preview memory budget, as the web).
        let base = graph.sourceStore.map { (width: $0.width, height: $0.height) } ?? (width: measured.width, height: measured.height)
        let edge = try graph.renderSize(params, width: base.width, height: base.height, requested: longEdge, preview: true)
        let frame: PhotoFrame
        if let source = graph.sourceStore {
            let size = Self.scaled(source.width, source.height, edge: edge)
            frame = PhotoFrame(width: size.width, height: size.height, rgba: measured.rgba)
        } else { frame = edge < max(measured.width, measured.height) ? try Self.decode(url, longEdge: edge) : measured }
        graph.previewRGBA = frame.rgba; graph.previewWidth = frame.width; graph.previewHeight = frame.height
        return frame
    }

    // MARK: - Lens blur depth and Refine Edge (web depth worker code)

    /// The model at `url` (a catalog `depthModels`/`matteModel` entry) is on this device.
    public func isStored(url: String, bytes: Int) -> Bool {
        URL(string: url).map { NativeModels.isStored($0, bytes: bytes) } ?? false
    }

    /// A model was needed that is not on the device; ask before downloading.
    public static func isNotCached(_ error: Error) -> Bool {
        if case GraphRuntimeError.notCached = error { return true }
        return false
    }

    /// Measures the depth map for lens blur with `model` ("fast", "detail").
    /// Progress arrives through `onDepthProgress`. Refine Edge stays on.
    public func measureDepth(model: String, gpu: Bool, allowDownload: Bool) async throws -> DepthResult {
        try await runAsync { [self] (finish: @escaping (Result<DepthResult, Error>) -> Void) in
            let graph = try graphRuntime()
            guard photoURL != nil, graph.sourceStore != nil else { throw EngineError.message("Open a photo first") }
            graph.invalidateExport()
            try graph.task(["operation": "depth", "model": model, "gpu": gpu, "allowDownload": allowDownload]) { [weak graph] outcome in
                do {
                    try outcome.get()
                    graph?.depthReady = true
                    let result = graph?.taskResult ?? [:]
                    finish(.success(DepthResult(milliseconds: (result["ms"] as? NSNumber)?.intValue ?? 0,
                                                gpu: result["backend"] as? String == "gpu", model: result["model"] as? String ?? model)))
                } catch { finish(.failure(error)) }
            }
        }
    }

    /// Refine Edge: `mask` is the brush at `width x height` (1 = brushed).
    /// The matte view arrives through `onMatte`.
    public func refineEdges(mask: Data, width: Int, height: Int, allowDownload: Bool) async throws {
        try await runAsync { [self] (finish: @escaping (Result<Void, Error>) -> Void) in
            let graph = try graphRuntime()
            guard graph.depthReady else { throw EngineError.message("Lens blur needs a depth map first.") }
            try graph.setRefineMask(mask, width: width, height: height)
            graph.invalidateExport()
            try graph.task(["operation": "refine", "allowDownload": allowDownload]) { finish($0) }
        }
    }

    /// Removes Refine Edge of this photo.
    public func clearRefine() async throws {
        try await run { [self] in try graphRuntime().clearRefine() }
    }

    /// Lens focus overlay for a pending focus point (`onFocus`).
    public func focusPreview(_ params: [String: Any]) async throws {
        try await run { [self] in try graphRuntime().focusPreview(params) }
    }

    /// Full-resolution part of the photo for the zoomed viewport; nil when
    /// effects that need the whole frame are on.
    public func detail(_ params: [String: Any], rect: CGRect, longEdge: Int) async throws -> DetailTile? {
        if ["lensBlurEnabled", "cameraDiffusionEnabled", "printDiffusionEnabled"].contains(where: { params[$0] as? Bool == true }) {
            return nil
        }
        return try await runAsync { [self] (finish: @escaping (Result<DetailTile?, Error>) -> Void) in
            let graph = try graphRuntime()
            guard !graph.isBusy, let source = graph.sourceStore,
                  [rect.minX, rect.minY, rect.width, rect.height].allSatisfy({ $0.isFinite }),
                  rect.minX >= 0, rect.minY >= 0, rect.width > 0, rect.height > 0,
                  rect.maxX <= 1.00001, rect.maxY <= 1.00001 else {
                throw EngineError.message("Invalid detail viewport")
            }
            let requested = max(1, min(max(source.width, source.height), longEdge))
            var scale = Double(requested) / Double(max(source.width, source.height))
            let area = Double(source.width * source.height) * scale * scale * rect.width * rect.height
            if area > 1_500_000 { scale *= sqrt(1_500_000 / area) }
            let width = max(1, Int((Double(source.width) * scale).rounded())), height = max(1, Int((Double(source.height) * scale).rounded()))
            let x = min(width - 1, Int(floor(rect.minX * Double(width)))), y = min(height - 1, Int(floor(rect.minY * Double(height))))
            let right = min(width, Int(ceil(rect.maxX * Double(width)))), bottom = min(height, Int(ceil(rect.maxY * Double(height))))
            detailImages = nil
            try graph.request(operation: "detail", params: params, width: width, height: height,
                region: ["x": x, "y": y, "width": max(1, right - x), "height": max(1, bottom - y)]) { [weak self] outcome in
                do {
                    try outcome.get()
                    guard let self, let meta = graph.detailMetadata, let images = self.detailImages,
                          let fw = meta["fullWidth"], let fh = meta["fullHeight"], fw > 0, fh > 0 else { finish(.success(nil)); return }
                    let r = CGRect(x: Double(meta["x"] ?? 0) / Double(fw), y: Double(meta["y"] ?? 0) / Double(fh),
                                   width: Double(meta["width"] ?? 0) / Double(fw), height: Double(meta["height"] ?? 0) / Double(fh))
                    finish(.success(DetailTile(image: images.0, original: images.1, rect: r, longEdge: max(fw, fh))))
                } catch { finish(.failure(error)) }
            }
        }
    }

    // MARK: - Scopes

    /// Waveform, parade or vectorscope trace of the last preview (web scope
    /// math), or nil before the first frame.
    public func scope(_ prefs: [String: Any], width: Int, height: Int) async throws -> UIImage? {
        try await run { [self] in
            let text = try graphRuntime().scope(["prefs": prefs, "width": width, "height": height])
            guard let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let base64 = value["rgba"] as? String, let data = Data(base64Encoded: base64),
                  let w = value["width"] as? Int, let h = value["height"] as? Int else { return nil }
            return try Self.image(data, width: w, height: h)
        }
    }

    // MARK: - Export

    public func cancelExport() { cancellation.set(true) }

    /// Export dimensions for a long edge (lens blur and diffusion may cap them).
    public func exportSize(_ params: [String: Any], longEdge: Int?) async throws -> CGSize {
        try await run { [self] in
            let graph = try graphRuntime()
            guard let url = photoURL else { throw EngineError.message("Open a photo first") }
            let dimensions = try graph.sourceStore.map { (width: $0.width, height: $0.height) } ?? Self.sourceDimensions(url)
            let edge = try graph.renderSize(params, width: dimensions.width, height: dimensions.height, requested: longEdge, preview: false)
            let size = Self.scaled(dimensions.width, dimensions.height, edge: edge)
            return CGSize(width: size.width, height: size.height)
        }
    }

    /// Develops at full size and encodes the file (temporary URL).
    public func export(_ params: [String: Any], format: String = "png8", longEdge: Int? = nil, quality: Double = 1) async throws -> URL {
        cancellation.set(false)
        return try await runAsync { [self] (finish: @escaping (Result<URL, Error>) -> Void) in
            let graph = try graphRuntime()
            guard let url = photoURL else { throw EngineError.message("Open a photo first") }
            guard !graph.isBusy else { throw EngineError.message("Native renderer is busy") }
            do {
                _ = try previewFrame(graph, url: url, params: params)
                let dimensions = try graph.sourceStore.map { (width: $0.width, height: $0.height) } ?? Self.sourceDimensions(url)
                let edge = try graph.renderSize(params, width: dimensions.width, height: dimensions.height, requested: longEdge, preview: false)
                let full: PhotoFrame
                if let source = graph.sourceStore {
                    let size = Self.scaled(source.width, source.height, edge: edge)
                    full = PhotoFrame(width: size.width, height: size.height, rgba: Data())
                } else { full = try autoreleasepool { try Self.decode(url, longEdge: edge) } }
                graph.sourceRGBA = full.rgba; graph.sourceWidth = full.width; graph.sourceHeight = full.height
                let bits = ["png16", "tiff16"].contains(format) ? 16 : 8
                try graph.request(operation: "export", params: params, width: full.width, height: full.height, bits: bits) { [weak self, weak graph] outcome in
                    guard let self, let graph else { finish(.failure(EngineError.message("Native renderer closed"))); return }
                    defer { graph.releaseExport() }
                    do {
                        try outcome.get()
                        guard !self.cancellation.value else { throw EngineError.message("Export cancelled") }
                        let colorSpace = params["outputColorSpace"] as? String ?? "sRGB"
                        finish(.success(try Self.write(graph.outputRGBA, width: full.width, height: full.height, outputColorSpace: colorSpace,
                            icc: graph.icc(colorSpace), bits: bits, format: format, quality: quality,
                            sourceURL: url, sourceMetadata: graph.sourceStore?.metadata ?? [:])))
                    } catch { finish(.failure(error)) }
                }
            } catch { graph.releaseExport(); throw error }
        }
    }

    /// The color part of the look as a .cube LUT (temporary URL).
    public func exportCube(_ params: [String: Any], size: Int) async throws -> URL {
        cancellation.set(false)
        return try await runAsync { [self] (finish: @escaping (Result<URL, Error>) -> Void) in
            let graph = try graphRuntime()
            guard !graph.isBusy else { throw EngineError.message("Native renderer is busy") }
            try graph.request(operation: "cube", params: params, width: 0, height: 0, cubeSize: size) { outcome in
                defer { graph.releaseExport() }
                do {
                    try outcome.get()
                    let url = FileManager.default.temporaryDirectory.appendingPathComponent("DICHROIC-\(size)-\(UUID().uuidString).cube")
                    try graph.outputCube.write(to: url, atomically: true, encoding: .utf8)
                    finish(.success(url))
                } catch { finish(.failure(error)) }
            }
        }
    }

    // MARK: - Remove Object (on-device LaMa)

    private func removalGraph() throws -> NativeGraphRuntime {
        let graph = try graphRuntime()
        guard !graph.isBusy, let url = photoURL else { throw EngineError.message("Finish development before removing an object") }
        if graph.sourceStore == nil {
            status("Preparing photo…")
            try autoreleasepool {
                let full = try Self.decode(url, longEdge: nil)
                try graph.attachSource(NativeSourceStore(rgba: full.rgba, width: full.width, height: full.height))
                graph.commitSource()
            }
        }
        return graph
    }

    /// Shows the untouched original for brushing.
    public func beginRemoval() async throws {
        try await run { [self] in defer { status("") }; try removalGraph().removalPreview(candidate: false) }
    }

    /// Removes the brushed area (binary mask, long edge ≤ 1024) and previews it.
    public func previewRemoval(mask: Data, width: Int, height: Int) async throws {
        try await run { [self] in
            defer { status("") }
            let graph = try removalGraph()
            let input = try graph.prepareRemoval(mask, width: width, height: height)
            status("Downloading LaMa (62 MB, cached for next time)…")
            let model = try NativeModels.lama()
            status("Removing object on this device…")
            let output = try NativeModels.infer(model: model, input: input, shape: [1, 4, 512, 512])
            guard output.shape == [1, 3, 512, 512] else { throw EngineError.message("Invalid LaMa dimensions") }
            try graph.finishRemoval(output.data)
            try graph.removalPreview(candidate: true)
        }
    }

    /// Keeps the previewed removal; returns the new history cursor.
    public func applyRemoval() async throws -> Int {
        try await run { [self] in
            let cursor = try removalGraph().removalAction("removalCommit")
            graph?.clearDepth(); clearFocus()
            return cursor
        }
    }

    public func cancelRemoval() async throws {
        try await run { [self] in _ = try removalGraph().removalAction("removalCancel") }
    }

    public func restoreRemoval(_ cursor: Int) async throws {
        try await run { [self] in
            _ = try removalGraph().removalAction("removalRestore", cursor: cursor)
            graph?.clearDepth(); clearFocus()
        }
    }

    // MARK: - Decoding and encoding

    private static func sourceDimensions(_ url: URL) throws -> (width: Int, height: Int) {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue else { throw EngineError.message("Source dimensions are missing") }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return orientation >= 5 ? (height, width) : (width, height)
    }

    static func scaled(_ width: Int, _ height: Int, edge: Int) -> (width: Int, height: Int) {
        let scale = min(1, Double(edge) / Double(max(width, height)))
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    static func decode(_ url: URL, longEdge: Int?) throws -> PhotoFrame {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              w > 0, h > 0, w <= 50_000, h <= 50_000, Int64(w) * Int64(h) <= 50_000_000 else {
            throw EngineError.message("Open a supported photo of 50 MP or less")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge ?? max(w, h),
            kCGImageSourceShouldCacheImmediately: false,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { throw EngineError.message("Could not decode photo") }
        let width = image.width, height = image.height
        var bytes = Data(count: width * height * 4)
        let success = bytes.withUnsafeMutableBytes { raw -> Bool in
            guard let context = CGContext(data: raw.baseAddress, width: width, height: height,
                bitsPerComponent: 8, bytesPerRow: width * 4, space: space,
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
            context.setFillColor(CGColor(red: 0, green: 0, blue: 0, alpha: 1))
            context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard success else { throw EngineError.message("Could not allocate photo pixels") }
        return PhotoFrame(width: width, height: height, rgba: bytes)
    }

    static func write(_ rgba: Data, width: Int, height: Int, outputColorSpace: String = "sRGB", icc: Data? = nil,
                      bits: Int = 8, format: String = "png8", quality: Double = 1, sourceURL: URL? = nil,
                      sourceMetadata: [CFString: Any] = [:]) throws -> URL {
        var space = icc.flatMap { CGColorSpace(iccData: $0 as CFData) }
        if space == nil {
            let name: CFString
            switch outputColorSpace {
            case "sRGB": name = CGColorSpace.sRGB
            case "Display P3": name = CGColorSpace.displayP3
            case "Adobe RGB (1998)": name = CGColorSpace.adobeRGB1998
            case "ProPhoto RGB": name = CGColorSpace.rommrgb
            case "DCI-P3": name = CGColorSpace.dcip3
            case "Linear Rec.2020": name = CGColorSpace.extendedLinearITUR_2020
            case "Linear P3-D65": name = CGColorSpace.extendedLinearDisplayP3
            case "ACEScg": name = CGColorSpace.acescgLinear
            default: throw EngineError.message("This native export color profile is not available yet")
            }
            space = CGColorSpace(name: name)
        }
        guard let space, let provider = CGDataProvider(data: rgba as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: bits, bitsPerPixel: bits * 4,
                bytesPerRow: width * 4 * (bits / 8), space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue |
                    (bits == 16 ? CGBitmapInfo.byteOrder16Little.rawValue : CGBitmapInfo.byteOrder32Big.rawValue)),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw EngineError.message("Could not prepare export pixels")
        }
        let type: UTType
        switch format {
        case "png8", "png16": type = .png
        case "tiff16": type = .tiff
        case "jpeg": type = .jpeg
        case "webp": type = .webP
        case "avif": guard let avif = UTType(mimeType: "image/avif") else { throw EngineError.message("AVIF encoding is unavailable") }; type = avif
        default: throw EngineError.message("Unknown export format")
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DICHROIC-\(UUID().uuidString).\(type.preferredFilenameExtension ?? "png")")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
            throw EngineError.message("Could not create export file")
        }
        // ImageIO AV1 rejects 1.0 with kCMPhotoError_UnsupportedQuality:
        // lossless AVIF is unavailable. Expose the supported 99% lossy maximum.
        let maximumQuality = format == "avif" ? 0.99 : 1.0
        var metadata: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: min(maximumQuality, max(0.01, quality)),
            kCGImagePropertyOrientation: 1, kCGImagePropertyPixelWidth: width, kCGImagePropertyPixelHeight: height]
        metadata.merge(sourceMetadata) { current, _ in current }
        if let sourceURL, let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
           let original = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
            for key in [kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyIPTCDictionary, kCGImagePropertyTIFFDictionary] {
                if let dictionary = original[key] as? [CFString: Any] {
                    var combined = metadata[key] as? [CFString: Any] ?? [:]
                    combined.merge(dictionary) { _, original in original }
                    metadata[key] = combined
                }
            }
        }
        var exif = metadata[kCGImagePropertyExifDictionary] as? [CFString: Any] ?? [:]
        exif[kCGImagePropertyExifPixelXDimension] = width; exif[kCGImagePropertyExifPixelYDimension] = height
        metadata[kCGImagePropertyExifDictionary] = exif
        var tiff = metadata[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
        tiff[kCGImagePropertyTIFFOrientation] = 1
        if format == "tiff16" { tiff[kCGImagePropertyTIFFCompression] = 1 }
        metadata[kCGImagePropertyTIFFDictionary] = tiff
        CGImageDestinationAddImage(destination, image, metadata as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: url)
            throw EngineError.message("\(format.uppercased()) export failed")
        }
        return url
    }
}

struct PhotoFrame {
    let width: Int
    let height: Int
    var rgba: Data
}
