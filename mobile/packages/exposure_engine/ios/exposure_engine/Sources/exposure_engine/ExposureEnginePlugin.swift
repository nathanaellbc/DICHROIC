import Flutter
import UIKit
import ImageIO
import CoreVideo
import UniformTypeIdentifiers
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

/// Flutter samples this texture directly; slider frames do not encode PNGs or cross Dart as pixels.
private final class PreviewTexture: NSObject, FlutterTexture {
    private let lock = NSLock()
    private var current: CVPixelBuffer?
    private var pool: CVPixelBufferPool?
    private var size = CGSize.zero

    func copyPixelBuffer() -> Unmanaged<CVPixelBuffer>? {
        lock.lock(); defer { lock.unlock() }
        return current.map { Unmanaged.passRetained($0) }
    }

    func publish(_ rgba: Data, width: Int, height: Int) throws {
        let nextSize = CGSize(width: width, height: height)
        if size != nextSize || pool == nil {
            let attributes: [CFString: Any] = [
                kCVPixelBufferWidthKey: width, kCVPixelBufferHeightKey: height,
                kCVPixelBufferPixelFormatTypeKey: kCVPixelFormatType_32BGRA,
                kCVPixelBufferMetalCompatibilityKey: true,
                kCVPixelBufferIOSurfacePropertiesKey: [:]
            ]
            guard CVPixelBufferPoolCreate(nil, nil, attributes as CFDictionary, &pool) == kCVReturnSuccess else {
                throw NativeError.message("Could not allocate preview texture")
            }
            size = nextSize
        }
        var pixelBuffer: CVPixelBuffer?
        guard let pool = pool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pixelBuffer) == kCVReturnSuccess,
              let buffer = pixelBuffer else { throw NativeError.message("Could not allocate preview frame") }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { throw NativeError.message("Preview texture has no storage") }
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        let status = rgba.withUnsafeBytes { raw -> vImage_Error in
            var input = vImage_Buffer(data: UnsafeMutableRawPointer(mutating: raw.baseAddress!),
                height: vImagePixelCount(height), width: vImagePixelCount(width), rowBytes: width * 4)
            var output = vImage_Buffer(data: base, height: vImagePixelCount(height),
                width: vImagePixelCount(width), rowBytes: stride)
            return [UInt8(2), 1, 0, 3].withUnsafeBufferPointer { permutation in
                vImagePermuteChannels_ARGB8888(&input, &output, permutation.baseAddress!, vImage_Flags(kvImageNoFlags))
            }
        }
        guard status == kvImageNoError else { throw NativeError.message("Preview pixel conversion failed") }
        lock.lock(); current = buffer; lock.unlock()
    }

    func clear() {
        lock.lock(); current = nil; lock.unlock()
        pool = nil; size = .zero
    }
}

