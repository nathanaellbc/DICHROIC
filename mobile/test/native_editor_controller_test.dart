import 'dart:async';
import 'dart:typed_data';
import 'dart:ui';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:exposure_ios/native_editor_controller.dart';
import 'package:flutter_test/flutter_test.dart';

class CanonicalFake extends ExposureEngine {
  @override
  Stream<Map<String, dynamic>> get events => const Stream.empty();
  int cursor = 0;
  @override
  Future<void> beginRemoval() async {}
  @override
  Future<void> previewRemoval(Uint8List mask, int width, int height) async {}
  @override
  Future<int> applyRemoval() async => ++cursor;
  @override
  Future<void> cancelRemoval() async {}
  @override
  Future<void> restoreRemoval(int cursor) async {
    this.cursor = cursor;
  }

  final frames = <Map<String, dynamic>>[];
  Completer<void>? gate;
  final exports = <Map<String, dynamic>>[];
  final details = <({Rect rect, int edge})>[];
  Completer<NativeDetail?>? detailGate;
  @override
  Future<NativeDetail?> detail(
    Map<String, dynamic> params,
    Rect rect,
    int longEdge,
  ) async {
    details.add((rect: rect, edge: longEdge));
    if (detailGate != null) return detailGate!.future;
    return NativeDetail({
      'textureId': 20,
      'originalTextureId': 21,
      'x': (rect.left * longEdge).round(),
      'y': (rect.top * longEdge).round(),
      'width': (rect.width * longEdge).round(),
      'height': (rect.height * longEdge).round(),
      'fullWidth': longEdge,
      'fullHeight': longEdge,
    });
  }

  @override
  Future<Map<String, dynamic>> catalog() async => {
    'baseline': {'a': 0, 'b': 0},
  };
  @override
  Future<NativePhoto> open(String path) async =>
      const NativePhoto(1, 1200, 800, sourceWidth: 8144, sourceHeight: 5424);
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
    'zoom detail retains its high-water resolution and export waits for detail work',
    () async {
      final engine = CanonicalFake();
      final c = NativeEditorController(engine);
      await c.open('photo');
      await flush();
      const area = Rect.fromLTWH(.25, .25, .5, .5);
      c.requestDetail(area, 4096);
      await flush();
      expect(engine.details.length, 1);
      final cached = c.detail;
      c.requestDetail(const Rect.fromLTWH(.1, .1, .8, .8), 2048);
      await flush();
      c.requestDetail(area, 4096);
      await flush();
      expect(c.detail, same(cached));
      expect(engine.details.length, 1);
      engine.detailGate = Completer();
      c.requestDetail(area, 6144);
      await flush();
      final export = c.export();
      await flush();
      expect(engine.exports, isEmpty);
      engine.detailGate!.complete(null);
      expect(await export, 'photo.png');
      c.dispose();
    },
  );
  test(
    'coalesces renders while retaining updates to different controls',
    () async {
      final engine = CanonicalFake();
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
      final engine = CanonicalFake();
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
  test(
    'applying removal regrades the changed source and undo restores its cursor',
    () async {
      final engine = CanonicalFake();
      final c = NativeEditorController(engine);
      await c.open('photo');
      await flush();
      final original = c.photo;
      await c.beginRemoval();
      expect(c.erasing, isTrue);
      await c.previewRemoval(Uint8List(16), 4, 4);
      await c.finishRemoval(apply: true);
      await flush();
      expect(engine.cursor, 1);
      expect(c.erasing, isFalse);
      expect(c.photo, same(original));
      await c.undo();
      await flush();
      expect(engine.cursor, 0);
      await c.redo();
      await flush();
      expect(engine.cursor, 1);
      c.dispose();
    },
  );
}
