import Foundation

/// Immutable, file-backed source bytes. Sparse floating-point removal patches
/// live in the canonical host; decoding/export never duplicates a full float
/// photo and Before continues to reference the untouched import.
final class NativeSourceStore {
    let url: URL
    let data: Data
    let width: Int
    let height: Int

    init(rgba: Data, width: Int, height: Int) throws {
        guard width > 0, height > 0, rgba.count == width * height * 4 else {
            throw GraphRuntimeError.message("Invalid native source storage")
        }
        self.width = width; self.height = height
        url = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-source-\(UUID().uuidString).rgba")
        do {
            try rgba.write(to: url)
            data = try Data(contentsOf: url, options: .alwaysMapped)
        } catch { try? FileManager.default.removeItem(at: url); throw error }
    }
    deinit { try? FileManager.default.removeItem(at: url) }
}
