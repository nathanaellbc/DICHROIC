import 'dart:io';
import 'dart:convert';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';
import 'editor_widgets.dart';
import 'native_editor_controller.dart';

class ExportPreferences {
  String format = 'png8';
  int? longEdge;
  double quality = 1;
  bool lut = false;
  int cubeSize = 33;
  Future<void> load(ExposureEngine engine) async {
    try {
      final text = await engine.loadExportPreferences();
      if (text == null) return;
      final values = jsonDecode(text) as Map<String, dynamic>;
      if ([
        'png8',
        'png16',
        'tiff16',
        'jpeg',
        'webp',
        'avif',
      ].contains(values['format'])) {
        format = values['format'] as String;
      }
      if ([null, 2048, 4096, 8192].contains(values['longEdge'])) {
        longEdge = values['longEdge'] as int?;
      }
      quality = (values['quality'] as num? ?? 1).toDouble().clamp(.1, 1);
      lut = values['lut'] == true;
      if ([17, 33, 65].contains(values['cubeSize'])) {
        cubeSize = values['cubeSize'] as int;
      }
    } catch (_) {
      /* Retain defaults when preferences are unavailable. */
    }
  }

  Future<void> save(ExposureEngine engine) async {
    try {
      await engine.saveExportPreferences(
        jsonEncode({
          'format': format,
          'longEdge': longEdge,
          'quality': quality,
          'lut': lut,
          'cubeSize': cubeSize,
        }),
      );
    } catch (_) {
      /* Export remains usable without preferences. */
    }
  }
}

class ExportSheet extends StatefulWidget {
  const ExportSheet({
    super.key,
    required this.controller,
    required this.preferences,
  });
  final NativeEditorController controller;
  final ExportPreferences preferences;
  @override
  State<ExportSheet> createState() => _ExportSheetState();
}

class _ExportSheetState extends State<ExportSheet> {
  String? path;
  int? bytes;
  bool sharing = false;
  NativeEditorController get c => widget.controller;
  ExportPreferences get p => widget.preferences;
  static const names = {
    'png8': 'PNG 8-bit',
    'png16': 'PNG 16-bit',
    'tiff16': 'TIFF 16-bit',
    'jpeg': 'JPEG',
    'webp': 'WebP',
    'avif': 'AVIF',
  };
  void change(VoidCallback action) {
    final old = path;
    path = null;
    bytes = null;
    if (old != null) File(old).delete().catchError((Object _) => File(old));
    setState(action);
    p.save(c.engine);
  }

  @override
  void dispose() {
    final old = path;
    if (old != null) File(old).delete().catchError((Object _) => File(old));
    super.dispose();
  }

  Future<void> develop() async {
    final result = await c.export(
      format: p.format,
      longEdge: p.longEdge,
      quality: p.quality,
      cubeSize: p.lut ? p.cubeSize : null,
    );
    if (result == null) return;
    if (!mounted) {
      await File(result).delete();
      return;
    }
    final size = await File(result).length();
    if (mounted) {
      setState(() {
        path = result;
        bytes = size;
      });
    }
  }

