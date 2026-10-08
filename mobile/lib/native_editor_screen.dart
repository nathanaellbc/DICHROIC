import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'editor_widgets.dart';
import 'native_editor_controller.dart';
import 'photo_viewport.dart';
import 'removal_brush.dart';
import 'export_sheet.dart';

class NativeEditorScreen extends StatefulWidget {
  const NativeEditorScreen({super.key, this.controller});
  final NativeEditorController? controller;
  @override
  State<NativeEditorScreen> createState() => _NativeEditorScreenState();
}

class _NativeEditorScreenState extends State<NativeEditorScreen> {
  late final controller =
      widget.controller ?? NativeEditorController(ExposureEngine());
  String groupId = 'camera';
  final selections = <String, String>{};
  final brush = RemovalBrush();
  final exportPreferences = ExportPreferences();
  @override
  void initState() {
    super.initState();
    exportPreferences.load(controller.engine);
  }

  @override
  void dispose() {
    controller.dispose();
    brush.dispose();
    super.dispose();
  }

  Future<void> pick() async {
    try {
      final photo = await ImagePicker().pickImage(
        source: ImageSource.gallery,
        requestFullMetadata: true,
      );
      if (photo != null) {
        await controller.open(photo.path);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not open photo: $e')));
      }
    }
  }

