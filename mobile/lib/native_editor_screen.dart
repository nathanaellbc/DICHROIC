import 'package:exposure_engine/exposure_engine.dart';
import 'dart:math';
import 'package:flutter/cupertino.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'editor_widgets.dart';
import 'native_editor_controller.dart';
import 'photo_viewport.dart';
import 'removal_brush.dart';
import 'export_sheet.dart';
import 'native_controls.dart';
import 'appearance.dart';
import 'editor_text.dart';
import 'start_screen.dart';

class NativeEditorScreen extends StatefulWidget {
  const NativeEditorScreen({super.key, this.controller});
  final NativeEditorController? controller;
  @override
  State<NativeEditorScreen> createState() => _NativeEditorScreenState();
}

class _NativeEditorScreenState extends State<NativeEditorScreen> {
  late final controller =
      widget.controller ?? NativeEditorController(ExposureEngine());

  /// The web editor opens on Film, with these tools first in each group.
  String groupId = 'film';
  final selections = <String, String>{
    'camera': 'cameraWhiteBalanceK',
    'lens': 'lensBlur',
    'film': 'printExposureEv',
    'color': 'filterC',
    'darkroom': 'dirCouplersAmount',
    'texture': 'halationAmount',
  };
  final brush = RemovalBrush();
  final exportPreferences = ExportPreferences();
  String? _alerted;

  @override
  void initState() {
    super.initState();
    exportPreferences.load(controller.engine);
    controller.addListener(_alert);
  }

  @override
  void dispose() {
    controller.removeListener(_alert);
    controller.dispose();
    brush.dispose();
    super.dispose();
  }

  /// Errors show as an alert with OK, as on the web.
  void _alert() {
    final error = controller.error;
    if (error == null || error == _alerted || !mounted) {
      if (error == null) _alerted = null;
      return;
    }
    _alerted = error;
    showCupertinoDialog<void>(
      context: context,
      barrierDismissible: true,
      builder: (context) => CupertinoAlertDialog(
        title: Text(controller.errorTitle),
        content: Text(error),
        actions: [
          CupertinoDialogAction(
            isDefaultAction: true,
            onPressed: () => Navigator.pop(context),
            child: const Text('OK'),
          ),
        ],
      ),
    ).then((_) {
      if (controller.error == error) controller.clearError();
    });
  }

  Future<void> _open(Future<String?> Function() choose) async {
    try {
      final path = await choose();
      if (path != null) await controller.open(path);
    } catch (e) {
      controller.errorTitle = 'Can’t Open This File';
      controller.error = e is PlatformException
          ? e.message ?? e.code
          : e.toString();
      _alert();
    }
  }

  /// "Open Photo…": the same choice iOS gives a web page's file input.
  Future<void> openPhoto() async {
    if (controller.busy) return;
    final choice = await showCupertinoModalPopup<String>(
      context: context,
      builder: (context) => CupertinoActionSheet(
        actions: [
          CupertinoActionSheetAction(
            onPressed: () => Navigator.pop(context, 'photos'),
            child: const Text('Photo Library'),
          ),
          CupertinoActionSheetAction(
            onPressed: () => Navigator.pop(context, 'files'),
            child: const Text('Choose File'),
          ),
        ],
        cancelButton: CupertinoActionSheetAction(
          onPressed: () => Navigator.pop(context),
          child: const Text('Cancel'),
        ),
      ),
    );
    if (choice == 'photos') await _open(controller.engine.choosePhoto);
    if (choice == 'files') await _open(controller.engine.chooseFile);
  }

  /// "Close Photo": asks first when anything is edited.
  Future<void> closePhoto() async {
    if (controller.edited) {
      final discard = await showCupertinoModalPopup<bool>(
        context: context,
        builder: (context) => CupertinoActionSheet(
          message: const Text('Discard your edits to this photo?'),
          actions: [
            CupertinoActionSheetAction(
              isDestructiveAction: true,
              onPressed: () => Navigator.pop(context, true),
              child: const Text('Discard Edits'),
            ),
          ],
          cancelButton: CupertinoActionSheetAction(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Cancel'),
          ),
        ),
      );
      if (discard != true) return;
    }
    await controller.closePhoto();
  }

  Stocks get stocks => Stocks(controller.catalog, controller.params);

  Future<void> stockSheet() => editorSheet<void>(
    context,
    StockSheet(controller: controller),
    // Medium detent (56%) as on the web; short landscape screens open large.
    fraction: MediaQuery.sizeOf(context).height < 600 ? .92 : .56,
  );

  void startRemoval() {
    brush.clear();
    controller.beginRemoval();
  }

  void cycleAppearance() {
    final modes = ThemeMode.values;
    setAppearance(modes[(modes.indexOf(appearance.value) + 1) % modes.length]);
  }

  static const themeSymbols = {
    ThemeMode.system: 'circle.lefthalf.filled',
    ThemeMode.light: 'sun.max',
    ThemeMode.dark: 'moon',
  };

