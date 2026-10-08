import 'dart:async';
import 'dart:math' as math;
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/scheduler.dart';
import 'editor_widgets.dart';
import 'native_controls.dart';
import 'photo_lightbox.dart';
import 'removal_brush.dart';
import 'native_preview.dart';

/// Hold this long without moving to peek at the original (web 220 ms).
const peekDelay = Duration(milliseconds: 220);

/// Gestures transform the cached native texture; they never schedule a develop.
/// Mirrors the web `PhotoView`: split compare, hold to peek, double-tap zoom,
/// the zoom and "Developing" pills, and a tap for the full-screen viewer.
class PhotoViewport extends StatefulWidget {
  const PhotoViewport({
    super.key,
    required this.photo,
    this.focus,
    this.onFocusStart,
    this.onFocusPreview,
    this.onFocusEnd,
    this.brush,
    this.showBrush = true,
    this.detail,
    this.detailRevision = 0,
    this.onDetailRequest,
    this.rendering = false,
    this.compareInset = 12,
    this.showOriginal = false,
    this.reveal = 0,
  });
  final NativePhoto photo;
  final Offset? focus;
  final VoidCallback? onFocusStart;
  final ValueChanged<Offset>? onFocusPreview, onFocusEnd;
  final RemovalBrush? brush;
  final bool showBrush;
  final NativeDetail? detail;
  final int detailRevision;
  final void Function(Rect, int)? onDetailRequest;

  /// A develop is running: after 350 ms the "Developing" pill appears.
  final bool rendering;

  /// Distance of the Compare button from the bottom edge.
  final double compareInset;

  /// Show the untouched original (Remove Object's Before).
  final bool showOriginal;

  /// Bumped when Remove Object closes: a blue line sweeps down, developing
  /// the film result over the original (web develop sweep).
  final int reveal;

  @override
  State<PhotoViewport> createState() => _PhotoViewportState();
}

