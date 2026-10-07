import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:exposure_engine/exposure_engine.dart';
import 'package:exposure_ios/main.dart';
import 'package:exposure_ios/native_editor_controller.dart';
import 'package:exposure_ios/native_editor_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

void main() {
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'ImageIO, canonical host and Metal match independent Dawn images',
    (tester) async {
      final engine = ExposureEngine();
      final catalog = await engine.catalog();
      final baseline = Map<String, dynamic>.from(catalog['baseline'] as Map);
      final groups = await engine.controls(baseline);
      expect(groups.length, 6);
      final source = await rootBundle.load('assets/parity/source.png');
      final file = File('${Directory.systemTemp.path}/dichroic-parity.png');
      await file.writeAsBytes(
        source.buffer.asUint8List(source.offsetInBytes, source.lengthInBytes),
      );
      final photo = await engine.open(file.path);
      expect(photo.originalTextureId, isNot(photo.textureId));
      final reference =
          jsonDecode(await rootBundle.loadString('assets/parity/dawn.json'))
              as Map<String, dynamic>;
      for (final test in reference['cases'] as List) {
        final params = Map<String, dynamic>.from(test['params'] as Map);
        await engine.develop(params);
        final path = await engine.developExport(params);
        final codec = await ui.instantiateImageCodec(
          await File(path).readAsBytes(),
        );
        final frame = await codec.getNextFrame();
        expect(frame.image.width, reference['width']);
        expect(frame.image.height, reference['height']);
        final bytes = (await frame.image.toByteData(
          format: ui.ImageByteFormat.rawRgba,
        ))!.buffer.asUint8List();
        final expected = (test['rgba'] as List).cast<int>();
        var maximum = 0;
        for (var i = 0; i < bytes.length; i++) {
          final error = (bytes[i] - expected[i]).abs();
          if (error > maximum) maximum = error;
        }

        // One byte is the final independent quantization boundary. The native
        // float replay retains its stricter 1e-5 gate for all intermediate taps.
        expect(
          maximum,
          lessThanOrEqualTo(1),
          reason: 'Native PNG differs from Dawn: $params',
        );
        frame.image.dispose();
        codec.dispose();
        await File(path).delete();
      }
      for (final format in ['png16', 'tiff16', 'jpeg']) {
        final path = await engine.exportImage(
          baseline,
          format: format,
          longEdge: 24,
        );
        final bytes = await File(path).readAsBytes();
        expect(bytes.length, greaterThan(32));
        if (format == 'png16')
          expect(bytes[24], 16, reason: 'PNG must retain 16-bit quantization');
        if (format == 'jpeg') expect(bytes.sublist(0, 2), [255, 216]);
        await File(path).delete();
      }
      final cube = await engine.exportCube(baseline, 17);
      expect(await File(cube).readAsString(), contains('LUT_3D_SIZE 17'));
      await File(cube).delete();
      final editor = NativeEditorController(engine);
      await editor.open(file.path);
      await tester.pumpWidget(
        MaterialApp(
          theme: dichroicTheme(),
          home: NativeEditorScreen(controller: editor),
        ),
      );
      // Keep the rendered screen available to the simulator screenshot command.
      await tester.pump(const Duration(seconds: 2));
      expect(tester.takeException(), isNull);
    },
    timeout: const Timeout(Duration(minutes: 10)),
  );
}
