import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui' as ui;
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/material.dart';

/// Scope settings, as the web `ScopePrefs` (src/ui/model/vectorscope.ts),
/// kept per device class. The traces come from the same web scope code in
/// the canonical host; this file draws them and the graticules.
class ScopePrefs extends ChangeNotifier {
  ScopePrefs(this.layout);
  final String layout;
  Map<String, dynamic> values = Map.of(defaults);

  static const defaults = <String, dynamic>{
    'open': false,
    'kind': 'vectorscope',
    'zoom': 1,
    'skinTone': true,
    'colorize': true,
    'targets': 75,
    'range': 'all',
    'style': 'standard',
    'waveMode': 'rgb',
    'waveChannels': [true, true, true],
    'paradeMode': 'rgb',
    'waveColorize': true,
    'lowPass': false,
    'extents': false,
  };

  static const kinds = [
    ('waveform', 'Waveform', 'Wave'),
    ('parade', 'Parade', 'Parade'),
    ('vectorscope', 'Vectorscope', 'Vector'),
  ];

  dynamic operator [](String key) => values[key];
  bool get open => values['open'] == true;
  String get kind => values['kind'] as String;

  Future<void> load(ExposureEngine engine) async {
    try {
      final text = await engine.loadScopePreferences(layout);
      if (text == null) return;
      final stored = jsonDecode(text) as Map<String, dynamic>;
      values = {
        ...defaults,
        for (final e in stored.entries)
          if (defaults.containsKey(e.key)) e.key: e.value,
      };
      notifyListeners();
    } catch (_) {
      // Damaged or missing preferences: the defaults.
    }
  }

  void update(ExposureEngine engine, Map<String, dynamic> patch) {
    values = {...values, ...patch};
    notifyListeners();
    engine
        .saveScopePreferences(layout, jsonEncode(values))
        .catchError((Object _) {});
  }
}

/// Rec.709 Cb/Cr of an RGB colour (web `toCbCr`).
(double, double) _cbcr(double r, double g, double b) {
  final y = .2126 * r + .7152 * g + .0722 * b;
  return ((b - y) / (2 * (1 - .0722)), (r - y) / (2 * (1 - .2126)));
}

const _targets = [
  ('R', [1.0, 0.0, 0.0], Color(0xffff453a)),
  ('Mg', [1.0, 0.0, 1.0], Color(0xffff4fd8)),
  ('B', [0.0, 0.0, 1.0], Color(0xff4d7dff)),
  ('Cy', [0.0, 1.0, 1.0], Color(0xff3ee0ff)),
  ('G', [0.0, 1.0, 0.0], Color(0xff3ddc63)),
  ('Yl', [1.0, 1.0, 0.0], Color(0xffffd23a)),
];

/// One scope (waveform, parade or vectorscope) of the current preview.
/// [frame] changes whenever a new preview is displayed.
class ScopeView extends StatefulWidget {
  const ScopeView({
    super.key,
    required this.engine,
    required this.prefs,
    required this.frame,
    required this.width,
    required this.height,
    this.labels = true,
    this.onToggleZoom,
  });
  final ExposureEngine engine;
  final Map<String, dynamic> prefs;
  final int frame;
  final double width, height;

  /// The 10-bit scale and lane labels (off in the phone overlay).
  final bool labels;
  final VoidCallback? onToggleZoom;
  @override
  State<ScopeView> createState() => _ScopeViewState();
}

class _ScopeViewState extends State<ScopeView> {
  ui.Image? trace;
  String? _key;
  int _ticket = 0;

  static const gutter = 28.0, pad = 4.0;

