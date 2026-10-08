import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:exposure_engine/exposure_engine.dart';
import 'package:exposure_ios/main.dart';
import 'package:exposure_ios/native_editor_controller.dart';
import 'package:exposure_ios/editor_widgets.dart';
import 'package:exposure_ios/native_controls.dart';
import 'package:exposure_ios/native_editor_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';

// ImageIO can rewrite compressed ICC metadata between otherwise identical
// exports. Compare decoded pixels for removal history, rather than PNG bytes.
Future<Uint8List> decodedRgba(Uint8List encoded) async {
  final codec = await ui.instantiateImageCodec(encoded);
  final frame = await codec.getNextFrame();
  try {
    final data = (await frame.image.toByteData(
      format: ui.ImageByteFormat.rawRgba,
    ))!;
    return Uint8List.fromList(
      data.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
    );
  } finally {
    frame.image.dispose();
    codec.dispose();
  }
}

/// Native UIKit buttons receive real touches only; synthetic test taps go to
/// Flutter. Invoke the labelled control's action directly, and tap Flutter
/// controls as before.
Future<void> activate(WidgetTester tester, String label) async {
  final native = find.byWidgetPredicate(
    (w) =>
        (w is NativeButton &&
            (w.label == label || w.label.startsWith('$label:'))) ||
        (w is Press && w.label == label),
  );
  if (useNativeControls && native.evaluate().isNotEmpty) {
    final widget = tester.widget(native.first);
    final onTap = widget is NativeButton
        ? widget.onTap
        : (widget as Press).onTap;
    onTap?.call();
    await tester.pump();
    return;
  }
  if (label == 'Stocks') {
    await tester.tap(find.byKey(const ValueKey('stock-capsule')));
    return;
  }
  await tester.tap(find.byTooltip(label));
}

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
        final preview = await const MethodChannel(
          'exposure/native',
        ).invokeMapMethod<String, dynamic>('debugPreview');
        final wideGamut = params['outputColorSpace'] == 'Display P3';
        expect(
          preview!['colorSpace'],
          wideGamut ? 'kCGColorSpaceDisplayP3' : 'kCGColorSpaceSRGB',
        );
        final previewBytes = preview['rgba'] as Uint8List;
        final previewExpected = (test[wideGamut ? 'p3rgba' : 'rgba'] as List)
            .cast<int>();
        expect(previewBytes.length, previewExpected.length);
        var previewError = 0;
        for (var i = 0; i < previewBytes.length; i++) {
          final error = (previewBytes[i] - previewExpected[i]).abs();
          if (error > previewError) previewError = error;
        }
        expect(
          previewError,
          lessThanOrEqualTo(1),
          reason:
              'Profiled native preview differs from independent P3 reference',
        );
        final path = await engine.developExport(params);
        if (wideGamut) {
          // Flutter's codec converts embedded P3 to its display space. Inspect
          // ImageIO's original encoded channel codes for the P3 oracle.
          final encoded = await const MethodChannel('exposure/native')
              .invokeMapMethod<String, dynamic>('debugEncodedPixels', {
                'path': path,
              });
          expect(encoded!['colorSpace'], 'Display P3');
          expect(encoded['width'], reference['width']);
          expect(encoded['height'], reference['height']);
          final bytes = encoded['rgba'] as Uint8List;
          final expected = (test['rgba'] as List).cast<int>();
          expect(bytes.length, expected.length);
          var maximum = 0;
          for (var i = 0; i < bytes.length; i++) {
            final error = (bytes[i] - expected[i]).abs();
            if (error > maximum) maximum = error;
          }
          expect(
            maximum,
            lessThanOrEqualTo(1),
            reason: 'Encoded P3 PNG differs from Dawn',
          );
          await File(path).delete();
          continue;
        }
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
      for (final format in (catalog['exportFormats'] as List).cast<String>()) {
        debugPrint('Native export encoder: $format');
        expect(
          await engine.exportSize(baseline, longEdge: 24),
          const Size(24, 18),
        );
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
      for (final profile
          in (catalog['outputColorSpaces'] as List).cast<String>()) {
        final path = await engine.exportImage(
          {...baseline, 'outputColorSpace': profile},
          format: 'png16',
          longEdge: 24,
        );
        expect(await File(path).length(), greaterThan(32), reason: profile);
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
          debugShowCheckedModeBanner: false,
          theme: dichroicTheme(),
          home: NativeEditorScreen(controller: editor),
        ),
      );
      // Keep the rendered screen available to the simulator screenshot command.
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      final proof = await const MethodChannel(
        'exposure/native',
      ).invokeMethod<String>('debugScreenshot');
      expect(proof, isNotNull);
      debugPrint('Native editor screenshot: $proof');
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(seconds: 4)),
      );
      await activate(tester, 'Stocks');
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await const MethodChannel(
        'exposure/native',
      ).invokeMethod<String>('debugScreenshot', {'name': 'editor-stocks'});
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(seconds: 4)),
      );
      await activate(tester, 'Done');
      await tester.pump(const Duration(seconds: 1));
      await activate(tester, 'Export');
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await const MethodChannel(
        'exposure/native',
      ).invokeMethod<String>('debugScreenshot', {'name': 'editor-export'});
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(seconds: 4)),
      );
      await activate(tester, 'Cancel');
      await tester.pump(const Duration(seconds: 1));
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(milliseconds: 100));
      await engine.close();
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
        debugPrint('Native decode fixture: $name');
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
    'large JPEG, HEIC, orientations, float EXR and export cancellation',
    (tester) async {
      final engine = ExposureEngine();
      final catalog = await engine.catalog();
      final params = Map<String, dynamic>.from(catalog['baseline'] as Map)
        ..addAll({
          'grainEnabled': false,
          'glareEnabled': false,
          'autoExposure': false,
        });
      Future<File> fixture(String name) async {
        final bytes = await rootBundle.load('assets/parity/$name');
        final file = File('${Directory.systemTemp.path}/$name');
        await file.writeAsBytes(
          bytes.buffer.asUint8List(bytes.offsetInBytes, bytes.lengthInBytes),
        );
        return file;
      }

      final files = <File>[];
      try {
        for (var orientation = 1; orientation <= 8; orientation++) {
          final file = await fixture('oriented-native-$orientation.jpg');
          files.add(file);
          final photo = await engine.open(file.path);
          expect([
            photo.sourceWidth,
            photo.sourceHeight,
          ], orientation < 5 ? [64, 48] : [48, 64]);
          if (orientation == 6) {
            final exported = await engine.exportImage(params, format: 'png8');
            final probe = await const MethodChannel('exposure/native')
                .invokeMapMethod<String, dynamic>('debugEncodedPixels', {
                  'path': exported,
                });
            expect(
              [probe!['width'], probe['height'], probe['orientation']],
              [48, 64, 1],
            );
            await File(exported).delete();
          }
        }
        for (final name in ['small-native.heic', 'float-native.exr']) {
          final file = await fixture(name);
          files.add(file);
          final photo = await engine.open(file.path);
          if (name.endsWith('.heic')) {
            expect([photo.sourceWidth, photo.sourceHeight], [64, 48]);
          } else {
            expect(photo.encoding, 'linear');
            expect(photo.inputColorSpace, 'Linear Rec.709');
            final bytes = (await const MethodChannel(
              'exposure/native',
            ).invokeMethod<Uint8List>('debugSource'))!;
            final floats = ByteData.sublistView(bytes);
            final expected = await rootBundle.load('assets/parity/$name.f32');
            expect(bytes.length, expected.lengthInBytes);
            for (var i = 0; i < expected.lengthInBytes; i += 4) {
              expect(
                (floats.getFloat32(i, Endian.little) -
                        expected.getFloat32(i, Endian.little))
                    .abs(),
                lessThanOrEqualTo(1e-7),
                reason: 'EXR source differs from independent web decoder',
              );
            }
            expect(floats.getFloat32(0, Endian.little), lessThan(0));
            expect(floats.getFloat32(8, Endian.little), greaterThan(1));
          }
        }
        final file = await fixture('large-native.jpg');
        files.add(file);
        final watch = Stopwatch()..start();
        final photo = await engine.open(file.path);
        expect([photo.sourceWidth, photo.sourceHeight], [8144, 5424]);
        debugPrint('44 MP native JPEG open: ${watch.elapsedMilliseconds} ms');
        final importStats = await const MethodChannel(
          'exposure/native',
        ).invokeMapMethod<String, dynamic>('debugStats');
        debugPrint('44 MP import breakdown: $importStats');
        await engine.develop(params);
        debugPrint('44 MP native first grade: ${watch.elapsedMilliseconds} ms');
        final pending = engine.developExport({
          ...params,
          'cameraExposureEv': .25,
        });
        final cancelled = expectLater(
          pending,
          throwsA(
            isA<PlatformException>().having(
              (e) => e.message,
              'message',
              contains('cancel'),
            ),
          ),
        );
        await engine.cancelExport();
        await cancelled;
        await const MethodChannel(
          'exposure/native',
        ).invokeMethod<void>('debugMemoryWarning');
        final output = await engine.exportImage(
          params,
          format: 'jpeg',
          longEdge: 2048,
        );
        expect(await File(output).length(), greaterThan(32));
        await File(output).delete();
        await engine.develop(params);
        debugPrint(
          '44 MP native cancel/recovery/export: ${watch.elapsedMilliseconds} ms',
        );
      } finally {
        await engine.close();
        for (final file in files) {
          await file.delete();
        }
      }
    },
    timeout: const Timeout(Duration(minutes: 10)),
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
      final originalPixels = await decodedRgba(original);
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
      final editedPixels = await decodedRgba(edited);
      expect(
        editedPixels,
        isNot(orderedEquals(originalPixels)),
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
      expect(
        await decodedRgba(await File(undoPath).readAsBytes()),
        orderedEquals(originalPixels),
      );
      await engine.restoreRemoval(1);
      await const MethodChannel(
        'exposure/native',
      ).invokeMethod<void>('debugMemoryWarning');
      final redoPath = await engine.developExport(params);
      expect(
        await decodedRgba(await File(redoPath).readAsBytes()),
        orderedEquals(editedPixels),
      );
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
