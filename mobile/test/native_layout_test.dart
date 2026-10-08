import 'dart:convert';
import 'dart:io';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:exposure_ios/main.dart';
import 'package:exposure_ios/native_editor_controller.dart';
import 'package:exposure_ios/native_editor_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

class LayoutEngine extends ExposureEngine {
  final fixture =
      jsonDecode(File('test/fixtures/controls.json').readAsStringSync())
          as Json;
  @override
  Stream<Json> get events => const Stream.empty();
  @override
  Future<Json> catalog() async =>
      Map<String, dynamic>.from(fixture['catalog'] as Map);
  @override
  Future<List<dynamic>> controls(Json params) async =>
      fixture['groups'] as List;
  @override
  Future<NativePhoto> open(String path) async =>
      const NativePhoto(1, 576, 1024);
  @override
  Future<void> develop(Json params) async {}
  @override
  Future<void> close() async {}
  @override
  Future<String?> loadExportPreferences() async => null;
}

void main() {
  for (final size in [
    const Size(390, 844),
    const Size(844, 390),
    const Size(768, 1024),
  ]) {
    testWidgets('all control groups fit $size without layout overflow', (
      tester,
    ) async {
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      final engine = LayoutEngine(),
          editor = NativeEditorController(LayoutEngine());
      await editor.open('fixture');
      await tester.pumpWidget(
        MaterialApp(
          theme: dichroicTheme(),
          home: NativeEditorScreen(controller: editor),
        ),
      );
      await tester.pumpAndSettle();
      for (final group in engine.fixture['groups'] as List) {
        await tester.tap(find.byTooltip(group['label'] as String));
        await tester.pumpAndSettle();
        expect(
          tester.takeException(),
          isNull,
          reason: '${group['label']} at $size',
        );
        final horizontal = find.byWidgetPredicate(
          (widget) =>
              widget is Scrollable &&
              widget.axisDirection == AxisDirection.right,
        );
        tester.state<ScrollableState>(horizontal).position.jumpTo(0);
        await tester.pumpAndSettle();
        for (final tool in group['tools'] as List) {
          final target = find.byKey(ValueKey('tool-${tool['id']}'));
          await tester.scrollUntilVisible(target, 130, scrollable: horizontal);
          await tester.tap(target);
          await tester.pumpAndSettle();
          expect(
            tester.takeException(),
            isNull,
            reason: '${tool['title']} at $size',
          );
        }
      }
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    });
  }
}
