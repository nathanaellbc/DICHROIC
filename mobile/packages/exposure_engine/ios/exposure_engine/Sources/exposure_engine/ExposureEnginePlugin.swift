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
    let rgba: Data
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

public final class ExposureEnginePlugin: NSObject, FlutterPlugin {
    private let queue = DispatchQueue(label: "exposure.render", qos: .userInitiated)
    private let texture = PreviewTexture()
    private let registry: FlutterTextureRegistry
    private var textureId: Int64 = -1
    private var engine: UnsafeMutableRawPointer?
    private var photoURL: URL?
    private var preview: PhotoFrame?
    private var memoryObserver: NSObjectProtocol?

    private init(registry: FlutterTextureRegistry) {
        self.registry = registry
        super.init()
        textureId = registry.register(texture)
        memoryObserver = NotificationCenter.default.addObserver(forName: UIApplication.didReceiveMemoryWarningNotification,
            object: nil, queue: .main) { [weak self] _ in
            self?.queue.async { [weak self] in
                guard let self = self else { return }
                self.preview = nil
                if let engine = self.engine { exposure_destroy(engine); self.engine = nil }
            }
        }
    }

    public static func register(with registrar: FlutterPluginRegistrar) {
        let instance = ExposureEnginePlugin(registry: registrar.textures())
        let channel = FlutterMethodChannel(name: "exposure/native", binaryMessenger: registrar.messenger())
        registrar.addMethodCallDelegate(instance, channel: channel)
    }

    deinit {
        if let observer = memoryObserver { NotificationCenter.default.removeObserver(observer) }
        if let engine = engine { exposure_destroy(engine) }
        registry.unregisterTexture(textureId)
    }

    public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
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
                    let pixels = try render(frame, exposureEv: 0)
                    try texture.publish(pixels, width: frame.width, height: frame.height)
                    photoURL = url; preview = frame
                    value = ["textureId": textureId, "width": frame.width, "height": frame.height]
                    DispatchQueue.main.async { self.registry.textureFrameAvailable(self.textureId) }
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
                        let full = try decode(url, longEdge: nil)
                        let pixels = try render(full, exposureEv: ev)
                        return try writePNG(pixels, width: full.width, height: full.height).path
                    }
                default:
                    photoURL = nil; preview = nil; texture.clear()
                    if let handle = engine { exposure_destroy(handle); engine = nil }
                    value = nil
                }
                DispatchQueue.main.async { result(value) }
            } catch {
                DispatchQueue.main.async { result(FlutterError(code: "native_render", message: error.localizedDescription, details: nil)) }
            }
        }
    }

    private func exposure(_ args: [String: Any]) throws -> Float {
        guard let number = args["exposureEv"] as? NSNumber else { throw NativeError.message("Exposure value is missing") }
        let value = number.floatValue
        guard value.isFinite, (-5...5).contains(value) else { throw NativeError.message("Exposure must be between -5 and +5 EV") }
        return value
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

    private func writePNG(_ rgba: Data, width: Int, height: Int) throws -> URL {
        guard let space = CGColorSpace(name: CGColorSpace.sRGB), let provider = CGDataProvider(data: rgba as CFData),
              let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
                bytesPerRow: width * 4, space: space, bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue),
                provider: provider, decode: nil, shouldInterpolate: false, intent: .defaultIntent) else {
            throw NativeError.message("Could not prepare export pixels")
        }
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("Exposure-\(UUID().uuidString).png")
        guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
            throw NativeError.message("Could not create export file")
        }
        CGImageDestinationAddImage(destination, image, nil)
        guard CGImageDestinationFinalize(destination) else {
            try? FileManager.default.removeItem(at: url)
            throw NativeError.message("PNG export failed")
        }
        return url
    }
}
