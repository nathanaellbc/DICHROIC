import 'dart:math' as math;
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/scheduler.dart';
import 'editor_widgets.dart';

/// Gestures transform the cached native texture; they never schedule a develop.
class PhotoViewport extends StatefulWidget {
  const PhotoViewport({
    super.key,
    required this.photo,
    this.focus,
    this.onFocusStart,
    this.onFocusPreview,
    this.onFocusEnd,
  });
  final NativePhoto photo;
  final Offset? focus;
  final VoidCallback? onFocusStart;
  final ValueChanged<Offset>? onFocusPreview, onFocusEnd;

  @override
  State<PhotoViewport> createState() => _PhotoViewportState();
}

class _PhotoViewportState extends State<PhotoViewport>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker;
  Size _viewport = Size.zero;
  Size _image = Size.zero;
  double _scale = 1;
  Offset _offset = Offset.zero;
  double _startScale = 1;
  Offset _startOffset = Offset.zero;
  Offset _startFocal = Offset.zero;
  SpringSimulation? _xSpring, _ySpring, _scaleSpring;
  bool _before = false;
  bool _picking = false;
  Offset? _focus;

  @override
  void initState() {
    super.initState();
    _ticker = createTicker(_tick);
  }

  @override
  void didUpdateWidget(PhotoViewport oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!identical(oldWidget.photo, widget.photo)) {
      _ticker.stop();
      _scale = 1;
      _offset = Offset.zero;
      _before = false;
    }
  }

  @override
  void dispose() {
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

  void _start(ScaleStartDetails details) {
    _ticker.stop();
    _startScale = _scale;
    _startOffset = _offset;
    _startFocal = details.localFocalPoint - _viewport.center(Offset.zero);
  }

  void _update(ScaleUpdateDetails details) {
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
    if (MediaQuery.disableAnimationsOf(context)) {
      setState(() {
        _scale = scale;
        _offset = target;
      });
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

  void _tick(Duration elapsed) {
    final t = elapsed.inMicroseconds / Duration.microsecondsPerSecond;
    setState(() {
      _offset = Offset(_xSpring!.x(t), _ySpring!.x(t));
      _scale = _scaleSpring!.x(t);
    });
    if (_xSpring!.isDone(t) && _ySpring!.isDone(t) && _scaleSpring!.isDone(t)) {
      _ticker.stop();
    }
  }

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      _viewport = constraints.biggest;
      final fit = math.min(
        _viewport.width / widget.photo.width,
        _viewport.height / widget.photo.height,
      );
      _image = Size(widget.photo.width * fit, widget.photo.height * fit);
      return Stack(
        children: [
          Positioned.fill(
            child: ClipRect(
              child: GestureDetector(
                behavior: HitTestBehavior.opaque,
                onScaleStart: _start,
                onScaleUpdate: _update,
                onScaleEnd: (details) =>
                    _settle(velocity: details.velocity.pixelsPerSecond),
                onDoubleTap: () {
                  _ticker.stop();
                  _settle(reset: true);
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
                            Texture(
                              textureId: _before
                                  ? widget.photo.originalTextureId ??
                                        widget.photo.textureId
                                  : widget.photo.textureId,
                              filterQuality: FilterQuality.medium,
                            ),
                            if (_picking && widget.photo.focusTextureId != null)
                              IgnorePointer(
                                child: Texture(
                                  textureId: widget.photo.focusTextureId!,
                                ),
                              ),
                            if (!_before && widget.focus != null)
                              Positioned(
                                left:
                                    (_focus ?? widget.focus!).dx *
                                        _image.width -
                                    22,
                                top:
                                    (_focus ?? widget.focus!).dy *
                                        _image.height -
                                    22,
                                child: GestureDetector(
                                  behavior: HitTestBehavior.opaque,
                                  onPanStart: (_) {
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
                                        Offset(
                                          d.delta.dx / (_image.width * _scale),
                                          d.delta.dy / (_image.height * _scale),
                                        );
                                    setState(
                                      () => _focus = Offset(
                                        point.dx.clamp(0, 1),
                                        point.dy.clamp(0, 1),
                                      ),
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
                                    widget.onFocusEnd?.call(
                                      _focus ?? widget.focus!,
                                    );
                                    setState(() {
                                      _picking = false;
                                      _focus = null;
                                    });
                                  },
                                  child: Transform.scale(
                                    scale: 1 / _scale,
                                    child: const SizedBox(
                                      width: 44,
                                      height: 44,
                                      child: Center(
                                        child: Glyph(
                                          'focus',
                                          color: Colors.white,
                                          size: 28,
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
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
          if (widget.photo.originalTextureId != null)
            Positioned(
              left: 16,
              bottom: 8,
              child: Semantics(
                toggled: _before,
                child: IconButton.filledTonal(
                  tooltip: _before
                      ? 'Show edited photo'
                      : 'Show original photo',
                  onPressed: () => setState(() => _before = !_before),
                  icon: const Glyph('compare'),
                ),
              ),
            ),
          if (_before)
            const Positioned(
              right: 16,
              bottom: 20,
              child: DecoratedBox(
                decoration: BoxDecoration(color: Color(0xb3000000)),
                child: Padding(
                  padding: EdgeInsets.symmetric(horizontal: 8, vertical: 4),
                  child: Text(
                    'Original',
                    style: TextStyle(color: Colors.white),
                  ),
                ),
              ),
            ),
        ],
      );
    },
  );
}
