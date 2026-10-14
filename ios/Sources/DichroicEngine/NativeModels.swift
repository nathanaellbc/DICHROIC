import Foundation
import CryptoKit
#if canImport(OnnxRuntimeBindings)
import OnnxRuntimeBindings
#else
import onnxruntime_objc
#endif

/// The same pinned ONNX weights as the web app, stored once per device in
/// Application Support. Sessions are scoped to one operation, so the model's
/// allocator is reclaimed before development.
enum NativeModels {
    private static var verified = Set<URL>()
    static let depthURL = URL(string: "https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/4472b7362082ad9968fee890ca0f1e5aca36b93d/onnx/model_quantized.onnx")!
    static let lamaURL = URL(string: "https://huggingface.co/g-ronimo/lama/resolve/418036c6b541e526cdbb0bead1ec3a87dabede53/lama_512_int8.onnx")!
    static let lamaBytes = 62_074_990

    /// SHA-256 of the files whose digest is known; the others are checked by size.
    private static let digests: [URL: String] = [
        depthURL: "fcf51f1b230362b28690bb9d1809bf0431f29cad20534e3f589bd7285547f20d",
        lamaURL: "cab19978adc306622fe37ef60d4a52103b99c98141d499c2a2366a7ed1255dbe",
    ]

    private static var directory: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("DichroicModels", isDirectory: true)
    }

    /// Local file of a pinned remote: repository, revision and file name.
    static func file(for remote: URL) -> URL {
        if remote == depthURL { return directory.appendingPathComponent("depth-4472b736-int8.onnx") }
        if remote == lamaURL { return directory.appendingPathComponent("lama-418036c6-int8.onnx") }
        let parts = remote.pathComponents.filter { $0 != "/" && $0 != "resolve" }
        let name = parts.joined(separator: "-").replacingOccurrences(of: "[^A-Za-z0-9._-]", with: "_", options: .regularExpression)
        return directory.appendingPathComponent(name)
    }

    /// Whether the model is on this device (size check; the hash is verified on load).
    static func isStored(_ remote: URL, bytes: Int) -> Bool {
        (try? file(for: remote).resourceValues(forKeys: [.fileSizeKey]).fileSize) == bytes
    }

    private static func valid(_ file: URL, remote: URL, bytes: Int) throws -> Bool {
        guard (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) == bytes else { return false }
        guard let expected = digests[remote] else { return true }
        let handle = try FileHandle(forReadingFrom: file)
        defer { try? handle.close() }
        var hash = SHA256()
        while let chunk = try handle.read(upToCount: 1024 * 1024), !chunk.isEmpty { hash.update(data: chunk) }
        return hash.finalize().map { String(format: "%02x", $0) }.joined() == expected
    }

    /// The model file, downloaded first when needed. `progress` reports bytes.
    static func fetch(_ remote: URL, bytes: Int, progress: ((Int, Int) -> Void)? = nil) throws -> URL {
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let destination = file(for: remote)
        if verified.contains(destination) { return destination }
        if FileManager.default.fileExists(atPath: destination.path) {
            if try valid(destination, remote: remote, bytes: bytes) { verified.insert(destination); return destination }
            try FileManager.default.removeItem(at: destination)
        }
        let download = Download(remote: remote, destination: destination, bytes: bytes, progress: progress)
        try download.run()
        guard try valid(destination, remote: remote, bytes: bytes) else {
            try? FileManager.default.removeItem(at: destination)
            throw GraphRuntimeError.message("Model download is incomplete. Please retry.")
        }
        verified.insert(destination)
        return destination
    }

    /// LaMa for Remove Object.
    static func lama() throws -> URL { try fetch(lamaURL, bytes: lamaBytes) }

    static func infer(model: URL, input: Data, shape: [Int]) throws -> (data: Data, shape: [Int]) {
        try autoreleasepool {
            let environment = try ORTEnv(loggingLevel: .warning)
            let session = try ORTSession(env: environment, modelPath: model.path, sessionOptions: try sessionOptions(gpu: false))
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

    /// CPU by default; `gpu` adds Core ML (GPU and Neural Engine) for the
    /// nodes it supports, as the web's depth GPU switch.
    static func sessionOptions(gpu: Bool) throws -> ORTSessionOptions {
        let options = try ORTSessionOptions()
        try options.setIntraOpNumThreads(2)
        try options.setGraphOptimizationLevel(.all)
        try options.addConfigEntry(withKey: "session.use_env_allocators", value: "0")
        if gpu { try options.appendCoreMLExecutionProvider(with: ORTCoreMLExecutionProviderOptions()) }
        return options
    }
}

/// One blocking download with byte progress, moved into place when complete.
private final class Download: NSObject, URLSessionDownloadDelegate {
    let remote: URL, destination: URL, bytes: Int
    let progress: ((Int, Int) -> Void)?
    private let done = DispatchSemaphore(value: 0)
    private var outcome: Result<Void, Error> = .failure(GraphRuntimeError.message("Model download did not complete"))

    init(remote: URL, destination: URL, bytes: Int, progress: ((Int, Int) -> Void)?) {
        self.remote = remote; self.destination = destination; self.bytes = bytes; self.progress = progress
    }

    func run() throws {
        let session = URLSession(configuration: .default, delegate: self, delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        let task = session.downloadTask(with: remote)
        task.resume()
        guard done.wait(timeout: .now() + 900) == .success else {
            task.cancel(); throw GraphRuntimeError.message("Model download timed out. Try again when connected.")
        }
        try outcome.get()
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didWriteData _: Int64,
                    totalBytesWritten written: Int64, totalBytesExpectedToWrite _: Int64) {
        progress?(Int(written), bytes)
    }

    func urlSession(_ session: URLSession, downloadTask: URLSessionDownloadTask, didFinishDownloadingTo location: URL) {
        do {
            guard let response = downloadTask.response as? HTTPURLResponse, response.statusCode == 200 else {
                throw GraphRuntimeError.message("Model download failed. Try again when connected.")
            }
            guard (try? location.resourceValues(forKeys: [.fileSizeKey]).fileSize) == bytes else {
                throw GraphRuntimeError.message("Model download is incomplete. Please retry.")
            }
            try? FileManager.default.removeItem(at: destination)
            try FileManager.default.moveItem(at: location, to: destination)
            outcome = .success(())
        } catch { outcome = .failure(error) }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        if let error { outcome = .failure(error) }
        done.signal()
    }
}