  /// The web "⋯" menu, in its order: Remove, Open, Redo and Reset when they
  /// apply, Appearance, Close.
  List<NativeMenuItem> menuItems() => [
    const NativeMenuItem(
      id: 'remove',
      title: 'Remove Object…',
      symbol: 'eraser',
    ),
    const NativeMenuItem(id: 'open', title: 'Open Photo…', symbol: 'folder'),
    if (controller.canRedo)
      const NativeMenuItem(
        id: 'redo',
        title: 'Redo',
        symbol: 'arrow.uturn.forward',
      ),
    if (controller.edited)
      const NativeMenuItem(
        id: 'reset',
        title: 'Reset All Adjustments',
        symbol: 'arrow.counterclockwise',
      ),
    NativeMenuItem(
      id: 'appearance',
      title: 'Appearance: ${appearanceLabels[appearance.value]}',
      symbol: themeSymbols[appearance.value],
    ),
    const NativeMenuItem(id: 'close', title: 'Close Photo', symbol: 'xmark'),
  ];

  void menuAction(String id) {
    switch (id) {
      case 'remove':
        startRemoval();
      case 'open':
        openPhoto();
      case 'redo':
        controller.redo();
      case 'reset':
        controller.resetAll();
      case 'appearance':
        cycleAppearance();
      case 'close':
        closePhoto();
    }
  }

  /// Flutter fallback for the menu: a sheet with the same rows.
  Future<void> menu() => editorSheet<void>(
    context,
    ValueListenableBuilder<ThemeMode>(
      valueListenable: appearance,
      builder: (context, mode, _) => ListView(
        children: [
          for (final item in menuItems())
            ListTile(
              title: Text(item.title),
              onTap: () {
                // Appearance cycles in place; the menu stays open.
                if (item.id != 'appearance') Navigator.pop(context);
                menuAction(item.id);
              },
            ),
        ],
      ),
    ),
    fraction: .5,
  );

