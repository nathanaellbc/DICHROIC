import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
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
        if (format == 'png16') {
          expect(bytes[24], 16, reason: 'PNG must retain 16-bit quantization');
        }
        if (format == 'jpeg') expect(bytes.sublist(0, 2), [255, 216]);
        await File(path).delete();
      }
      final cube = await engine.exportCube(baseline, 17);
      expect(await File(cube).readAsString(), contains('LUT_3D_SIZE 17'));
      await File(cube).delete();
      final first = await engine.exportImage(
        baseline,
        format: 'png8',
        longEdge: 24,
      );
      final countBefore = await const MethodChannel(
        'exposure/native',
      ).invokeMapMethod<String, dynamic>('debugStats');
      final second = await engine.exportImage(
        baseline,
        format: 'jpeg',
        longEdge: 24,
        quality: .8,
      );
      final countAfter = await const MethodChannel(
        'exposure/native',
      ).invokeMapMethod<String, dynamic>('debugStats');
      expect(
        countAfter!['exportRenderCount'],
        countBefore!['exportRenderCount'],
        reason: 'Changing format must reuse cached grading',
      );
      await File(first).delete();
      await File(second).delete();
      final detail = await engine.detail(
        baseline,
        const Rect.fromLTWH(.25, .25, .5, .5),
        32,
      );
      expect(detail, isNotNull);
      expect(detail!.textureId, isNot(detail.originalTextureId));
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
      final proof = await const MethodChannel(
        'exposure/native',
      ).invokeMethod<String>('debugScreenshot');
      expect(proof, isNotNull);
    },
    timeout: const Timeout(Duration(minutes: 10)),
  );
  testWidgets(
    'native imports preserve web RAW orientation, gamut and 16-bit source codes',
    (tester) async {
      final engine = ExposureEngine();
      final cases =
          jsonDecode(await rootBundle.loadString('assets/parity/decode.json'))
              as List;
      for (final test in cases) {
        final name = test['file'] as String;
        final bytes = await rootBundle.load('assets/parity/$name');
        final file = File('${Directory.systemTemp.path}/$name');
        await file.writeAsBytes(
          bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
        );
        final photo = await engine.open(file.path);
        expect(
          [photo.sourceWidth, photo.sourceHeight],
          [test['width'], test['height']],
        );
        expect(photo.inputColorSpace, test['colorSpace']);
        expect(photo.encoding, test['encoding']);
        final actual = await const MethodChannel(
          'exposure/native',
        ).invokeMethod<Uint8List>('debugSource');
        expect(actual, isNotNull);
        final expected = await rootBundle.load('assets/parity/$name.f32');
        final nativeView = ByteData.sublistView(actual!);
        var maximum = 0.0;
        for (var i = 0; i < expected.lengthInBytes; i += 4) {
          final error =
              (nativeView.getFloat32(i, Endian.little) -
                      expected.getFloat32(i, Endian.little))
                  .abs();
          if (error > maximum) maximum = error;
        }
        expect(
          maximum,
          lessThanOrEqualTo(test['tolerance']),
          reason: '$name source decode differs from web',
        );
        await file.delete();
      }
      await engine.close();
    },
  );
  testWidgets(
    'native LaMa apply/undo and depth survive memory pressure',
    (tester) async {
      final engine = ExposureEngine();
      final catalog = await engine.catalog();
      final params = Map<String, dynamic>.from(catalog['baseline'] as Map);
      final bytes = await rootBundle.load('assets/parity/source.png');
      final file = File('${Directory.systemTemp.path}/dichroic-model-test.png');
      await file.writeAsBytes(
        bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
      );
      await engine.open(file.path);
      await engine.develop(params);
      final originalPath = await engine.developExport(params);
      final original = await File(originalPath).readAsBytes();
      final sourceBefore = await const MethodChannel(
        'exposure/native',
      ).invokeMethod<Uint8List>('debugSource');
      await engine.beginRemoval();
      final mask = Uint8List(32 * 24);
      for (var y = 8; y < 16; y++) {
        for (var x = 12; x < 20; x++) {
          mask[y * 32 + x] = 255;
        }
      }
      await engine.previewRemoval(mask, 32, 24);
      expect(await engine.applyRemoval(), 1);
      final editedPath = await engine.developExport(params);
      final edited = await File(editedPath).readAsBytes();
      expect(
        edited,
        isNot(orderedEquals(original)),
        reason: 'Apply must change the developed photo',
      );
      final sourceAfter = await const MethodChannel(
        'exposure/native',
      ).invokeMethod<Uint8List>('debugSource');
      expect(
        sourceAfter,
        orderedEquals(sourceBefore!),
        reason: 'Before must retain the original object',
      );
      await engine.restoreRemoval(0);
      final undoPath = await engine.developExport(params);
      expect(await File(undoPath).readAsBytes(), orderedEquals(original));
      await engine.restoreRemoval(1);
      await const MethodChannel(
        'exposure/native',
      ).invokeMethod<void>('debugMemoryWarning');
      final redoPath = await engine.developExport(params);
      expect(await File(redoPath).readAsBytes(), orderedEquals(edited));
      params['lensBlurEnabled'] = true;
      await engine.develop(params);
      await engine.focusPreview({
        ...params,
        'lensFocusX': .5,
        'lensFocusY': .5,
      });
      await engine.develop({...params, 'lensFocusX': .5, 'lensFocusY': .5});
      await engine.close();
      for (final path in [
        originalPath,
        editedPath,
        undoPath,
        redoPath,
        file.path,
      ]) {
        await File(path).delete();
      }
    },
    timeout: const Timeout(Duration(minutes: 15)),
  );
}
