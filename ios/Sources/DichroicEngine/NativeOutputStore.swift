import Foundation
import Darwin

/// Tile output lands in a file-backed mapping. 16-bit exports therefore do
/// not require a second full-photo heap allocation beside the decoded source.
final class NativeOutputStore {
    let url: URL
    let pointer: UnsafeMutableRawPointer
    let count: Int
    var data: Data { Data(bytesNoCopy: pointer, count: count, deallocator: .none) }

    init(count: Int) throws {
        guard count > 0, count <= 50_000_000 * 8 else { throw GraphRuntimeError.message("Invalid export storage size") }
        self.count = count
        url = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-output-\(UUID().uuidString).rgba")
        let fd = open(url.path, O_RDWR | O_CREAT | O_EXCL, S_IRUSR | S_IWUSR)
        guard fd >= 0 else { throw GraphRuntimeError.message("Could not create export storage") }
        defer { close(fd) }
        guard ftruncate(fd, off_t(count)) == 0 else {
            try? FileManager.default.removeItem(at: url); throw GraphRuntimeError.message("Not enough storage for export")
        }
        let mapping = mmap(nil, count, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0)
        guard let mapping = mapping, mapping != MAP_FAILED else {
            try? FileManager.default.removeItem(at: url); throw GraphRuntimeError.message("Could not map export storage")
        }
        pointer = mapping
    }
    deinit { munmap(pointer, count); try? FileManager.default.removeItem(at: url) }
}