  /// "DICHROIC" with a second line, in place of the toolbar buttons.
  Widget brand(String line) => Padding(
    padding: const EdgeInsets.symmetric(horizontal: 8),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        const Text(
          'DICHROIC',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w700,
            letterSpacing: 1.8,
          ),
        ),
        Text(line, style: const TextStyle(fontSize: 12, color: secondary)),
      ],
    ),
  );

  /// Phone toolbar (web `.mobile-toolbar`): More, the stock capsule, Undo
  /// and Export; the brand alone with no photo.
  Widget topBar(bool wide) {
    final erasing = controller.erasing, photo = controller.photo != null;
    if (!photo && !erasing) {
      return SizedBox(
        height: 52,
        child: Align(
          alignment: Alignment.centerLeft,
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 12),
            child: brand('Your pocket darkroom'),
          ),
        ),
      );
    }
    if (useNativeControls) return nativeTopBar(wide);
    return Padding(
      padding: const EdgeInsets.all(4),
      child: Glass(
        radius: 20,
        padding: const EdgeInsets.all(4),
        child: Row(
          children: [
            Press(
              label: erasing ? 'Cancel removal' : 'More',
              plain: true,
              onTap: controller.busy
                  ? null
                  : erasing
                  ? () => controller.finishRemoval(apply: false)
                  : menu,
              child: Glyph(erasing ? 'close' : 'more'),
            ),
            Expanded(
              child: erasing
                  ? brand('Original · grading paused')
                  : GestureDetector(
                      key: const ValueKey('stock-capsule'),
                      onTap: stockSheet,
                      child: Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 8),
                        child: Row(
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    stocks.filmLine,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 15,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  Text(
                                    stocks.paperLine,
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 12,
                                      fontWeight: FontWeight.w500,
                                      color: secondary,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                            const Glyph('upDown', size: 14, color: secondary),
                          ],
                        ),
                      ),
                    ),
            ),
            if (!erasing)
              Press(
                label: 'Undo',
                plain: true,
                onTap: controller.canUndo && !controller.busy
                    ? controller.undo
                    : null,
                child: const Glyph('undo', size: 20),
              ),
            if (wide && !erasing)
              Press(
                label: 'Redo',
                plain: true,
                onTap: controller.canRedo && !controller.busy
                    ? controller.redo
                    : null,
                child: const Glyph('redo', size: 20),
              ),
            Press(
              label: erasing ? 'Apply removal' : 'Export',
              radius: 16,
              selected: true,
              filled: true,
              onTap: controller.busy || (erasing && !controller.removalReady)
                  ? null
                  : erasing
                  ? () => controller.finishRemoval(apply: true)
                  : export,
              child: Glyph(erasing ? 'check' : 'share', size: 20),
            ),
          ],
        ),
      ),
    );
  }

  /// iOS top bar: separate floating Liquid Glass controls, as in iOS 26
  /// toolbars, instead of one blurred Flutter strip.
  Widget nativeTopBar(bool wide) {
    final erasing = controller.erasing;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
      child: Row(
        children: [
          if (erasing)
            NativeButton(
              label: 'Cancel removal',
              symbol: 'xmark',
              width: 44,
              onTap: controller.busy
                  ? null
                  : () => controller.finishRemoval(apply: false),
            )
          else
            // Rebuilt on appearance changes too, for the Appearance row.
            ValueListenableBuilder<ThemeMode>(
              valueListenable: appearance,
              builder: (context, _, _) => NativeButton(
                label: 'More',
                symbol: 'ellipsis',
                width: 44,
                menu: menuItems(),
                onMenu: controller.busy ? null : menuAction,
              ),
            ),
          const SizedBox(width: 8),
          Expanded(
            child: erasing
                ? brand('Original · grading paused')
                : NativeButton(
                    label:
                        'Stocks: ${stocks.filmLine}, ${stocks.paperLine}. Change',
                    title: stocks.filmLine,
                    subtitle: stocks.paperLine,
                    symbol: 'chevron.up.chevron.down',
                    symbolSize: 12,
                    imageTrailing: true,
                    leadingAligned: true,
                    onTap: stockSheet,
                  ),
          ),
          if (!erasing) ...[
            const SizedBox(width: 8),
            NativeButton(
              label: 'Undo',
              symbol: 'arrow.uturn.backward',
              width: 44,
              onTap: controller.canUndo && !controller.busy
                  ? controller.undo
                  : null,
            ),
          ],
          if (wide && !erasing) ...[
            const SizedBox(width: 8),
            NativeButton(
              label: 'Redo',
              symbol: 'arrow.uturn.forward',
              width: 44,
              onTap: controller.canRedo && !controller.busy
                  ? controller.redo
                  : null,
            ),
          ],
          const SizedBox(width: 8),
          NativeButton(
            label: erasing ? 'Apply removal' : 'Export',
            symbol: erasing ? 'checkmark' : 'square.and.arrow.up',
            style: 'prominent',
            width: 52,
            onTap: controller.busy || (erasing && !controller.removalReady)
                ? null
                : erasing
                ? () => controller.finishRemoval(apply: true)
                : export,
          ),
        ],
      ),
    );
  }

  Widget removalControls() => ListenableBuilder(
    listenable: brush,
    builder: (context, _) => Padding(
      padding: const EdgeInsets.all(12),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Row(
            children: [
              Glyph('erase', size: 20),
              SizedBox(width: 8),
              Text(
                'Remove Object',
                style: TextStyle(fontWeight: FontWeight.w700),
              ),
              Spacer(),
              Text(
                'Original · grading paused',
                style: TextStyle(color: secondary, fontSize: 11),
              ),
            ],
          ),
          const SizedBox(height: 8),
          if (!controller.removalReady)
            DetailSlider(
              value: brush.diameter,
              min: 8,
              max: 80,
              step: 1,
              label: 'Brush size',
              onChanged: (v) => setState(() => brush.diameter = v),
            ),
          Row(
            children: [
              Press(
                label: 'Brush',
                selected: brush.painting && !brush.eraser,
                onTap: () => setState(() {
                  brush.painting = true;
                  brush.eraser = false;
                }),
                child: const Glyph('erase', size: 20),
              ),
              const SizedBox(width: 6),
              Press(
                label: 'Move photo',
                selected: !brush.painting,
                onTap: () => setState(() => brush.painting = false),
                child: const Glyph('move', size: 20),
              ),
              const SizedBox(width: 6),
              Press(
                label: 'Undo brush stroke',
                onTap: brush.isEmpty || controller.removalReady
                    ? null
                    : brush.undo,
                child: const Glyph('undo', size: 20),
              ),
              const Spacer(),
              if (controller.removalReady)
                Press(
                  label: 'Try again',
                  onTap: controller.busy
                      ? null
                      : () {
                          brush.clear();
                          controller.restartRemoval();
                        },
                  child: const Text('Try again'),
                )
              else
                Press(
                  label: 'Remove object',
                  selected: true,
                  filled: true,
                  onTap: brush.isEmpty || controller.busy
                      ? null
                      : () async {
                          final photo = controller.photo!,
                              mask = await brush.mask(
                                photo.width,
                                photo.height,
                              );
                          await controller.previewRemoval(
                            mask.pixels,
                            mask.width,
                            mask.height,
                          );
                        },
                  child: Text(controller.removing ? 'Removing…' : 'Remove'),
                ),
            ],
          ),
          const SizedBox(height: 8),
          const Text(
            'Brush over the object. Pinch or use two fingers to move.',
            style: TextStyle(color: secondary, fontSize: 11),
          ),
        ],
      ),
    ),
  );
  Future<void> export() => editorSheet<void>(
    context,
    ExportSheet(controller: controller, preferences: exportPreferences),
    fraction: MediaQuery.sizeOf(context).height < 600 ? .92 : .76,
    blur: 3.2,
  );

  /// Tools of the current group, and the one shown: the remembered tool, else
  /// its namesake in this process mode (Exposure in print and scan), else the
  /// first (Editor.tsx).
  ({List<Json> tools, Json? selected}) currentTools() {
    final group = controller.groups
        .where((g) => g['id'] == groupId)
        .firstOrNull;
    final tools = (group?['tools'] as List? ?? []).cast<Json>();
    final wanted = selections[groupId];
    var selected = tools.where((t) => t['id'] == wanted).firstOrNull;
    if (selected == null && wanted != null) {
      String? label;
      for (final g in controller.catalog['groups'] as List? ?? const []) {
        for (final t in g['tools'] as List) {
          if (t['id'] == wanted) label = t['label'] as String?;
        }
      }
      selected = tools.where((t) => t['label'] == label).firstOrNull;
    }
    return (tools: tools, selected: selected ?? tools.firstOrNull);
  }

  Widget toolChips(List<Json> tools, Json? selected) {
    bool dimmed(Json tool) =>
        tool['enabled'] == false ||
        (tool['kind'] == 'toggle' && controller.params[tool['field']] != true);
    if (useNativeControls) {
      return Padding(
        padding: const EdgeInsets.only(top: 4),
        child: NativeToolStrip(
          tools: [
            for (final tool in tools)
              NativeTool(
                id: tool['id'] as String,
                title: tool['title'] as String,
                label: tool['label'] as String,
                glyph: tool['icon'] as String,
                modified: tool['modified'] == true,
                dimmed: dimmed(tool),
                locked: tool['kind'] == 'locked',
              ),
          ],
          selected: selected?['id'] as String?,
          onSelect: (id) => setState(() => selections[groupId] = id),
        ),
      );
    }
    return SizedBox(
      key: const ValueKey('tool-strip'),
      height: 96,
      child: ListView.separated(
        key: PageStorageKey('tools-$groupId'),
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(
          parent: AlwaysScrollableScrollPhysics(),
        ),
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
        itemCount: tools.length,
        separatorBuilder: (_, _) => const SizedBox(width: 2),
        itemBuilder: (context, i) {
          final tool = tools[i];
          final active = tool['id'] == selected?['id'];
          final color = active
              ? signalBlue
              : dimmed(tool)
              ? secondary.withValues(alpha: .5)
              : secondary;
          // Web chip: 66 wide, 46 px tile; blue wash when selected, inset
          // blue ring when edited, lock badge when locked.
          return SizedBox(
            width: 66,
            child: Column(
              children: [
                Stack(
                  clipBehavior: Clip.none,
                  children: [
                    Press(
                      key: ValueKey('tool-${tool['id']}'),
                      label: tool['title'] as String,
                      selected: active,
                      edited: tool['modified'] == true,
                      onTap: () => setState(
                        () => selections[groupId] = tool['id'] as String,
                      ),
                      child: Glyph(
                        tool['icon'] as String,
                        color: tool['tint'] == null
                            ? color
                            : Color(
                                int.parse(
                                  'ff${(tool['tint'] as String).substring(1)}',
                                  radix: 16,
                                ),
                              ),
                      ),
                    ),
                    if (tool['kind'] == 'locked')
                      const Positioned(
                        right: -2,
                        bottom: -2,
                        child: Glyph('lock', size: 12, color: secondary),
                      ),
                  ],
                ),
                const SizedBox(height: 4),
                Text(
                  tool['label'] as String,
                  maxLines: 2,
                  textAlign: TextAlign.center,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                    fontSize: 11,
                    height: 1.15,
                    color: active
                        ? Theme.of(context).colorScheme.onSurface
                        : color,
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }

  /// Icon-only group tabs with an "edited" dot (web `GroupTabs`).
  Widget groupTabs() {
    final groups = controller.groups;
    final index = groups.indexWhere((g) => g['id'] == groupId);
    if (useNativeControls) {
      return Padding(
        padding: const EdgeInsets.fromLTRB(12, 8, 12, 12),
        child: NativeSegmented(
          items: [for (final g in groups) g['label'] as String],
          symbols: [for (final g in groups) sfSymbol(g['icon'] as String)],
          marked: [
            for (var i = 0; i < groups.length; i++)
              if (groups[i]['modified'] == true) i,
          ],
          selected: index.clamp(0, groups.length),
          onChanged: (i) => setState(() => groupId = groups[i]['id'] as String),
        ),
      );
    }
    return SizedBox(
      height: 58,
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          for (final g in groups)
            Stack(
              children: [
                Press(
                  label: g['label'] as String,
                  selected: g['id'] == groupId,
                  onTap: () => setState(() => groupId = g['id'] as String),
                  child: Glyph(
                    g['icon'] as String,
                    color: g['id'] == groupId ? signalBlue : secondary,
                  ),
                ),
                if (g['modified'] == true)
                  const Positioned(
                    right: 8,
                    top: 8,
                    child: SizedBox(
                      width: 5,
                      height: 5,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: signalBlue,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  Widget adjustments() {
    final (:tools, :selected) = currentTools();
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (selected != null)
          AnimatedSize(
            duration: MediaQuery.disableAnimationsOf(context)
                ? Duration.zero
                : const Duration(milliseconds: 380),
            curve: Curves.easeOutCubic,
            alignment: Alignment.topCenter,
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 156 + 64),
              child: SingleChildScrollView(
                physics: const BouncingScrollPhysics(),
                child: ToolPanel(
                  key: ValueKey(selected['id']),
                  tool: selected,
                  controller: controller,
                ),
              ),
            ),
          ),
        toolChips(tools, selected),
        groupTabs(),
      ],
    );
  }

  Widget viewport() {
    if (controller.photo == null) {
      return StartScreen(onChoose: controller.loading ? null : openPhoto);
    }
    return PhotoViewport(
      photo: controller.photo!,
      detail: controller.detail,
      detailRevision: controller.revision,
      onDetailRequest: controller.requestDetail,
      rendering: controller.rendering,
      brush: controller.erasing ? brush : null,
      showBrush: !controller.removalReady && !controller.removing,
      focus:
          !controller.erasing &&
              !controller.rendering &&
              groupId == 'lens' &&
              controller.params['lensBlurEnabled'] == true &&
              controller.depthState == 'ready'
          ? Offset(
              (controller.params['lensFocusX'] as num).toDouble(),
              (controller.params['lensFocusY'] as num).toDouble(),
            )
          : null,
      onFocusStart: controller.beginGesture,
      onFocusPreview: (point) => controller.previewFocus(point.dx, point.dy),
      onFocusEnd: (point) async {
        await controller.edit('fields', 'focus', {
          'lensFocusX': point.dx,
          'lensFocusY': point.dy,
        });
        await controller.endGesture();
      },
    );
  }

  /// "Opening …" card with the decoder stage (web `OpeningCard`).
  Widget openingCard() => Center(
    child: SizedBox(
      width: 270,
      child: Glass(
        radius: 14,
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const CircularProgressIndicator.adaptive(),
            const SizedBox(height: 12),
            Text(
              'Opening ${controller.openingName ?? 'photo'}',
              textAlign: TextAlign.center,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: 4),
            Text(
              controller.status?.isNotEmpty == true
                  ? controller.status!
                  : 'Reading…',
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 13, color: secondary),
            ),
          ],
        ),
      ),
    ),
  );

  /// Top-centre toast pill with a green check (web `Toast`).
  Widget toast() => ValueListenableBuilder<String?>(
    valueListenable: controller.toast,
    builder: (context, message, _) => IgnorePointer(
      child: Align(
        alignment: Alignment.topCenter,
        child: Padding(
          padding: const EdgeInsets.only(top: 60),
          child: AnimatedSwitcher(
            duration: const Duration(milliseconds: 220),
            child: message == null
                ? const SizedBox.shrink()
                : Glass(
                    key: ValueKey(message),
                    radius: 20,
                    padding: const EdgeInsets.symmetric(horizontal: 16),
                    child: SizedBox(
                      height: 40,
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Glyph(
                            'check',
                            size: 16,
                            color: Color(0xff30d158),
                          ),
                          const SizedBox(width: 8),
                          Flexible(
                            child: Text(
                              message,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: const TextStyle(
                                fontSize: 15,
                                fontWeight: FontWeight.w500,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final photo = controller.photo != null;
      return Scaffold(
        body: Stack(
          children: [
            SafeArea(
              child: LayoutBuilder(
                builder: (context, constraints) {
                  final wide = constraints.maxWidth > 720;
                  final controls = controller.erasing
                      ? removalControls()
                      : adjustments();
                  return Column(
                    children: [
                      topBar(wide),
                      Expanded(
                        child: wide && photo
                            ? Row(
                                children: [
                                  Expanded(child: viewport()),
                                  SizedBox(
                                    width: 320,
                                    child: Glass(
                                      child: SingleChildScrollView(
                                        physics: const BouncingScrollPhysics(),
                                        child: controls,
                                      ),
                                    ),
                                  ),
                                ],
                              )
                            : viewport(),
                      ),
                      if (!wide && photo) Glass(radius: 24, child: controls),
                    ],
                  );
                },
              ),
            ),
            if (controller.openingName != null)
              Positioned.fill(
                child: ColoredBox(
                  color: Colors.black.withValues(alpha: .28),
                  child: openingCard(),
                ),
              ),
            Positioned.fill(child: SafeArea(child: toast())),
          ],
        ),
      );
    },
  );
}

/// One tool, laid out like the web phone panel (Editor.tsx, ToolControls.tsx):
/// a heading with the title, value, reset and switch, then the control.
class ToolPanel extends StatelessWidget {
  const ToolPanel({super.key, required this.tool, required this.controller});
  final Json tool;
  final NativeEditorController controller;

  static const _note = TextStyle(fontSize: 13, height: 1.35, color: secondary);

  @override
  Widget build(BuildContext context) {
    final p = controller.params, id = tool['id'] as String, kind = tool['kind'];
    final title = tool['title'] as String;
    final enabled = !controller.busy && tool['enabled'] != false;
    void fields(Json value) => controller.edit('fields', id, value);

    // Switch in the heading: toggles, lens blur, and tools with their own.
    final switchField = (kind == 'toggle' || kind == 'lens')
        ? tool['field'] as String
        : tool['enabledBy'] as String?;
    final decodeBlocked =
        kind == 'toggle' && tool['field'] == 'inputCctfDecoding' && !enabled;

    Widget? body;
    switch (kind) {
      case 'slider':
        final range = tool['range'] as Json;
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            DetailSlider(
              value: (tool['position'] as num).toDouble(),
              min: (range['min'] as num).toDouble(),
              max: (range['max'] as num).toDouble(),
              step: (range['step'] as num).toDouble(),
              label: title,
              enabled: enabled,
              onStart: controller.beginGesture,
              onEnd: controller.endGesture,
              onChanged: (v) => controller.edit('position', id, v),
              onReset: tool['defaultPosition'] == null
                  ? null
                  : () => controller.edit(
                      'position',
                      id,
                      (tool['defaultPosition'] as num).toDouble(),
                    ),
            ),
            if (tool['note'] != null)
              Text(tool['note'] as String, style: _note),
          ],
        );
      case 'stepper':
        final seed = tool['field'] == 'grainSeed';
        body = Row(
          children: [
            Press(
              label: 'Decrease $title',
              onTap: enabled && tool['atMin'] != true
                  ? () => controller.edit('step', id, -1)
                  : null,
              child: const Glyph('minus', size: 18),
            ),
            Expanded(
              child: Column(
                children: [
                  AnimatedSwitcher(
                    duration: MediaQuery.disableAnimationsOf(context)
                        ? Duration.zero
                        : const Duration(milliseconds: 220),
                    child: Text(
                      tool['valueText'] as String,
                      key: ValueKey(tool['valueText']),
                      style: const TextStyle(
                        fontSize: 17,
                        fontWeight: FontWeight.w600,
                        fontFeatures: [FontFeature.tabularFigures()],
                      ),
                    ),
                  ),
                  if (tool['hint'] != null)
                    Text(tool['hint'] as String, style: _note),
                ],
              ),
            ),
            Press(
              label: 'Increase $title',
              onTap: enabled && tool['atMax'] != true
                  ? () => controller.edit('step', id, 1)
                  : null,
              child: const Glyph('plus', size: 18),
            ),
            if (seed) ...[
              const SizedBox(width: 8),
              Press(
                label: 'Random grain pattern',
                onTap: enabled
                    ? () => fields({'grainSeed': 1 + Random().nextInt(9999)})
                    : null,
                child: const Glyph('shuffle', size: 18),
              ),
            ],
          ],
        );
      case 'choice':
        final options = (tool['options'] as List).cast<Json>();
        if (options.length > 10) {
          // Long lists (color spaces) open a list sheet, as on the web.
          body = ListPress(
            label: '$title: ${tool['valueText']}. Change',
            onTap: enabled
                ? () => editorSheet<void>(
                    context,
                    OptionSheet(
                      title: title,
                      options: options,
                      value: p[tool['field']] as String,
                      onSelect: (v) => controller.edit('choice', id, v),
                    ),
                  )
                : null,
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    tool['valueText'] as String,
                    overflow: TextOverflow.ellipsis,
                    style: const TextStyle(fontWeight: FontWeight.w500),
                  ),
                ),
                const Glyph('upDown', size: 16),
              ],
            ),
          );
        } else {
          body = Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              OptionRow(
                label: title,
                options: options,
                value: p[tool['field']] as String,
                onChanged: enabled
                    ? (v) => controller.edit('choice', id, v)
                    : null,
              ),
              if (tool['note'] != null)
                Text(tool['note'] as String, style: _note),
            ],
          );
        }
      case 'diffusion':
        final families = (controller.catalog['diffusionFamilies'] as List)
            .cast<Json>();
        final range =
            tool['strengthRange'] as Json? ??
            const {'min': 0, 'max': 2, 'step': .125};
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            OptionRow(
              label: '$title type',
              options: families,
              value: p[tool['familyField']] as String,
              onChanged: controller.busy
                  ? null
                  : (v) => fields({
                      tool['familyField'] as String: v,
                      tool['enabledBy'] as String: true,
                      if ((p[tool['strengthField']] as num) <= 0)
                        tool['strengthField'] as String: .5,
                    }),
            ),
            Row(
              children: [
                Expanded(
                  child: DetailSlider(
                    value: (p[tool['strengthField']] as num).toDouble(),
                    min: (range['min'] as num).toDouble(),
                    max: (range['max'] as num).toDouble(),
                    step: (range['step'] as num).toDouble(),
                    label: '$title strength',
                    enabled: enabled,
                    onStart: controller.beginGesture,
                    onEnd: controller.endGesture,
                    onChanged: (v) =>
                        fields({tool['strengthField'] as String: v}),
                    onReset: () => fields({
                      tool['strengthField'] as String:
                          tool['defaultStrength'] ?? 0,
                    }),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  tool['strengthText'] as String? ?? '',
                  style: const TextStyle(
                    fontSize: 15,
                    fontWeight: FontWeight.w600,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              ],
            ),
            if (tool['note'] != null)
              Text(tool['note'] as String, style: _note),
          ],
        );
      case 'lens':
        body = LensCard(tool: tool, controller: controller);
      default: // toggle, locked
        if (tool['note'] != null) {
          body = Text(
            tool['note'] as String,
            style: _note.copyWith(fontSize: 15),
          );
        }
    }

    return Padding(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        mainAxisSize: MainAxisSize.min,
        children: [
          Row(
            children: [
              Expanded(
                child: TweenAnimationBuilder<double>(
                  key: ValueKey(id),
                  tween: Tween(begin: .4, end: 1),
                  duration: const Duration(milliseconds: 160),
                  builder: (context, o, child) =>
                      Opacity(opacity: o, child: child),
                  child: Text(
                    title,
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ),
              if (kind == 'slider' || kind == 'stepper')
                Text(
                  tool['valueText'] as String,
                  style: const TextStyle(
                    fontSize: 20,
                    fontWeight: FontWeight.w600,
                    fontFeatures: [FontFeature.tabularFigures()],
                  ),
                ),
              if (tool['resettable'] == true)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: Press(
                    label: 'Reset $title',
                    onTap: controller.busy
                        ? null
                        : () => controller.edit('reset', id, null),
                    child: const Glyph('reset', size: 18),
                  ),
                ),
              if (switchField != null)
                Padding(
                  padding: const EdgeInsets.only(left: 8),
                  child: LightSwitch(
                    label: title,
                    value: p[switchField] == true,
                    onChanged: controller.busy || decodeBlocked
                        ? null
                        : (v) => fields({
                            switchField: v,
                            if (v &&
                                kind == 'diffusion' &&
                                (p[tool['strengthField']] as num) <= 0)
                              tool['strengthField'] as String: .5,
                          }),
                  ),
                ),
            ],
          ),
          if (body != null)
            Padding(padding: const EdgeInsets.only(top: 8), child: body),
        ],
      ),
    );
  }
}

/// Depth state, model download, focus hint and depth of field
/// (ToolControls.tsx `LensCard`).
class LensCard extends StatelessWidget {
  const LensCard({super.key, required this.tool, required this.controller});
  final Json tool;
  final NativeEditorController controller;
  static const _foot = TextStyle(fontSize: 13, height: 1.35, color: secondary);
  @override
  Widget build(BuildContext context) {
    final c = controller;
    final note = Text(tool['note'] as String, style: _foot);
    if (c.params['lensBlurEnabled'] != true) return note;
    final Widget status = switch (c.depthState) {
      'needs-download' => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Lens blur needs a one-time download of the depth model. It stays on this device, and your photos never leave it.',
            style: TextStyle(fontSize: 15),
          ),
          const SizedBox(height: 8),
          Press(
            label: 'Download',
            onTap: c.busy ? null : c.downloadDepth,
            child: Text('Download · ${(c.depthBytes / 1000000).round()} MB'),
          ),
        ],
      ),
      'error' => Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Couldn’t measure depth: ${c.depthError ?? ''}',
            style: const TextStyle(fontSize: 15),
          ),
          const SizedBox(height: 8),
          Press(
            label: 'Try Again',
            onTap: c.busy ? null : c.downloadDepth,
            child: const Text('Try Again'),
          ),
        ],
      ),
      'ready' => Wrap(
        spacing: 10,
        children: [
          Text(
            'Depth ready · CPU · ${c.depthSeconds.toStringAsFixed(1)} s',
            style: _foot,
          ),
          const Text('Drag the focus pin on the photo to focus.', style: _foot),
        ],
      ),
      _ => Row(
        children: [
          const SizedBox(
            width: 16,
            height: 16,
            child: CircularProgressIndicator.adaptive(strokeWidth: 2),
          ),
          const SizedBox(width: 8),
          Text('${c.depthPhase}…', style: const TextStyle(fontSize: 15)),
        ],
      ),
    };
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        status,
        if (tool['readout'] != null) ...[
          const SizedBox(height: 8),
          Text(
            tool['readout'] as String,
            style: _foot.copyWith(
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ],
      ],
    );
  }
}

