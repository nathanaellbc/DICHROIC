import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';

class BrushStroke {
  BrushStroke(this.radius, this.erase, Offset point) : points = [point];
  final double radius;
  final bool erase;
  final List<Offset> points;
}

class RemovalBrush extends ChangeNotifier {
  final strokes = <BrushStroke>[];
  double diameter = 32;
  bool painting = true, eraser = false;
  BrushStroke? active;
  bool get isEmpty => strokes.isEmpty;
  void begin(Offset point, double radius) {
    active = BrushStroke(radius, eraser, point);
    strokes.add(active!);
    notifyListeners();
  }

  void add(Offset point) {
    active?.points.add(point);
    notifyListeners();
  }

  void end() {
    active = null;
    notifyListeners();
  }

  void cancel() {
    if (active != null) strokes.remove(active);
    active = null;
    notifyListeners();
  }

  void undo() {
    if (strokes.isNotEmpty) strokes.removeLast();
    notifyListeners();
  }

  void clear() {
    strokes.clear();
    active = null;
    notifyListeners();
  }

  Future<({Uint8List pixels, int width, int height})> mask(
    int width,
    int height,
  ) async {
    final scale = 1024 / (width > height ? width : height);
    final w = (width * scale).round().clamp(1, 1024),
        h = (height * scale).round().clamp(1, 1024);
    final recorder = ui.PictureRecorder(), canvas = Canvas(recorder);
    paintBrush(canvas, Size(w.toDouble(), h.toDouble()), strokes, Colors.white);
    final picture = recorder.endRecording(),
        image = await picture.toImage(w, h);
    final data = await image.toByteData(format: ui.ImageByteFormat.rawRgba);
    image.dispose();
    picture.dispose();
    if (data == null) throw StateError('Could not prepare brush mask.');
    final rgba = data.buffer.asUint8List(
      data.offsetInBytes,
      data.lengthInBytes,
    );
    // Match web's binary painted mask; antialiasing cannot select outside it.
    final pixels = Uint8List(w * h);
    for (var p = 0; p < pixels.length; p++) {
      pixels[p] = rgba[p * 4 + 3] >= 128 ? 255 : 0;
    }
    return (pixels: pixels, width: w, height: h);
  }
}

void paintBrush(
  Canvas canvas,
  Size size,
  List<BrushStroke> strokes,
  Color color,
) {
  canvas.saveLayer(Offset.zero & size, Paint());
  for (final stroke in strokes) {
    final paint = Paint()
      ..color = color
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke.radius * size.width * 2
      ..blendMode = stroke.erase ? BlendMode.clear : BlendMode.srcOver;
    final points = stroke.points
        .map((p) => Offset(p.dx * size.width, p.dy * size.height))
        .toList();
    if (points.length == 1) {
      canvas.drawCircle(
        points.first,
        stroke.radius * size.width,
        paint..style = PaintingStyle.fill,
      );
    } else {
      final path = Path()..moveTo(points.first.dx, points.first.dy);
      for (final p in points.skip(1)) {
        path.lineTo(p.dx, p.dy);
      }
      canvas.drawPath(path, paint);
    }
  }
  canvas.restore();
}

class BrushPainter extends CustomPainter {
  BrushPainter(this.brush) : super(repaint: brush);
  final RemovalBrush brush;
  @override
  void paint(Canvas canvas, Size size) =>
      paintBrush(canvas, size, brush.strokes, const Color(0x73ff4650));
  @override
  bool shouldRepaint(BrushPainter oldDelegate) => oldDelegate.brush != brush;
}
