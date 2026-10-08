import Foundation
import ImageIO
import CoreGraphics

/// Retain decoded channel codes, bit depth and input gamut instead of drawing
/// the entire photo into an 8-bit sRGB CGContext. Orient rows directly into
/// the file-backed source; only one output row is allocated at a time.
enum NativeRasterSource {
    static func decode(_ url: URL, profileSpace: (Data) throws -> String) throws -> NativeSourceStore {
        try autoreleasepool {
            guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
                  let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
                  let w = (properties[kCGImagePropertyPixelWidth] as? NSNumber)?.intValue,
                  let h = (properties[kCGImagePropertyPixelHeight] as? NSNumber)?.intValue,
                  w > 0, h > 0, w <= 50_000, h <= 50_000, Int64(w) * Int64(h) <= 50_000_000,
                  let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldCache: false, kCGImageSourceShouldAllowFloat: true] as CFDictionary),
                  let provider = image.dataProvider?.data else {
                throw GraphRuntimeError.message("Open a supported photo of 50 MP or less")
            }
            let bits = image.bitsPerComponent, count = image.bitsPerPixel / bits, bytes = bits / 8
            let model = image.colorSpace?.model
            guard [8, 16, 32].contains(bits), model == .rgb || model == .monochrome, count >= 1, count <= 4,
                  image.bytesPerRow >= image.width * count * bytes,
                  CFDataGetLength(provider) >= image.bytesPerRow * image.height,
                  bits != 32 || image.bitmapInfo.contains(.floatComponents) else {
                throw GraphRuntimeError.message("This source pixel format is not supported by ImageIO")
            }
            let orientation = (properties[kCGImagePropertyOrientation] as? NSNumber)?.intValue ?? 1
            let rotated = (5...8).contains(orientation)
            let width = rotated ? image.height : image.width, height = rotated ? image.width : image.height
            let alpha = image.alphaInfo, first = alpha == .first || alpha == .premultipliedFirst || alpha == .noneSkipFirst
            let hasAlpha = [.first, .last, .premultipliedFirst, .premultipliedLast].contains(alpha)
            let premultiplied = alpha == .premultipliedFirst || alpha == .premultipliedLast
            let order = image.bitmapInfo.intersection(.byteOrderMask)
            let reversePixel = bits == 8 && count == 4 && order == .byteOrder32Little
            let bigEndian = bits == 16 ? order != .byteOrder16Little : bits == 32 && order == .byteOrder32Big
            var space = "sRGB"
            if let icc = image.colorSpace?.copyICCData() { space = try profileSpace(icc as Data) }
            if space.isEmpty { space = "sRGB" }
            let name = image.colorSpace?.name.map { $0 as String } ?? ""
            let floating = image.bitmapInfo.contains(.floatComponents)
            if floating {
                if name == CGColorSpace.extendedLinearDisplayP3 as String { space = "Linear P3-D65" }
                else if name == CGColorSpace.extendedLinearITUR_2020 as String { space = "Linear Rec.2020" }
                else if name == CGColorSpace.acescgLinear as String { space = "ACEScg" }
                else { space = "Linear Rec.709" }
            }
            // Premultiplied pixels are restored once at source import, with
            // float storage to avoid a second integer quantization.
            let outputBits = premultiplied || floating ? 32 : bits, outputBytes = outputBits / 8
            let output = FileManager.default.temporaryDirectory.appendingPathComponent("Dichroic-source-\(UUID().uuidString).pixels")
            guard FileManager.default.createFile(atPath: output.path, contents: nil), let input = CFDataGetBytePtr(provider) else {
                throw GraphRuntimeError.message("Could not store decoded photo")
            }
            do {
                let file = try FileHandle(forWritingTo: output); defer { try? file.close() }
                var row = Data(count: width * 4 * outputBytes)
                for y in 0..<height {
                    row.withUnsafeMutableBytes { (target: UnsafeMutableRawBufferPointer) in
                        for x in 0..<width {
                            let sx: Int, sy: Int
                            switch orientation {
                            case 2: sx = image.width - 1 - x; sy = y
                            case 3: sx = image.width - 1 - x; sy = image.height - 1 - y
                            case 4: sx = x; sy = image.height - 1 - y
                            case 5: sx = y; sy = x
                            case 6: sx = y; sy = image.height - 1 - x
                            case 7: sx = image.width - 1 - y; sy = image.height - 1 - x
                            case 8: sx = image.width - 1 - y; sy = x
                            default: sx = x; sy = y
                            }
                            let base = sy * image.bytesPerRow + sx * count * bytes
                            func component(_ channel: Int) -> Float {
                                let index = reversePixel ? count - 1 - channel : channel, p = base + index * bytes
                                if bits == 8 { return Float(input[p]) / 255 }
                                if bits == 16 {
                                    let code = bigEndian ? UInt16(input[p]) << 8 | UInt16(input[p + 1]) : UInt16(input[p + 1]) << 8 | UInt16(input[p])
                                    return floating ? Float(Float16(bitPattern: code)) : Float(code) / 65535
                                }
                                let raw = UnsafeRawPointer(input + p).loadUnaligned(as: UInt32.self)
                                return Float(bitPattern: bigEndian ? UInt32(bigEndian: raw) : raw)
                            }
                            let opacity = hasAlpha ? component(first ? 0 : count - 1) : 1
                            for c in 0..<4 {
                                var value = c == 3 ? opacity : component((first ? 1 : 0) + (model == .monochrome ? 0 : c))
                                if c < 3 && premultiplied { value = opacity > 0 ? value / opacity : 0 }
                                let at = (x * 4 + c) * outputBytes
                                if outputBits == 32 { target.storeBytes(of: value, toByteOffset: at, as: Float.self) }
                                else if outputBits == 16 { target.storeBytes(of: UInt16((max(0, min(1, value)) * 65535).rounded()), toByteOffset: at, as: UInt16.self) }
                                else { target[at] = UInt8((max(0, min(1, value)) * 255).rounded()) }
                            }
                        }
                    }
                    try file.write(contentsOf: row)
                }
                return try NativeSourceStore(url: output, width: width, height: height, bits: outputBits, channels: 4,
                    colorSpace: space, encoding: floating ? "linear" : "encoded")
            } catch { try? FileManager.default.removeItem(at: output); throw error }
        }
    }
}
