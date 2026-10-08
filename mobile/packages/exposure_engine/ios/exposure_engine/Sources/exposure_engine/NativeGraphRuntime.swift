import Foundation
import JavaScriptCore
import ExposureNative

enum GraphRuntimeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

private final class NativeGPUHandle {
    let pointer: UnsafeMutableRawPointer
    init() throws {
        guard let pointer = dichroic_gpu_create(384 * 1024 * 1024) else {
            throw GraphRuntimeError.message(exposure_last_error().map { String(cString: $0) } ?? "Native GPU initialization failed")
        }
        self.pointer = pointer
    }
    deinit { dichroic_gpu_destroy(pointer) }
}

final class NativeCancellation {
    private let lock = NSLock()
    private var cancelled = false
    func set(_ value: Bool) { lock.lock(); cancelled = value; lock.unlock() }
    var value: Bool { lock.lock(); defer { lock.unlock() }; return cancelled }
}

/// One runtime on the plugin's serial render queue. JavaScriptCore runs only
/// canonical host mathematics; wgpu executes the unchanged WGSL on Metal.
/// The bridge transfers typed-array storage directly, never JSON photo pixels.
final class NativeGraphRuntime {
    private let context: JSContext
    private let gpu: NativeGPUHandle
    private var handle: UnsafeMutableRawPointer { gpu.pointer }
    private let queue: DispatchQueue
    private let resources: URL
    private var runtime: JSValue?
    private var pending: [Int: (Result<Void, Error>) -> Void] = [:]
    private var serial = 0
    private var purgePending = false
    private(set) var catalog = ""
    var previewRGBA = Data()
    var previewWidth = 0
    var previewHeight = 0
    var sourceRGBA = Data()
    var sourceWidth = 0
    var sourceHeight = 0
    var outputRGBA = Data()
    private var outputStore: NativeOutputStore?
    private var outputBits = 8
    private var exportKey: Data?
    private var pendingExportKey: Data?
    private(set) var exportRenderCount = 0
    private let cancellation: NativeCancellation
    var outputCube = ""
    var onPublish: ((Data, Int, Int) throws -> Void)?
    var onProgress: ((Int, Int) -> Void)?
    var onMask: ((Data, Int, Int) throws -> Void)?
    var onOriginal: ((Data, Int, Int) throws -> Void)?
    var onDetail: ((Data, Data, Int, Int) throws -> Void)?
    var detailMetadata: [String: Int]?
    private(set) var depthReady = false
    var sourceStore: NativeSourceStore?
    private var sourceBackup: NativeSourceStore?

