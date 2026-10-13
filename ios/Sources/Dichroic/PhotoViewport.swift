import SwiftUI
import DichroicEngine

/// Hold this long without moving to peek at the original (web 220 ms).
private let peekDelay = 0.22

/// Mirrors the web PhotoView: split compare, hold to peek, pinch and
/// double-tap zoom with elastic edges, the "Developing" pill, the lens focus
/// pin, the Remove Object brush, the develop sweep, full-resolution detail
/// while zoomed, and a tap for the full-screen viewer. Gestures transform the
/// cached preview; they never schedule a develop.
struct PhotoViewport: View {
    enum Mode { case editor, lightbox }

    @Bindable var model: EditorModel
    var mode: Mode = .editor
    var brush: RemovalBrush?
    var showBrush = false
    /// Remove Object's Before: the untouched original.
    var showOriginal = false
    /// Lens focus point (0..1) while the pin is offered.
    var focus: CGPoint?
    /// Bumped when Remove Object closes: a blue line sweeps down, developing
    /// the film result over the original.
    var reveal = 0
    @Binding var compare: Bool
    var compareButton = true
    var onTap: () -> Void = {}

    @Environment(\.displayScale) private var displayScale
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var scale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var pinch: CGFloat = 1
    @State private var pinchAnchor: CGPoint?
    @State private var pan: CGSize = .zero
    @State private var divider: CGFloat = 0.5
    @State private var peek = false
    @State private var focusDrag: CGPoint?
    @State private var developingPill = false
    @State private var sweep: CGFloat = 1
    @State private var zoomPill = false
    @State private var painting = false

    private var photoSize: CGSize {
        CGSize(width: max(1, model.photo?.width ?? 1), height: max(1, model.photo?.height ?? 1))
    }

    private func fitted(_ size: CGSize) -> CGSize {
        let s = min(size.width / photoSize.width, size.height / photoSize.height)
        return CGSize(width: photoSize.width * s, height: photoSize.height * s)
    }

    private var liveScale: CGFloat { scale * pinch }
    private var liveOffset: CGSize { CGSize(width: offset.width + pan.width, height: offset.height + pan.height) }

    /// Photo point (0..1) under a view point.
    private func photoPoint(_ p: CGPoint, in size: CGSize) -> CGPoint {
        let fit = fitted(size), s = liveScale
        let x = (p.x - size.width / 2 - liveOffset.width) / (fit.width * s) + 0.5
        let y = (p.y - size.height / 2 - liveOffset.height) / (fit.height * s) + 0.5
        return CGPoint(x: x, y: y)
    }

    /// View point of a photo point.
    private func viewPoint(_ q: CGPoint, in size: CGSize) -> CGPoint {
        let fit = fitted(size), s = liveScale
        return CGPoint(x: size.width / 2 + liveOffset.width + (q.x - 0.5) * fit.width * s,
                       y: size.height / 2 + liveOffset.height + (q.y - 0.5) * fit.height * s)
    }

    /// Offset limits for a scale: the photo never leaves its frame.
    private func clamped(_ offset: CGSize, scale: CGFloat, in size: CGSize) -> CGSize {
        let fit = fitted(size)
        let mx = max(0, (fit.width * scale - size.width) / 2), my = max(0, (fit.height * scale - size.height) / 2)
        return CGSize(width: min(mx, max(-mx, offset.width)), height: min(my, max(-my, offset.height)))
    }

