import 'package:exposure_engine/exposure_engine.dart';
import 'package:exposure_ios/photo_viewport.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

const photo = NativePhoto(10, 1200, 800, originalTextureId: 11);

Future<void> mount(WidgetTester tester, NativePhoto image) => tester.pumpWidget(
  MaterialApp(
    home: Scaffold(
      body: Center(
        child: SizedBox(
          width: 390,
          height: 500,
          child: PhotoViewport(photo: image),
        ),
      ),
    ),
  ),
);

void main() {
  testWidgets('compare switches cached textures and preserves zoom', (
    tester,
  ) async {
    await mount(tester, photo);
    expect(tester.widget<Texture>(find.byType(Texture)).textureId, 10);
    await tester.tap(find.byTooltip('Show original photo'));
    await tester.pump();
    expect(tester.widget<Texture>(find.byType(Texture)).textureId, 11);
    expect(find.text('Original'), findsOneWidget);
    await tester.tap(find.byTooltip('Show edited photo'));
    await tester.pump();
    expect(tester.widget<Texture>(find.byType(Texture)).textureId, 10);
    expect(tester.takeException(), isNull);
  });

  testWidgets('drag at fit size overscrolls then springs to the origin', (
    tester,
  ) async {
    await mount(tester, photo);
    final viewport = find.byType(PhotoViewport);
    final gesture = await tester.startGesture(tester.getCenter(viewport));
    await gesture.moveBy(const Offset(25, 0));
    await tester.pump();
    await gesture.moveBy(const Offset(110, 60));
    await tester.pump();
    Matrix4 translation() => tester
        .widgetList<Transform>(
          find.descendant(of: viewport, matching: find.byType(Transform)),
        )
        .first
        .transform;
    expect(translation().storage[12], greaterThan(0));
    expect(translation().storage[12], lessThan(110));
    await gesture.up();
    await tester.pumpAndSettle();
    expect(translation().storage[12], closeTo(0, 0.5));
    expect(translation().storage[13], closeTo(0, 0.5));
    expect(tester.takeException(), isNull);
  });

  testWidgets('pinch zoom survives compare and resets on a new photo', (
    tester,
  ) async {
    await mount(tester, photo);
    final center = tester.getCenter(find.byType(PhotoViewport));
    final left = await tester.startGesture(
      center - const Offset(40, 0),
      pointer: 1,
    );
    final right = await tester.startGesture(
      center + const Offset(40, 0),
      pointer: 2,
    );
    await tester.pump();
    await left.moveTo(center - const Offset(100, 0));
    await right.moveTo(center + const Offset(100, 0));
    await tester.pump();
    await left.moveTo(center - const Offset(150, 0));
    await right.moveTo(center + const Offset(150, 0));
    await tester.pump();
    await left.up();
    await right.up();
    await tester.pumpAndSettle();
    double scale() => tester
        .widgetList<Transform>(
          find.descendant(
            of: find.byType(PhotoViewport),
            matching: find.byType(Transform),
          ),
        )
        .last
        .transform
        .storage[0];
    expect(scale(), greaterThan(1.5));
    final zoom = scale();
    await tester.tap(find.byTooltip('Show original photo'));
    await tester.pump();
    expect(scale(), zoom);
    await mount(
      tester,
      const NativePhoto(20, 800, 1200, originalTextureId: 21),
    );
    expect(scale(), 1);
    expect(tester.widget<Texture>(find.byType(Texture)).textureId, 20);
    expect(tester.takeException(), isNull);
  });
}