class OptionSheet extends StatelessWidget {
  const OptionSheet({
    super.key,
    required this.title,
    required this.options,
    required this.value,
    required this.onSelect,
  });
  final String title, value;
  final List<Json> options;
  final ValueChanged<String> onSelect;
  @override
  Widget build(BuildContext context) => Column(
    children: [
      Row(
        children: [
          Expanded(
            child: Text(
              title,
              style: const TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
            ),
          ),
          Press(
            label: 'Done',
            onTap: () => Navigator.pop(context),
            child: const Glyph('check'),
          ),
        ],
      ),
      const SizedBox(height: 12),
      Expanded(
        child: EditorScrollView(
          builder: (scroll) => ListView.builder(
            controller: scroll,
            physics: const BouncingScrollPhysics(),
            itemCount: options.length,
            itemBuilder: (context, i) => ListTile(
              title: Text(options[i]['label'] as String),
              subtitle: options[i]['group'] == null
                  ? null
                  : Text(options[i]['group'] as String),
              trailing: options[i]['value'] == value
                  ? const Glyph('check', color: signalBlue)
                  : null,
              onTap: () {
                onSelect(options[i]['value'] as String);
                Navigator.pop(context);
              },
            ),
          ),
        ),
      ),
    ],
  );
}

/// Film & Paper picker (web `StockBrowser` in its sheet): picks preview at
/// once, Cancel restores the stocks from when it opened, Swap compares with
/// the previous choice.
class StockSheet extends StatefulWidget {
  const StockSheet({super.key, required this.controller});
  final NativeEditorController controller;
  @override
  State<StockSheet> createState() => _StockSheetState();
}