  Future<void> pickFile() async {
    try {
      final path = await controller.engine.chooseFile();
      if (path != null) {
        await controller.open(path);
      }
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not open file: $e')));
      }
    }
  }

  String stockName(String kind) {
    if (kind == 'film' && controller.params['filmEnabled'] == false) {
      return 'Film Off';
    }
    final sections =
        controller.catalog['${kind == 'film' ? 'film' : 'paper'}Sections']
            as List? ??
        [];
    for (final section in sections) {
      for (final stock in section['stocks'] as List) {
        if (stock['id'] == controller.params[kind]) {
          return stock['name'] as String;
        }
      }
    }
    return kind == 'film' ? 'Film' : 'Paper';
  }

  Future<void> stocks() =>
      editorSheet<void>(context, StockSheet(controller: controller));
  Future<void> menu() => editorSheet<void>(
    context,
    ListView(
      children: [
        ListTile(
          leading: const Glyph('open'),
          title: const Text('Open from Photos'),
          onTap: () {
            Navigator.pop(context);
            pick();
          },
        ),
        ListTile(
          leading: const Glyph('erase'),
          title: const Text('Remove Object'),
          enabled: controller.photo != null,
          onTap: () {
            Navigator.pop(context);
            brush.clear();
            controller.beginRemoval();
          },
        ),
        ListTile(
          leading: const Glyph('redo'),
          title: const Text('Redo'),
          enabled: controller.canRedo,
          onTap: () {
            Navigator.pop(context);
            controller.redo();
          },
        ),
        ListTile(
          leading: const Glyph('reset'),
          title: const Text('Reset all controls'),
          enabled: controller.photo != null,
          onTap: () {
            Navigator.pop(context);
            controller.resetAll();
          },
        ),
      ],
    ),
    fraction: .4,
  );

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
          ListTile(
            leading: const Glyph('open'),
            title: const Text('Open from Files'),
            onTap: () {
              Navigator.pop(context);
              pickFile();
            },
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
    fraction: .68,
    blur: 3.2,
  );

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final group = controller.groups
          .where((g) => g['id'] == groupId)
          .firstOrNull;
      final tools = (group?['tools'] as List? ?? []).cast<Json>();
      final selected =
          tools.where((t) => t['id'] == selections[groupId]).firstOrNull ??
          tools.firstOrNull;
      return Scaffold(
        backgroundColor: Colors.black,
        body: SafeArea(
          child: LayoutBuilder(
            builder: (context, constraints) {
              final wide = constraints.maxWidth > 720;
              final controls = controller.erasing
                  ? removalControls()
                  : Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        if (selected != null)
                          ToolPanel(
                            key: ValueKey(selected['id']),
                            tool: selected,
                            controller: controller,
                          ),
                        SizedBox(
                          height: 88,
                          child: ListView.separated(
                            scrollDirection: Axis.horizontal,
                            physics: const BouncingScrollPhysics(
                              parent: AlwaysScrollableScrollPhysics(),
                            ),
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 6,
                            ),
                            itemCount: tools.length,
                            separatorBuilder: (_, _) =>
                                const SizedBox(width: 5),
                            itemBuilder: (context, i) {
                              final tool = tools[i];
                              final active = tool['id'] == selected?['id'];
                              return SizedBox(
                                width: 65,
                                child: Column(
                                  children: [
                                    Stack(
                                      children: [
                                        Press(
                                          label: tool['title'] as String,
                                          selected: active,
                                          onTap: () => setState(
                                            () => selections[groupId] =
                                                tool['id'] as String,
                                          ),
                                          child: Glyph(
                                            tool['icon'] as String,
                                            color: active
                                                ? signalBlue
                                                : secondary,
                                          ),
                                        ),
                                        if (tool['modified'] == true)
                                          const Positioned(
                                            right: 7,
                                            top: 6,
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
                                    const SizedBox(height: 4),
                                    Text(
                                      tool['label'] as String,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: TextStyle(
                                        fontSize: 11,
                                        color: active
                                            ? Colors.white
                                            : secondary,
                                      ),
                                    ),
                                  ],
                                ),
                              );
                            },
                          ),
                        ),
                        const Divider(height: 1, color: Color(0x33545458)),
                        SizedBox(
                          height: 62,
                          child: Row(
                            mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                            children: controller.groups
                                .map(
                                  (g) => Press(
                                    label: g['label'] as String,
                                    selected: g['id'] == groupId,
                                    onTap: () => setState(
                                      () => groupId = g['id'] as String,
                                    ),
                                    child: Glyph(
                                      g['icon'] as String,
                                      color: g['id'] == groupId
                                          ? signalBlue
                                          : secondary,
                                    ),
                                  ),
                                )
                                .toList(),
                          ),
                        ),
                      ],
                    );
              final viewport = controller.photo == null
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Glyph('photo', size: 42, color: secondary),
                          const SizedBox(height: 16),
                          const Text(
                            'Start with a photo',
                            style: TextStyle(
                              fontSize: 24,
                              fontWeight: FontWeight.w700,
                            ),
                          ),
                          const SizedBox(height: 8),
                          const Text(
                            'A film and paper darkroom.',
                            style: TextStyle(color: secondary),
                          ),
                          const SizedBox(height: 24),
                          Press(
                            label: 'Open photo',
                            selected: true,
                            onTap: controller.loading ? null : pick,
                            child: const Text('Open photo'),
                          ),
                        ],
                      ),
                    )
                  : PhotoViewport(
                      photo: controller.photo!,
                      detail: controller.detail,
                      detailRevision: controller.revision,
                      onDetailRequest: controller.requestDetail,
                      brush: controller.erasing ? brush : null,
                      showBrush:
                          !controller.removalReady && !controller.removing,
                      focus:
                          !controller.erasing &&
                              !controller.rendering &&
                              controller.params['lensBlurEnabled'] == true
                          ? Offset(
                              (controller.params['lensFocusX'] as num)
                                  .toDouble(),
                              (controller.params['lensFocusY'] as num)
                                  .toDouble(),
                            )
                          : null,
                      onFocusStart: controller.beginGesture,
                      onFocusPreview: (point) =>
                          controller.previewFocus(point.dx, point.dy),
                      onFocusEnd: (point) async {
                        await controller.edit('fields', 'focus', {
                          'lensFocusX': point.dx,
                          'lensFocusY': point.dy,
                        });
                        await controller.endGesture();
                      },
                    );
              return Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.all(4),
                    child: Glass(
                      radius: 20,
                      padding: const EdgeInsets.all(4),
                      child: Row(
                        children: [
                          Press(
                            label: controller.erasing
                                ? 'Cancel removal'
                                : 'More options',
                            radius: 16,
                            onTap: controller.busy
                                ? null
                                : controller.erasing
                                ? () => controller.finishRemoval(apply: false)
                                : menu,
                            child: Glyph(controller.erasing ? 'close' : 'more'),
                          ),
                          Expanded(
                            child: GestureDetector(
                              onTap:
                                  controller.photo == null || controller.erasing
                                  ? null
                                  : stocks,
                              child: Padding(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 12,
                                ),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      controller.erasing
                                          ? 'Remove Object'
                                          : controller.photo == null
                                          ? 'DICHROIC'
                                          : stockName('film'),
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 15,
                                        fontWeight: FontWeight.w700,
                                      ),
                                    ),
                                    if (controller.photo != null)
                                      Text(
                                        'on ${stockName('paper')}',
                                        maxLines: 1,
                                        overflow: TextOverflow.ellipsis,
                                        style: const TextStyle(
                                          fontSize: 11,
                                          color: secondary,
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                          if (!controller.erasing)
                            Press(
                              label: 'Film & Paper',
                              plain: true,
                              onTap: controller.photo == null ? null : stocks,
                              child: const Glyph('upDown', size: 18),
                            ),
                          if (!controller.erasing)
                            Press(
                              label: 'Undo',
                              plain: true,
                              onTap: controller.canUndo && !controller.busy
                                  ? controller.undo
                                  : null,
                              child: const Glyph('undo', size: 18),
                            ),
                          if (wide && !controller.erasing)
                            Press(
                              label: 'Redo',
                              plain: true,
                              onTap: controller.canRedo && !controller.busy
                                  ? controller.redo
                                  : null,
                              child: const Glyph('redo', size: 18),
                            ),
                          Press(
                            label: controller.erasing
                                ? 'Apply removal'
                                : 'Export',
                            radius: 16,
                            selected: true,
                            filled: true,
                            onTap:
                                controller.photo == null ||
                                    controller.busy ||
                                    (controller.erasing &&
                                        !controller.removalReady)
                                ? null
                                : controller.erasing
                                ? () => controller.finishRemoval(apply: true)
                                : export,
                            child: Glyph(
                              controller.erasing ? 'check' : 'share',
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  Expanded(
                    child: wide
                        ? Row(
                            children: [
                              Expanded(child: viewport),
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
                        : viewport,
                  ),
                  if (controller.loading)
                    const Padding(
                      padding: EdgeInsets.all(12),
                      child: Text('Opening photo…'),
                    ),
                  if (controller.status?.isNotEmpty == true)
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(
                        controller.status!,
                        style: const TextStyle(color: secondary, fontSize: 12),
                      ),
                    ),
                  if (controller.error != null)
                    Padding(
                      padding: const EdgeInsets.all(8),
                      child: Text(
                        controller.error!,
                        maxLines: 3,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.redAccent,
                          fontSize: 12,
                        ),
                      ),
                    ),
                  if (!wide && controller.photo != null)
                    Glass(radius: 24, child: controls),
                ],
              );
            },
          ),
        ),
      );
    },
  );
}