  Future<void> share() async {
    if (path == null) return;
    setState(() => sharing = true);
    try {
      final box = context.findRenderObject() as RenderBox?;
      await SharePlus.instance.share(
        ShareParams(
          files: [XFile(path!)],
          sharePositionOrigin: box == null
              ? null
              : box.localToGlobal(Offset.zero) & box.size,
        ),
      );
    } finally {
      if (mounted) setState(() => sharing = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) => Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Row(
          children: [
            const Text(
              'Export',
              style: TextStyle(fontSize: 20, fontWeight: FontWeight.w700),
            ),
            const Spacer(),
            Press(
              label: 'Close export',
              plain: true,
              onTap: c.exporting ? null : () => Navigator.pop(context),
              child: const Glyph('close', size: 18),
            ),
          ],
        ),
        const SizedBox(height: 8),
        Expanded(
          child: ListView(
            children: [
              Row(
                children: [
                  Expanded(
                    child: Press(
                      label: 'Image export',
                      selected: !p.lut,
                      onTap: c.exporting
                          ? null
                          : () => change(() => p.lut = false),
                      child: const Text('Image'),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Press(
                      label: 'LUT export',
                      selected: p.lut,
                      onTap: c.exporting
                          ? null
                          : () => change(() => p.lut = true),
                      child: const Text('3D LUT'),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 16),
              if (p.lut) ...[
                const Text('Cube size', style: TextStyle(color: secondary)),
                Wrap(
                  spacing: 8,
                  children: [17, 33, 65]
                      .map(
                        (size) => Press(
                          label: '$size point cube',
                          selected: p.cubeSize == size,
                          onTap: c.exporting
                              ? null
                              : () => change(() => p.cubeSize = size),
                          child: Text('$size³'),
                        ),
                      )
                      .toList(),
                ),
                const SizedBox(height: 12),
                const Text(
                  'Color transforms are included. Grain, lens blur and spatial effects cannot be stored in a 3D LUT.',
                  style: TextStyle(color: secondary, fontSize: 12),
                ),
              ] else ...[
                const Text('Format', style: TextStyle(color: secondary)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children:
                      ((c.catalog['exportFormats'] as List?) ??
                              ['png8', 'png16', 'tiff16', 'jpeg'])
                          .cast<String>()
                          .map(
                            (f) => Press(
                              label: names[f]!,
                              selected: p.format == f,
                              onTap: c.exporting
                                  ? null
                                  : () => change(() => p.format = f),
                              child: Text(names[f]!),
                            ),
                          )
                          .toList(),
                ),
                const SizedBox(height: 16),
                const Text('Long edge', style: TextStyle(color: secondary)),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: <int?>[null, 2048, 4096, 8192]
                      .map(
                        (edge) => Press(
                          label: edge == null
                              ? 'Source resolution'
                              : '$edge pixels',
                          selected: p.longEdge == edge,
                          onTap: c.exporting
                              ? null
                              : () => change(() => p.longEdge = edge),
                          child: Text(edge == null ? 'Source' : '$edge'),
                        ),
                      )
                      .toList(),
                ),
                if (['jpeg', 'webp', 'avif'].contains(p.format)) ...[
                  const SizedBox(height: 12),
                  Text(
                    'Quality ${(p.quality * 100).round()}%',
                    style: const TextStyle(color: secondary),
                  ),
                  DetailSlider(
                    value: p.quality * 100,
                    min: 10,
                    max: 100,
                    step: 1,
                    label: 'Export quality',
                    enabled: !c.exporting,
                    onChanged: (v) => change(() => p.quality = v / 100),
                  ),
                ],
              ],
              const SizedBox(height: 16),
              Text(
                '${c.params['outputColorSpace']} · embedded color profile',
                style: const TextStyle(color: secondary, fontSize: 12),
              ),
              if (!p.lut &&
                  (c.params['lensBlurEnabled'] == true ||
                      c.params['cameraDiffusionEnabled'] == true ||
                      c.params['printDiffusionEnabled'] == true))
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    'Lens and diffusion resolution adapts to the device memory budget, as in the web editor.',
                    style: TextStyle(color: secondary, fontSize: 12),
                  ),
                ),
              if (bytes != null)
                Padding(
                  padding: const EdgeInsets.only(top: 16),
                  child: Text(
                    '${(bytes! / 1048576).toStringAsFixed(2)} MB · ready to share',
                  ),
                ),
              if (c.error != null)
                Padding(
                  padding: const EdgeInsets.only(top: 12),
                  child: Text(
                    c.error!,
                    style: const TextStyle(color: Colors.redAccent),
                  ),
                ),
            ],
          ),
        ),
        const SizedBox(height: 8),
        if (c.exporting) ...[
          Press(
            label: 'Stop export',
            onTap: c.cancelExport,
            child: const Text('Stop'),
          ),
          const SizedBox(height: 8),
        ],
        Press(
          label: path == null ? 'Develop export' : 'Save or share',
          selected: true,
          filled: true,
          onTap: c.exporting || sharing
              ? null
              : path == null
              ? develop
              : share,
          child: Text(
            c.exporting
                ? c.status?.isNotEmpty == true
                      ? c.status!
                      : 'Developing…'
                : path == null
                ? 'Develop'
                : 'Save or Share',
          ),
        ),
      ],
    ),
  );
}