  bool get vector => widget.prefs['kind'] == 'vectorscope';
  double get plotWidth =>
      math.max(32, widget.width - (widget.labels && !vector ? gutter : 0));
  double get plotHeight => math.max(32, widget.height - pad * 2);

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _fetch();
  }

  @override
  void didUpdateWidget(ScopeView old) {
    super.didUpdateWidget(old);
    _fetch();
  }

  @override
  void dispose() {
    trace?.dispose();
    super.dispose();
  }

  Future<void> _fetch() async {
    final dpr = math.min(2.0, MediaQuery.devicePixelRatioOf(context));
    final w = ((vector ? widget.width : plotWidth) * dpr).round();
    final h = ((vector ? widget.width : plotHeight) * dpr).round();
    final key = '${widget.frame}|${jsonEncode(widget.prefs)}|$w|$h';
    if (key == _key) return;
    _key = key;
    final ticket = ++_ticket;
    try {
      final result = await widget.engine.scope(widget.prefs, w, h);
      if (result == null || !mounted || ticket != _ticket) return;
      ui.decodeImageFromPixels(
        result.rgba,
        result.width,
        result.height,
        ui.PixelFormat.rgba8888,
        (image) {
          if (!mounted || ticket != _ticket) {
            image.dispose();
            return;
          }
          setState(() {
            trace?.dispose();
            trace = image;
          });
        },
      );
    } catch (_) {
      // No frame yet, or no native host (tests): an empty scope.
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.prefs;
    if (vector) {
      return GestureDetector(
        onDoubleTap: widget.onToggleZoom,
        child: Semantics(
          image: true,
          label:
              'Vectorscope, Rec.709, ${p['range'] == 'all' ? 'all levels' : '${p['range']} levels'}, ${p['targets']}% targets${p['zoom'] == 2 ? ', 2x zoom' : ''}${p['skinTone'] == true ? ', skin tone line' : ''}',
          child: CustomPaint(
            size: Size.square(widget.width),
            painter: _VectorPainter(trace, p),
          ),
        ),
      );
    }
    final parade = p['kind'] == 'parade';
    final channels = parade
        ? const {
            'rgb': ['r', 'g', 'b'],
            'yrgb': ['y', 'r', 'g', 'b'],
            'ycbcr': ['y', 'cb', 'cr'],
          }[p['paradeMode']]!
        : p['waveMode'] == 'y'
        ? const ['y']
        : p['waveMode'] == 'cbcr'
        ? const ['cb', 'cr']
        : [
            for (var i = 0; i < 3; i++)
              if ((p['waveChannels'] as List)[i] != false) 'rgb'[i],
          ];
    const names = {
      'y': 'Y',
      'r': 'R',
      'g': 'G',
      'b': 'B',
      'cb': 'Cb',
      'cr': 'Cr',
    };
    return Semantics(
      image: true,
      label:
          '${parade ? 'Parade' : 'Waveform'} ${channels.map((c) => names[c]).join()}, Rec.709, 10-bit scale',
      child: ClipRRect(
        borderRadius: BorderRadius.circular(widget.labels ? 8 : 14),
        child: ColoredBox(
          color: const Color(0xff0b0b0c),
          child: CustomPaint(
            size: Size(widget.width, widget.height),
            painter: _WavePainter(
              trace,
              gutter: widget.labels ? gutter : 0,
              pad: pad,
              plot: Size(plotWidth, plotHeight),
              parade: parade,
              channels: channels,
              colorize: p['waveColorize'] == true,
              labels: widget.labels,
            ),
          ),
        ),
      ),
    );
  }
}

class _WavePainter extends CustomPainter {
  _WavePainter(
    this.trace, {
    required this.gutter,
    required this.pad,
    required this.plot,
    required this.parade,
    required this.channels,
    required this.colorize,
    required this.labels,
  });
  final ui.Image? trace;
  final double gutter, pad;
  final Size plot;
  final bool parade, colorize, labels;
  final List<String> channels;

  static const laneColors = {
    'y': Color(0xffe8e8ea),
    'r': Color(0xffff5a50),
    'g': Color(0xff4be06a),
    'b': Color(0xff6f8dff),
    'cb': Color(0xff7f9dff),
    'cr': Color(0xffff7a8a),
  };

  void _text(
    Canvas canvas,
    String text,
    Offset at,
    Color color, {
    bool right = false,
    FontWeight weight = FontWeight.w400,
  }) {
    final painter = TextPainter(
      text: TextSpan(
        text: text,
        style: TextStyle(
          fontSize: 9,
          color: color,
          fontWeight: weight,
          fontFeatures: const [FontFeature.tabularFigures()],
        ),
      ),
      textDirection: TextDirection.ltr,
    )..layout();
    painter.paint(
      canvas,
      Offset(right ? at.dx - painter.width : at.dx, at.dy - painter.height + 2),
    );
  }

