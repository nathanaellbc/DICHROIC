import Foundation

/// The canonical `DisplayTransform` (src/io/display.ts) applied natively:
/// rendered RGB (float, encoded in the output space) to RGBA8 for the screen.
/// JavaScriptCore has no JIT in apps, and this runs on every developed frame.
/// The arithmetic is `applyDisplayTransform`, operation for operation.
enum NativeDisplay {
    static func convert(_ rgb: UnsafeBufferPointer<Float>, width: Int, height: Int, transform json: String,
                        into output: UnsafeMutableRawBufferPointer) throws {
        guard let t = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any], let kind = t["kind"] as? String else {
            throw GraphRuntimeError.message("Invalid display transform")
        }
        let n = width * height
        // 3: packed RGB; 4: the GPU readback as is (alpha ignored).
        let stride = (t["stride"] as? NSNumber)?.intValue == 4 ? 4 : 3
        guard rgb.count >= n * stride, output.count >= n * 4 else { throw GraphRuntimeError.message("Invalid display frame") }
        let out = output.bindMemory(to: UInt8.self)
        let source = rgb.baseAddress!, target = out.baseAddress!
        let rows = max(1, height), chunk = max(1, rows / (ProcessInfo.processInfo.activeProcessorCount * 4))
        if kind == "quantize" {
            // `quantize(rgb, 8)`: v > 0 ? (v >= 1 ? 255 : round(v * 255)) : 0 (NaN -> 0).
            DispatchQueue.concurrentPerform(iterations: (rows + chunk - 1) / chunk) { block in
                let start = block * chunk * width, end = min(n, (block + 1) * chunk * width)
                for i in start..<end {
                    for c in 0..<3 {
                        let v = Double(source[i * stride + c])
                        target[i * 4 + c] = v > 0 ? (v >= 1 ? 255 : UInt8((v * 255).rounded(.toNearestOrAwayFromZero))) : 0
                    }
                    target[i * 4 + 3] = 255
                }
            }
            return
        }
        guard kind == "matrix", let m = (t["m"] as? [NSNumber])?.map(\.doubleValue), m.count == 9,
              let encoding = t["encoding"] as? String else { throw GraphRuntimeError.message("Invalid display transform") }
        let gamma = (t["gamma"] as? NSNumber)?.doubleValue ?? 1
        let decode: (Double) -> Double
        switch encoding {
        case "linear": decode = { $0 }
        case "srgb": decode = { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
        case "romm": decode = { $0 < 1.0 / 32 ? $0 / 16 : pow($0, 1.8) }
        default: decode = { pow(max(0, $0), gamma) }
        }
        // `srgbEncode(v) * 255` stored into a Uint8ClampedArray (clamp, round half to even, NaN -> 0).
        @inline(__always) func store(_ v: Double) -> UInt8 {
            let c = v <= 0 ? 0 : v >= 1 ? 1 : v
            let e = (c <= 0.0031308 ? 12.92 * c : 1.055 * pow(c, 1 / 2.4) - 0.055) * 255
            guard e.isFinite, e > 0 else { return 0 }
            return e >= 255 ? 255 : UInt8(e.rounded(.toNearestOrEven))
        }
        DispatchQueue.concurrentPerform(iterations: (rows + chunk - 1) / chunk) { block in
            let start = block * chunk * width, end = min(n, (block + 1) * chunk * width)
            for i in start..<end {
                let r = decode(Double(source[i * stride])), g = decode(Double(source[i * stride + 1])), b = decode(Double(source[i * stride + 2]))
                target[i * 4] = store(m[0] * r + m[1] * g + m[2] * b)
                target[i * 4 + 1] = store(m[3] * r + m[4] * g + m[5] * b)
                target[i * 4 + 2] = store(m[6] * r + m[7] * g + m[8] * b)
                target[i * 4 + 3] = 255
            }
        }
    }
}