class _StockSheetState extends State<StockSheet> {
  String tab = 'film', query = '';
  late final Json before = pick(widget.controller.params);
  late Json swap = before;

  static Json pick(Json p) => {
    'film': p['film'],
    'filmEnabled': p['filmEnabled'],
    'paper': p['paper'],
    'process': p['process'],
  };

  static bool same(Json a, Json b) => a.keys.every((k) => a[k] == b[k]);

  Widget segmented(
    List<String> labels,
    int selected,
    ValueChanged<int> onChanged, {
    double height = 36,
  }) {
    if (useNativeControls) {
      return NativeSegmented(
        items: labels,
        selected: selected,
        onChanged: onChanged,
        height: height,
      );
    }
    return Row(
      children: [
        for (var i = 0; i < labels.length; i++)
          Expanded(
            child: Press(
              label: labels[i],
              selected: i == selected,
              onTap: () => onChanged(i),
              child: Text(labels[i]),
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller, p = c.params;
      final s = Stocks(c.catalog, p);
      final current = pick(p);
      final chosen = p[tab] as String?;
      final q = query.trim().toLowerCase();
      final sections = [
        for (final section in c.catalog['${tab}Sections'] as List? ?? const [])
          (
            section: section as Map,
            stocks: [
              for (final stock in section['stocks'] as List)
                if (q.isEmpty ||
                    '${stock['name']} ${stock['detail']}'
                        .toLowerCase()
                        .contains(q))
                  stock as Map,
            ],
          ),
      ].where((e) => e.stocks.isNotEmpty).toList();
      const sub = TextStyle(fontSize: 15, color: secondary);

      final items = <Widget>[
        if (sections.isEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 24),
            child: Text(
              'No stocks match “$query”.',
              textAlign: TextAlign.center,
              style: sub,
            ),
          ),
        if (tab == 'film' && q.isEmpty)
          ListTile(
            minTileHeight: 56,
            title: const Text('Off'),
            subtitle: const Text('Neutral negative · controls active'),
            trailing: !s.filmEnabled
                ? const Glyph('check', size: 20, color: signalBlue)
                : null,
            onTap: () => c.edit('film', 'film', 'off'),
          ),
        if (q.isEmpty)
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
            child: Text(
              stockHint(tab, filmEnabled: s.filmEnabled, scan: s.scan),
              style: const TextStyle(fontSize: 13, color: secondary),
            ),
          ),
      ];
      for (final (:section, :stocks) in sections) {
        final title = section['title'] as String;
        final locked = section['locked'] == true;
        items.add(
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 20, 16, 6),
            child: Text(
              title.toUpperCase(),
              style: const TextStyle(fontSize: 13, color: secondary),
            ),
          ),
        );
        for (final stock in stocks) {
          final id = stock['id'] as String;
          final paperOff =
              tab == 'paper' &&
              (s.scan || !s.filmEnabled || s.isSlide(p['film'] as String?)) &&
              !Stocks.isPrintLut(id);
          final selected =
              !locked &&
              id == chosen &&
              !paperOff &&
              (tab != 'film' || s.filmEnabled);
          final disabled = locked || paperOff;
          // Brand dropped under the Kodak and Fujifilm headers.
          final name =
              (tab == 'film' && locked) ||
                  !(title == 'Kodak' || title == 'Fujifilm')
              ? stock['name'] as String
              : stock['short'] as String;
          items.add(
            Opacity(
              opacity: disabled ? .45 : 1,
              child: ListTile(
                minTileHeight: 56,
                enabled: !disabled,
                title: Text(name),
                subtitle: Text(stock['detail'] as String),
                trailing: locked
                    ? const Glyph('lock', size: 18, color: secondary)
                    : selected
                    ? const Glyph('check', size: 20, color: signalBlue)
                    : null,
                onTap: disabled ? null : () => c.edit(tab, tab, id),
              ),
            ),
          );
        }
        if (section['footer'] != null) {
          items.add(
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
              child: Text(
                section['footer'] as String,
                style: const TextStyle(fontSize: 13, color: secondary),
              ),
            ),
          );
        }
      }

