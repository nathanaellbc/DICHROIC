import Foundation
import Accelerate
import ExposureNative

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
    let metadata: [CFString: Any]
    private var patches: [Int: URL] = [:]
    private var patchSerial = 0

    func saveRemoval(_ data: Data) throws -> Int {
        guard data.count == 512 * 512 * 16 else { throw GraphRuntimeError.message("Invalid removal history") }
        let file = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-patch-\(UUID().uuidString).f32")
        try data.write(to: file, options: .atomic)
        patchSerial += 1; patches[patchSerial] = file
        return patchSerial
    }
    func loadRemoval(_ id: Int) throws -> Data {
        guard let file = patches[id] else { throw GraphRuntimeError.message("Removal history is missing") }
        let data = try Data(contentsOf: file, options: .alwaysMapped)
        guard data.count == 512 * 512 * 16 else { throw GraphRuntimeError.message("Removal history is truncated") }
        return data
    }

    init(rgba: Data, width: Int, height: Int) throws {
        guard width > 0, height > 0, rgba.count == width * height * 4 else {
            throw GraphRuntimeError.message("Invalid native source storage")
        }
        self.width = width; self.height = height
        bits = 8; channels = 4; colorSpace = "sRGB"; encoding = "encoded"; lookup = nil
        byteOffset = 0; bigEndian = false
        metadata = [:]
        url = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-source-\(UUID().uuidString).rgba")
        do {
            try rgba.write(to: url)
            data = try Data(contentsOf: url, options: .alwaysMapped)
        } catch { try? FileManager.default.removeItem(at: url); throw error }
    }
    init(url: URL, width: Int, height: Int, bits: Int, channels: Int, colorSpace: String, encoding: String, lookup: [Float]? = nil, byteOffset: Int = 0, bigEndian: Bool = false, metadata: [CFString: Any] = [:]) throws {
        guard width > 0, height > 0, width * height <= 50_000_000, [8, 16, 32].contains(bits), [1, 3, 4].contains(channels),
              lookup == nil || lookup?.count == 65536 else { throw GraphRuntimeError.message("Invalid native source description") }
        self.url = url; self.width = width; self.height = height; self.bits = bits; self.channels = channels
        self.colorSpace = colorSpace; self.encoding = encoding; self.lookup = lookup
        self.byteOffset = byteOffset; self.bigEndian = bigEndian
        self.metadata = metadata
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
    func copyRegion(x: Int, y: Int, width: Int, height: Int, into output: UnsafeMutableBufferPointer<Float>) {
        data.withUnsafeBytes { raw in
            for row in 0..<height {
                let origin = ((row + y) * self.width + x) * channels
                let destination = output.baseAddress! + row * width * 4
                if channels == 4 && bits == 32 && !bigEndian {
                    memcpy(destination, raw.baseAddress! + byteOffset + origin * 4, width * 16)
                } else if channels == 4 && bits == 8 {
                    let source = raw.baseAddress!.assumingMemoryBound(to: UInt8.self) + byteOffset + origin
                    vDSP_vfltu8(source, 1, destination, 1, vDSP_Length(width * 4))
                    // Retain correctly rounded Float division, as in value().
                    for i in 0..<(width * 4) { destination[i] /= 255 }
                } else {
                    for col in 0..<width { for c in 0..<4 {
                        destination[col * 4 + c] = value(raw, pixel: (row + y) * self.width + col + x, channel: c)
                    } }
                }
            }
        }
    }
    func copyBox(_ region: [String: Int], into output: UnsafeMutableBufferPointer<Float>) throws {
        var descriptor: [String: Any] = region
        descriptor["sourceWidth"] = width; descriptor["sourceHeight"] = height
        descriptor["bits"] = bits; descriptor["channels"] = channels
        descriptor["byteOffset"] = byteOffset; descriptor["bigEndian"] = bigEndian
        let json = String(decoding: try JSONSerialization.data(withJSONObject: descriptor), as: UTF8.self)
        let status = data.withUnsafeBytes { bytes in
            json.withCString { request in
                if let lookup {
                    return lookup.withUnsafeBufferPointer { table in
                        dichroic_source_box(bytes.baseAddress!.assumingMemoryBound(to: UInt8.self), bytes.count,
                            table.baseAddress, table.count, request, output.baseAddress, output.count)
                    }
                }
                return dichroic_source_box(bytes.baseAddress!.assumingMemoryBound(to: UInt8.self), bytes.count,
                    nil, 0, request, output.baseAddress, output.count)
            }
        }
        guard status == 0 else {
            throw GraphRuntimeError.message(exposure_last_error().map { String(cString: $0) } ?? "Source box read failed")
        }
    }
    deinit {
        for file in patches.values { try? FileManager.default.removeItem(at: file) }
        try? FileManager.default.removeItem(at: url)
    }
}
