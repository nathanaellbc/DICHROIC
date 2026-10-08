import Foundation
import CoreGraphics
import ImageIO

// Mac-only fixture preparation, outside the app process and before simulator
// asset bundling. Release builds do not include these generated stress images.
let directory = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
func write(_ image: CGImage, _ type: String, _ name: String, properties: [CFString: Any] = [:]) throws {
    let file = directory.appendingPathComponent(name)
    guard let output = CGImageDestinationCreateWithURL(file as CFURL, type as CFString, 1, nil) else {
        throw NSError(domain: "fixture", code: 1)
    }
    CGImageDestinationAddImage(output, image, properties as CFDictionary)
    guard CGImageDestinationFinalize(output) else { throw NSError(domain: "fixture", code: 2) }
}
try autoreleasepool {
    let width = 8144, height = 5424
    var pixels = Data(count: width * height * 4)
    pixels.withUnsafeMutableBytes { (raw: UnsafeMutableRawBufferPointer) in
        for y in 0..<height { for x in 0..<width {
            let p = (y * width + x) * 4
            raw[p] = UInt8((x / 32) % 256)
            raw[p + 1] = UInt8((y / 24) % 256)
            raw[p + 2] = UInt8(((x + y) / 64) % 256)
            raw[p + 3] = 255
        } }
    }
    let image = CGImage(width: width, height: height, bitsPerComponent: 8, bitsPerPixel: 32,
        bytesPerRow: width * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue),
        provider: CGDataProvider(data: pixels as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    try write(image, "public.jpeg", "large-native.jpg", properties: [kCGImageDestinationLossyCompressionQuality: 0.9])
    let crop = image.cropping(to: CGRect(x: 512, y: 256, width: 64, height: 48))!
    try write(crop, "public.heic", "small-native.heic")
    for orientation in [1, 2, 3, 4, 5, 6, 7, 8] {
        try write(crop, "public.jpeg", "oriented-native-\(orientation).jpg", properties: [kCGImagePropertyOrientation: orientation])
    }
}
try autoreleasepool {
    // Exact binary fractions survive float16 EXR. Keep negative and >1 values
    // so an accidental sRGB/8-bit conversion fails the native import check.
    let values: [Float] = [-0.25, 0.5, 1.5, 1, 0.125, 0.25, 0.75, 1]
    let bytes = values.withUnsafeBytes { Data($0) }
    let image = CGImage(width: 2, height: 1, bitsPerComponent: 32, bitsPerPixel: 128,
        bytesPerRow: 32, space: CGColorSpace(name: CGColorSpace.extendedLinearSRGB)!,
        bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.noneSkipLast.rawValue | CGBitmapInfo.floatComponents.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
        provider: CGDataProvider(data: bytes as CFData)!, decode: nil, shouldInterpolate: false, intent: .defaultIntent)!
    try write(image, "com.ilm.openexr-image", "float-native.exr")
}
