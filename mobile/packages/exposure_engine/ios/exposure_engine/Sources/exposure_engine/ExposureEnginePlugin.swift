import Flutter
import UIKit
import ImageIO
import CoreVideo
import UniformTypeIdentifiers
import PhotosUI
import ExposureNative
import Accelerate

private struct PhotoFrame {
    let width: Int
    let height: Int
    var rgba: Data
}

private enum NativeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let text) = self { return text }; return nil }
}

/// Stable surface IDs retain one profiled image each. UIKit performs native
/// wide-gamut composition instead of Flutter's untagged 8-bit texture path.
private final class PreviewTexture: NSObject, FlutterTexture {
    private let lock = NSLock()
    private var image: UIImage?
    // Observers are added, removed and invoked only on the main thread.
    private var observers: [UUID: (UIImage?) -> Void] = [:]
    func copyPixelBuffer() -> Unmanaged<CVPixelBuffer>? { nil }
    func snapshot() -> UIImage? { lock.lock(); defer { lock.unlock() }; return image }
    func observe(_ callback: @escaping (UIImage?) -> Void) -> UUID {
        let token = UUID(); observers[token] = callback; callback(snapshot()); return token
    }
    func removeObserver(_ token: UUID) { observers.removeValue(forKey: token) }
    private func notify() {
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            let image = self.snapshot()
            for observer in self.observers.values { observer(image) }
        }
    }
    func publish(_ rgba: Data, width: Int, height: Int, gamut: String = "srgb") throws {
        guard width > 0, height > 0, rgba.count == width * height * 4,
              let provider = CGDataProvider(data: rgba as CFData),
              let space = CGColorSpace(name: gamut == "display-p3" ? CGColorSpace.displayP3 : CGColorSpace.sRGB),
              let frame = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                  bytesPerRow: width * 4, space: space,
                  bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue),
                  provider: provider, decode: nil, shouldInterpolate: true, intent: .relativeColorimetric) else {
            throw NativeError.message("Could not create color-managed preview")
        }
        let next = UIImage(cgImage: frame)
        lock.lock(); image = next; lock.unlock(); notify()
    }
    func clear() { lock.lock(); image = nil; lock.unlock(); notify() }
}

private final class PreviewSurface: NSObject, FlutterPlatformView {
    private let imageView: UIImageView
    private let texture: PreviewTexture?
    private var observer: UUID?
    init(frame: CGRect, texture: PreviewTexture?) {
        self.texture = texture; imageView = UIImageView(frame: frame)
        imageView.contentMode = .scaleToFill; imageView.clipsToBounds = true
        imageView.isUserInteractionEnabled = false
        super.init()
        observer = texture?.observe { [weak self] image in self?.imageView.image = image }
    }
    deinit { if let observer { texture?.removeObserver(observer) } }
    func view() -> UIView { imageView }
}

private final class PreviewSurfaceFactory: NSObject, FlutterPlatformViewFactory {
    private let lookup: (Int64) -> PreviewTexture?
    init(lookup: @escaping (Int64) -> PreviewTexture?) { self.lookup = lookup; super.init() }
    func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
        let id = ((args as? [String: Any])?["textureId"] as? NSNumber)?.int64Value ?? -1
        return PreviewSurface(frame: frame, texture: lookup(id))
    }
    func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol { FlutterStandardMessageCodec.sharedInstance() }
}

public final class ExposureEnginePlugin: NSObject, FlutterPlugin, FlutterStreamHandler, UIDocumentPickerDelegate, PHPickerViewControllerDelegate {
    private let queue = DispatchQueue(label: "exposure.render", qos: .userInitiated)
    private let cancellation = NativeCancellation()
    private let texture = PreviewTexture()
    private let originalTexture = PreviewTexture()
    private let focusTexture = PreviewTexture()
    private let detailTexture = PreviewTexture()
    private let originalDetailTexture = PreviewTexture()
    private let spareDetailTexture = PreviewTexture()
    private let spareOriginalDetailTexture = PreviewTexture()
    private var detailUsesSpare = false
    private let registry: FlutterTextureRegistry
    private var textureId: Int64 = -1
    private var originalTextureId: Int64 = -1
    private var focusTextureId: Int64 = -1
    private var detailTextureId: Int64 = -1
    private var originalDetailTextureId: Int64 = -1
    private var spareDetailTextureId: Int64 = -1
    private var spareOriginalDetailTextureId: Int64 = -1
    private var engine: UnsafeMutableRawPointer?
    private var graph: NativeGraphRuntime?
    private var photoURL: URL?
    private var preview: PhotoFrame?
    private var memoryObserver: NSObjectProtocol?
    private var eventSink: FlutterEventSink?
    private var pickerResult: FlutterResult?
    private var importedPhotos: [URL] = []
    private var cachedExportFormats: [String]?
    private var lastDecodeMilliseconds = 0.0
    private var lastPreviewMilliseconds = 0.0