public final class ExposureEnginePlugin: NSObject, FlutterPlugin, FlutterStreamHandler {
    private let queue = DispatchQueue(label: "exposure.render", qos: .userInitiated)
    private let texture = PreviewTexture()
    private let originalTexture = PreviewTexture()
    private let focusTexture = PreviewTexture()
    private let registry: FlutterTextureRegistry
    private var textureId: Int64 = -1
    private var originalTextureId: Int64 = -1
    private var focusTextureId: Int64 = -1
    private var engine: UnsafeMutableRawPointer?
    private var graph: NativeGraphRuntime?
    private var photoURL: URL?
    private var preview: PhotoFrame?
    private var memoryObserver: NSObjectProtocol?
    private var eventSink: FlutterEventSink?

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
        let channel = FlutterMethodChannel(name: "exposure/native", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: channel)
        FlutterEventChannel(name: "exposure/status", binaryMessenger: registrar.messenger()).setStreamHandler(instance)
    }

    deinit {
        if let observer = memoryObserver { NotificationCenter.default.removeObserver(observer) }
        if let engine = engine { exposure_destroy(engine) }
        registry.unregisterTexture(textureId)
        registry.unregisterTexture(originalTextureId)
        registry.unregisterTexture(focusTextureId)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        if call.method.hasPrefix("erase") { handleRemoval(call, result: result); return }
        if ["catalog", "controls", "patch", "develop", "developExport", "cubeExport", "focusPreview"].contains(call.method) {
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
                    let frame = try decode(url, longEdge: 1600)
                    // Keep the untouched import on a separate, bounded texture. Compare never renders.
                    try originalTexture.publish(frame.rgba, width: frame.width, height: frame.height)
                    try texture.publish(frame.rgba, width: frame.width, height: frame.height)
                    photoURL = url; preview = frame
                    graph?.clearDepth()
                    graph?.clearSource()
                    focusTexture.clear()
                    value = ["textureId": textureId, "originalTextureId": originalTextureId, "focusTextureId": focusTextureId,
                        "width": frame.width, "height": frame.height]
                    DispatchQueue.main.async {
                        self.registry.textureFrameAvailable(self.textureId)
                        self.registry.textureFrameAvailable(self.originalTextureId)
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
                    photoURL = nil; preview = nil; texture.clear(); originalTexture.clear(); focusTexture.clear()
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
        let graph = try NativeGraphRuntime(queue: queue)
        graph.onPublish = { [weak self] pixels, width, height in
            guard let self = self else { return }
            try self.texture.publish(pixels, width: width, height: height)
            DispatchQueue.main.async { self.registry.textureFrameAvailable(self.textureId) }
        }
        self.graph = graph
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
                if call.method == "catalog" {
                    var catalog = try JSONSerialization.jsonObject(with: Data(graph.catalog.utf8)) as! [String: Any]
                    let encoders = CGImageDestinationCopyTypeIdentifiers() as! [String]
                    var formats = ["png8", "png16", "tiff16", "jpeg"]
                    if encoders.contains(UTType.webP.identifier) { formats.append("webp") }
                    if let type = UTType(mimeType: "image/avif"), encoders.contains(type.identifier) { formats.append("avif") }
                    catalog["exportFormats"] = formats
                    finish(String(decoding: try JSONSerialization.data(withJSONObject: catalog), as: UTF8.self)); return
                }
                if call.method == "patch" { finish(try graph.patch(args)); return }
                guard var params = args["params"] as? [String: Any] else { throw NativeError.message("Render parameters are missing") }
                if call.method == "controls" { finish(try graph.controlState(params)); return }
                if call.method == "focusPreview" { try graph.focusPreview(params); finish(nil); return }
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
                let measured = try preview ?? decode(url, longEdge: 1600)
                preview = measured
                let edge = try graph.renderSize(params, width: measured.width, height: measured.height, requested: 1600, preview: true)
                let frame = edge < max(measured.width, measured.height) ? try decode(url, longEdge: edge) : measured
                graph.previewRGBA = frame.rgba; graph.previewWidth = frame.width; graph.previewHeight = frame.height
                if params["lensBlurEnabled"] as? Bool == true && !graph.depthReady {
                    status("Preparing depth…")
                    let guide = try decode(url, longEdge: 1024)
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
                    // The display texture has an sRGB encoding. Export retains
                    // the chosen output gamut in its separately tagged image.
                    params["outputColorSpace"] = "sRGB"
                    try graph.request(operation: "preview", params: params, width: frame.width, height: frame.height) { outcome in
                        switch outcome { case .success: finish(nil); case .failure(let error): fail(error) }
                    }
                } else {
                    let dimensions = try sourceDimensions(url)
                    let edge = try graph.renderSize(params, width: dimensions.width, height: dimensions.height,
                        requested: (args["longEdge"] as? NSNumber)?.intValue, preview: false)
                    let full = try autoreleasepool { try decode(url, longEdge: edge) }
                    graph.sourceRGBA = full.rgba; graph.sourceWidth = full.width; graph.sourceHeight = full.height
                    let format = args["format"] as? String ?? "png8", bits = ["png16", "tiff16"].contains(format) ? 16 : 8
                    try graph.request(operation: "export", params: params, width: full.width, height: full.height, bits: bits) { [weak self, weak graph] outcome in
                        guard let self = self, let graph = graph else { fail(NativeError.message("Native renderer closed")); return }
                        defer { graph.releaseExport() }
                        do {
                            try outcome.get()
                            let colorSpace = params["outputColorSpace"] as? String ?? "sRGB"
                            finish(try self.writePNG(graph.outputRGBA, width: full.width, height: full.height, outputColorSpace: colorSpace,
                                icc: graph.icc(colorSpace), bits: bits, format: format, quality: (args["quality"] as? NSNumber)?.doubleValue ?? 1,
                                sourceURL: url).path)
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
                          bits: Int = 8, format: String = "png8", quality: Double = 1, sourceURL: URL? = nil) throws -> URL {
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
        if let sourceURL = sourceURL, let source = CGImageSourceCreateWithURL(sourceURL as CFURL, nil),
           let original = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
            for key in [kCGImagePropertyExifDictionary, kCGImagePropertyGPSDictionary, kCGImagePropertyIPTCDictionary, kCGImagePropertyTIFFDictionary] {
                metadata[key] = original[key]
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
            throw NativeError.message("PNG export failed")
        }
        return url
    }
}
