import 'dart:async';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:exposure_ios/native_editor_controller.dart';
import 'package:flutter_test/flutter_test.dart';

class CanonicalFake extends ExposureEngine {
  final frames = <Map<String, dynamic>>[];
  Completer<void>? gate;
  final exports = <Map<String, dynamic>>[];
  @override
  Future<Map<String, dynamic>> catalog() async => {
    'baseline': {'a': 0, 'b': 0},
  };
  @override
  Future<NativePhoto> open(String path) async =>
      const NativePhoto(1, 1200, 800);
  @override
  Future<List<dynamic>> controls(Map<String, dynamic> params) async => [];
  @override
  Future<Map<String, dynamic>> patch(
    Map<String, dynamic> params,
    String action,
    String id,
    Object? value,
  ) async {
    return {
      ...params,
      if (action == 'fields') ...value as Map<String, dynamic> else id: value,
    };
  }

  @override
  Future<void> develop(Map<String, dynamic> params) async {
    frames.add(Map.of(params));
    await gate?.future;
  }

  @override
  Future<String> developExport(Map<String, dynamic> params) async {
    exports.add(Map.of(params));
    return 'photo.png';
  }

  @override
  Future<void> close() async {}
}

Future<void> flush() => Future<void>.delayed(Duration.zero);

void main() {
  test(
    'coalesces renders while retaining updates to different controls',
    () async {
      final engine = CanonicalFake(),
          c = NativeEditorController(CanonicalFake());
      c.dispose();
      final editor = NativeEditorController(engine);
      await editor.open('photo');
      await flush();
      engine.gate = Completer();
      editor.beginGesture();
      await editor.edit('position', 'a', 1);
      await editor.edit('position', 'a', 2);
      await editor.edit('position', 'b', 3);
      await editor.endGesture();
      expect(engine.frames.last['a'], 1);
      expect(editor.params, {'a': 2, 'b': 3});
      engine.gate!.complete();
      engine.gate = null;
      await flush();
      await flush();
      expect(engine.frames.last, {'a': 2, 'b': 3});
      await editor.undo();
      await flush();
      expect(editor.params, {'a': 0, 'b': 0});
      await editor.redo();
      await flush();
      expect(editor.params, {'a': 2, 'b': 3});
      editor.dispose();
    },
  );
  test(
    'export awaits edits and active preview, then uses latest parameters',
    () async {
      final engine = CanonicalFake(),
          editor = NativeEditorController(CanonicalFake());
      editor.dispose();
      final c = NativeEditorController(engine);
      await c.open('photo');
      await flush();
      engine.gate = Completer();
      await c.edit('position', 'a', 1);
      await c.edit('position', 'b', 2);
      final export = c.export();
      await flush();
      expect(engine.exports, isEmpty);
      engine.gate!.complete();
      engine.gate = null;
      expect(await export, 'photo.png');
      expect(engine.exports.single, {'a': 1, 'b': 2});
      c.dispose();
    },
  );
}
