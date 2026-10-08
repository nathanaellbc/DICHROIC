import Foundation
import RawNative

enum NativeRawSource {
    static let extensions: Set<String> = ["arw", "dng", "cr2", "cr3", "nef", "nrw", "raf", "rw2", "orf", "pef", "srw", "raw", "iiq", "3fr", "fff", "rwl", "mos", "mrw", "kdc", "dcr", "erf", "srf", "sr2"]

    static func decode(_ url: URL, lookup: [Float]) throws -> NativeSourceStore {
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-raw-\(UUID().uuidString).rgb16")
        var info = DichroicRawInfo()
        let status = url.path.withCString { source in output.path.withCString { destination in
            dichroic_raw_decode(source, destination, &info)
        } }
        guard status == 0 else {
            try? FileManager.default.removeItem(at: output)
            throw GraphRuntimeError.message(dichroic_raw_error().map { String(cString: $0) } ?? "RAW decoder failed")
        }
        do {
            return try NativeSourceStore(url: output, width: Int(info.width), height: Int(info.height), bits: Int(info.bits),
                channels: Int(info.channels), colorSpace: "ACES2065-1", encoding: "linear", lookup: lookup, byteOffset: Int(info.byte_offset), bigEndian: true)
        } catch { try? FileManager.default.removeItem(at: output); throw error }
    }
}
