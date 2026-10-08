import Foundation
import CryptoKit
import onnxruntime_objc

/// Identical pinned ONNX weights to the web app. CPU sessions are scoped to
/// one operation, so the model's allocator is reclaimed before development.
enum NativeModels {
    private static var verified = Set<URL>()
    private static func valid(_ file: URL, remote: URL) throws -> Bool {
        let depth = remote == depthURL
        let size = depth ? 27258801 : 62074990
        let expected = depth ? "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d" : "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe"
        guard (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) == size else { return false }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined() == expected
    }
    static let depthURL = URL(string: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx")!
    static let lamaURL = URL(string: "https://huggingface.co/g-ronimo/lama/resolve/418036c6b541e526cdbb0bead1ec3a87dabede53/lama_512_int8.onnx")!

    static func model(_ remote: URL, name: String) throws -> URL {
        let directory = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DichroicModels", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = directory.appendingPathComponent(name)
        if verified.contains(destination) { return destination }
        if FileManager.default.fileExists(atPath: destination.path) {
            if try valid(destination, remote: remote) { verified.insert(destination); return destination }
            try FileManager.default.removeItem(at: destination)
        }
        let semaphore = DispatchSemaphore(value: 0)
        var outcome: Result<Void, Error> = .failure(GraphRuntimeError.message("Model download did not complete"))
        let task = URLSession.shared.downloadTask(with: remote) { url, response, error in
            defer { semaphore.signal() }
            do {
                if let error = error { throw error }
                guard let url = url, let response = response as? HTTPURLResponse, response.statusCode == 200 else {
                    throw GraphRuntimeError.message("Model download failed. Try again when connected.")
                }
                guard try valid(url, remote: remote) else { throw GraphRuntimeError.message("Model download is incomplete. Please retry.") }
                try FileManager.default.moveItem(at: url, to: destination)
                outcome = .success(())
            } catch { outcome = .failure(error) }
        }
        task.resume()
        guard semaphore.wait(timeout: .now() + 300) == .success else {
            task.cancel(); throw GraphRuntimeError.message("Model download timed out. Try again when connected.")
        }
        try outcome.get(); verified.insert(destination); return destination
    }

    static func infer(model: URL, input: Data, shape: [Int]) throws -> (data: Data, shape: [Int]) {
        try autoreleasepool {
            let environment = try ORTEnv(loggingLevel: .warning)
            let options = try ORTSessionOptions()
            try options.setIntraOpNumThreads(2)
            try options.setGraphOptimizationLevel(.all)
            try options.addConfigEntry(withKey: "session.use_env_allocators", value: "0")
            let session = try ORTSession(env: environment, modelPath: model.path, sessionOptions: options)
            guard let inputName = try session.inputNames().first, let outputName = try session.outputNames().first else {
                throw GraphRuntimeError.message("Model tensor names are missing")
            }
            let storage = NSMutableData(data: input)
            let tensor = try ORTValue(tensorData: storage, elementType: .float, shape: shape.map { NSNumber(value: $0) })
            let values = try session.run(withInputs: [inputName: tensor], outputNames: Set([outputName]), runOptions: nil)
            guard let output = values[outputName] else { throw GraphRuntimeError.message("Model output is missing") }
            let bytes = try output.tensorData()
            return (Data(bytes: bytes.bytes, count: bytes.length), try output.tensorTypeAndShapeInfo().shape.map { $0.intValue })
        }
    }
}
