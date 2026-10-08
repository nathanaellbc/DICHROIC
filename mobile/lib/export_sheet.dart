import 'dart:async';
import 'dart:io';
import 'dart:convert';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/material.dart';
import 'package:share_plus/share_plus.dart';
import 'editor_text.dart';
import 'editor_widgets.dart';
import 'native_controls.dart';
import 'native_editor_controller.dart';

/// Lossy default, as on the web: no visible artefacts, far smaller than 100.
const defaultQuality = 92;

class ExportPreferences {
  String format = 'png8';
  int? longEdge;

  /// 1..100, lossy formats only.
  int quality = defaultQuality;
  bool lut = false;
  int cubeSize = 33;
  Future<void> load(ExposureEngine engine) async {
    try {
      final text = await engine.loadExportPreferences();
      if (text == null) return;
      final values = jsonDecode(text) as Map<String, dynamic>;
      if (formats.containsKey(values['format'])) {
        format = values['format'] as String;
      }
      if ([null, 2048, 4096, 8192].contains(values['longEdge'])) {
        longEdge = values['longEdge'] as int?;
      }
      final q = values['quality'] as num?;
      // Older builds stored a fraction (0.1..1).
      if (q != null) quality = (q <= 1 ? q * 100 : q).round().clamp(1, 100);
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

  /// Name, hint and extension per format (web `FORMAT_INFO`).
  static const formats = {
    'png8': ('PNG 8-bit', 'Lossless · every pixel as rendered', 'png'),
    'png16': ('PNG 16-bit', 'Lossless · smooth gradients', 'png'),
    'tiff16': ('TIFF 16-bit', 'Uncompressed · for further editing', 'tif'),
    'jpeg': ('JPEG', 'Lossy · smallest widely compatible file', 'jpg'),
    'webp': ('WebP', 'Lossy · smaller than JPEG at like quality', 'webp'),
    'avif': ('AVIF', 'Lossy · smallest file, slowest to encode', 'avif'),
  };
  static bool lossy(String format) =>
      const {'jpeg', 'webp', 'avif'}.contains(format);
}

/// Export, as the web sheet: opening it renders nothing; Develop renders at
/// the chosen size, then the button becomes "Save to Photos · 12.3 MB".
/// Format and quality changes encode again on their own; a new size or bit
/// depth needs Develop again. A LUT builds as soon as it is chosen.
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
  /// The finished file, and the settings it was made with.
  ({String path, int bytes, String key})? file;

  /// Render settings (size and bit depth) that were developed.
  String? developedFor;
  bool hasDeveloped = false;
  bool working = false;
  String? failure;
  Size? limitedTo;
  Timer? _reencode;
  int _ticket = 0;
  Future<void>? _running;
  NativeEditorController get c => widget.controller;
  ExportPreferences get p => widget.preferences;

  List<String> get formats =>
      ((c.catalog['exportFormats'] as List?) ??
              const ['png8', 'png16', 'tiff16', 'jpeg'])
          .cast<String>();

  ({int w, int h}) get source => (
    w: c.photo?.sourceWidth ?? c.photo?.width ?? 1,
    h: c.photo?.sourceHeight ?? c.photo?.height ?? 1,
  );

  /// Long-edge detents that really shrink the photo, plus "Source · N".
  List<({int? edge, String label, int w, int h})> get detents {
    final (:w, :h) = source;
    final long = w > h ? w : h;
    ({int w, int h}) dims(int edge) =>
        (w: (w * edge / long).round(), h: (h * edge / long).round());
    return [
      for (final d in const [2048, 4096, 8192])
        if (d < long) (edge: d, label: '$d', w: dims(d).w, h: dims(d).h),
      (edge: null, label: 'Source · $long', w: w, h: h),
    ];
  }

  ({int? edge, String label, int w, int h}) get selected => detents.firstWhere(
    (d) => d.edge == p.longEdge,
    orElse: () => detents.last,
  );

  int get bits => const {'png16', 'tiff16'}.contains(p.format) ? 16 : 8;
  String get requestKey => '${selected.edge ?? 'source'}|$bits';
  String get encodeKey => p.lut
      ? 'lut|${p.cubeSize}'
      : '$requestKey|${p.format}|${ExportPreferences.lossy(p.format) ? p.quality : 100}';
  bool get needsDevelop => !p.lut && developedFor != requestKey;
  bool get ready => file != null && file!.key == encodeKey && !working;

  @override
  void initState() {
    super.initState();
    if (!formats.contains(p.format)) p.format = 'png8';
    if (p.lut) WidgetsBinding.instance.addPostFrameCallback((_) => _make());
  }

  @override
  void dispose() {
    _reencode?.cancel();
    // Closing abandons pending work, as on the web.
    if (working) c.cancelExport();
    _discard();
    super.dispose();
  }

  void _discard() {
    final old = file?.path;
    file = null;
    if (old != null) {
      File(old).parent.delete(recursive: true).catchError((Object _) {
        return File(old).parent;
      });
    }
  }

  /// A setting changed: re-encode on its own when the render still fits,
  /// otherwise wait for Develop.
  void change(VoidCallback action) {
    setState(action);
    p.save(c.engine);
    _reencode?.cancel();
    if (file?.key == encodeKey) return;
    if (p.lut || (!needsDevelop && hasDeveloped)) {
      _reencode = Timer(const Duration(milliseconds: 200), _make);
    }
  }

  Future<void> develop() async {
    hasDeveloped = true;
    developedFor = requestKey;
    await _make();
  }

  Future<void> _make() async {
    if (!mounted) return;
    final ticket = ++_ticket;
    // A newer request supersedes the running one; wait for it to stop.
    if (_running != null) {
      await c.cancelExport();
      await _running;
      if (ticket != _ticket || !mounted) return;
    }
    final run = _run(ticket);
    _running = run;
    await run;
    if (identical(_running, run)) _running = null;
  }

  Future<void> _run(int ticket) async {
    final key = encodeKey;
    setState(() {
      working = true;
      failure = null;
      _discard();
    });
    final quality = ExportPreferences.lossy(p.format)
        ? (p.format == 'avif' ? p.quality.clamp(1, 99) : p.quality) / 100
        : 1.0;
    final result = await c.export(
      format: p.format,
      longEdge: selected.edge,
      quality: quality,
      cubeSize: p.lut ? p.cubeSize : null,
    );
    Size? actual;
    if (result != null && !p.lut) {
      try {
        actual = await c.engine.exportSize(
          Map.of(c.params),
          longEdge: selected.edge,
        );
      } catch (_) {}
    }
    if (!mounted || ticket != _ticket || key != encodeKey) {
      if (result != null) {
        File(result).delete().catchError((Object _) => File(result));
      }
      return;
    }
    if (result == null) {
      setState(() {
        working = false;
        if (c.exportError != null) {
          failure = p.lut
              ? 'Couldn’t build the LUT. Try a smaller cube size.'
              : 'Couldn’t prepare the file. Try a smaller long edge or another format; your edits are kept.';
          developedFor = null;
        }
      });
      return;
    }
    // `<photo> - <film> on <paper>.<ext>`, in its own folder so the name is
    // free to reuse.
    final stocks = Stocks(c.catalog, c.params);
    final name = p.lut
        ? stocks.fileName(c.sourceStem, 'cube', suffix: '${p.cubeSize}')
        : stocks.fileName(
            c.sourceStem,
            ExportPreferences.formats[p.format]!.$3,
          );
    var path = result;
    try {
      final folder = await Directory.systemTemp.createTemp('DICHROIC-');
      path = (await File(result).rename('${folder.path}/$name')).path;
    } catch (_) {}
    final bytes = await File(path).length();
    if (!mounted) return;
    setState(() {
      working = false;
      file = (path: path, bytes: bytes, key: key);
      limitedTo =
          actual != null &&
              (actual.width < selected.w || actual.height < selected.h)
          ? actual
          : null;
    });
  }

  Future<void> share() async {
    final ready = file;
    if (ready == null) return;
    final box = context.findRenderObject() as RenderBox?;
    final result = await SharePlus.instance.share(
      ShareParams(
        files: [XFile(ready.path)],
        sharePositionOrigin: box == null
            ? null
            : box.localToGlobal(Offset.zero) & box.size,
      ),
    );
    // Closing the share sheet without saving is a cancel, not an error.
    if (result.status != ShareResultStatus.success || !mounted) return;
    final recipe = Stocks(c.catalog, c.params).exportRecipe;
    final limited = limitedTo == null
        ? ''
        : ' at ${limitedTo!.width.round()} × ${limitedTo!.height.round()} (memory limit for lens blur or diffusion)';
    Navigator.pop(context);
    c.showToast('Exported · $recipe$limited');
  }

  Widget header(String text, [String? trailing]) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 6),
    child: Row(
      children: [
        Expanded(
          child: Text(
            text.toUpperCase(),
            style: const TextStyle(fontSize: 13, color: secondary),
          ),
        ),
        if (trailing != null)
          Text(
            trailing,
            style: const TextStyle(
              fontSize: 13,
              color: secondary,
              fontFeatures: [FontFeature.tabularFigures()],
            ),
          ),
      ],
    ),
  );

  Widget footer(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 6, 16, 0),
    child: Text(text, style: const TextStyle(fontSize: 13, color: secondary)),
  );

  Widget group(List<Widget> rows) => ClipRRect(
    borderRadius: BorderRadius.circular(14),
    child: Material(
      color: const Color(0x1f787880),
      child: Column(children: rows),
    ),
  );

  Widget segmented(
    List<String> labels,
    int index,
    ValueChanged<int> onChanged,
  ) {
    if (useNativeControls) {
      return NativeSegmented(
        items: labels,
        selected: index,
        onChanged: onChanged,
      );
    }
    return Row(
      children: [
        for (var i = 0; i < labels.length; i++)
          Expanded(
            child: Press(
              label: labels[i],
              selected: i == index,
              onTap: () => onChanged(i),
              child: Text(labels[i], maxLines: 1),
            ),
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final info = ExportPreferences.formats[p.format]!;
      final lossy = ExportPreferences.lossy(p.format);
      final size = file == null ? '' : formatBytes(file!.bytes);
      final out = c.params['outputColorSpace'] as String? ?? 'sRGB';
      final busy = working || (!needsDevelop && !ready && failure == null);
      final rendering =
          working && c.progressTotal > 0 && c.progressDone < c.progressTotal;
      final steps = [
        'Developing ${selected.w} × ${selected.h} on the GPU'
            '${rendering && c.progressTotal > 1 ? ' · tile ${(c.progressDone + 1).clamp(1, c.progressTotal)} of ${c.progressTotal}' : ''}',
        'Encoding ${info.$1}${lossy ? ' · quality ${p.quality}' : ''}',
      ];
      final children = <Widget>[
        segmented(
          const ['Image', 'LUT (.cube)'],
          p.lut ? 1 : 0,
          (i) => change(() => p.lut = i == 1),
        ),
        const SizedBox(height: 14),
      ];
      if (!p.lut) {
        children.addAll([
          group([
            for (final f in formats)
              ListTile(
                minTileHeight: 56,
                title: Text(ExportPreferences.formats[f]!.$1),
                subtitle: Text(ExportPreferences.formats[f]!.$2),
                trailing: f == p.format
                    ? const Glyph('check', size: 20, color: signalBlue)
                    : null,
                onTap: () => change(() => p.format = f),
              ),
          ]),
          if (lossy) ...[
            const SizedBox(height: 14),
            header(
              'Quality',
              '${p.quality} · ${working
                  ? 'measuring…'
                  : size.isEmpty
                  ? '—'
                  : size}',
            ),
            DetailSlider(
              value: p.quality.toDouble(),
              min: 1,
              max: 100,
              step: 1,
              label: 'Quality',
              onChanged: (v) {
                setState(() => p.quality = v.round());
              },
              onEnd: () => change(() {}),
              onReset: () => change(() => p.quality = defaultQuality),
            ),
            footer(
              'The size is measured, not estimated: the file is encoded again as the slider settles.',
            ),
          ],
          const SizedBox(height: 14),
          header('Long edge', '${selected.w} × ${selected.h} px'),
          if (detents.length > 1)
            segmented(
              [for (final d in detents) d.label],
              detents.indexOf(selected),
              (i) => change(() => p.longEdge = detents[i].edge),
            )
          else
            group([
              ListTile(
                title: Text(selected.label),
                trailing: const Text(
                  'No smaller sizes',
                  style: TextStyle(fontSize: 17, color: secondary),
                ),
              ),
            ]),
          footer(
            'Grain, halation and diffusion are physical sizes, so a smaller export is developed again at its own pixel pitch rather than resized.',
          ),
          const SizedBox(height: 14),
          group([
            ListTile(
              title: const Text('Color Space'),
              trailing: Text(
                out,
                style: const TextStyle(fontSize: 17, color: secondary),
              ),
            ),
          ]),
          footer(
            'Embeds the $out ICC profile, and the camera EXIF when the original has it. Change the color space in Color › Output.',
          ),
        ]);
      } else {
        children.addAll([
          header('Cube size'),
          segmented(
            const ['17', '33', '65'],
            const [17, 33, 65].indexOf(p.cubeSize),
            (i) => change(() => p.cubeSize = const [17, 33, 65][i]),
          ),
          const SizedBox(height: 14),
          group([
            ListTile(
              title: const Text('Converts'),
              trailing: Text(
                '${c.params['inputColorSpace']} → $out',
                style: const TextStyle(fontSize: 15, color: secondary),
              ),
            ),
          ]),
          const SizedBox(height: 14),
          ClipRRect(
            borderRadius: BorderRadius.circular(14),
            child: ColoredBox(
              color: const Color(0x26ff9230),
              child: Padding(
                padding: const EdgeInsets.all(12),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: const [
                    Glyph('info', size: 20, color: Color(0xffff9230)),
                    SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        'A LUT carries color only. Grain, halation, glare, diffusion, lens blur and sharpening are left out, and film and print exposure are ignored.',
                        style: TextStyle(fontSize: 15),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ),
        ]);
      }

      final status = <Widget>[
        if (failure != null) ...[
          Text(
            failure!,
            style: const TextStyle(
              fontSize: 13,
              fontWeight: FontWeight.w600,
              color: Color(0xffff6961),
            ),
          ),
          if (c.exportError != null)
            Text(
              c.exportError!,
              style: const TextStyle(fontSize: 12, color: secondary),
            ),
        ],
        if (!p.lut && hasDeveloped && !needsDevelop && failure == null)
          for (var i = 0; i < 2; i++)
            _Step(
              text: steps[i],
              done:
                  ready ||
                  (i == 0 && working && !rendering && c.progressTotal > 0),
              active:
                  working &&
                  (i == 0
                      ? rendering || c.progressTotal == 0
                      : !rendering && c.progressTotal > 0),
            ),
        if (!p.lut && needsDevelop && failure == null)
          Text(
            hasDeveloped
                ? 'The export settings changed. Press Develop to prepare this size.'
                : 'Press Develop to prepare your file.',
            style: const TextStyle(fontSize: 13, color: secondary),
          ),
        if (ready)
          Text(
            file!.path.split('/').last,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 13, color: secondary),
          ),
      ];

      final busyLabel = p.lut
          ? 'Building LUT'
          : rendering || c.progressTotal == 0
          ? 'Developing'
          : 'Encoding';
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Row(
            children: [
              Press(
                label: 'Cancel',
                onTap: () => Navigator.pop(context),
                child: const Glyph('close', size: 16),
              ),
              const Expanded(
                child: Text(
                  'Export',
                  textAlign: TextAlign.center,
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(width: 44),
            ],
          ),
          const SizedBox(height: 12),
          Expanded(
            child: EditorScrollView(
              builder: (scroll) => ListView(
                controller: scroll,
                physics: const BouncingScrollPhysics(),
                children: children,
              ),
            ),
          ),
          if (status.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 10),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: status,
              ),
            ),
          const SizedBox(height: 10),
          SizedBox(
            height: 50,
            child: _PrimaryButton(
              onTap: needsDevelop
                  ? develop
                  : ready
                  ? share
                  : null,
              busy: !needsDevelop && busy,
              busyLabel: busyLabel,
              label: needsDevelop
                  ? 'Develop'
                  : '${p.lut ? 'Save' : 'Save to Photos'}${size.isEmpty ? '' : ' · $size'}',
            ),
          ),
        ],
      );
    },
  );
}