    func attachSource(_ source: NativeSourceStore) throws {
        invalidateExport()
        sourceBackup = sourceStore
        sourceStore = source
        let json = String(decoding: try JSONSerialization.data(withJSONObject: ["width": source.width, "height": source.height,
            "encoding": source.encoding, "suggestedColorSpace": source.colorSpace]), as: UTF8.self)
        runtime?.invokeMethod("attachSource", withArguments: [json]); try checkException()
    }
    func commitSource() { runtime?.invokeMethod("commitSource", withArguments: []); sourceBackup = nil }
    func rollbackSource() { runtime?.invokeMethod("rollbackSource", withArguments: []); sourceStore = sourceBackup; sourceBackup = nil }
    func clearSource() { runtime?.invokeMethod("clearSource", withArguments: []); sourceStore = nil; invalidateExport() }
    func hibernate() {
        invalidateExport()
        if isBusy { purgePending = true }
        else {
            runtime?.invokeMethod("hibernate", withArguments: []); purgePending = false
            JSGarbageCollect(context.jsGlobalContextRef)
        }
    }
    func rawLookup() throws -> [Float] {
        guard let value = runtime?.invokeMethod("rawLookup", withArguments: []) else { throw GraphRuntimeError.message("RAW gamma table is missing") }
        try checkException()
        let bytes = try typedBytes(value)
        guard bytes.count == 65536 * 4 else { throw GraphRuntimeError.message("Invalid RAW gamma table") }
        return Array(bytes.bindMemory(to: Float.self))
    }
    func profileSpace(_ data: Data) throws -> String {
        let buffer = try arrayBuffer(count: data.count) { data.copyBytes(to: $0) }
        let value = runtime?.invokeMethod("profileSpace", withArguments: [buffer])?.toString() ?? ""
        try checkException(); return value
    }
    func originalPreview(edge: Int) throws -> (width: Int, height: Int) {
        guard let text = runtime?.invokeMethod("originalPreview", withArguments: [edge])?.toString(),
              let size = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Int],
              let width = size["width"], let height = size["height"] else { throw GraphRuntimeError.message("Original preview dimensions are missing") }
        try checkException(); return (width, height)
    }

    func prepareRemoval(_ mask: Data, width: Int, height: Int) throws -> Data {
        guard width > 0, height > 0, width <= 2048, height <= 2048, mask.count == width * height else {
            throw GraphRuntimeError.message("Invalid brush mask")
        }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: ["width": width, "height": height]), as: UTF8.self)
        let buffer = try arrayBuffer(count: mask.count) { mask.copyBytes(to: $0) }
        guard let input = runtime?.invokeMethod("removalInput", withArguments: [json, buffer]) else {
            throw GraphRuntimeError.message("Removal input is missing")
        }
        try checkException()
        let bytes = try typedBytes(input)
        return Data(bytes: bytes.baseAddress!, count: bytes.count)
    }
    func finishRemoval(_ result: Data) throws {
        let buffer = try arrayBuffer(count: result.count) { result.copyBytes(to: $0) }
        runtime?.invokeMethod("removalResult", withArguments: [buffer]); try checkException()
    }
    func removalPreview(candidate: Bool) throws {
        runtime?.invokeMethod("removalPreview", withArguments: [1600, candidate]); try checkException()
    }
    func removalAction(_ name: String, cursor: Int? = nil) throws -> Int {
        let result = runtime?.invokeMethod(name, withArguments: cursor.map { [$0] } ?? [])
        try checkException(); return Int(result?.toInt32() ?? 0)
    }

    init(queue: DispatchQueue, cancellation: NativeCancellation = NativeCancellation()) throws {
        guard let context = JSContext() else {
            throw GraphRuntimeError.message(Self.nativeMessage())
        }
        self.context = context; gpu = try NativeGPUHandle(); self.queue = queue; self.cancellation = cancellation
        #if SWIFT_PACKAGE
        resources = Bundle.module.bundleURL.appendingPathComponent("Resources")
        #else
        let owner = Bundle(for: NativeGraphRuntime.self)
        guard let url = owner.url(forResource: "ExposureHost", withExtension: "bundle")
            ?? Bundle.main.url(forResource: "ExposureHost", withExtension: "bundle") else {
            throw GraphRuntimeError.message("Native shader resources are missing")
        }
        resources = url
        #endif
        installBridge()
        let script = try String(contentsOf: resources.appendingPathComponent("renderer.js"), encoding: .utf8)
        context.evaluateScript(script, withSourceURL: URL(string: "exposure://renderer.js"))
        try checkException()
        runtime = context.evaluateScript("ExposureHost.createNativeRuntime(nativeHost)")
        try checkException()
        guard let runtime = runtime, !runtime.isUndefined,
              let catalog = runtime.invokeMethod("catalog", withArguments: [])?.toString() else {
            throw GraphRuntimeError.message("Could not initialize the canonical render host")
        }
        self.catalog = catalog
    }

    // The handle owner also releases Metal on a throwing initializer. JS
    // callbacks capture self weakly and cannot retain the runtime after close.

    func request(operation: String, params: [String: Any], width: Int, height: Int,
                 bits: Int = 8, cubeSize: Int = 33,
                 region: [String: Int]? = nil,
                 completion: @escaping (Result<Void, Error>) -> Void) throws {
        guard pending.isEmpty else { throw GraphRuntimeError.message("Native renderer is busy") }
        var request: [String: Any] = ["operation": operation, "params": params,
            "width": width, "height": height]
        if operation == "export" {
            request["measureWidth"] = previewWidth; request["measureHeight"] = previewHeight
            outputBits = bits == 16 ? 16 : 8
            let key = try JSONSerialization.data(withJSONObject: ["params": params, "width": width, "height": height, "bits": outputBits], options: .sortedKeys)
            if key == exportKey, let store = outputStore {
                outputRGBA = store.data
                queue.async { completion(.success(())) }; return
            }
            invalidateExport(); pendingExportKey = key
            exportRenderCount += 1
            outputStore = try NativeOutputStore(count: width * height * 4 * (outputBits / 8))
            outputRGBA = outputStore!.data
        }
        if operation == "cube" { request["size"] = cubeSize; outputCube = "" }
        if operation == "detail" { request["region"] = region; detailMetadata = nil }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        serial += 1; let id = serial
        pending[id] = completion
        runtime?.invokeMethod("request", withArguments: [id, json])
        if let exception = context.exception {
            context.exception = nil; pending.removeValue(forKey: id)
            throw GraphRuntimeError.message(exception.toString() ?? "Native host request failed")
        }
    }

    func releaseExport() { sourceRGBA = Data(); outputRGBA = Data(); outputCube = ""; sourceWidth = 0; sourceHeight = 0 }
    func invalidateExport() { exportKey = nil; pendingExportKey = nil; outputRGBA = Data(); outputStore = nil }

    var isBusy: Bool { !pending.isEmpty }

    func clearDepth() {
        invalidateExport()
        runtime?.invokeMethod("clearDepth", withArguments: [])
        depthReady = false
    }

    func prepareDepth() throws -> (data: Data, width: Int, height: Int) {
        guard let result = runtime?.invokeMethod("depthInput", withArguments: [previewWidth, previewHeight]),
              let value = result.forProperty("data") else { throw GraphRuntimeError.message("Depth input is missing") }
        try checkException()
        let width = Int(result.forProperty("width").toInt32()), height = Int(result.forProperty("height").toInt32())
        let bytes = try typedBytes(value)
        return (Data(bytes: bytes.baseAddress!, count: bytes.count), width, height)
    }

    func finishDepth(_ data: Data, width: Int, height: Int) throws {
        let buffer = try arrayBuffer(count: data.count) { data.copyBytes(to: $0) }
        runtime?.invokeMethod("depthResult", withArguments: [buffer, width, height])
        try checkException(); depthReady = true
    }

    func icc(_ name: String) throws -> Data {
        guard let value = runtime?.invokeMethod("icc", withArguments: [name]) else { throw GraphRuntimeError.message("ICC profile is missing") }
        try checkException()
        let bytes = try typedBytes(value)
        return Data(bytes: bytes.baseAddress!, count: bytes.count)
    }

    func focusPreview(_ params: [String: Any]) throws {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: params), as: UTF8.self)
        runtime?.invokeMethod("focusPreview", withArguments: [json]); try checkException()
    }

    func renderSize(_ params: [String: Any], width: Int, height: Int, requested: Int?, preview: Bool) throws -> Int {
        var request: [String: Any] = ["params": params, "width": width, "height": height, "preview": preview]
        if let requested = requested { request["requested"] = requested }
        let result = try hostCall("renderSize", request)
        guard let object = try JSONSerialization.jsonObject(with: Data(result.utf8)) as? [String: Any],
              let edge = object["longEdge"] as? NSNumber else { throw GraphRuntimeError.message("Native render dimensions are missing") }
        return edge.intValue
    }

    func controlState(_ params: [String: Any]) throws -> String {
        try hostCall("controls", params)
    }

    func patch(_ request: [String: Any]) throws -> String {
        try hostCall("patch", request)
    }

    private func hostCall(_ method: String, _ object: [String: Any]) throws -> String {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
        let value = runtime?.invokeMethod(method, withArguments: [json])
        try checkException()
        guard let value = value?.toString() else { throw GraphRuntimeError.message("Native control response is missing") }
        return value
    }

    private static func nativeMessage() -> String {
        exposure_last_error().map { String(cString: $0) } ?? "Native compute failed"
    }

    private func checkException() throws {
        if let exception = context.exception {
            context.exception = nil
            throw GraphRuntimeError.message(exception.toString() ?? "Native host initialization failed")
        }
    }

    private func fail(_ error: Error) {
        context.exception = JSValue(newErrorFromMessage: error.localizedDescription, in: context)
    }

    private func arrayBuffer(count: Int, fill: (UnsafeMutableRawBufferPointer) throws -> Void) throws -> JSValue {
        guard count > 0, count <= 256 * 1024 * 1024 else { throw GraphRuntimeError.message("Invalid native binary size") }
        let pointer = UnsafeMutableRawPointer.allocate(byteCount: count, alignment: 16)
        do { try fill(UnsafeMutableRawBufferPointer(start: pointer, count: count)) }
        catch { pointer.deallocate(); throw error }
        var exception: JSValueRef?
        let object = JSObjectMakeArrayBufferWithBytesNoCopy(context.jsGlobalContextRef, pointer, count,
            { bytes, _ in bytes?.deallocate() }, nil, &exception)
        if let exception = exception {
            // JavaScriptCore invokes the supplied deallocator even on failure.
            throw GraphRuntimeError.message(JSValue(jsValueRef: exception, in: context).toString())
        }
        guard let object = object else { throw GraphRuntimeError.message("Could not allocate native ArrayBuffer") }
        return JSValue(jsValueRef: object, in: context)
    }

    private func typedBytes(_ value: JSValue) throws -> UnsafeMutableRawBufferPointer {
        var exception: JSValueRef?
        guard let object = JSValueToObject(context.jsGlobalContextRef, value.jsValueRef, &exception), exception == nil else {
            throw GraphRuntimeError.message("Expected a typed array")
        }
        let count = JSObjectGetTypedArrayByteLength(context.jsGlobalContextRef, object, &exception)
        let pointer = JSObjectGetTypedArrayBytesPtr(context.jsGlobalContextRef, object, &exception)
        guard exception == nil, count > 0, let pointer = pointer else {
            throw GraphRuntimeError.message("Typed array has no native storage")
        }
        // Do not call JavaScriptCore while this ephemeral pointer is in use.
        return UnsafeMutableRawBufferPointer(start: pointer, count: count)
    }

    private func installBridge() {
        let command: @convention(block) (String) -> String = { [weak self] json in
            guard let self = self else { return "{\"error\":\"Native renderer closed\"}" }
            return json.withCString { request in
                dichroic_gpu_execute(self.handle, request).map { String(cString: $0) }
                    ?? "{\"error\":\"Native descriptor failed\"}"
            }
        }
        let upload: @convention(block) (Double, Double, JSValue) -> Void = { [weak self] id, offset, value in
            guard let self = self else { return }
            do {
                let bytes = try self.typedBytes(value)
                let status = dichroic_gpu_upload(self.handle, UInt64(id), UInt64(offset), bytes.baseAddress?.assumingMemoryBound(to: UInt8.self), bytes.count)
                guard status == 0 else { throw GraphRuntimeError.message(Self.nativeMessage()) }
            } catch { self.fail(error) }
        }
        let read: @convention(block) (Double, Double, Int) -> JSValue? = { [weak self] id, offset, count in
            guard let self = self else { return nil }
            do { return try self.arrayBuffer(count: count) { bytes in
                guard dichroic_gpu_read(self.handle, UInt64(id), UInt64(offset), bytes.baseAddress?.assumingMemoryBound(to: UInt8.self), count) == 0
                    else { throw GraphRuntimeError.message(Self.nativeMessage()) }
            } } catch { self.fail(error); return nil }
        }
        let asset: @convention(block) (String) -> JSValue? = { [weak self] name in
            guard let self = self else { return nil }
            do {
                let data = try Data(contentsOf: self.assetURL(name), options: .mappedIfSafe)
                return try self.arrayBuffer(count: data.count) { output in data.copyBytes(to: output) }
            } catch { self.fail(error); return nil }
        }
        let text: @convention(block) (String) -> String? = { [weak self] name in
            guard let self = self else { return nil }
            do { return try String(contentsOf: self.assetURL(name), encoding: .utf8) }
            catch { self.fail(error); return nil }
        }
        let input: @convention(block) () -> JSValue? = { [weak self] in
            guard let self = self else { return nil }
            do { return try self.arrayBuffer(count: self.previewRGBA.count * 4) { raw in
                let output = raw.bindMemory(to: Float.self)
                self.previewRGBA.withUnsafeBytes { bytes in
                    let source = bytes.bindMemory(to: UInt8.self)
                    for i in 0..<source.count { output[i] = Float(source[i]) / 255 }
                }
            } } catch { self.fail(error); return nil }
        }
        let region: @convention(block) (Int, Int, Int, Int, JSValue) -> Void = { [weak self] x, y, width, height, destination in
            guard let self = self else { return }
            do {
                guard let source = self.sourceStore, x >= 0, y >= 0, width > 0, height > 0,
                      x + width <= source.width, y + height <= source.height, width * height * 16 <= 4 * 1024 * 1024 else {
                    throw GraphRuntimeError.message("Invalid native source region")
                }
                let output = try self.typedBytes(destination)
                guard output.count >= width * height * 16 else { throw GraphRuntimeError.message("Source strip storage is too small") }
                    let floats = output.bindMemory(to: Float.self)
                    source.data.withUnsafeBytes { raw in
                        for row in 0..<height { for col in 0..<width { for c in 0..<4 {
                            floats[(row * width + col) * 4 + c] = source.value(raw, pixel: (row + y) * source.width + col + x, channel: c)
                        } } }
                    }
            } catch { self.fail(error) }
        }
        let samples: @convention(block) (JSValue) -> JSValue? = { [weak self] bounds in
            guard let self = self else { return nil }
            do {
                guard let source = self.sourceStore, let b = bounds.toDictionary() as? [String: Int],
                      let x = b["x"], let y = b["y"], let width = b["width"], let height = b["height"],
                      x >= 0, y >= 0, width > 0, height > 0, x + width <= source.width, y + height <= source.height else {
                    throw GraphRuntimeError.message("Invalid removal sample region")
                }
                return try self.arrayBuffer(count: 512 * 512 * 16) { output in
                    let floats = output.bindMemory(to: Float.self)
                    source.data.withUnsafeBytes { raw in
                        for j in 0..<512 { for i in 0..<512 {
                            let sx = min(source.width - 1, x + Int(floor((Double(i) + 0.5) * Double(width) / 512)))
                            let sy = min(source.height - 1, y + Int(floor((Double(j) + 0.5) * Double(height) / 512)))
                            for c in 0..<4 { floats[(j * 512 + i) * 4 + c] = source.value(raw, pixel: sy * source.width + sx, channel: c) }
                        } }
                    }
                }
            } catch { self.fail(error); return nil }
        }
        let publish: @convention(block) (JSValue, Int, Int) -> Void = { [weak self] value, width, height in
            guard let self = self else { return }
            do {
                let raw = try self.typedBytes(value)
                guard raw.count == width * height * 3 * 4 else { throw GraphRuntimeError.message("Invalid preview readback") }
                let input = raw.bindMemory(to: Float.self)
                var rgba = Data(count: width * height * 4)
                rgba.withUnsafeMutableBytes { output in
                    let bytes = output.bindMemory(to: UInt8.self)
                    for pixel in 0..<(width * height) {
                        for c in 0..<3 { bytes[pixel * 4 + c] = Self.quantize(input[pixel * 3 + c]) }
                        bytes[pixel * 4 + 3] = 255
                    }
                }
                try self.onPublish?(rgba, width, height)
            } catch { self.fail(error) }
        }
        let detail: @convention(block) (JSValue, JSValue, String) -> Void = { [weak self] value, original, json in
            guard let self = self else { return }
            do {
                guard let meta = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Int],
                      let width = meta["width"], let height = meta["height"], width > 0, height > 0, width * height <= 1_600_000 else {
                    throw GraphRuntimeError.message("Invalid detail dimensions")
                }
                let raw = try self.typedBytes(value)
                guard raw.count == width * height * 12 else { throw GraphRuntimeError.message("Invalid detail readback") }
                let floats = raw.bindMemory(to: Float.self)
                var rgba = Data(count: width * height * 4)
                rgba.withUnsafeMutableBytes { (output: UnsafeMutableRawBufferPointer) in
                    for p in 0..<(width * height) {
                        for c in 0..<3 { output[p * 4 + c] = Self.quantize(floats[p * 3 + c]) }
                        output[p * 4 + 3] = 255
                    }
                }
                let before = try self.typedBytes(original)
                guard before.count == rgba.count else { throw GraphRuntimeError.message("Invalid original detail pixels") }
                let originalData = Data(bytes: before.baseAddress!, count: before.count)
                try self.onDetail?(rgba, originalData, width, height)
                self.detailMetadata = meta
            } catch { self.fail(error) }
        }
        let source: @convention(block) (JSValue, JSValue) -> Void = { [weak self] tile, value in
            guard let self = self else { return }
            do {
                // Read descriptor before acquiring ephemeral typed-array storage.
                let rect = try self.tile(tile, prefix: "tile")
                let raw = try self.typedBytes(value)
                guard raw.count == rect.width * rect.height * 16, self.sourceRGBA.count == self.sourceWidth * self.sourceHeight * 4,
                      rect.x >= 0, rect.y >= 0, rect.x + rect.width <= self.sourceWidth, rect.y + rect.height <= self.sourceHeight
                    else { throw GraphRuntimeError.message("Invalid export source tile") }
                let floats = raw.bindMemory(to: Float.self)
                self.sourceRGBA.withUnsafeBytes { rawSource in
                    let bytes = rawSource.bindMemory(to: UInt8.self)
                    for row in 0..<rect.height { for x in 0..<rect.width {
                        let origin = ((row + rect.y) * self.sourceWidth + x + rect.x) * 4
                        let destination = (row * rect.width + x) * 4
                        for c in 0..<4 { floats[destination + c] = Float(bytes[origin + c]) / 255 }
                    } }
                }
            } catch { self.fail(error) }
        }
        let output: @convention(block) (JSValue, JSValue) -> Void = { [weak self] tile, value in
            guard let self = self else { return }
            do {
                let rect = try self.tile(tile, prefix: "active")
                let raw = try self.typedBytes(value)
                guard raw.count == rect.width * rect.height * 12, let storage = self.outputStore,
                      storage.count == self.sourceWidth * self.sourceHeight * 4 * (self.outputBits / 8),
                      rect.x >= 0, rect.y >= 0, rect.x + rect.width <= self.sourceWidth, rect.y + rect.height <= self.sourceHeight
                    else { throw GraphRuntimeError.message("Invalid export output tile") }
                let floats = raw.bindMemory(to: Float.self)
                let bytes = UnsafeMutableRawBufferPointer(start: storage.pointer, count: storage.count)
                    let output = bytes.bindMemory(to: UInt8.self), output16 = bytes.bindMemory(to: UInt16.self)
                    for row in 0..<rect.height { for x in 0..<rect.width {
                        let origin = (row * rect.width + x) * 3
                        let destination = ((row + rect.y) * self.sourceWidth + x + rect.x) * 4
                        if self.outputBits == 16 {
                            for c in 0..<3 { output16[destination + c] = Self.quantize16(floats[origin + c]) }
                            output16[destination + 3] = 65535
                        } else {
                            for c in 0..<3 { output[destination + c] = Self.quantize(floats[origin + c]) }
                            output[destination + 3] = 255
                        }
                    } }
            } catch { self.fail(error) }
        }
        let progress: @convention(block) (Int, Int) -> Void = { [weak self] done, total in self?.onProgress?(done, total) }
        let original: @convention(block) (JSValue, Int, Int) -> Void = { [weak self] value, width, height in
            guard let self = self else { return }
            do {
                let raw = try self.typedBytes(value)
                guard width > 0, height > 0, raw.count == width * height * 12 else { throw GraphRuntimeError.message("Invalid original preview") }
                let floats = raw.bindMemory(to: Float.self)
                var rgba = Data(count: width * height * 4)
                rgba.withUnsafeMutableBytes { output in
                    let bytes = output.bindMemory(to: UInt8.self)
                    for p in 0..<(width * height) {
                        for c in 0..<3 { bytes[p * 4 + c] = Self.quantize(floats[p * 3 + c]) }
                        bytes[p * 4 + 3] = 255
                    }
                }
                self.previewRGBA = rgba; self.previewWidth = width; self.previewHeight = height
                try self.onOriginal?(rgba, width, height)
            } catch { self.fail(error) }
        }
        let savePatch: @convention(block) (JSValue) -> Int = { [weak self] value in
            guard let self, let source = self.sourceStore else { return -1 }
            do {
                let bytes = try self.typedBytes(value)
                return try source.saveRemoval(Data(bytes: bytes.baseAddress!, count: bytes.count))
            } catch { self.fail(error); return -1 }
        }
        let loadPatch: @convention(block) (Int) -> JSValue? = { [weak self] id in
            guard let self, let source = self.sourceStore else { return nil }
            do {
                let bytes = try source.loadRemoval(id)
                return try self.arrayBuffer(count: bytes.count) { bytes.copyBytes(to: $0) }
            } catch { self.fail(error); return nil }
        }
        let cube: @convention(block) (String) -> Void = { [weak self] text in self?.outputCube = text }
        let mask: @convention(block) (JSValue, Int, Int) -> Void = { [weak self] value, width, height in
            guard let self = self else { return }
            do {
                let bytes = try self.typedBytes(value)
                let data = Data(bytes: bytes.baseAddress!, count: bytes.count)
                try self.onMask?(data, width, height)
            } catch { self.fail(error) }
        }
        let complete: @convention(block) (Int, String) -> Void = { [weak self] id, json in
            guard let self = self, let completion = self.pending.removeValue(forKey: id) else { return }
            // Yield outside the JS call stack before the caller can destroy a
            // runtime, start another operation, or change its source buffers.
            let error = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
            let result: Result<Void, Error> = error?["error"].map { .failure(GraphRuntimeError.message(String(describing: $0))) } ?? .success(())
            if let key = self.pendingExportKey {
                if case .success = result { self.exportKey = key; self.pendingExportKey = nil }
                else { self.invalidateExport() }
            }
            self.queue.async {
                if self.purgePending { self.hibernate() }
                JSGarbageCollect(self.context.jsGlobalContextRef)
                completion(result)
            }
        }
        let timer: @convention(block) (JSValue, Double) -> Void = { [weak self] callback, delay in
            guard let self = self else { return }
            self.queue.asyncAfter(deadline: .now() + max(0, min(delay, 1000)) / 1000) { [weak self] in
                guard let self else { return }
                // Tile boundary: the JS stack has yielded and old source-strip
                // buffers can be reclaimed before the next GPU submission.
                JSGarbageCollect(self.context.jsGlobalContextRef)
                callback.call(withArguments: [])
            }
        }
        let cancelled: @convention(block) () -> Bool = { [weak self] in self?.cancellation.value ?? true }
        for (name, block) in ["nativeCommand": command as Any, "nativeUpload": upload as Any,
            "nativeCancelled": cancelled as Any,
            "nativeRead": read as Any, "nativeAsset": asset as Any, "nativeText": text as Any,
            "nativeInput": input as Any, "nativePublish": publish as Any, "nativeSource": source as Any,
            "nativeOutput": output as Any, "nativeProgress": progress as Any, "nativeComplete": complete as Any, "nativeMask": mask as Any,
            "nativeRegion": region as Any, "nativeSamples": samples as Any,
            "nativeSavePatch": savePatch as Any, "nativeLoadPatch": loadPatch as Any,
            "nativeCube": cube as Any,
            "nativeOriginal": original as Any,
            "nativeDetail": detail as Any,
            "setTimeout": timer as Any] { context.setObject(block, forKeyedSubscript: name as NSString) }
        context.evaluateScript("""
            var nativeReadStrip = new Float32Array(1024 * 1024);
            var nativeHost = { command: nativeCommand, upload: nativeUpload, read: nativeRead,
                readAsset: nativeAsset, readText: nativeText, previewInput: () => new Float32Array(nativeInput()),
                publish: nativePublish, sourceTile: nativeSource, outputTile: nativeOutput,
                progress: nativeProgress, complete: nativeComplete, publishMask: nativeMask, publishCube: nativeCube, publishOriginal: nativeOriginal, publishDetail: nativeDetail,
                sourceRegion: (x,y,w,h) => { nativeRegion(x,y,w,h,nativeReadStrip); return nativeReadStrip.subarray(0,w*h*4); },
                sourceSamples: b => new Float32Array(nativeSamples(b)),
                saveRemoval: v => { const id = nativeSavePatch(v); if (id < 0) throw new Error('Could not save removal history'); return id; },
                loadRemoval: id => new Float32Array(nativeLoadPatch(id)), isCancelled: nativeCancelled };
            """)
    }

    private func assetURL(_ name: String) throws -> URL {
        let url = resources.appendingPathComponent(name).standardizedFileURL
        guard url.path.hasPrefix(resources.standardizedFileURL.path + "/") else {
            throw GraphRuntimeError.message("Invalid native asset path")
        }
        return url
    }

    private func tile(_ value: JSValue, prefix: String) throws -> (x: Int, y: Int, width: Int, height: Int) {
        guard let dictionary = value.toDictionary() as? [String: Any],
              let x = dictionary[prefix + "OriginX"] as? NSNumber,
              let y = dictionary[prefix + "OriginY"] as? NSNumber,
              let width = dictionary[prefix + "Width"] as? NSNumber,
              let height = dictionary[prefix + "Height"] as? NSNumber,
              width.intValue > 0, height.intValue > 0 else { throw GraphRuntimeError.message("Invalid native tile descriptor") }
        return (x.intValue, y.intValue, width.intValue, height.intValue)
    }

    private static func quantize(_ value: Float) -> UInt8 {
        guard !value.isNaN else { return 0 }
        return UInt8((min(1, max(0, value)) * 255).rounded())
    }
    private static func quantize16(_ value: Float) -> UInt16 {
        guard !value.isNaN else { return 0 }
        return UInt16((min(1, max(0, value)) * 65535).rounded())
    }
}