    public func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        picker.dismiss(animated: true)
        guard let provider = results.first?.itemProvider else { pickerResult?(nil); pickerResult = nil; return }
        let type = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .rawImage) == true }
            ?? provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
            ?? UTType.image.identifier
        // File representation preserves HEIC, RAW and metadata. UIImage-based
        // picking can silently turn the original into an 8-bit JPEG instead.
        provider.loadFileRepresentation(forTypeIdentifier: type) { [weak self] url, error in
            do {
                if let error { throw error }
                guard let url else { throw NativeError.message("Could not load the original photo") }
                let suffix = url.pathExtension.isEmpty ? (UTType(type)?.preferredFilenameExtension ?? "jpg") : url.pathExtension
                let copy = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-import-\(UUID().uuidString).\(suffix)")
                try FileManager.default.copyItem(at: url, to: copy)
                DispatchQueue.main.async {
                    guard let self else { try? FileManager.default.removeItem(at: copy); return }
                    self.importedPhotos.append(copy)
                    self.pickerResult?(copy.path); self.pickerResult = nil
                }
            } catch {
                DispatchQueue.main.async { [weak self] in
                    self?.pickerResult?(FlutterError(code: "photo_picker", message: error.localizedDescription, details: nil))
                    self?.pickerResult = nil
                }
            }
        }
    }

    public func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        pickerResult?(urls.first?.path); pickerResult = nil
    }
    public func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) { pickerResult?(nil); pickerResult = nil }

    public func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        eventSink = events; return nil
    }
    public func onCancel(withArguments arguments: Any?) -> FlutterError? { eventSink = nil; return nil }
    private func status(_ text: String, done: Int? = nil, total: Int? = nil) {
        var value: [String: Any] = ["message": text]
        if let done = done, let total = total { value["done"] = done; value["total"] = total }
        DispatchQueue.main.async { [weak self] in self?.eventSink?(value) }
    }

    private init(registry: FlutterTextureRegistry) {
        self.registry = registry
        super.init()
        textureId = registry.register(texture)
        originalTextureId = registry.register(originalTexture)
        focusTextureId = registry.register(focusTexture)
        detailTextureId = registry.register(detailTexture)
        originalDetailTextureId = registry.register(originalDetailTexture)
        spareDetailTextureId = registry.register(spareDetailTexture)
        spareOriginalDetailTextureId = registry.register(spareOriginalDetailTexture)
        memoryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil, queue: .main) { [weak self] _ in
            self?.queue.async { [weak self] in
                guard let self = self else { return }
                self.preview = nil
                if let engine = self.engine { exposure_destroy(engine); self.engine = nil }
                self.graph?.hibernate()
            }
        }
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = ExposureEnginePlugin(registry: registrar.textures())
        registrar.register(PreviewSurfaceFactory { [weak instance] id in
            guard let instance else { return nil }
            let surfaces: [Int64: PreviewTexture] = [instance.textureId: instance.texture,
                instance.originalTextureId: instance.originalTexture, instance.focusTextureId: instance.focusTexture,
                instance.detailTextureId: instance.detailTexture, instance.originalDetailTextureId: instance.originalDetailTexture,
                instance.spareDetailTextureId: instance.spareDetailTexture, instance.spareOriginalDetailTextureId: instance.spareOriginalDetailTexture]
            return surfaces[id]
        }, withId: "dichroic/preview")
        let channel = FlutterMethodChannel(name: "exposure/native", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: channel)
        FlutterEventChannel(name: "exposure/status", binaryMessenger: registrar.messenger()).setStreamHandler(instance)
    }

    deinit {
        for url in importedPhotos { try? FileManager.default.removeItem(at: url) }
        if let observer = memoryObserver { NotificationCenter.default.removeObserver(observer) }
        if let engine = engine { exposure_destroy(engine) }
        registry.unregisterTexture(textureId)
        registry.unregisterTexture(originalTextureId)
        registry.unregisterTexture(focusTextureId)
        registry.unregisterTexture(detailTextureId)
        registry.unregisterTexture(originalDetailTextureId)
        registry.unregisterTexture(spareDetailTextureId)
        registry.unregisterTexture(spareOriginalDetailTextureId)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        if call.method == "cancelExport" { cancellation.set(true); result(nil); return }
        if call.method == "loadExportPreferences" { result(UserDefaults.standard.string(forKey: "DichroicExportPreferences")); return }
        if call.method == "saveExportPreferences" {
            guard let json = call.arguments as? String, json.utf8.count <= 4096,
                  (try? JSONSerialization.jsonObject(with: Data(json.utf8))) is [String: Any] else {
                result(FlutterError(code: "preferences", message: "Invalid export preferences", details: nil)); return
            }
            UserDefaults.standard.set(json, forKey: "DichroicExportPreferences"); result(nil); return
        }
        if ["developExport", "cubeExport"].contains(call.method) { cancellation.set(false) }
        #if DEBUG
        if call.method == "debugPreview" {
            guard let image = texture.snapshot()?.cgImage, image.width * image.height <= 65536,
                  let bytes = image.dataProvider?.data else { result(nil); return }
            result(["colorSpace": image.colorSpace?.name.map { $0 as String } ?? "",
                "rgba": FlutterStandardTypedData(bytes: bytes as Data)]); return
        }
        if call.method == "debugScreenshot" {
            guard let window = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene })
                .flatMap({ $0.windows }).first(where: { $0.isKeyWindow }) else { result(nil); return }
            let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
                window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
            }
            do {
                let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
                let file = directory.appendingPathComponent("editor.png")
                guard let bytes = image.pngData() else { result(nil); return }
                try bytes.write(to: file); result(file.path)
            } catch { result(FlutterError(code: "screenshot", message: error.localizedDescription, details: nil)) }
            return
        }
        if call.method == "debugMemoryWarning" {
            NotificationCenter.default.post(name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
            result(nil); return
        }
        #endif
        if ["chooseFile", "choosePhoto"].contains(call.method) {
            guard pickerResult == nil else { result(FlutterError(code: "picker_busy", message: "File picker is already open", details: nil)); return }
            guard let scene = UIApplication.shared.connectedScenes.compactMap({ $0 as? UIWindowScene }).first(where: { $0.activationState == .foregroundActive }),
                  var presenter = scene.windows.first(where: { $0.isKeyWindow })?.rootViewController else {
                result(FlutterError(code: "picker_window", message: "The editor window is not active", details: nil)); return
            }
            while let presented = presenter.presentedViewController { presenter = presented }
            pickerResult = result
            if call.method == "choosePhoto" {
                var configuration = PHPickerConfiguration()
                configuration.filter = .images
                configuration.selectionLimit = 1
                configuration.preferredAssetRepresentationMode = .current
                let picker = PHPickerViewController(configuration: configuration)
                picker.delegate = self
                presenter.present(picker, animated: true)
            } else {
                let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image, .rawImage, .data], asCopy: true)
                picker.delegate = self
                presenter.present(picker, animated: true)
            }
            return
        }
        if call.method.hasPrefix("erase") { handleRemoval(call, result: result); return }
        if ["catalog", "controls", "patch", "develop", "developExport", "cubeExport", "focusPreview", "debugSource", "debugStats", "detail", "exportSize"].contains(call.method) {
            handleGraph(call, result: result); return
        }
        guard ["open", "render", "export", "close"].contains(call.method) else {
            result(FlutterMethodNotImplemented); return
        }
        let args = call.arguments as? [String: Any] ?? [:]
        queue.async { [self] in
            do {
                let value: Any?
                switch call.method {
                case "open":
                    guard let path = args["path"] as? String else { throw NativeError.message("Photo path is missing") }
                    let url = URL(fileURLWithPath: path)
                    let graph = try graphRuntime()
                    guard !graph.isBusy else { throw NativeError.message("Finish development before opening another photo") }
                    graph.hibernate()
                    status("Opening photo…")
                    let decodeStart = Date()
                    let source: NativeSourceStore
                    if NativeRawSource.extensions.contains(url.pathExtension.lowercased()) {
                        status("Developing RAW with LibRaw…")
                        source = try NativeRawSource.decode(url, lookup: graph.rawLookup())
                    } else {
                        source = try NativeRasterSource.decode(url, profileSpace: graph.profileSpace)
                    }
                    lastDecodeMilliseconds = Date().timeIntervalSince(decodeStart) * 1000
                    do {
                        try graph.attachSource(source)
                        let previewStart = Date()
                        let size = try graph.originalPreview(edge: 1280)
                        lastPreviewMilliseconds = Date().timeIntervalSince(previewStart) * 1000
                        graph.commitSource()
                        graph.clearDepth(); focusTexture.clear()
                        detailTexture.clear(); originalDetailTexture.clear()
                        spareDetailTexture.clear(); spareOriginalDetailTexture.clear()
                        photoURL = url
                        DispatchQueue.main.async { [weak self] in
                            guard let self else { return }
                            for old in self.importedPhotos where old != url { try? FileManager.default.removeItem(at: old) }
                            self.importedPhotos.removeAll { $0 != url }
                        }
                        value = ["textureId": textureId, "originalTextureId": originalTextureId, "focusTextureId": focusTextureId,
                            "width": size.width, "height": size.height, "sourceWidth": source.width, "sourceHeight": source.height,
                            "inputColorSpace": source.colorSpace, "encoding": source.encoding]
                        status("")
                    } catch {
                        graph.rollbackSource(); status(""); throw error
                    }
                case "render":
                    let ev = try exposure(args)
                    guard let url = photoURL else { throw NativeError.message("Open a photo first") }
                    let frame = try preview ?? decode(url, longEdge: 1600)
                    preview = frame
                    let pixels = try render(frame, exposureEv: ev)
                    try texture.publish(pixels, width: frame.width, height: frame.height)
                    DispatchQueue.main.async { self.registry.textureFrameAvailable(self.textureId) }
                    value = nil
                case "export":
                    let ev = try exposure(args)
                    guard let url = photoURL else { throw NativeError.message("Open a photo first") }
                    value = try autoreleasepool {
                        var full = try decode(url, longEdge: nil)
                        if engine == nil { engine = exposure_create() }
                        guard let handle = engine else { throw nativeError() }
                        let count = full.rgba.count
                        let width = UInt32(full.width), height = UInt32(full.height)
                        let status = full.rgba.withUnsafeMutableBytes { pixels in
                            exposure_render_in_place(handle, pixels.baseAddress?.assumingMemoryBound(to: UInt8.self),
                                count, width, height, ev)
                        }
                        guard status == 0 else { throw nativeError() }
                        return try writePNG(full.rgba, width: full.width, height: full.height).path
                    }
                default:
                    photoURL = nil; preview = nil; texture.clear(); originalTexture.clear(); focusTexture.clear(); detailTexture.clear(); originalDetailTexture.clear()
                    spareDetailTexture.clear(); spareOriginalDetailTexture.clear()
                    graph = nil
                    if let handle = engine { exposure_destroy(handle); engine = nil }
                    value = nil
                }
                DispatchQueue.main.async { result(value) }
            } catch {
                DispatchQueue.main.async { result(FlutterError(code: "native_render", message: error.localizedDescription, details: nil)) }
            }
        }
    }

    private func graphRuntime() throws -> NativeGraphRuntime {
        if let graph = graph { return graph }
        let graph = try NativeGraphRuntime(queue: queue, cancellation: cancellation)
        graph.onPublish = { [weak self] pixels, width, height, gamut in
            guard let self = self else { return }
            try self.texture.publish(pixels, width: width, height: height, gamut: gamut)
            DispatchQueue.main.async { self.registry.textureFrameAvailable(self.textureId) }
        }
        self.graph = graph
        graph.onDetail = { [weak self] rgba, original, width, height, gamut, originalGamut in
            guard let self = self else { return }
            let spare = !self.detailUsesSpare
            let graded = spare ? self.spareDetailTexture : self.detailTexture
            let untouched = spare ? self.spareOriginalDetailTexture : self.originalDetailTexture
            try graded.publish(rgba, width: width, height: height, gamut: gamut)
            try untouched.publish(original, width: width, height: height, gamut: originalGamut)
            self.detailUsesSpare = spare
            let gradedId = spare ? self.spareDetailTextureId : self.detailTextureId
            let originalId = spare ? self.spareOriginalDetailTextureId : self.originalDetailTextureId
            DispatchQueue.main.async {
                self.registry.textureFrameAvailable(gradedId)
                self.registry.textureFrameAvailable(originalId)
            }
        }
        graph.onOriginal = { [weak self] rgba, width, height, gamut in
            guard let self = self else { return }
            try self.originalTexture.publish(rgba, width: width, height: height, gamut: gamut)
            try self.texture.publish(rgba, width: width, height: height, gamut: gamut)
            self.preview = PhotoFrame(width: width, height: height, rgba: rgba)
            DispatchQueue.main.async {
                self.registry.textureFrameAvailable(self.originalTextureId)
                self.registry.textureFrameAvailable(self.textureId)
            }
        }
        graph.onProgress = { [weak self] done, total in self?.status("Developing…", done: done, total: total) }
        graph.onMask = { [weak self] rgba, width, height in
            guard let self = self else { return }
            try self.focusTexture.publish(rgba, width: width, height: height)
            DispatchQueue.main.async { self.registry.textureFrameAvailable(self.focusTextureId) }
        }
        return graph
    }

    private func handleRemoval(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        queue.async { [self] in
            do {
                let graph = try graphRuntime()
                guard !graph.isBusy, let url = photoURL else { throw NativeError.message("Finish development before removing an object") }
                if graph.sourceStore == nil {
                    status("Preparing photo…")
                    try autoreleasepool {
                        let full = try decode(url, longEdge: nil)
                        try graph.attachSource(NativeSourceStore(rgba: full.rgba, width: full.width, height: full.height))
                        graph.commitSource()
                    }
                }
                var value: Any?
                switch call.method {
                case "eraseBegin":
                    try graph.removalPreview(candidate: false)
                case "erasePreview":
                    guard let mask = args["mask"] as? FlutterStandardTypedData,
                          let width = args["width"] as? Int, let height = args["height"] as? Int else {
                        throw NativeError.message("Brush over an object first")
                    }
                    let input = try graph.prepareRemoval(mask.data, width: width, height: height)
                    status("Downloading LaMa (62 MB, cached for next time)…")
                    let model = try NativeModels.model(NativeModels.lamaURL, name: "lama-418036c6-int8.onnx")
                    status("Removing object on this device…")
                    let output = try NativeModels.infer(model: model, input: input, shape: [1, 4, 512, 512])
                    guard output.shape == [1, 3, 512, 512] else { throw NativeError.message("Invalid LaMa dimensions") }
                    try graph.finishRemoval(output.data)
                    try graph.removalPreview(candidate: true)
                case "eraseApply":
                    value = try graph.removalAction("removalCommit")
                    graph.clearDepth(); focusTexture.clear()
                case "eraseCancel":
                    _ = try graph.removalAction("removalCancel")
                case "eraseRestore":
                    guard let cursor = args["cursor"] as? Int else { throw NativeError.message("Removal history is missing") }
                    _ = try graph.removalAction("removalRestore", cursor: cursor)
                    graph.clearDepth(); focusTexture.clear()
                default: throw NativeError.message("Unknown removal operation")
                }
                status("")
                DispatchQueue.main.async { result(value) }
            } catch {
                status("")
                DispatchQueue.main.async { result(FlutterError(code: "native_removal", message: error.localizedDescription, details: nil)) }
            }
        }
    }

    private func handleGraph(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let args = call.arguments as? [String: Any] ?? [:]
        queue.async { [self] in
            func finish(_ value: Any?) { DispatchQueue.main.async { result(value) } }
            func fail(_ error: Error) { finish(FlutterError(code: "native_graph", message: error.localizedDescription, details: nil)) }
            do {
                let graph = try graphRuntime()
                if call.method == "debugStats" {
                    #if DEBUG
                    finish(["exportRenderCount": graph.exportRenderCount,
                        "decodeMilliseconds": lastDecodeMilliseconds,
                        "originalPreviewMilliseconds": lastPreviewMilliseconds]); return
                    #else
                    finish(FlutterMethodNotImplemented); return
                    #endif
                }
                if call.method == "catalog" {
                    var catalog = try JSONSerialization.jsonObject(with: Data(graph.catalog.utf8)) as! [String: Any]
                    if cachedExportFormats == nil {
                        let encoders = CGImageDestinationCopyTypeIdentifiers() as! [String]
                        var formats = ["png8", "png16", "tiff16", "jpeg"]
                        var candidates: [String] = []
                        if encoders.contains(UTType.webP.identifier) { candidates.append("webp") }
                        if let type = UTType(mimeType: "image/avif"), encoders.contains(type.identifier) { candidates.append("avif") }
                        // Match web's real 4x4 encoder probe. A listed ImageIO
                        // identifier does not prove that this device can encode it.
                        let pixels = Data(repeating: 255, count: 4 * 4 * 4)
                        for format in candidates {
                            if let probe = try? writePNG(pixels, width: 4, height: 4, icc: graph.icc("sRGB"), format: format, quality: 0.5) {
                                try? FileManager.default.removeItem(at: probe); formats.append(format)
                            }
                        }
                        cachedExportFormats = formats
                    }
                    catalog["exportFormats"] = cachedExportFormats!
                    finish(String(decoding: try JSONSerialization.data(withJSONObject: catalog), as: UTF8.self)); return
                }
                if call.method == "debugSource" {
                    #if DEBUG
                    guard let source = graph.sourceStore, source.width * source.height <= 65536 else {
                        throw NativeError.message("Source probe only accepts small integration fixtures")
                    }
                    var pixels = Data(count: source.width * source.height * 16)
                    source.data.withUnsafeBytes { input in pixels.withUnsafeMutableBytes { (output: UnsafeMutableRawBufferPointer) in
                        for p in 0..<(source.width * source.height) { for c in 0..<4 {
                            output.storeBytes(of: source.value(input, pixel: p, channel: c), toByteOffset: (p * 4 + c) * 4, as: Float.self)
                        } }
                    } }
                    finish(FlutterStandardTypedData(bytes: pixels)); return
                    #else
                    finish(FlutterMethodNotImplemented); return
                    #endif
                }
                if call.method == "patch" { finish(try graph.patch(args)); return }
                guard var params = args["params"] as? [String: Any] else { throw NativeError.message("Render parameters are missing") }
                if call.method == "controls" { finish(try graph.controlState(params)); return }
                if call.method == "exportSize" {
                    guard let url = photoURL else { throw NativeError.message("Open a photo first") }
                    let dimensions = try graph.sourceStore.map { (width: $0.width, height: $0.height) } ?? sourceDimensions(url)
                    let edge = try graph.renderSize(params, width: dimensions.width, height: dimensions.height,
                        requested: (args["longEdge"] as? NSNumber)?.intValue, preview: false)
                    let size = scaledSize(dimensions.width, dimensions.height, edge: edge)
                    finish(["width": size.width, "height": size.height]); return
                }
                if call.method == "focusPreview" { try graph.focusPreview(params); finish(nil); return }
                if call.method == "detail" {
                    if ["lensBlurEnabled", "cameraDiffusionEnabled", "printDiffusionEnabled"].contains(where: { params[$0] as? Bool == true }) {
                        finish(nil); return
                    }
                    guard !graph.isBusy, let source = graph.sourceStore,
                          let rect = args["rect"] as? [String: NSNumber], let left = rect["x"]?.doubleValue,
                          let top = rect["y"]?.doubleValue, let rw = rect["width"]?.doubleValue, let rh = rect["height"]?.doubleValue,
                          [left, top, rw, rh].allSatisfy({ $0.isFinite }), left >= 0, top >= 0, rw > 0, rh > 0, left + rw <= 1.00001, top + rh <= 1.00001 else {
                        throw NativeError.message("Invalid detail viewport")
                    }
                    let requested = max(1, min(max(source.width, source.height), (args["longEdge"] as? NSNumber)?.intValue ?? 1600))
                    var scale = Double(requested) / Double(max(source.width, source.height))
                    let area = Double(source.width * source.height) * scale * scale * rw * rh
                    if area > 1_500_000 { scale *= sqrt(1_500_000 / area) }
                    let width = max(1, Int((Double(source.width) * scale).rounded())), height = max(1, Int((Double(source.height) * scale).rounded()))
                    let x = min(width - 1, Int(floor(left * Double(width)))), y = min(height - 1, Int(floor(top * Double(height))))
                    let right = min(width, Int(ceil((left + rw) * Double(width)))), bottom = min(height, Int(ceil((top + rh) * Double(height))))
                    try graph.request(operation: "detail", params: params, width: width, height: height,
                        region: ["x": x, "y": y, "width": max(1, right - x), "height": max(1, bottom - y)]) { outcome in
                        do {
                            try outcome.get()
                            guard var meta = graph.detailMetadata else { finish(nil); return }
                            meta["textureId"] = Int(self.detailUsesSpare ? self.spareDetailTextureId : self.detailTextureId)
                            meta["originalTextureId"] = Int(self.detailUsesSpare ? self.spareOriginalDetailTextureId : self.originalDetailTextureId)
                            finish(meta)
                        } catch { fail(error) }
                    }
                    return
                }
                if call.method == "cubeExport" {
                    guard !graph.isBusy else { throw NativeError.message("Native renderer is busy") }
                    let size = (args["size"] as? Int) ?? 33
                    try graph.request(operation: "cube", params: params, width: 0, height: 0, cubeSize: size) { outcome in
                        defer { graph.releaseExport() }
                        do {
                            try outcome.get()
                            let url = FileManager.default.temporaryDirectory.appendingPathComponent("DICHROIC-\(size)-\(UUID().uuidString).cube")
                            try graph.outputCube.write(to: url, atomically: true, encoding: .utf8)
                            finish(url.path)
                        } catch { fail(error) }
                    }
                    return
                }
                guard let url = photoURL else { throw NativeError.message("Open a photo first") }
                guard !graph.isBusy else { throw NativeError.message("Native renderer is busy") }
                let measured: PhotoFrame
                if let preview = preview { measured = preview }
                else if let source = graph.sourceStore {
                    let size = scaledSize(source.width, source.height, edge: 1280)
                    measured = PhotoFrame(width: size.width, height: size.height, rgba: Data())
                } else { measured = try decode(url, longEdge: 1600) }
                preview = measured
                let edge = try graph.renderSize(params, width: measured.width, height: measured.height, requested: 1600, preview: true)
                let frame: PhotoFrame
                if let source = graph.sourceStore {
                    let size = scaledSize(source.width, source.height, edge: edge)
                    frame = PhotoFrame(width: size.width, height: size.height, rgba: measured.rgba)
                } else { frame = edge < max(measured.width, measured.height) ? try decode(url, longEdge: edge) : measured }
                graph.previewRGBA = frame.rgba; graph.previewWidth = frame.width; graph.previewHeight = frame.height
                if params["lensBlurEnabled"] as? Bool == true && !graph.depthReady {
                    status("Preparing depth…")
                    let guide: PhotoFrame
                    if let source = graph.sourceStore {
                        let size = scaledSize(source.width, source.height, edge: 1024)
                        guide = PhotoFrame(width: size.width, height: size.height, rgba: Data())
                    } else { guide = try decode(url, longEdge: 1024) }
                    graph.previewRGBA = guide.rgba; graph.previewWidth = guide.width; graph.previewHeight = guide.height
                    let input = try graph.prepareDepth()
                    status("Downloading depth model (27 MB, cached for next time)…")
                    let model = try NativeModels.model(NativeModels.depthURL, name: "depth-4472b736-int8.onnx")
                    let result = try NativeModels.infer(model: model, input: input.data, shape: [1, 3, input.height, input.width])
                    guard result.shape.count >= 2 else { throw NativeError.message("Invalid depth dimensions") }
                    try graph.finishDepth(result.data, width: result.shape[result.shape.count - 1], height: result.shape[result.shape.count - 2])
                    graph.previewRGBA = frame.rgba; graph.previewWidth = frame.width; graph.previewHeight = frame.height
                    status("")
                }
                if call.method == "develop" {
                    // UIKit composites the separately tagged sRGB/P3 image;
                    // preserve the selected output profile through the graph.
                    try graph.request(operation: "preview", params: params, width: frame.width, height: frame.height) { outcome in
                        switch outcome { case .success: finish(nil); case .failure(let error): fail(error) }
                    }
                } else {
                    let dimensions = try graph.sourceStore.map { (width: $0.width, height: $0.height) } ?? sourceDimensions(url)
                    let edge = try graph.renderSize(params, width: dimensions.width, height: dimensions.height,
                        requested: (args["longEdge"] as? NSNumber)?.intValue, preview: false)
                    let full: PhotoFrame
                    if let source = graph.sourceStore {
                        let size = scaledSize(source.width, source.height, edge: edge)
                        full = PhotoFrame(width: size.width, height: size.height, rgba: Data())
                    } else { full = try autoreleasepool { try decode(url, longEdge: edge) } }
                    graph.sourceRGBA = full.rgba; graph.sourceWidth = full.width; graph.sourceHeight = full.height
                    let format = args["format"] as? String ?? "png8", bits = ["png16", "tiff16"].contains(format) ? 16 : 8
                    try graph.request(operation: "export", params: params, width: full.width, height: full.height, bits: bits) { [weak self, weak graph] outcome in
                        guard let self = self, let graph = graph else { fail(NativeError.message("Native renderer closed")); return }
                        defer { graph.releaseExport() }
                        do {
                            try outcome.get()
                            guard !self.cancellation.value else { throw NativeError.message("Export cancelled") }
                            let colorSpace = params["outputColorSpace"] as? String ?? "sRGB"
                            finish(try self.writePNG(graph.outputRGBA, width: full.width, height: full.height, outputColorSpace: colorSpace,
                                icc: graph.icc(colorSpace), bits: bits, format: format, quality: (args["quality"] as? NSNumber)?.doubleValue ?? 1,
                                sourceURL: url, sourceMetadata: graph.sourceStore?.metadata ?? [:]).path)
                        } catch { fail(error) }
                    }
                }
            } catch { graph?.releaseExport(); fail(error) }
        }
    }

    private func exposure(_ args: [String: Any]) throws -> Float {
        guard let number = args["exposureEv"] as? NSNumber else { throw NativeError.message("Exposure value is missing") }
        let value = number.floatValue
        guard value.isFinite, (-5...5).contains(value) else { throw NativeError.message("Exposure must be between -5 and +5 EV") }
        return value
    }

    private func sourceDimensions(_ url: URL) throws -> (width: Int, height: Int) {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let height = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue else { throw NativeError.message("Source dimensions are missing") }
        let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
        return orientation >= 5 ? (height, width) : (width, height)
    }
    private func scaledSize(_ width: Int, _ height: Int, edge: Int) -> (width: Int, height: Int) {
        let scale = min(1, Double(edge) / Double(max(width, height)))
        return (max(1, Int((Double(width) * scale).rounded())), max(1, Int((Double(height) * scale).rounded())))
    }

    private func decode(_ url: URL, longEdge: Int?) throws -> PhotoFrame {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let w = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
              let h = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
              w > 0, h > 0, w <= 50_000, h <= 50_000, Int64(w) * Int64(h) <= 50_000_000 else {
            throw NativeError.message("Open a supported photo of 50 MP or less")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: longEdge ?? max(w, h),
            kCGImageSourceShouldCacheImmediately: false
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              let space = CGColorSpace(name: CGColorSpace.sRGB) else { throw NativeError.message("Could not decode photo") }
        let width = image.width; let height = image.height
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
        guard success else { throw NativeError.message("Could not allocate photo pixels") }
        return PhotoFrame(width: width, height: height, rgba: bytes)
    }

    private func render(_ frame: PhotoFrame, exposureEv: Float) throws -> Data {
        if engine == nil { engine = exposure_create() }
        guard let handle = engine else { throw nativeError() }
        var pixels = Data(count: frame.rgba.count)
        let count = pixels.count
        let status = frame.rgba.withUnsafeBytes { source in pixels.withUnsafeMutableBytes { output in
            exposure_render(handle, source.baseAddress?.assumingMemoryBound(to: UInt8.self), frame.rgba.count,
                UInt32(frame.width), UInt32(frame.height), exposureEv,
                output.baseAddress?.assumingMemoryBound(to: UInt8.self), count)
        } }
        guard status == 0 else { throw nativeError() }
        return pixels
    }

    private func nativeError() -> NativeError {
        guard let message = exposure_last_error() else { return .message("Native GPU failed") }
        return .message(String(cString: message))
    }

    private func writePNG(_ rgba: Data, width: Int, height: Int, outputColorSpace: String = "sRGB", icc: Data? = nil,
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
        default: throw NativeError.message("This native export color profile is not available yet")
        }
        space = CGColorSpace(name: name)
        }
        guard let space = space, let provider = CGDataProvider(data: rgba as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: bits, bitsPerPixel: bits * 4,
                bytesPerRow: width * 4 * (bits / 8), space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue |
                    (bits == 16 ? CGBitmapInfo.byteOrder16Little.rawValue : CGBitmapInfo.byteOrder32Big.rawValue)),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw NativeError.message("Could not prepare export pixels")
        }
        let type: UTType
        switch format {
        case "png8", "png16": type = .png
        case "tiff16": type = .tiff
        case "jpeg": type = .jpeg
        case "webp": type = .webP
        case "avif": guard let avif = UTType(mimeType: "image/avif") else { throw NativeError.message("AVIF encoding is unavailable") }; type = avif
        default: throw NativeError.message("Unknown export format")
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("DICHROIC-\(UUID().uuidString).\(type.preferredFilenameExtension ?? "png")")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
            throw NativeError.message("Could not create export file")
        }
        var metadata: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: min(1, max(0.01, quality)),
            kCGImagePropertyOrientation: 1, kCGImagePropertyPixelWidth: width, kCGImagePropertyPixelHeight: height]
        metadata.merge(sourceMetadata) { current, _ in current }
        if let sourceURL = sourceURL, let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
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
        if format == "tiff16" {
            var tiff = metadata[kCGImagePropertyTIFFDictionary] as? [CFString: Any] ?? [:]
            tiff[kCGImagePropertyTIFFCompression] = 1; tiff[kCGImagePropertyTIFFOrientation] = 1
            metadata[kCGImagePropertyTIFFDictionary] = tiff
        }
        CGImageDestinationAddImage(destination, image, metadata as CFDictionary)
        guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: url)
            throw NativeError.message("\(format.uppercased()) export failed")
        }
        return url
    }
}