class ToolPanel extends StatelessWidget {
  const ToolPanel({super.key, required this.tool, required this.controller});
  final Json tool;
  final NativeEditorController controller;
  @override
  Widget build(BuildContext context) {
    final p = controller.params, id = tool['id'] as String, kind = tool['kind'];
    final toggle = (kind == 'toggle' || kind == 'lens')
        ? tool['field']
        : tool['enabledBy'];
    final enabled =
        !controller.busy &&
        kind != 'locked' &&
        (tool['requires'] == null || p[tool['requires']] == true) &&
        (tool['enabledBy'] == null || p[tool['enabledBy']] == true);
    void fields(Json value) {
      controller.edit('fields', id, value);
    }

    Widget? body;
    if (kind == 'slider') {
      final range = tool['range'] as Json;
      body = DetailSlider(
        value: (tool['position'] as num).toDouble(),
        min: (range['min'] as num).toDouble(),
        max: (range['max'] as num).toDouble(),
        step: (range['step'] as num).toDouble(),
        label: tool['title'] as String,
        enabled: enabled,
        onStart: controller.beginGesture,
        onEnd: controller.endGesture,
        onChanged: (v) => controller.edit('position', id, v),
      );
    } else if (kind == 'choice') {
      body = Press(
        label: tool['title'] as String,
        onTap: enabled
            ? () => editorSheet<void>(
                context,
                OptionSheet(
                  title: tool['title'] as String,
                  options: (tool['options'] as List).cast<Json>(),
                  value: p[tool['field']] as String,
                  onSelect: (v) => controller.edit('choice', id, v),
                ),
              )
            : null,
        child: Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Flexible(
              child: Text(
                tool['valueText'] as String,
                overflow: TextOverflow.ellipsis,
              ),
            ),
            const Glyph('upDown', size: 16),
          ],
        ),
      );
    } else if (kind == 'stepper') {
      final value = (p[tool['field']] as num).toDouble();
      final list = tool['values'] as List?;
      body = Row(
        mainAxisAlignment: MainAxisAlignment.end,
        children: [
          Press(
            label: 'Decrease ${tool['title']}',
            onTap:
                enabled && value > (list?.first as num? ?? tool['min'] as num)
                ? () => controller.edit('step', id, -1)
                : null,
            child: const Glyph('minus', size: 18),
          ),
          const SizedBox(width: 8),
          Press(
            label: 'Increase ${tool['title']}',
            onTap: enabled && value < (list?.last as num? ?? tool['max'] as num)
                ? () => controller.edit('step', id, 1)
                : null,
            child: const Glyph('plus', size: 18),
          ),
        ],
      );
    } else if (kind == 'diffusion') {
      body = Column(
        children: [
          Press(
            label: '${tool['title']} type',
            onTap: controller.busy
                ? null
                : () => editorSheet<void>(
                    context,
                    OptionSheet(
                      title: 'Filter',
                      options: (controller.catalog['diffusionFamilies'] as List)
                          .cast<Json>(),
                      value: p[tool['familyField']] as String,
                      onSelect: (v) => fields({
                        tool['familyField'] as String: v,
                        tool['enabledBy'] as String: true,
                        if ((p[tool['strengthField']] as num) <= 0)
                          tool['strengthField'] as String: .5,
                      }),
                    ),
                  ),
            child: Text('${p[tool['familyField']]}'),
          ),
          DetailSlider(
            value: (p[tool['strengthField']] as num).toDouble(),
            min: 0,
            max: 2,
            step: .125,
            label: '${tool['title']} strength',
            enabled: enabled,
            onStart: controller.beginGesture,
            onEnd: controller.endGesture,
            onChanged: (v) => fields({tool['strengthField'] as String: v}),
          ),
        ],
      );
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
                child: Text(
                  tool['title'] as String,
                  style: const TextStyle(
                    fontSize: 16,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
              if (toggle != null)
                LightSwitch(
                  label: tool['title'] as String,
                  value: p[toggle] == true,
                  onChanged: controller.busy
                      ? null
                      : (v) => fields({
                          toggle as String: v,
                          if (v &&
                              kind == 'diffusion' &&
                              (p[tool['strengthField']] as num) <= 0)
                            tool['strengthField'] as String: .5,
                        }),
                )
              else
                Text(
                  tool['valueText'] as String,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              if (tool['modified'] == true)
                Padding(
                  padding: const EdgeInsets.only(left: 6),
                  child: Press(
                    label: 'Reset ${tool['title']}',
                    onTap: () => controller.edit('reset', id, null),
                    child: const Glyph('reset', size: 17),
                  ),
                ),
            ],
          ),
          if (body != null) body,
          if (tool['note'] != null)
            Padding(
              padding: const EdgeInsets.only(top: 6, bottom: 8),
              child: Text(
                tool['note'] as String,
                style: const TextStyle(
                  fontSize: 12,
                  height: 1.35,
                  color: secondary,
                ),
              ),
            ),
        ],
      ),
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
        child: Scrollbar(
          child: ListView.builder(
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

class StockSheet extends StatefulWidget {
  const StockSheet({super.key, required this.controller});
  final NativeEditorController controller;
  @override
  State<StockSheet> createState() => _StockSheetState();
}

class _StockSheetState extends State<StockSheet> {
  String tab = 'film', search = '';
  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.controller,
    builder: (context, _) {
      final c = widget.controller;
      final sections = c.catalog['${tab}Sections'] as List? ?? [];
      final items = <Widget>[];
      if (tab == 'film' && (search.isEmpty || 'off'.contains(search))) {
        items.add(
          ListTile(
            title: const Text('Off'),
            subtitle: const Text('Neutral negative · controls active'),
            trailing: c.params['filmEnabled'] == false
                ? const Glyph('check', color: signalBlue)
                : null,
            onTap: () => c.edit('film', 'film', 'off'),
          ),
        );
      }
      for (final section in sections) {
        final stocks = (section['stocks'] as List)
            .where(
              (s) =>
                  '${s['name']} ${s['detail']}'.toLowerCase().contains(search),
            )
            .toList();
        if (stocks.isEmpty) continue;
        items.add(
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 20, 12, 4),
            child: Text(
              section['title'] as String,
              style: const TextStyle(
                color: secondary,
                fontSize: 12,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
        );
        for (final stock in stocks) {
          final blocked =
              section['locked'] == true ||
              (tab == 'paper' &&
                  c.params['filmEnabled'] == false &&
                  !(stock['id'] as String).startsWith('lut_'));
          final active =
              stock['id'] == c.params[tab] &&
              (tab != 'film' || c.params['filmEnabled'] == true);
          items.add(
            ListTile(
              enabled: !blocked,
              title: Text(stock['short'] as String),
              subtitle: Text(stock['detail'] as String),
              trailing: active ? const Glyph('check', color: signalBlue) : null,
              onTap: blocked ? null : () => c.edit(tab, tab, stock['id']),
            ),
          );
        }
        if (section['footer'] != null) {
          items.add(
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              child: Text(
                section['footer'] as String,
                style: const TextStyle(fontSize: 12, color: secondary),
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
                label: 'Close',
                onTap: () => Navigator.pop(context),
                child: const Glyph('close'),
              ),
              const Expanded(
                child: Text(
                  'Film & Paper',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
                ),
              ),
              Press(
                label: 'Done',
                selected: true,
                onTap: () => Navigator.pop(context),
                child: const Glyph('check'),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Row(
            children: ['film', 'paper']
                .map(
                  (value) => Expanded(
                    child: Press(
                      label: value,
                      selected: tab == value,
                      onTap: () => setState(() => tab = value),
                      child: Text(value == 'film' ? 'Film' : 'Paper'),
                    ),
                  ),
                )
                .toList(),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 12),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    'Process',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
                ),
                for (final process in ['printSimulation', 'scanNegative'])
                  Press(
                    label: process == 'printSimulation' ? 'Print' : 'Scan',
                    selected: c.params['process'] == process,
                    onTap: () => c.edit('choice', 'process', process),
                    child: Text(
                      process == 'printSimulation' ? 'Print' : 'Scan',
                    ),
                  ),
              ],
            ),
          ),
          ClipPath(
            clipper: ShapeBorderClipper(
              shape: RoundedSuperellipseBorder(
                borderRadius: BorderRadius.circular(12),
              ),
            ),
            child: TextField(
              onChanged: (v) => setState(() => search = v.toLowerCase()),
              decoration: const InputDecoration(
                prefixIcon: Padding(
                  padding: EdgeInsets.all(12),
                  child: Glyph('search', size: 16, color: secondary),
                ),
                hintText: 'Search',
              ),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: Scrollbar(
              child: ListView(
                physics: const BouncingScrollPhysics(),
                children: items,
              ),
            ),
          ),
        ],
      );
    },
  );
}
