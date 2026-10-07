import Foundation
import JavaScriptCore
import ExposureNative

enum GraphRuntimeError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let value) = self { return value }; return nil }
}

/// One runtime on the plugin's serial render queue. JavaScriptCore runs only
/// canonical host mathematics; wgpu executes the unchanged WGSL on Metal.
/// The bridge transfers typed-array storage directly, never JSON photo pixels.
final class NativeGraphRuntime {
    private let context: JSContext
    private let handle: UnsafeMutableRawPointer
    private let queue: DispatchQueue
    private let resources: URL
    private var runtime: JSValue?
    private var pending: [Int: (Result<Void, Error>) -> Void] = [:]
    private var serial = 0
    private(set) var catalog = ""
    var previewRGBA = Data()
    var previewWidth = 0
    var previewHeight = 0
    var sourceRGBA = Data()
    var sourceWidth = 0
    var sourceHeight = 0
    var outputRGBA = Data()
    var onPublish: ((Data, Int, Int) throws -> Void)?
    var onProgress: ((Int, Int) -> Void)?

    init(queue: DispatchQueue) throws {
        guard let context = JSContext(), let handle = dichroic_gpu_create(384 * 1024 * 1024) else {
            throw GraphRuntimeError.message(Self.nativeMessage())
        }
        self.context = context; self.handle = handle; self.queue = queue
        #if SWIFT_PACKAGE
        resources = Bundle.module.bundleURL.appendingPathComponent("Resources")
        #else
        let owner = Bundle(for: NativeGraphRuntime.self)
        guard let url = owner.url(forResource: "ExposureHost", withExtension: "bundle")
            ?? Bundle.main.url(forResource: "ExposureHost", withExtension: "bundle") else {
            dichroic_gpu_destroy(handle)
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

    deinit {
        // JS closures capture self weakly; the runtime does not own this object.
        // Metal handles are released even after a host exception during startup.
        dichroic_gpu_destroy(handle)
    }

    func request(operation: String, params: [String: Any], width: Int, height: Int,
                 completion: @escaping (Result<Void, Error>) -> Void) throws {
        guard pending.isEmpty else { throw GraphRuntimeError.message("Native renderer is busy") }
        var request: [String: Any] = ["operation": operation, "params": params,
            "width": width, "height": height]
        if operation == "export" {
            request["measureWidth"] = previewWidth; request["measureHeight"] = previewHeight
            outputRGBA = Data(count: width * height * 4)
        }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: request), as: UTF8.self)
        serial += 1; let id = serial
        pending[id] = completion
        runtime?.invokeMethod("request", withArguments: [id, json])
        if let exception = context.exception {
            context.exception = nil; pending.removeValue(forKey: id)
            throw GraphRuntimeError.message(exception.toString() ?? "Native host request failed")
        }
    }

    func releaseExport() { sourceRGBA = Data(); outputRGBA = Data(); sourceWidth = 0; sourceHeight = 0 }

    var isBusy: Bool { !pending.isEmpty }

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
                guard raw.count == rect.width * rect.height * 12, self.outputRGBA.count == self.sourceWidth * self.sourceHeight * 4,
                      rect.x >= 0, rect.y >= 0, rect.x + rect.width <= self.sourceWidth, rect.y + rect.height <= self.sourceHeight
                    else { throw GraphRuntimeError.message("Invalid export output tile") }
                let floats = raw.bindMemory(to: Float.self)
                self.outputRGBA.withUnsafeMutableBytes { bytes in
                    let output = bytes.bindMemory(to: UInt8.self)
                    for row in 0..<rect.height { for x in 0..<rect.width {
                        let origin = (row * rect.width + x) * 3
                        let destination = ((row + rect.y) * self.sourceWidth + x + rect.x) * 4
                        for c in 0..<3 { output[destination + c] = Self.quantize(floats[origin + c]) }
                        output[destination + 3] = 255
                    } }
                }
            } catch { self.fail(error) }
        }
        let progress: @convention(block) (Int, Int) -> Void = { [weak self] done, total in self?.onProgress?(done, total) }
        let complete: @convention(block) (Int, String) -> Void = { [weak self] id, json in
            guard let self = self, let completion = self.pending.removeValue(forKey: id) else { return }
            // Yield outside the JS call stack before the caller can destroy a
            // runtime, start another operation, or change its source buffers.
            let error = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
            let result: Result<Void, Error> = error?["error"].map { .failure(GraphRuntimeError.message(String(describing: $0))) } ?? .success(())
            self.queue.async { completion(result) }
        }
        let timer: @convention(block) (JSValue, Double) -> Void = { [weak self] callback, delay in
            guard let self = self else { return }
            self.queue.asyncAfter(deadline: .now() + max(0, min(delay, 1000)) / 1000) { [weak self] in
                guard self != nil else { return }; callback.call(withArguments: [])
            }
        }
        for (name, block) in ["nativeCommand": command as Any, "nativeUpload": upload as Any,
            "nativeRead": read as Any, "nativeAsset": asset as Any, "nativeText": text as Any,
            "nativeInput": input as Any, "nativePublish": publish as Any, "nativeSource": source as Any,
            "nativeOutput": output as Any, "nativeProgress": progress as Any, "nativeComplete": complete as Any,
            "setTimeout": timer as Any] { context.setObject(block, forKeyedSubscript: name as NSString) }
        context.evaluateScript("""
            var nativeHost = { command: nativeCommand, upload: nativeUpload, read: nativeRead,
                readAsset: nativeAsset, readText: nativeText, previewInput: () => new Float32Array(nativeInput()),
                publish: nativePublish, sourceTile: nativeSource, outputTile: nativeOutput,
                progress: nativeProgress, complete: nativeComplete };
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
        guard value.isFinite else { return 0 }
        return UInt8((min(1, max(0, value)) * 255).rounded())
    }
}
