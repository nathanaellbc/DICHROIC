import 'dart:math' as math;
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import 'package:flutter/scheduler.dart';
import 'editor_widgets.dart';
import 'native_controls.dart';
import 'native_preview.dart';
import 'photo_viewport.dart' show peekDelay;

/// Full-screen viewer, as the web `PhotoLightbox`: grows from the editor
/// photo over black; pinch, double-tap and pan with edge bounce; at fit a tap
/// or a swipe down closes, and holding shows the original.
class PhotoLightbox extends StatefulWidget {
  const PhotoLightbox({super.key, required this.photo, required this.from});
  final NativePhoto photo;

  /// The photo's rectangle in the editor, for the grow and shrink.
  final Rect from;

  static Future<void> open(
    BuildContext context, {
    required NativePhoto photo,
    required Rect from,
  }) => Navigator.of(context).push(
    PageRouteBuilder<void>(
      opaque: false,
      transitionDuration: const Duration(milliseconds: 500),
      reverseTransitionDuration: const Duration(milliseconds: 380),
      pageBuilder: (context, animation, _) =>
          PhotoLightbox(photo: photo, from: from),
    ),
  );

  @override
  State<PhotoLightbox> createState() => _PhotoLightboxState();
}

class _PhotoLightboxState extends State<PhotoLightbox>
    with SingleTickerProviderStateMixin {
  late final Ticker _ticker = createTicker(_tick);
  double _scale = 1, _startScale = 1;
  Offset _offset = Offset.zero, _startOffset = Offset.zero;
  Offset _startFocal = Offset.zero;
  Offset? _doubleTapAt;
  double _dismiss = 0;
  bool _peek = false;
  SpringSimulation? _xs, _ys, _ss;
  Size _view = Size.zero, _image = Size.zero;

  @override
  void dispose() {
    _ticker.dispose();
    super.dispose();
  }

  Offset _bounds(double scale) => Offset(
    math.max(0, (_image.width * scale - _view.width) / 2),
    math.max(0, (_image.height * scale - _view.height) / 2),
  );

  void _animateTo(
    double scale,
    Offset offset, [
    Offset velocity = Offset.zero,
  ]) {
    _ticker.stop();
    if (MediaQuery.disableAnimationsOf(context)) {
      setState(() {
        _scale = scale;
        _offset = offset;
      });
      return;
    }
    const spring = SpringDescription(mass: 1, stiffness: 260, damping: 30);
    _xs = SpringSimulation(spring, _offset.dx, offset.dx, velocity.dx);
    _ys = SpringSimulation(spring, _offset.dy, offset.dy, velocity.dy);
    _ss = SpringSimulation(spring, _scale, scale, 0);
    _ticker.start();
  }

  void _tick(Duration elapsed) {
    final t = elapsed.inMicroseconds / 1e6;
    setState(() {
      _offset = Offset(_xs!.x(t), _ys!.x(t));
      _scale = _ss!.x(t);
    });
    if (_xs!.isDone(t) && _ys!.isDone(t) && _ss!.isDone(t)) _ticker.stop();
  }

  void _close() => Navigator.of(context).pop();

  void _start(ScaleStartDetails d) {
    _ticker.stop();
    _startScale = _scale;
    _startOffset = _offset;
    _startFocal = d.localFocalPoint - _view.center(Offset.zero);
  }

  void _update(ScaleUpdateDetails d) {
    final focal = d.localFocalPoint - _view.center(Offset.zero);
    // At fit, a one-finger vertical drag dismisses; the backdrop fades.
    if (d.pointerCount == 1 && _startScale <= 1.01 && d.scale == 1) {
      setState(() => _dismiss = (focal - _startFocal).dy);
      return;
    }
    final raw = _startScale * d.scale;
    final scale = raw > 8 ? 8 + (raw - 8) / (1 + raw - 8) * .5 : raw;
    final offset = focal - (_startFocal - _startOffset) * (scale / _startScale);
    final b = _bounds(scale);
    double rubber(double v, double bound, double dim) {
      if (v.abs() <= bound) return v;
      final extra = v.abs() - bound;
      return v.sign * (bound + extra * dim * .55 / (dim + extra * .55));
    }

    setState(() {
      _scale = scale;
      _offset = Offset(
        rubber(offset.dx, b.dx, _view.width),
        rubber(offset.dy, b.dy, _view.height),
      );
    });
  }

  void _end(ScaleEndDetails d) {
    final v = d.velocity.pixelsPerSecond;
    if (_dismiss != 0) {
      if (_dismiss > 110 || v.dy > 600) {
        _close();
      } else {
        setState(() => _dismiss = 0);
      }
      return;
    }
    // Pinching well below fit closes.
    if (_scale < .72) {
      _close();
      return;
    }
    final scale = _scale.clamp(1.0, 8.0).toDouble();
    final b = _bounds(scale);
    // Pan glides with inertia and bounces at the edges.
    final target = Offset(
      (_offset.dx + v.dx * .2).clamp(-b.dx, b.dx).toDouble(),
      (_offset.dy + v.dy * .2).clamp(-b.dy, b.dy).toDouble(),
    );
    _animateTo(scale, target, v);
  }

  void _doubleTap() {
    if (_scale > 1.01) {
      _animateTo(1, Offset.zero);
      return;
    }
    const scale = 2.5;
    final focal =
        (_doubleTapAt ?? _view.center(Offset.zero)) - _view.center(Offset.zero);
    final raw = focal - (focal - _offset) * (scale / _scale);
    final b = _bounds(scale);
    _animateTo(
      scale,
      Offset(
        raw.dx.clamp(-b.dx, b.dx).toDouble(),
        raw.dy.clamp(-b.dy, b.dy).toDouble(),
      ),
    );
  }

  Widget _pill(String text) => ClipRRect(
    borderRadius: BorderRadius.circular(12),
    child: ColoredBox(
      color: const Color(0x61000000),
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
        child: Text(
          text,
          style: const TextStyle(
            color: Colors.white,
            fontSize: 13,
            fontWeight: FontWeight.w600,
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final route = ModalRoute.of(context)!.animation!;
    return LayoutBuilder(
      builder: (context, constraints) {
        _view = constraints.biggest;
        final fit = math.min(
          _view.width / widget.photo.width,
          _view.height / widget.photo.height,
        );
        _image = Size(widget.photo.width * fit, widget.photo.height * fit);
        final target = Rect.fromCenter(
          center: _view.center(Offset.zero),
          width: _image.width,
          height: _image.height,
        );
        final fade = (1 - _dismiss.abs() / 400).clamp(0.0, 1.0);
        return AnimatedBuilder(
          animation: route,
          builder: (context, _) {
            final t = CurvedAnimation(
              parent: route,
              curve: const Cubic(.2, 1.1, .3, 1),
              reverseCurve: Curves.easeInCubic,
            ).value;
            final rect = Rect.lerp(widget.from, target, t)!;
            return Stack(
              children: [
                Positioned.fill(
                  child: Opacity(
                    opacity: (route.value * fade).clamp(0.0, 1.0),
                    child: const ColoredBox(color: Colors.black),
                  ),
                ),
                Positioned.fill(
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
                              ..onEnd = _end;
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
                            r.onTap = () {
                              if (_scale <= 1.01) _close();
                            };
                          }),
                      LongPressGestureRecognizer:
                          GestureRecognizerFactoryWithHandlers<
                            LongPressGestureRecognizer
                          >(
                            () =>
                                LongPressGestureRecognizer(duration: peekDelay),
                            (r) {
                              r
                                ..onLongPressStart = (_) {
                                  setState(() => _peek = true);
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
                    child: Stack(
                      children: [
                        Positioned.fromRect(
                          rect: rect.shift(
                            t >= 1
                                ? _offset + Offset(0, _dismiss)
                                : Offset.zero,
                          ),
                          child: Transform.scale(
                            scale: t >= 1 ? _scale : 1,
                            child: NativePreview(
                              textureId: _peek
                                  ? widget.photo.originalTextureId ??
                                        widget.photo.textureId
                                  : widget.photo.textureId,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
                if (_peek)
                  Positioned(
                    top: MediaQuery.paddingOf(context).top + 12,
                    left: 0,
                    right: 0,
                    child: Center(child: _pill('Original')),
                  ),
                Positioned(
                  top: MediaQuery.paddingOf(context).top + 8,
                  right: 12,
                  child: Opacity(
                    opacity: route.value * fade,
                    child: useNativeControls
                        ? NativeButton(
                            label: 'Close',
                            symbol: 'xmark',
                            width: 44,
                            onTap: _close,
                          )
                        : Glass(
                            radius: 22,
                            child: Press(
                              label: 'Close',
                              plain: true,
                              onTap: _close,
                              child: const Glyph('close', color: Colors.white),
                            ),
                          ),
                  ),
                ),
              ],
            );
          },
        );
      },
    );
  }
}
