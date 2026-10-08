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
  testWidgets('dragging a focus pin follows the finger at a zoomed scale', (
    tester,
  ) async {
    Offset? selected;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Center(
            child: SizedBox(
              width: 390,
              height: 500,
              child: PhotoViewport(
                photo: photo,
                focus: const Offset(.5, .5),
                onFocusPreview: (p) => selected = p,
              ),
            ),
          ),
        ),
      ),
    );
    final viewport = find.byType(PhotoViewport),
        center = tester.getCenter(find.byType(PhotoViewport));
    final left = await tester.startGesture(
      center - const Offset(60, 0),
      pointer: 1,
    );
    final right = await tester.startGesture(
      center + const Offset(60, 0),
      pointer: 2,
    );
    await tester.pump();
    await left.moveTo(center - const Offset(140, 0));
    await right.moveTo(center + const Offset(140, 0));
    await tester.pump();
    await left.moveTo(center - const Offset(180, 0));
    await right.moveTo(center + const Offset(180, 0));
    await tester.pump();
    await left.up();
    await right.up();
    await tester.pumpAndSettle();
    final scale = tester
        .widgetList<Transform>(
          find.descendant(of: viewport, matching: find.byType(Transform)),
        )
        .elementAt(1)
        .transform
        .storage[0];
    expect(scale, greaterThan(1.5));
    final finger = await tester.startGesture(
      tester.getCenter(find.byKey(const ValueKey('focus-pin'))),
      pointer: 3,
    );
    await finger.moveBy(const Offset(60, 0));
    await tester.pump();
    expect(selected, isNotNull);
    final start = selected!;
    await finger.moveBy(const Offset(78, 0));
    await tester.pump();
    expect(selected!.dx - start.dx, closeTo(78 / (390 * scale), .003));
    await finger.up();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
  List<int> textures(WidgetTester tester) => [
    for (final t in tester.widgetList<Texture>(find.byType(Texture)))
      t.textureId,
  ];

  testWidgets('compare splits the original over the edit; drag moves it', (
    tester,
  ) async {
    await mount(tester, photo);
    expect(textures(tester), [10]);
    await tester.tap(find.byTooltip('Compare with original'));
    await tester.pump();
    expect(textures(tester), [10, 11]);
    expect(find.text('Before'), findsOneWidget);
    expect(find.text('After'), findsOneWidget);
    final viewport = find.byType(PhotoViewport);
    final finger = await tester.startGesture(tester.getCenter(viewport));
    await finger.moveBy(const Offset(60, 0));
    await tester.pump();
    await finger.up();
    await tester.pumpAndSettle();
    final semantics = tester.getSemantics(
      find.bySemanticsLabel('Before and after divider'),
    );
    expect(semantics.value, isNot('50% original'));
    await tester.tap(find.byTooltip('Compare with original'));
    await tester.pump();
    expect(textures(tester), [10]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('holding the photo shows the original', (tester) async {
    await mount(tester, photo);
    final hold = await tester.startGesture(
      tester.getCenter(find.byType(PhotoViewport)),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(textures(tester), [11]);
    expect(find.text('Original'), findsOneWidget);
    await hold.up();
    await tester.pump();
    expect(textures(tester), [10]);
    expect(tester.takeException(), isNull);
  });

  testWidgets('double-tap zooms to 2.5x and back to fit', (tester) async {
    await mount(tester, photo);
    final center = tester.getCenter(find.byType(PhotoViewport));
    await tester.tapAt(center);
    await tester.pump(const Duration(milliseconds: 60));
    await tester.tapAt(center);
    await tester.pumpAndSettle();
    expect(
      find.textContaining('250% · Fit', findRichText: true),
      findsOneWidget,
    );
    await tester.tapAt(center);
    await tester.pump(const Duration(milliseconds: 60));
    await tester.tapAt(center);
    await tester.pumpAndSettle();
    expect(find.textContaining('250%', findRichText: true), findsNothing);
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
        .elementAt(1)
        .transform
        .storage[0];
    expect(scale(), greaterThan(1.5));
    final zoom = scale();
    await tester.tap(find.byTooltip('Compare with original'));
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