  @override
  void paint(Canvas canvas, Size size) {
    final image = trace;
    if (image != null) {
      paintImage(
        canvas: canvas,
        rect: Rect.fromLTWH(gutter, pad, plot.width, plot.height),
        image: image,
        fit: BoxFit.fill,
        filterQuality: FilterQuality.medium,
      );
    }
    double y(int code) => pad + (1 - code / 1023) * (plot.height - 1) + .5;
    for (final code in const [0, 128, 256, 384, 512, 640, 768, 896, 1023]) {
      final edge = code == 0 || code == 1023;
      canvas.drawLine(
        Offset(gutter, y(code)),
        Offset(size.width, y(code)),
        Paint()
          ..color = Color.fromRGBO(255, 255, 255, edge ? .3 : .13)
          ..strokeWidth = 1,
      );
      if (labels && (code % 256 == 0 || code == 1023)) {
        _text(
          canvas,
          '$code',
          Offset(gutter - 4, y(code) + 3),
          const Color(0x80ffffff),
          right: true,
        );
      }
    }
    if (!parade) return;
    // Lanes as `laneBox` in src/ui/model/waveform.ts.
    final count = channels.length;
    final gap = math.max(2, (plot.width * .012).round()).toDouble();
    final lane = ((plot.width - (count - 1) * gap) / count).floorToDouble();
    for (var i = 0; i < count; i++) {
      final x = i * (lane + gap);
      if (i > 0) {
        final line = gutter + x - gap / 2;
        canvas.drawLine(
          Offset(line, pad),
          Offset(line, pad + plot.height),
          Paint()
            ..color = const Color(0x2effffff)
            ..strokeWidth = 1,
        );
      }
      if (labels) {
        _text(
          canvas,
          const {
            'y': 'Y',
            'r': 'R',
            'g': 'G',
            'b': 'B',
            'cb': 'Cb',
            'cr': 'Cr',
          }[channels[i]]!,
          Offset(gutter + x + 4, pad + 10),
          colorize ? laneColors[channels[i]]! : const Color(0x99ffffff),
          weight: FontWeight.w700,
        );
      }
    }
  }

  @override
  bool shouldRepaint(_WavePainter old) => true;
}

class _VectorPainter extends CustomPainter {
  _VectorPainter(this.trace, this.prefs);
  final ui.Image? trace;
  final Map<String, dynamic> prefs;

