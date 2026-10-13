import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Copies a picked or dropped item to a private temporary file. The file
/// representation preserves HEIC, RAW and metadata; UIImage-based picking can
/// silently turn the original into an 8-bit JPEG instead. The original name
/// follows "--" so export can name the file after it, as on the web.
enum PhotoImport {
    static func copy(_ provider: NSItemProvider) async throws -> URL {
        let type = provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .rawImage) == true }
            ?? provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .image) == true }
            ?? provider.registeredTypeIdentifiers.first { UTType($0)?.conforms(to: .fileURL) == false }
            ?? UTType.image.identifier
        return try await withCheckedThrowingContinuation { continuation in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type) { url, error in
                do {
                    if let error { throw error }
                    guard let url else { throw CocoaError(.fileReadUnknown) }
                    let suffix = url.pathExtension.isEmpty ? (UTType(type)?.preferredFilenameExtension ?? "jpg") : url.pathExtension
                    let original = (provider.suggestedName ?? "").replacingOccurrences(of: "/", with: "-")
                    continuation.resume(returning: try copy(url, name: original, suffix: suffix))
                } catch { continuation.resume(throwing: error) }
            }
        }
    }

    /// A file from Files (security-scoped) or a temporary picker file.
    static func copy(_ url: URL, name: String? = nil, suffix: String? = nil) throws -> URL {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let original = name ?? url.deletingPathExtension().lastPathComponent
        let ext = suffix ?? url.pathExtension
        let copy = FileManager.default.temporaryDirectory
            .appendingPathComponent("Dichroic-import-\(UUID().uuidString)--\(original)\(ext.isEmpty ? "" : ".\(ext)")")
        try FileManager.default.copyItem(at: url, to: copy)
        return copy
    }

    /// Removes earlier imports except the one in use.
    static func purge(keeping url: URL?) {
        let folder = FileManager.default.temporaryDirectory
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: folder.path) else { return }
        for name in names where name.hasPrefix("Dichroic-import-") && name != url?.lastPathComponent {
            try? FileManager.default.removeItem(at: folder.appendingPathComponent(name))
        }
    }
}

/// The system photo picker, current representation (no transcoding).
struct PhotoPicker: UIViewControllerRepresentable {
    let onPick: (NSItemProvider?) -> Void

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var configuration = PHPickerConfiguration()
        configuration.filter = .images
        configuration.selectionLimit = 1
        configuration.preferredAssetRepresentationMode = .current
        let picker = PHPickerViewController(configuration: configuration)
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: PHPickerViewController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(onPick) }

    final class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let onPick: (NSItemProvider?) -> Void
        init(_ onPick: @escaping (NSItemProvider?) -> Void) { self.onPick = onPick }
        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            onPick(results.first?.itemProvider)
        }
    }
}

/// The share sheet ("Save Image", Files, AirDrop); reports completion.
struct ShareSheet: UIViewControllerRepresentable {
    let items: [Any]
    var onComplete: (Bool) -> Void = { _ in }

    func makeUIViewController(context: Context) -> UIActivityViewController {
        let controller = UIActivityViewController(activityItems: items, applicationActivities: nil)
        controller.completionWithItemsHandler = { _, completed, _, _ in onComplete(completed) }
        return controller
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
