import Foundation
#if canImport(OnnxRuntimeBindings)
import OnnxRuntimeBindings
#else
import onnxruntime_objc
#endif

/// ONNX Runtime sessions for the canonical host (`src/native/ort.ts`): the
/// web's depth and matte code opens, runs and releases them through the
/// JavaScriptCore bridge. Used only on the render queue.
final class NativeOnnx {
    private var environment: ORTEnv?
    private var sessions: [Int: ORTSession] = [:]
    private var serial = 0
    private var outputs: [Data] = []
    /// Download progress in bytes (phase "model").
    var onDownload: ((Int, Int) -> Void)?

    /// Session id, or -1 when the model is missing and downloads are not allowed.
    func open(url: String, bytes: Int, allowDownload: Bool, gpu: Bool) throws -> Int {
        guard let remote = URL(string: url), remote.host == "huggingface.co", bytes > 0 else {
            throw GraphRuntimeError.message("Invalid model address")
        }
        if !allowDownload && !NativeModels.isStored(remote, bytes: bytes) { return -1 }
        let file = try NativeModels.fetch(remote, bytes: bytes, progress: onDownload)
        let environment = try self.environment ?? ORTEnv(loggingLevel: .warning)
        self.environment = environment
        let session: ORTSession
        do {
            session = try ORTSession(env: environment, modelPath: file.path, sessionOptions: try NativeModels.sessionOptions(gpu: gpu))
        } catch {
            // Core ML can refuse a graph; the CPU always works.
            guard gpu else { throw error }
            session = try ORTSession(env: environment, modelPath: file.path, sessionOptions: try NativeModels.sessionOptions(gpu: false))
        }
        serial += 1
        sessions[serial] = session
        return serial
    }

    func names(_ id: Int) throws -> String {
        guard let session = sessions[id] else { throw GraphRuntimeError.message("ONNX session is closed") }
        let object: [String: [String]] = ["inputs": try session.inputNames(), "outputs": try session.outputNames()]
        return String(decoding: try JSONSerialization.data(withJSONObject: object), as: UTF8.self)
    }

    /// Runs one inference; outputs are kept until the next run (`output`).
    func run(_ id: Int, meta: [[String: Any]], inputs: [Data]) throws -> String {
        guard let session = sessions[id] else { throw GraphRuntimeError.message("ONNX session is closed") }
        guard meta.count == inputs.count else { throw GraphRuntimeError.message("Invalid model inputs") }
        return try autoreleasepool {
            var feeds: [String: ORTValue] = [:]
            for (item, data) in zip(meta, inputs) {
                guard let name = item["name"] as? String, let dims = item["dims"] as? [NSNumber] else {
                    throw GraphRuntimeError.message("Invalid model input description")
                }
                let type: ORTTensorElementDataType = item["type"] as? String == "int64" ? .int64 : .float
                feeds[name] = try ORTValue(tensorData: NSMutableData(data: data), elementType: type, shape: dims)
            }
            let names = try session.outputNames()
            let values = try session.run(withInputs: feeds, outputNames: Set(names), runOptions: nil)
            var described: [[String: Any]] = []
            outputs = []
            for name in names {
                guard let value = values[name] else { continue }
                let info = try value.tensorTypeAndShapeInfo()
                let data = try value.tensorData()
                outputs.append(Data(bytes: data.bytes, count: data.length))
                described.append(["name": name, "type": info.elementType == .int64 ? "int64" : "float32", "dims": info.shape])
            }
            return String(decoding: try JSONSerialization.data(withJSONObject: described), as: UTF8.self)
        }
    }

    func output(_ index: Int) -> Data? { outputs.indices.contains(index) ? outputs[index] : nil }

    func close(_ id: Int) {
        sessions.removeValue(forKey: id)
        if sessions.isEmpty { outputs = []; environment = nil }
    }

    func closeAll() { sessions.removeAll(); outputs = []; environment = nil }
}