  @override
  void paint(Canvas canvas, Size size) {
    final image = trace;
    canvas.drawRRect(
      RRect.fromRectAndRadius(Offset.zero & size, const Radius.circular(8)),
      Paint()..color = const Color(0xff0b0b0c),
    );
    if (image != null) {
      paintImage(
        canvas: canvas,
        rect: Offset.zero & size,
        image: image,
        fit: BoxFit.fill,
        filterQuality: FilterQuality.medium,
      );
    }
    // The web graticule is a 100 x 100 viewBox.
    final k = size.width / 100;
    canvas.save();
    canvas.scale(k);
    const c = 50.0, r = 50 * .8;
    final zoom = (prefs['zoom'] as num).toDouble();
    final scale = r * zoom / .5;
    final style = prefs['style'] as String;
    Paint line(Color color, double width) => Paint()
      ..color = color
      ..strokeWidth = width
      ..style = PaintingStyle.stroke;
    if (style != 'off') {
      canvas.drawCircle(
        const Offset(c, c),
        r,
        line(const Color(0x52ffffff), .5),
      );
    }
    if (style == 'standard') {
      for (var deg = 0; deg < 360; deg += 10) {
        final a = deg * math.pi / 180, long = deg % 30 == 0;
        final r0 = r - (long ? 2.2 : 1.2);
        canvas.drawLine(
          Offset(c + math.cos(a) * r0, c - math.sin(a) * r0),
          Offset(c + math.cos(a) * r, c - math.sin(a) * r),
          line(const Color(0x52ffffff), .4),
        );
      }
    }
    if (style == 'standard' || style == 'simplified') {
      final axis = line(const Color(0x24ffffff), .35);
      canvas.drawLine(const Offset(c - r, c), const Offset(c + r, c), axis);
      canvas.drawLine(const Offset(c, c - r), const Offset(c, c + r), axis);
    }
    canvas.clipRect(const Rect.fromLTWH(0, 0, 100, 100));
    void label(
      String text,
      Offset at,
      Color color, {
      TextAlign align = TextAlign.center,
    }) {
      final painter = TextPainter(
        text: TextSpan(
          text: text,
          style: TextStyle(
            fontSize: 4.2,
            fontWeight: FontWeight.w600,
            color: color.withValues(alpha: .9),
          ),
        ),
        textDirection: TextDirection.ltr,
      )..layout();
      final dx = switch (align) {
        TextAlign.center => -painter.width / 2,
        TextAlign.end => -painter.width,
        _ => 0.0,
      };
      painter.paint(canvas, at + Offset(dx, -painter.height + 1));
    }

    if (style == 'hueVectors') {
      for (final (name, rgb, color) in _targets) {
        final (cb, cr) = _cbcr(rgb[0], rgb[1], rgb[2]);
        final a = math.atan2(cr, cb);
        canvas.drawLine(
          const Offset(c, c),
          Offset(c + math.cos(a) * r, c - math.sin(a) * r),
          line(color.withValues(alpha: .5), .4),
        );
        label(
          name,
          Offset(
            c + math.cos(a) * (r + 4.5),
            c - math.sin(a) * (r + 4.5) + 1.5,
          ),
          color,
        );
      }
    }
    if (prefs['skinTone'] == true) {
      const skin = 123 * math.pi / 180;
      canvas.drawLine(
        const Offset(c, c),
        Offset(c + math.cos(skin) * r * 1.05, c - math.sin(skin) * r * 1.05),
        line(const Color(0xd9ffc496), .55),
      );
    }
    if (style == 'standard' || style == 'simplified') {
      final level = prefs['targets'] == 75 ? .75 : 1.0;
      final box = .03 * scale;
      for (final (name, rgb, color) in _targets) {
        final (cb, cr) = _cbcr(rgb[0] * level, rgb[1] * level, rgb[2] * level);
        final x = c + cb * scale, y = c - cr * scale;
        if (style == 'simplified') {
          canvas.drawCircle(
            Offset(x, y),
            .9,
            Paint()..color = color.withValues(alpha: .85),
          );
          continue;
        }
        canvas.drawRect(
          Rect.fromLTWH(x - box, y - box, box * 2, box * 2),
          line(color.withValues(alpha: .9), .5),
        );
        label(
          name,
          Offset(
            x + (cb >= 0 ? box + 1.2 : -box - 1.2),
            y + (cr >= 0 ? -box - .6 : box + 3.2),
          ),
          color,
          align: cb >= 0 ? TextAlign.start : TextAlign.end,
        );
      }
    }
    canvas.drawCircle(
      const Offset(c, c),
      .5,
      Paint()..color = const Color(0x80ffffff),
    );
    canvas.restore();
  }

  @override
  bool shouldRepaint(_VectorPainter old) => true;
}