    var body: some View {
        GeometryReader { geo in
            let size = geo.size, fit = fitted(size)
            ZStack {
                photoLayer(fit: fit)
                    .frame(width: fit.width, height: fit.height)
                    .scaleEffect(liveScale)
                    .offset(liveOffset)
                if compare && mode == .editor && !showOriginal { compareHandle(size: size) }
                if let focus, mode == .editor { focusPin(focus, size: size) }
            }
            .frame(width: size.width, height: size.height)
            .coordinateSpace(name: "viewport")
            .contentShape(Rectangle())
            .clipped()
            .gesture(dragGesture(size: size))
            .simultaneousGesture(magnifyGesture(size: size))
            .onTapGesture(count: 2, coordinateSpace: .local) { point in doubleTap(point, size: size) }
            .onTapGesture { if !compare && focusDrag == nil && brush == nil { onTap() } }
            .onLongPressGesture(minimumDuration: peekDelay, maximumDistance: 10, perform: {
                if brush == nil && !compare { peek = true }
            }, onPressingChanged: { pressing in if !pressing { peek = false } })
            .overlay(alignment: .top) { pills }
            .overlay(alignment: .bottomLeading) {
                if mode == .editor && compareButton && brush == nil {
                    GlassIconButton(symbol: "rectangle.split.2x1", label: "Compare with original", selected: compare) {
                        withAnimation(.snappy) { compare.toggle() }
                    }
                    .padding(12)
                }
            }
            .onChange(of: model.photo) { _, _ in resetZoom(animated: false) }
        }
        .task(id: model.rendering) {
            if model.rendering {
                try? await Task.sleep(for: .milliseconds(350))
                if !Task.isCancelled { withAnimation { developingPill = true } }
            } else {
                withAnimation { developingPill = false }
            }
        }
        .onChange(of: reveal) { _, _ in
            guard !reduceMotion else { sweep = 1; return }
            sweep = 0
            withAnimation(.timingCurve(0.65, 0, 0.35, 1, duration: 0.9)) { sweep = 1 }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Photo")
    }

    // MARK: - Layers

    @ViewBuilder private func photoLayer(fit: CGSize) -> some View {
        let original = model.original
        ZStack(alignment: .topLeading) {
            image(model.preview, fit: fit)
            if let tile = model.detail { tileView(tile.image, rect: tile.rect, fit: fit) }
            if (peek || showOriginal), let original {
                image(original, fit: fit)
                if let tile = model.detail { tileView(tile.original, rect: tile.rect, fit: fit) }
            } else if compare && mode == .editor, let original {
                ZStack(alignment: .topLeading) {
                    image(original, fit: fit)
                    if let tile = model.detail { tileView(tile.original, rect: tile.rect, fit: fit) }
                }
                .mask(alignment: .leading) { Rectangle().frame(width: fit.width * divider) }
            }
            if sweep < 1, let original {
                image(original, fit: fit)
                    .mask(BelowLine(progress: sweep))
                Rectangle().fill(Color.signal)
                    .frame(width: fit.width, height: 2)
                    .shadow(color: Color.signal.opacity(0.9), radius: 8)
                    .offset(y: fit.height * sweep - 1)
                    .opacity(sweep > 0.98 ? 0 : 1)
            }
            if let mask = model.focusMask, focusDrag != nil {
                Image(uiImage: mask).resizable().interpolation(.medium).frame(width: fit.width, height: fit.height).allowsHitTesting(false)
            }
            if let brush, showBrush {
                Canvas { context, canvasSize in
                    for (path, width) in brush.path(in: canvasSize) {
                        if width == 0 { context.fill(path, with: .color(Color(red: 1, green: 0.27, blue: 0.31).opacity(0.45))) }
                        else { context.stroke(path, with: .color(Color(red: 1, green: 0.27, blue: 0.31).opacity(0.45)),
                                              style: StrokeStyle(lineWidth: width, lineCap: .round, lineJoin: .round)) }
                    }
                }
                .frame(width: fit.width, height: fit.height)
                .allowsHitTesting(false)
            }
        }
    }

    private func image(_ image: UIImage?, fit: CGSize) -> some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().interpolation(liveScale > 1.5 ? .medium : .high)
            } else {
                Color.black.opacity(0.2)
            }
        }
        .frame(width: fit.width, height: fit.height)
    }

    private func tileView(_ image: UIImage, rect: CGRect, fit: CGSize) -> some View {
        Image(uiImage: image).resizable().interpolation(.high)
            .frame(width: rect.width * fit.width, height: rect.height * fit.height)
            .offset(x: rect.minX * fit.width, y: rect.minY * fit.height)
            .allowsHitTesting(false)
    }

    @ViewBuilder private var pills: some View {
        HStack(spacing: 8) {
            if developingPill && mode == .editor {
                HStack(spacing: 6) { ProgressView().controlSize(.mini); Text("Developing") }
                    .font(.system(size: 13, weight: .semibold)).padding(.horizontal, 12).frame(height: 30).glass(15)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
            if zoomPill {
                Text(String(format: "%.1f×", liveScale)).font(.system(size: 13, weight: .semibold)).monospacedDigit()
                    .padding(.horizontal, 12).frame(height: 30).glass(15)
                    .transition(.opacity)
            }
            if peek || showOriginal {
                Text("Original").font(.system(size: 13, weight: .semibold)).padding(.horizontal, 12).frame(height: 30).glass(15)
                    .transition(.opacity)
            }
        }
        .padding(.top, 10)
        .allowsHitTesting(false)
    }

    /// Split divider with a round handle (web compare slider).
    private func compareHandle(size: CGSize) -> some View {
        let fit = fitted(size)
        let x = viewPoint(CGPoint(x: divider, y: 0.5), in: size).x
        return ZStack {
            Rectangle().fill(Color.white).frame(width: 2).shadow(radius: 3)
            Circle().fill(.ultraThinMaterial).frame(width: 36, height: 36)
                .overlay(Image(systemName: "arrow.left.and.right").font(.system(size: 13, weight: .bold)))
        }
        .frame(width: 44, height: min(size.height, fit.height * liveScale))
        .contentShape(Rectangle())
        .position(x: x, y: size.height / 2)
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("viewport")).onChanged { value in
            divider = min(1, max(0, photoPoint(value.location, in: size).x))
        })
        .accessibilityElement()
        .accessibilityLabel("Compare divider")
        .accessibilityValue("\(Int(divider * 100)) percent")
        .accessibilityAdjustableAction { direction in
            divider = min(1, max(0, divider + (direction == .increment ? 0.05 : -0.05)))
        }
    }

    /// White ring with a centre dot (web focus pin); drag to focus.
    private func focusPin(_ focus: CGPoint, size: CGSize) -> some View {
        let point = viewPoint(focusDrag ?? focus, in: size)
        return ZStack {
            Circle().strokeBorder(Color.white, lineWidth: 2).frame(width: 44, height: 44).shadow(radius: 3)
            Circle().fill(Color.white).frame(width: 6, height: 6)
        }
        .frame(width: 64, height: 64)
        .contentShape(Circle())
        .position(point)
        .gesture(DragGesture(minimumDistance: 0, coordinateSpace: .named("viewport")).onChanged { value in
            if focusDrag == nil { model.beginGesture() }
            let q = photoPoint(value.location, in: size)
            let next = CGPoint(x: min(1, max(0, q.x)), y: min(1, max(0, q.y)))
            focusDrag = next
            Task { await model.previewFocus(next) }
        }.onEnded { _ in
            guard let point = focusDrag else { return }
            Task {
                await model.commitFocus(point)
                focusDrag = nil
            }
        })
        .accessibilityLabel("Focus point")
    }

    // MARK: - Gestures

    private var paints: Bool { brush != nil && (brush?.painting ?? false) && showBrush }

    private func dragGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: paints ? 0 : 6)
            .onChanged { value in
                if paints, let brush {
                    let q = photoPoint(value.location, in: size)
                    if !painting {
                        painting = true
                        brush.begin(q, radius: CGFloat(brush.diameter / 2) / (fitted(size).width * liveScale))
                    } else { brush.add(q) }
                    return
                }
                guard liveScale > 1.001 || mode == .lightbox else { return }
                pan = value.translation
            }
            .onEnded { value in
                if painting { painting = false; brush?.end(); return }
                // Lightbox: a downward swipe at fit size closes.
                if mode == .lightbox, scale <= 1.001, value.translation.height > 120 { pan = .zero; onTap(); return }
                let next = CGSize(width: offset.width + pan.width, height: offset.height + pan.height)
                pan = .zero
                offset = next
                withAnimation(.spring(response: 0.35, dampingFraction: 0.85)) { offset = clamped(next, scale: scale, in: size) }
                requestDetail(size: size)
            }
    }

    private func magnifyGesture(size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if painting { brush?.cancel(); painting = false }
                // Elastic past 1× and 8×.
                let raw = scale * value.magnification
                let bounded = raw < 1 ? 1 - (1 - raw) * 0.35 : raw > 8 ? 8 + (raw - 8) * 0.35 : raw
                if pinchAnchor == nil { pinchAnchor = value.startLocation }
                let anchor = pinchAnchor ?? CGPoint(x: size.width / 2, y: size.height / 2)
                // Keep the photo point under the fingers in place.
                let factor = bounded / scale
                let cx = anchor.x - size.width / 2, cy = anchor.y - size.height / 2
                pan = CGSize(width: (offset.width - cx) * (factor - 1), height: (offset.height - cy) * (factor - 1))
                pinch = factor
                withAnimation(.easeOut(duration: 0.15)) { zoomPill = true }
            }
            .onEnded { _ in
                let target = min(8, max(1, scale * pinch))
                let next = CGSize(width: offset.width + pan.width, height: offset.height + pan.height)
                let ratio = target / (scale * pinch)
                scale = scale * pinch; offset = next; pinch = 1; pan = .zero; pinchAnchor = nil
                withAnimation(.spring(response: 0.4, dampingFraction: 0.82)) {
                    scale = target
                    offset = clamped(CGSize(width: next.width * ratio, height: next.height * ratio), scale: target, in: size)
                }
                hideZoomPill()
                requestDetail(size: size)
            }
    }

    /// Double-tap: fit ↔ 2.5× about the tapped point.
    private func doubleTap(_ point: CGPoint, size: CGSize) {
        guard brush == nil || !(brush?.painting ?? false) else { return }
        if scale > 1.01 { resetZoom(animated: true); return }
        let target: CGFloat = 2.5
        let cx = point.x - size.width / 2, cy = point.y - size.height / 2
        withAnimation(.spring(response: 0.4, dampingFraction: 0.85)) {
            scale = target
            offset = clamped(CGSize(width: -cx * (target - 1), height: -cy * (target - 1)), scale: target, in: size)
        }
        zoomPill = true
        hideZoomPill()
        requestDetail(size: size, scale: target, offset: offset)
    }

    private func resetZoom(animated: Bool) {
        let apply = { scale = 1; offset = .zero; pinch = 1; pan = .zero }
        if animated { withAnimation(.spring(response: 0.4, dampingFraction: 0.85), apply) } else { apply() }
    }

    private func hideZoomPill() {
        Task {
            try? await Task.sleep(for: .milliseconds(900))
            withAnimation { zoomPill = false }
        }
    }

    /// Full resolution for the visible part once the zoom settles.
    private func requestDetail(size: CGSize, scale target: CGFloat? = nil, offset to: CGSize? = nil) {
        let s = target ?? scale, o = clamped(to ?? offset, scale: s, in: size), fit = fitted(size)
        guard s > 1.05 else { return }
        let w = fit.width * s, h = fit.height * s
        let x0 = (size.width / 2 + o.width - w / 2), y0 = (size.height / 2 + o.height - h / 2)
        let rect = CGRect(x: max(0, -x0 / w), y: max(0, -y0 / h), width: 0, height: 0)
        let maxX = min(1, (size.width - x0) / w), maxY = min(1, (size.height - y0) / h)
        let visible = CGRect(x: rect.minX, y: rect.minY, width: max(0, maxX - rect.minX), height: max(0, maxY - rect.minY))
        let longEdge = Int((max(w, h) * displayScale).rounded())
        model.requestDetail(visible, longEdge: longEdge)
    }
}

/// The area below a horizontal line at `progress` of the height.
private struct BelowLine: Shape {
    var progress: CGFloat
    var animatableData: CGFloat {
        get { progress }
        set { progress = newValue }
    }
    func path(in rect: CGRect) -> Path {
        Path(CGRect(x: rect.minX, y: rect.minY + rect.height * progress, width: rect.width, height: rect.height * (1 - progress)))
    }
}

/// Full-screen viewer (web PhotoLightbox): black backdrop, pinch, double-tap
/// and wheel-free zoom, hold to reveal the original, full-resolution detail.
struct PhotoLightbox: View {
    @Bindable var model: EditorModel
    @Environment(\.dismiss) private var dismiss
    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            PhotoViewport(model: model, mode: .lightbox, compare: .constant(false), compareButton: false) { dismiss() }
                .ignoresSafeArea()
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 15, weight: .bold)).foregroundStyle(.white)
                    .frame(width: 36, height: 36).background(Circle().fill(.ultraThinMaterial))
            }
            .padding(16)
            .accessibilityLabel("Close")
        }
        .statusBarHidden()
        .preferredColorScheme(.dark)
    }
}