      return Column(
        children: [
          Row(
            children: [
              Press(
                label: 'Cancel',
                onTap: () {
                  c.edit('fields', 'stocks', before);
                  Navigator.pop(context);
                },
                child: const Glyph('close', size: 16),
              ),
              const Expanded(
                child: Text(
                  'Film & Paper',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                ),
              ),
              Press(
                label: 'Done',
                selected: true,
                filled: true,
                onTap: () => Navigator.pop(context),
                child: const Glyph('check', size: 18),
              ),
            ],
          ),
          const SizedBox(height: 12),
          segmented(
            const ['Film', 'Paper'],
            tab == 'film' ? 0 : 1,
            (i) => setState(() => tab = i == 0 ? 'film' : 'paper'),
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
            child: Row(
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      const Text(
                        'Process',
                        style: TextStyle(
                          fontSize: 15,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      Text(
                        !s.filmEnabled
                            ? 'Neutral negative · controls active'
                            : s.scan
                            ? 'The film itself, no paper'
                            : 'Film printed onto paper',
                        style: const TextStyle(fontSize: 13, color: secondary),
                      ),
                    ],
                  ),
                ),
                SizedBox(
                  width: 150,
                  child: segmented(
                    const ['Print', 'Scan'],
                    p['process'] == 'scanNegative' ? 1 : 0,
                    (i) => c.edit(
                      'choice',
                      'process',
                      i == 0 ? 'printSimulation' : 'scanNegative',
                    ),
                    height: 32,
                  ),
                ),
              ],
            ),
          ),
          if (!same(swap, current))
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 12, 4, 0),
              child: Row(
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Previous',
                          style: TextStyle(fontSize: 13, color: secondary),
                        ),
                        Text(
                          Stocks(c.catalog, swap).recipe,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ],
                    ),
                  ),
                  Press(
                    label:
                        'Swap with previous stocks, ${Stocks(c.catalog, swap).recipe}',
                    onTap: () {
                      final next = swap;
                      setState(() => swap = current);
                      c.edit('fields', 'stocks', next);
                    },
                    child: const Text('Swap'),
                  ),
                ],
              ),
            ),
          const SizedBox(height: 12),
          ClipPath(
            clipper: ShapeBorderClipper(
              shape: RoundedSuperellipseBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: TextField(
              onChanged: (v) => setState(() => query = v),
              textInputAction: TextInputAction.search,
              decoration: const InputDecoration(
                prefixIcon: Padding(
                  padding: EdgeInsets.all(12),
                  child: Glyph('search', size: 16, color: secondary),
                ),
                hintText: 'Search',
              ),
            ),
          ),
          const SizedBox(height: 4),
          Expanded(
            child: EditorScrollView(
              builder: (scroll) => ListView(
                controller: scroll,
                physics: const BouncingScrollPhysics(),
                padding: const EdgeInsets.only(bottom: 32),
                children: items,
              ),
            ),
          ),
        ],
      );
    },
  );
}
