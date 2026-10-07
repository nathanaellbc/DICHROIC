import 'dart:async';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:exposure_ios/editor_controller.dart';

class FakeEngine extends ExposureEngine {
  final renders = <double>[];
  final completions = <Completer<void>>[];
  int exports = 0;
  @override
  Future<NativePhoto> open(String path) async =>
      const NativePhoto(1, 1200, 800);
  @override
  Future<void> render(double ev) {
    renders.add(ev);
    final pending = Completer<void>();
    completions.add(pending);
    return pending.future;
  }

  @override
  Future<String> export(double ev) async {
    exports++;
    return '/tmp/photo.png';
  }

  @override
  Future<void> close() async {}
}

void main() {
  test(
    'export drains the active preview and restores the latest slider preview',
    () async {
      final engine = FakeEngine();
      final controller = EditorController(engine);
      await controller.open('/tmp/input.heic');
      controller.setExposure(1);
      controller.setExposure(3);
      final exporting = controller.export();
      await Future<void>.delayed(Duration.zero);
      expect(engine.exports, 0);
      expect(controller.exporting, true);
      engine.completions.first.complete();
      expect(await exporting, '/tmp/photo.png');
      expect(engine.exports, 1);
      expect(engine.renders, [1, 3]);
      engine.completions.last.complete();
      await Future<void>.delayed(Duration.zero);
      controller.dispose();
    },
  );
  test(
    'slider replaces pending frames; opening a photo does not develop an export',
    () async {
      final engine = FakeEngine();
      final controller = EditorController(engine);
      await controller.open('/tmp/input.heic');
      expect(engine.exports, 0);
      controller.setExposure(1);
      controller.setExposure(2);
      controller.setExposure(3);
      expect(engine.renders, [1]);
      engine.completions.first.complete();
      await Future<void>.delayed(Duration.zero);
      expect(engine.renders, [1, 3]);
      engine.completions.last.complete();
      await Future<void>.delayed(Duration.zero);
      expect(await controller.export(), '/tmp/photo.png');
      expect(engine.exports, 1);
      controller.dispose();
    },
  );
}