class _PhotoViewportState extends State<PhotoViewport>
    with TickerProviderStateMixin {
  late final Ticker _ticker;
  late final _sweep = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );
  Size _viewport = Size.zero;
  Size _image = Size.zero;
  double _scale = 1;
  Offset _offset = Offset.zero;
  double _startScale = 1;
  Offset _startOffset = Offset.zero;
  Offset _startFocal = Offset.zero;
  SpringSimulation? _xSpring, _ySpring, _scaleSpring;
  bool _compare = false, _peek = false;
  double _split = .5;
  bool _splitting = false;
  bool _picking = false;
  Offset? _focus;
  bool _brushing = false;
  int _pointerCount = 0;
  Offset? _doubleTapAt;
  bool _slow = false;
  Timer? _slowTimer;

  Offset _photoPoint(Offset point) {
    final local = (point - _viewport.center(Offset.zero) - _offset) / _scale;
    return Offset(
      (local.dx / _image.width + .5).clamp(0.0, 1.0),
      (local.dy / _image.height + .5).clamp(0.0, 1.0),
    );
  }

  /// Screen position of a photo point (0..1).
  Offset _screen(Offset photo) =>
      _viewport.center(Offset.zero) +
      _offset +
      Offset(
        (photo.dx - .5) * _image.width * _scale,
        (photo.dy - .5) * _image.height * _scale,
      );

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick);
    _watchRendering();
  }

  @override
  void didUpdateWidget(PhotoViewport oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.photo, widget.photo)) {
      _ticker.stop();
      _scale = 1;
      _offset = Offset.zero;
      _compare = false;
      _peek = false;
      _split = .5;
    }
    if (oldWidget.rendering != widget.rendering) _watchRendering();
    if (oldWidget.reveal != widget.reveal && widget.reveal > 0) {
      _sweep.forward(from: 0);
    }
    if (oldWidget.detailRevision != widget.detailRevision) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _requestDetail();
      });
    }
  }

  void _watchRendering() {
    _slowTimer?.cancel();
    if (!widget.rendering) {
      if (_slow) setState(() => _slow = false);
      return;
    }
    _slowTimer = Timer(const Duration(milliseconds: 350), () {
      if (mounted && widget.rendering) setState(() => _slow = true);
    });
  }

  @override
  void dispose() {
    _slowTimer?.cancel();
    _sweep.dispose();
    _ticker.dispose();
    super.dispose();
  }

  double _rubber(double value, double bound, double dimension) {
    if (value.abs() <= bound) return value;
    final extra = value.abs() - bound;
    final resistance = extra * dimension * 0.55 / (dimension + extra * 0.55);
    return value.sign * (bound + resistance);
  }

  Offset _bounds(double scale) => Offset(
    math.max(0, (_image.width * scale - _viewport.width) / 2),
    math.max(0, (_image.height * scale - _viewport.height) / 2),
  );

  bool get _comparing => _compare && !_picking && widget.brush == null;

  void _start(ScaleStartDetails details) {
    _ticker.stop();
    _startScale = _scale;
    _startOffset = _offset;
    _startFocal = details.localFocalPoint - _viewport.center(Offset.zero);
    _pointerCount = details.pointerCount;
    if (widget.brush?.painting == true &&
        widget.showBrush &&
        details.pointerCount == 1) {
      _brushing = true;
      widget.brush!.begin(
        _photoPoint(details.localFocalPoint),
        widget.brush!.diameter / (2 * _image.width * _scale),
      );
    } else if (_comparing && details.pointerCount == 1) {
      // In compare, one finger moves the divider anywhere on the photo.
      _splitting = true;
      setState(() => _split = _photoPoint(details.localFocalPoint).dx);
    }
  }

  void _update(ScaleUpdateDetails details) {
    if (_brushing && details.pointerCount == 1) {
      widget.brush!.add(_photoPoint(details.localFocalPoint));
      return;
    }
    if (_brushing) {
      widget.brush?.cancel();
      _brushing = false;
    }
    if (_splitting && details.pointerCount == 1) {
      setState(() => _split = _photoPoint(details.localFocalPoint).dx);
      return;
    }
    _splitting = false;
    if (_pointerCount != details.pointerCount) {
      _startScale = _scale / details.scale;
      _startOffset = _offset;
      _startFocal = details.localFocalPoint - _viewport.center(Offset.zero);
      _pointerCount = details.pointerCount;
    }
    final rawScale = _startScale * details.scale;
    final scale = rawScale < 1
        ? 1 - (1 - rawScale) * 0.25
        : rawScale > 8
        ? 8 + (rawScale - 8) / (1 + rawScale - 8) * 0.5
        : rawScale;
    final focal = details.localFocalPoint - _viewport.center(Offset.zero);
    final rawOffset =
        focal - (_startFocal - _startOffset) * (scale / _startScale);
    final bounds = _bounds(scale);
    setState(() {
      _scale = scale;
      _offset = Offset(
        _rubber(rawOffset.dx, bounds.dx, _viewport.width),
        _rubber(rawOffset.dy, bounds.dy, _viewport.height),
      );
    });
  }

  void _settle({Offset velocity = Offset.zero, bool reset = false}) {
    final scale = reset ? 1.0 : _scale.clamp(1.0, 8.0).toDouble();
    final bounds = _bounds(scale);
    final target = reset
        ? Offset.zero
        : Offset(
            (_offset.dx + velocity.dx * 0.12)
                .clamp(-bounds.dx, bounds.dx)
                .toDouble(),
            (_offset.dy + velocity.dy * 0.12)
                .clamp(-bounds.dy, bounds.dy)
                .toDouble(),
          );
    _animateTo(scale, target, velocity: velocity);
  }

  void _animateTo(
    double scale,
    Offset target, {
    Offset velocity = Offset.zero,
  }) {
    _ticker.stop();
    if (MediaQuery.disableAnimationsOf(context)) {
      setState(() {
        _scale = scale;
        _offset = target;
      });
      _requestDetail();
      return;
    }
    const spring = SpringDescription(mass: 1, stiffness: 280, damping: 28);
    // Independent axes inherit finger velocity and can be grabbed mid-spring.
    _xSpring = SpringSimulation(
      spring,
      _offset.dx,
      target.dx,
      velocity.dx.clamp(-2500, 2500).toDouble(),
    );
    _ySpring = SpringSimulation(
      spring,
      _offset.dy,
      target.dy,
      velocity.dy.clamp(-2500, 2500).toDouble(),
    );
    _scaleSpring = SpringSimulation(spring, _scale, scale, 0);
    _ticker.start();
  }

  /// Double-tap: fit ↔ 2.5× about the tapped point (web PhotoView).
  void _doubleTap() {
    if (_scale > 1.01) {
      _animateTo(1, Offset.zero);
      return;
    }
    const scale = 2.5;
    final focal =
        (_doubleTapAt ?? _viewport.center(Offset.zero)) -
        _viewport.center(Offset.zero);
    final raw = focal - (focal - _offset) * (scale / _scale);
    final bounds = _bounds(scale);
    _animateTo(
      scale,
      Offset(
        raw.dx.clamp(-bounds.dx, bounds.dx).toDouble(),
        raw.dy.clamp(-bounds.dy, bounds.dy).toDouble(),
      ),
    );
  }

  void _tick(Duration elapsed) {
    final t = elapsed.inMicroseconds / Duration.microsecondsPerSecond;
    setState(() {
      _offset = Offset(_xSpring!.x(t), _ySpring!.x(t));
      _scale = _scaleSpring!.x(t);
    });
    if (_xSpring!.isDone(t) && _ySpring!.isDone(t) && _scaleSpring!.isDone(t)) {
      _ticker.stop();
      _requestDetail();
    }
  }

  void _requestDetail() {
    if (widget.onDetailRequest == null ||
        widget.brush != null ||
        _image.isEmpty ||
        _viewport.isEmpty) {
      return;
    }
    final left =
        (.5 + (-_viewport.width / 2 - _offset.dx) / (_image.width * _scale))
            .clamp(0.0, 1.0);
    final top =
        (.5 + (-_viewport.height / 2 - _offset.dy) / (_image.height * _scale))
            .clamp(0.0, 1.0);
    final right =
        (.5 + (_viewport.width / 2 - _offset.dx) / (_image.width * _scale))
            .clamp(0.0, 1.0);
    final bottom =
        (.5 + (_viewport.height / 2 - _offset.dy) / (_image.height * _scale))
            .clamp(0.0, 1.0);
    final rect = Rect.fromLTRB(
      (left - .025).clamp(0.0, 1.0),
      (top - .025).clamp(0.0, 1.0),
      (right + .025).clamp(0.0, 1.0),
      (bottom + .025).clamp(0.0, 1.0),
    );
    final needed =
        (_image.longestSide * _scale * MediaQuery.devicePixelRatioOf(context))
            .ceil();
    final edge = [
      1600,
      2048,
      2560,
      3200,
      4096,
      5120,
      6144,
      8192,
      12288,
      16384,
    ].firstWhere((v) => v >= needed, orElse: () => 16384);
    widget.onDetailRequest!(rect, edge);
  }

  /// A short tap opens the full-screen viewer (not while comparing, picking
  /// focus or removing).
  void _openLightbox() {
    if (_comparing || _picking || widget.brush != null) return;
    final box = context.findRenderObject() as RenderBox?;
    if (box == null) return;
    final origin = box.localToGlobal(_screen(Offset.zero));
    PhotoLightbox.open(
      context,
      photo: widget.photo,
      from: origin & (_image * _scale),
    );
  }

  /// One photo layer: the texture, its zoom detail, and (when comparing)
  /// the original clipped to the left of the divider.
  Widget _surface({required bool original}) => Stack(
    fit: StackFit.expand,
    children: [
      NativePreview(
        textureId: original
            ? widget.photo.originalTextureId ?? widget.photo.textureId
            : widget.photo.textureId,
      ),
      if (widget.detail != null && widget.brush == null)
        Positioned(
          left: widget.detail!.rect.left * _image.width,
          top: widget.detail!.rect.top * _image.height,
          width: widget.detail!.rect.width * _image.width,
          height: widget.detail!.rect.height * _image.height,
          child: IgnorePointer(
            child: NativePreview(
              textureId: original
                  ? widget.detail!.originalTextureId
                  : widget.detail!.textureId,
            ),
          ),
        ),
    ],
  );

  Widget _pill(Widget child, {VoidCallback? onTap, String? label}) => Semantics(
    button: onTap != null,
    label: label,
    child: GestureDetector(
      onTap: onTap,
      child: ClipRRect(
        borderRadius: BorderRadius.circular(12),
        child: DecoratedBox(
          decoration: const BoxDecoration(color: Color(0x61000000)),
          child: SizedBox(
            height: 28,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10),
              child: DefaultTextStyle(
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 13,
                  fontWeight: FontWeight.w600,
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
                child: Center(widthFactor: 1, child: child),
              ),
            ),
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final changed = _viewport != constraints.biggest;
      _viewport = constraints.biggest;
      final fit = math.min(
        _viewport.width / widget.photo.width,
        _viewport.height / widget.photo.height,
      );
      _image = Size(widget.photo.width * fit, widget.photo.height * fit);
      if (changed) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted) _requestDetail();
        });
      }
      final hasOriginal = widget.photo.originalTextureId != null;
      final peeking = _peek && !_comparing && !_picking;
      final splitX = _screen(Offset(_split, .5)).dx;
      final top = _screen(Offset.zero).dy,
          bottom = _screen(const Offset(1, 1)).dy;
      final zoomed = _scale > 1.01;
      return Stack(
        children: [
          Positioned.fill(
            child: ClipRect(
              child: RawGestureDetector(
                behavior: HitTestBehavior.opaque,
                gestures: {
                  ScaleGestureRecognizer:
                      GestureRecognizerFactoryWithHandlers<
                        ScaleGestureRecognizer
                      >(ScaleGestureRecognizer.new, (r) {
                        r
                          ..onStart = _start
                          ..onUpdate = _update
                          ..onEnd = (details) {
                            if (_brushing) {
                              widget.brush?.end();
                              _brushing = false;
                            } else if (_splitting) {
                              _splitting = false;
                            } else {
                              _settle(
                                velocity: details.velocity.pixelsPerSecond,
                              );
                            }
                          };
                      }),
                  DoubleTapGestureRecognizer:
                      GestureRecognizerFactoryWithHandlers<
                        DoubleTapGestureRecognizer
                      >(DoubleTapGestureRecognizer.new, (r) {
                        r
                          ..onDoubleTapDown = (d) {
                            _doubleTapAt = d.localPosition;
                          }
                          ..onDoubleTap = _doubleTap;
                      }),
                  TapGestureRecognizer:
                      GestureRecognizerFactoryWithHandlers<
                        TapGestureRecognizer
                      >(TapGestureRecognizer.new, (r) {
                        r.onTap = _openLightbox;
                      }),
                  if (hasOriginal && widget.brush == null)
                    LongPressGestureRecognizer:
                        GestureRecognizerFactoryWithHandlers<
                          LongPressGestureRecognizer
                        >(
                          () => LongPressGestureRecognizer(duration: peekDelay),
                          (r) {
                            r
                              ..onLongPressStart = (_) {
                                if (!_comparing) setState(() => _peek = true);
                              }
                              ..onLongPressEnd = (_) {
                                setState(() => _peek = false);
                              }
                              ..onLongPressCancel = () {
                                if (_peek) setState(() => _peek = false);
                              };
                          },
                        ),
                },
                child: Center(
                  child: Transform.translate(
                    offset: _offset,
                    child: Transform.scale(
                      scale: _scale,
                      child: SizedBox.fromSize(
                        size: _image,
                        child: Stack(
                          fit: StackFit.expand,
                          children: [
                            _surface(original: peeking || widget.showOriginal),
                            if (_comparing && hasOriginal)
                              ClipRect(
                                clipper: _SplitClipper(_split),
                                child: _surface(original: true),
                              ),
                            if (hasOriginal)
                              _DevelopSweep(
                                animation: _sweep,
                                reduced: MediaQuery.disableAnimationsOf(
                                  context,
                                ),
                                child: _surface(original: true),
                              ),
                            if (widget.brush != null &&
                                widget.showBrush &&
                                !widget.showOriginal)
                              IgnorePointer(
                                child: CustomPaint(
                                  painter: BrushPainter(widget.brush!),
                                ),
                              ),
                            if (_picking && widget.photo.focusTextureId != null)
                              IgnorePointer(
                                child: NativePreview(
                                  textureId: widget.photo.focusTextureId!,
                                ),
                              ),
                            if (!peeking && widget.focus != null)
                              Positioned(
                                left:
                                    (_focus ?? widget.focus!).dx *
                                        _image.width -
                                    22,
                                top:
                                    (_focus ?? widget.focus!).dy *
                                        _image.height -
                                    22,
                                child: _focusPin(),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
          if (_comparing && hasOriginal) ...[
            Positioned(
              left: splitX - 1,
              top: top.clamp(0, _viewport.height),
              height:
                  (bottom.clamp(0, _viewport.height) -
                          top.clamp(0, _viewport.height))
                      .toDouble(),
              width: 2,
              child: const IgnorePointer(
                child: ColoredBox(color: Color(0xebffffff)),
              ),
            ),
            Positioned(
              left: splitX - 18,
              top:
                  (_screen(
                            const Offset(.5, .5),
                          ).dy.clamp(18, _viewport.height - 18) -
                          18)
                      .toDouble(),
              child: Semantics(
                slider: true,
                label: 'Before and after divider',
                value: '${(_split * 100).round()}% original',
                child: IgnorePointer(
                  child: ClipOval(
                    child: Container(
                      width: 36,
                      height: 36,
                      color: const Color(0x61000000),
                      alignment: Alignment.center,
                      child: const Glyph(
                        'compare',
                        size: 18,
                        color: Colors.white,
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              top: 10,
              right: _viewport.width - splitX + 8,
              child: AnimatedOpacity(
                opacity: _split > .12 ? 1 : 0,
                duration: const Duration(milliseconds: 150),
                child: IgnorePointer(child: _pill(const Text('Before'))),
              ),
            ),
            Positioned(
              top: 10,
              left: splitX + 8,
              child: AnimatedOpacity(
                opacity: _split < .88 ? 1 : 0,
                duration: const Duration(milliseconds: 150),
                child: IgnorePointer(child: _pill(const Text('After'))),
              ),
            ),
          ],
          if (peeking)
            Positioned(
              top: 10,
              left: 10,
              child: IgnorePointer(child: _pill(const Text('Original'))),
            ),
          if (_picking)
            Positioned(
              top: 10,
              left: 0,
              right: 0,
              child: IgnorePointer(
                child: Center(
                  child: _pill(
                    const Text('Hold & drag to focus · grey is outside focus'),
                  ),
                ),
              ),
            ),
          // Status, top right: Developing beside the zoom level.
          Positioned(
            top: 10,
            right: 10,
            child: Row(
              children: [
                if (_slow)
                  _pill(
                    const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        SizedBox(
                          width: 13,
                          height: 13,
                          child: CircularProgressIndicator(
                            strokeWidth: 1.6,
                            color: Colors.white,
                          ),
                        ),
                        SizedBox(width: 6),
                        Text('Developing'),
                      ],
                    ),
                  ),
                if (_slow && zoomed) const SizedBox(width: 6),
                if (zoomed)
                  _pill(
                    label: 'Fit to view (double-tap)',
                    onTap: () => _animateTo(1, Offset.zero),
                    Text.rich(
                      TextSpan(
                        text: '${(_scale * 100).round()}% ',
                        children: const [
                          TextSpan(
                            text: '· Fit',
                            style: TextStyle(color: Color(0xffaaaab3)),
                          ),
                        ],
                      ),
                    ),
                  ),
              ],
            ),
          ),
          if (hasOriginal && widget.brush == null)
            Positioned(
              left: 12,
              bottom: widget.compareInset,
              child: _compareButton(),
            ),
        ],
      );
    },
  );

  /// Floating glass "Compare with original" toggle (web compare button).
  Widget _compareButton() {
    void toggle() => setState(() {
      _compare = !_compare;
      _split = .5;
    });
    if (useNativeControls) {
      return NativeButton(
        label: 'Compare with original',
        symbol: 'rectangle.split.2x1',
        selected: _compare,
        width: 44,
        onTap: toggle,
      );
    }
    return Semantics(
      toggled: _compare,
      child: Glass(
        radius: 22,
        child: Press(
          label: 'Compare with original',
          plain: !_compare,
          selected: _compare,
          radius: 22,
          onTap: toggle,
          child: Glyph('compare', color: _compare ? signalBlue : null),
        ),
      ),
    );
  }

  /// White ring with a centre dot (web focus pin), counter-scaled so it
  /// keeps its size while zoomed.
  Widget _focusPin() => GestureDetector(
    key: const ValueKey('focus-pin'),
    behavior: HitTestBehavior.opaque,
    onPanDown: (_) {
      setState(() {
        _picking = true;
        _focus = widget.focus;
      });
      widget.onFocusStart?.call();
      widget.onFocusPreview?.call(_focus!);
    },
    onPanUpdate: (d) {
      final point =
          (_focus ?? widget.focus!) +
          Offset(d.delta.dx / _image.width, d.delta.dy / _image.height);
      setState(
        () => _focus = Offset(point.dx.clamp(0, 1), point.dy.clamp(0, 1)),
      );
      widget.onFocusPreview?.call(_focus!);
    },
    onPanEnd: (_) {
      widget.onFocusEnd?.call(_focus!);
      setState(() {
        _picking = false;
        _focus = null;
      });
    },
    onPanCancel: () {
      widget.onFocusEnd?.call(_focus ?? widget.focus!);
      setState(() {
        _picking = false;
        _focus = null;
      });
    },
    child: Transform.scale(
      scale: 1 / _scale,
      child: Semantics(
        button: true,
        label: 'Focus point. Drag to focus.',
        child: SizedBox(
          width: 44,
          height: 44,
          child: Center(
            child: Stack(
              alignment: Alignment.center,
              children: [
                // 1.5 px white ring with a 1 px dark outline on both sides.
                Container(
                  width: 32,
                  height: 32,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    border: Border.all(color: const Color(0x8c000000)),
                  ),
                  alignment: Alignment.center,
                  child: Container(
                    width: 30,
                    height: 30,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      border: Border.all(color: Colors.white, width: 1.5),
                    ),
                  ),
                ),
                Container(
                  width: 4,
                  height: 4,
                  decoration: const BoxDecoration(
                    color: Colors.white,
                    shape: BoxShape.circle,
                    boxShadow: [
                      BoxShadow(color: Color(0x73000000), spreadRadius: 1),
                    ],
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}

/// Keeps the part of the photo left of the divider (photo fraction).
class _SplitClipper extends CustomClipper<Rect> {
  _SplitClipper(this.split);
  final double split;
  @override
  Rect getClip(Size size) =>
      Rect.fromLTWH(0, 0, size.width * split, size.height);
  @override
  bool shouldReclip(_SplitClipper old) => old.split != split;
}

/// The original covering the photo below a blue glowing line that moves
/// down, revealing the film result (a fade under Reduce Motion).
class _DevelopSweep extends StatelessWidget {
  const _DevelopSweep({
    required this.animation,
    required this.reduced,
    required this.child,
  });
  final AnimationController animation;
  final bool reduced;
  final Widget child;
  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: animation,
    builder: (context, _) {
      if (!animation.isAnimating) return const SizedBox.shrink();
      final t = Curves.easeInOutCubic.transform(animation.value);
      if (reduced) {
        return IgnorePointer(
          child: Opacity(opacity: 1 - t, child: child),
        );
      }
      return IgnorePointer(
        child: LayoutBuilder(
          builder: (context, box) {
            final y = box.maxHeight * t;
            return Stack(
              fit: StackFit.expand,
              children: [
                ClipRect(clipper: _BelowClipper(y), child: child),
                Positioned(
                  left: 0,
                  right: 0,
                  top: y - 1,
                  height: 2,
                  child: const DecoratedBox(
                    decoration: BoxDecoration(
                      color: Color(0xff5cb8ff),
                      boxShadow: [
                        BoxShadow(color: Color(0xb30091ff), blurRadius: 12),
                      ],
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      );
    },
  );
}

class _BelowClipper extends CustomClipper<Rect> {
  _BelowClipper(this.top);
  final double top;
  @override
  Rect getClip(Size size) =>
      Rect.fromLTRB(0, top.clamp(0, size.height), size.width, size.height);
  @override
  bool shouldReclip(_BelowClipper old) => old.top != top;
}