/// One Thought Line step: tick when done, pulsing while active.
class _Step extends StatelessWidget {
  const _Step({required this.text, required this.done, required this.active});
  final String text;
  final bool done, active;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 2),
    child: Row(
      children: [
        SizedBox(
          width: 16,
          child: done
              ? const Glyph('check', size: 14, color: Color(0xff30d158))
              : active
              ? const SizedBox(
                  width: 10,
                  height: 10,
                  child: CircularProgressIndicator(strokeWidth: 1.5),
                )
              : const SizedBox.shrink(),
        ),
        const SizedBox(width: 6),
        Expanded(
          child: Text(
            text,
            style: TextStyle(
              fontSize: 13,
              color: active
                  ? Theme.of(context).colorScheme.onSurface
                  : secondary,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
        ),
      ],
    ),
  );
}

/// Large prominent capsule: label, or spinner + phase + elapsed timer.
class _PrimaryButton extends StatefulWidget {
  const _PrimaryButton({
    required this.onTap,
    required this.busy,
    required this.busyLabel,
    required this.label,
  });
  final VoidCallback? onTap;
  final bool busy;
  final String busyLabel, label;
  @override
  State<_PrimaryButton> createState() => _PrimaryButtonState();
}

class _PrimaryButtonState extends State<_PrimaryButton> {
  Timer? _timer;
  final _watch = Stopwatch();

