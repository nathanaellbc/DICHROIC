// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "exposure_engine",
    platforms: [.iOS(.v16)],
    products: [.library(name: "exposure-engine", targets: ["exposure_engine"])],
    dependencies: [.package(name: "FlutterFramework", path: "../FlutterFramework")],
    targets: [
        .binaryTarget(name: "ExposureNative", path: "Frameworks/ExposureNative.xcframework"),
        .target(name: "exposure_engine", dependencies: ["ExposureNative", .product(name: "FlutterFramework", package: "FlutterFramework")], linkerSettings: [
            .linkedFramework("Metal"), .linkedFramework("QuartzCore"),
            .linkedFramework("CoreGraphics"), .linkedFramework("Foundation"), .linkedFramework("Accelerate"),
            .linkedLibrary("c++")
        ])
    ]
)
