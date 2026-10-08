import 'package:exposure_ios/main.dart';
import 'package:exposure_ios/native_controls.dart';
import 'package:exposure_ios/native_editor_controller.dart';
import 'package:exposure_ios/native_editor_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'native_layout_test.dart' show LayoutEngine;

/// The iOS path renders UIKit platform views. With the platform-view channel
/// mocked, every group and tool must lay out with bounded native views and
/// no Flutter exceptions, and each native control kind must actually appear.
void main() {
  setUp(() => debugNativeControlsOverride = true);
  tearDown(() => debugNativeControlsOverride = null);

  for (final size in [const Size(390, 844), const Size(844, 390)]) {
    testWidgets('native controls lay out every group and tool at $size', (
      tester,
    ) async {
      final created = <String, int>{};
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform_views,
        (call) async {
          if (call.method == 'create') {
            final type = (call.arguments as Map)['viewType'] as String;
            created[type] = (created[type] ?? 0) + 1;
          }
          return null;
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform_views,
          null,
        ),
      );
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
      expect(tester.takeException(), isNull);

      final groups = engine.fixture['groups'] as List;
      for (var i = 0; i < groups.length; i += 1) {
        tester
            .widget<NativeSegmented>(find.byType(NativeSegmented))
            .onChanged(i);
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull, reason: '${groups[i]['label']}');
        for (final tool in groups[i]['tools'] as List) {
          tester
              .widget<NativeToolStrip>(find.byType(NativeToolStrip))
              .onSelect(tool['id'] as String);
          await tester.pumpAndSettle();
          expect(
            tester.takeException(),
            isNull,
            reason: '${tool['title']} at $size',
          );
        }
      }

      // Sheets with native Press buttons (taps go to the widget's action).
      NativeButton button(String label) => tester.widget<NativeButton>(
        find.byWidgetPredicate((w) => w is NativeButton && w.label == label),
      );
      button('Film & Paper').onTap!();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: 'Stock sheet at $size');
      button('Done').onTap!();
      await tester.pumpAndSettle();
      button('Export').onTap!();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull, reason: 'Export sheet at $size');
      button('Close export').onTap!();
      await tester.pumpAndSettle();

      for (final type in [
        'dichroic/button',
        'dichroic/segmented',
        'dichroic/toolstrip',
        'dichroic/glass',
        'dichroic/slider',
        'dichroic/switch',
      ]) {
        expect(created[type] ?? 0, greaterThan(0), reason: type);
      }
      await tester.pumpWidget(const SizedBox());
      await tester.pumpAndSettle();
    });
  }
}