  @override
  void initState() {
    super.initState();
    _sync();
  }

  @override
  void didUpdateWidget(_PrimaryButton old) {
    super.didUpdateWidget(old);
    if (old.busy != widget.busy) _sync();
  }

  void _sync() {
    _timer?.cancel();
    if (widget.busy) {
      _watch
        ..reset()
        ..start();
      _timer = Timer.periodic(
        const Duration(milliseconds: 100),
        (_) => setState(() {}),
      );
    } else {
      _watch.stop();
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  /// "0.0s", "1m 3.0s" (web `formatElapsed`).
  String get elapsed {
    final ds = _watch.elapsedMilliseconds ~/ 100;
    final s = ds / 10;
    if (s < 60) return '${s.toStringAsFixed(1)}s';
    final m = s ~/ 60;
    return '${m}m ${(s - m * 60).toStringAsFixed(1)}s';
  }

  @override
  Widget build(BuildContext context) {
    final label = widget.busy ? widget.busyLabel : widget.label;
    if (useNativeControls && !widget.busy) {
      return NativeButton(
        label: label,
        title: label,
        style: 'prominent',
        onTap: widget.onTap,
      );
    }
    return Opacity(
      opacity: widget.onTap == null && !widget.busy ? .5 : 1,
      child: Material(
        color: const Color(0xb30070e0),
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: widget.busy ? null : widget.onTap,
          child: Center(
            child: widget.busy
                ? Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      const SizedBox(
                        width: 16,
                        height: 16,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        label,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 17,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      const SizedBox(width: 8),
                      Text(
                        elapsed,
                        style: const TextStyle(
                          color: Color(0xb3ffffff),
                          fontSize: 15,
                          fontFeatures: [FontFeature.tabularFigures()],
                        ),
                      ),
                    ],
                  )
                : Text(
                    label,
                    semanticsLabel: label,
                    style: const TextStyle(
                      color: Colors.white,
                      fontSize: 17,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
          ),
        ),
      ),
    );
  }
}