/// Phone overlay (web `.scope-overlay`): tap cycles Waveform → Parade →
/// Vectorscope; badges show the kind and the 2× zoom.
class ScopeOverlay extends StatelessWidget {
  const ScopeOverlay({
    super.key,
    required this.engine,
    required this.prefs,
    required this.frame,
    required this.landscape,
  });
  final ExposureEngine engine;
  final ScopePrefs prefs;
  final int frame;
  final bool landscape;
  @override
  Widget build(BuildContext context) {
    final kinds = ScopePrefs.kinds;
    final index = kinds.indexWhere((k) => k.$1 == prefs.kind);
    final kind = kinds[index < 0 ? 2 : index];
    final next = kinds[(kinds.indexOf(kind) + 1) % kinds.length];
    final vector = prefs.kind == 'vectorscope';
    const badge = TextStyle(
      fontSize: 10,
      fontWeight: FontWeight.w700,
      color: Color(0xb8ffffff),
      shadows: [Shadow(blurRadius: 3)],
    );
    return Semantics(
      button: true,
      label: '${kind.$2}. Show ${next.$2}',
      child: GestureDetector(
        onTap: () => prefs.update(engine, {'kind': next.$1}),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(22),
          child: BackdropFilter(
            filter: ui.ImageFilter.blur(sigmaX: 14, sigmaY: 14),
            child: Container(
              padding: const EdgeInsets.all(6),
              decoration: BoxDecoration(
                color: const Color(0xb80a0a0c),
                borderRadius: BorderRadius.circular(22),
                border: Border.all(color: const Color(0x24ffffff), width: .5),
              ),
              child: Stack(
                children: [
                  ScopeView(
                    engine: engine,
                    prefs: prefs.values,
                    frame: frame,
                    width: vector
                        ? (landscape ? 116 : 132)
                        : (landscape ? 176 : 200),
                    height: vector
                        ? (landscape ? 116 : 132)
                        : (landscape ? 100 : 112),
                    labels: false,
                  ),
                  if (vector && prefs['zoom'] == 2)
                    const Positioned(
                      left: 8,
                      bottom: 6,
                      child: Text('2×', style: badge),
                    ),
                  Positioned(
                    right: 10,
                    bottom: 6,
                    child: Text(kind.$3, style: badge),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Inspector scope panel (web `ScopePanel`): kind tabs, the options of each
/// kind as chips, and the scope at the inspector's width.
class ScopePanel extends StatelessWidget {
  const ScopePanel({
    super.key,
    required this.engine,
    required this.prefs,
    required this.frame,
    required this.window,
  });
  final ExposureEngine engine;
  final ScopePrefs prefs;
  final int frame;
  final Size window;

  Widget _chip(String label, bool pressed, VoidCallback onTap, [String? tip]) =>
      Tooltip(
        message: tip ?? label,
        child: Semantics(
          button: true,
          toggled: pressed,
          child: GestureDetector(
            onTap: onTap,
            child: Container(
              height: 20,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: pressed
                    ? const Color(0x8c0091ff)
                    : const Color(0x12ffffff),
                borderRadius: BorderRadius.circular(6),
              ),
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w600,
                  color: pressed ? Colors.white : const Color(0xffaaaab3),
                ),
              ),
            ),
          ),
        ),
      );

  Widget _choice(
    List<(String, String)> items,
    String value,
    ValueChanged<String> onPick,
  ) => Container(
    padding: const EdgeInsets.all(2),
    decoration: BoxDecoration(
      color: const Color(0x0fffffff),
      borderRadius: BorderRadius.circular(7),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final (v, label) in items)
          GestureDetector(
            onTap: () => onPick(v),
            child: Container(
              height: 20,
              padding: const EdgeInsets.symmetric(horizontal: 7),
              alignment: Alignment.center,
              decoration: BoxDecoration(
                color: v == value
                    ? const Color(0x29ffffff)
                    : Colors.transparent,
                borderRadius: BorderRadius.circular(5),
              ),
              child: Text(
                label,
                style: TextStyle(
                  fontSize: 10.5,
                  fontWeight: FontWeight.w600,
                  color: v == value ? Colors.white : const Color(0xffaaaab3),
                ),
              ),
            ),
          ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    void set(Map<String, dynamic> patch) => prefs.update(engine, patch);
    final p = prefs.values, kind = prefs.kind;
    final options = <Widget>[];
    final second = <Widget>[];
    if (kind == 'waveform') {
      options.add(
        _choice(
          const [('y', 'Y'), ('rgb', 'RGB'), ('cbcr', 'CbCr')],
          p['waveMode'] as String,
          (v) => set({'waveMode': v}),
        ),
      );
      if (p['waveMode'] == 'rgb') {
        final channels = List<bool>.from(p['waveChannels'] as List);
        const names = ['R', 'G', 'B'];
        for (var i = 0; i < 3; i++) {
          options.add(
            _chip(names[i], channels[i], () {
              final next = List<bool>.of(channels)..[i] = !channels[i];
              if (next.any((c) => c)) set({'waveChannels': next});
            }),
          );
        }
      }
    } else if (kind == 'parade') {
      options.add(
        _choice(
          const [('rgb', 'RGB'), ('yrgb', 'YRGB'), ('ycbcr', 'YCbCr')],
          p['paradeMode'] as String,
          (v) => set({'paradeMode': v}),
        ),
      );
    } else {
      options.add(
        _choice(
          const [
            ('all', 'All'),
            ('low', 'Low'),
            ('mid', 'Mid'),
            ('high', 'High'),
          ],
          p['range'] as String,
          (v) => set({'range': v}),
        ),
      );
    }
    if (kind == 'vectorscope') {
      const styles = [
        ('standard', 'Standard'),
        ('simplified', 'Simplified'),
        ('hueVectors', 'Hue Vectors'),
        ('off', 'Off'),
      ];
      final at = styles.indexWhere((s) => s.$1 == p['style']);
      second.addAll([
        _chip(
          styles[at < 0 ? 0 : at].$2,
          true,
          () => set({'style': styles[(at + 1) % styles.length].$1}),
          'Graticule style',
        ),
        _chip(
          '${p['targets']}%',
          true,
          () => set({'targets': p['targets'] == 75 ? 100 : 75}),
          'Color targets at 75% or 100%',
        ),
        _chip(
          '2×',
          p['zoom'] == 2,
          () => set({'zoom': p['zoom'] == 2 ? 1 : 2}),
          'Zoom 2×',
        ),
        _chip(
          'Skin',
          p['skinTone'] == true,
          () => set({'skinTone': p['skinTone'] != true}),
          'Skin tone line',
        ),
        _chip(
          'Colorize',
          p['colorize'] == true,
          () => set({'colorize': p['colorize'] != true}),
          'Colorize: the trace in the colors it shows',
        ),
      ]);
    } else {
      second.addAll([
        _chip(
          'Colorize',
          p['waveColorize'] == true,
          () => set({'waveColorize': p['waveColorize'] != true}),
          'Colorize: R, G, B traces in their colors (off: white)',
        ),
        _chip(
          'Low Pass',
          p['lowPass'] == true,
          () => set({'lowPass': p['lowPass'] != true}),
          'Low pass filter: reduces noise in the trace',
        ),
        _chip(
          'Extents',
          p['extents'] == true,
          () => set({'extents': p['extents'] != true}),
          'Extents: outline the highest and lowest values',
        ),
      ]);
    }
    return LayoutBuilder(
      builder: (context, box) {
        final width = box.maxWidth - 24;
        final vector = kind == 'vectorscope';
        final height = vector
            ? math.max(140.0, math.min(width, window.height * .38))
            : math.min(width * .62, window.height * .3);
        return Container(
          padding: const EdgeInsets.fromLTRB(12, 8, 12, 10),
          decoration: const BoxDecoration(
            color: Color(0xff0b0b0c),
            border: Border(top: BorderSide(color: Color(0x1f8e8e93))),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Flexible(
                    child: FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: _choice(
                        [for (final k in ScopePrefs.kinds) (k.$1, k.$2)],
                        kind,
                        (v) => set({'kind': v}),
                      ),
                    ),
                  ),
                  const SizedBox(width: 6),
                  const Text(
                    'Rec.709',
                    style: TextStyle(fontSize: 10.5, color: Color(0xffaaaab3)),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Wrap(spacing: 4, runSpacing: 4, children: options),
              const SizedBox(height: 6),
              Wrap(spacing: 4, runSpacing: 4, children: second),
              const SizedBox(height: 6),
              Center(
                child: ScopeView(
                  engine: engine,
                  prefs: p,
                  frame: frame,
                  width: vector ? height : width,
                  height: height,
                  onToggleZoom: () => set({'zoom': p['zoom'] == 2 ? 1 : 2}),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
