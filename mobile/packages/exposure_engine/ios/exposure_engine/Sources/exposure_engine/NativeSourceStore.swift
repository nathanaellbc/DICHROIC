import Foundation

/// Immutable, file-backed source bytes. Sparse floating-point removal patches
/// live in the canonical host; decoding/export never duplicates a full float
/// photo and Before continues to reference the untouched import.
final class NativeSourceStore {
    let url: URL
    let data: Data
    let width: Int
    let height: Int
    let bits: Int
    let channels: Int
    let colorSpace: String
    let encoding: String
    let lookup: [Float]?
    let byteOffset: Int
    let bigEndian: Bool

    init(rgba: Data, width: Int, height: Int) throws {
        guard width > 0, height > 0, rgba.count == width * height * 4 else {
            throw GraphRuntimeError.message("Invalid native source storage")
        }
        self.width = width; self.height = height
        bits = 8; channels = 4; colorSpace = "sRGB"; encoding = "encoded"; lookup = nil
        byteOffset = 0; bigEndian = false
        url = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-source-\(UUID().uuidString).rgba")
        do {
            try rgba.write(to: url)
            data = try Data(contentsOf: url, options: .alwaysMapped)
        } catch { try? FileManager.default.removeItem(at: url); throw error }
    }
    init(url: URL, width: Int, height: Int, bits: Int, channels: Int, colorSpace: String, encoding: String, lookup: [Float]? = nil, byteOffset: Int = 0, bigEndian: Bool = false) throws {
        guard width > 0, height > 0, width * height <= 50_000_000, [8, 16, 32].contains(bits), [1, 3, 4].contains(channels),
              lookup == nil || lookup?.count == 65536 else { throw GraphRuntimeError.message("Invalid native source description") }
        self.url = url; self.width = width; self.height = height; self.bits = bits; self.channels = channels
        self.colorSpace = colorSpace; self.encoding = encoding; self.lookup = lookup
        self.byteOffset = byteOffset; self.bigEndian = bigEndian
        data = try Data(contentsOf: url, options: .alwaysMapped)
        guard byteOffset >= 0, data.count == byteOffset + width * height * channels * (bits / 8) else { throw GraphRuntimeError.message("Source pixel file is truncated") }
    }
    func value(_ raw: UnsafeRawBufferPointer, pixel: Int, channel: Int) -> Float {
        if channel == 3 && channels != 4 { return 1 }
        let c = channels == 1 ? 0 : channel, index = pixel * channels + c
        if bits == 8 { return Float(raw[byteOffset + index]) / 255 }
        if bits == 16 {
            let value = raw.loadUnaligned(fromByteOffset: byteOffset + index * 2, as: UInt16.self)
            let code = bigEndian ? UInt16(bigEndian: value) : value
            return lookup?[Int(code)] ?? Float(code) / 65535
        }
        return raw.loadUnaligned(fromByteOffset: byteOffset + index * 4, as: Float.self)
    }
    deinit { try? FileManager.default.removeItem(at: url) }
}
