/// Names and texts shared with the web editor (src/ui/screens/Editor.tsx,
/// Stocks.tsx, share.ts), so the iOS app reads exactly like the website.
library;

import 'native_editor_controller.dart' show Json;

/// Stock lookups over the canonical catalog (`filmSections`/`paperSections`).
class Stocks {
  Stocks(this.catalog, this.params);
  final Json catalog, params;

  Json info(String kind, String? id) {
    for (final section in catalog['${kind}Sections'] as List? ?? const []) {
      for (final stock in section['stocks'] as List) {
        if (stock['id'] == id) return (stock as Map).cast<String, dynamic>();
      }
    }
    return {'id': id, 'short': id ?? '', 'name': id ?? '', 'detail': ''};
  }

  static bool isPrintLut(String? id) => id?.startsWith('lut_') ?? false;

  bool isSlide(String? id) {
    for (final section in catalog['filmSections'] as List? ?? const []) {
      if (section['scanOnly'] != true) continue;
      if ((section['stocks'] as List).any((s) => s['id'] == id)) return true;
    }
    return false;
  }

  bool get filmEnabled => params['filmEnabled'] != false;
  bool get scan =>
      params['process'] == 'scanNegative' &&
      !isPrintLut(params['paper'] as String?);

  String get offOutput => isPrintLut(params['paper'] as String?)
      ? 'on ${info('paper', params['paper'] as String?)['short']}'
      : 'Neutral negative';

  /// Toolbar capsule, first line: film short name or "Film Off".
  String get filmLine => filmEnabled
      ? info('film', params['film'] as String?)['short'] as String
      : 'Film Off';

  /// Toolbar capsule, second line.
  String get paperLine => !filmEnabled
      ? offOutput
      : scan
      ? 'Scanned'
      : 'on ${info('paper', params['paper'] as String?)['short']}';

  /// "Portra 400 → Portra Endura", "Velvia 100, scanned" or "Film Off · …".
  String get recipe {
    if (!filmEnabled) return 'Film Off · $offOutput';
    final film = info('film', params['film'] as String?)['short'];
    return scan
        ? '$film, scanned'
        : '$film → ${info('paper', params['paper'] as String?)['short']}';
  }

  /// Export toast: "Portra 400 on Portra Endura".
  String get exportRecipe {
    if (!filmEnabled) return 'Film Off · $offOutput';
    final film = info('film', params['film'] as String?)['short'];
    return scan
        ? '$film, scanned'
        : '$film on ${info('paper', params['paper'] as String?)['short']}';
  }

  /// `<photo> - <film> on <paper>.<ext>` (or `<film> scan` without paper).
  String fileName(String stem, String ext, {String suffix = ''}) {
    final film = asciiName(
      info('film', params['film'] as String?)['name'] as String,
    );
    final look = scan
        ? '$film scan'
        : '$film on ${asciiName(info('paper', params['paper'] as String?)['name'] as String)}';
    final base = asciiName(stem);
    return '${base.isEmpty ? 'photo' : base} - $look${suffix.isEmpty ? '' : ' $suffix'}.$ext';
  }
}

const _folds = {
  'à': 'a',
  'á': 'a',
  'â': 'a',
  'ã': 'a',
  'ä': 'a',
  'å': 'a',
  'ç': 'c',
  'è': 'e',
  'é': 'e',
  'ê': 'e',
  'ë': 'e',
  'ì': 'i',
  'í': 'i',
  'î': 'i',
  'ï': 'i',
  'ñ': 'n',
  'ò': 'o',
  'ó': 'o',
  'ô': 'o',
  'õ': 'o',
  'ö': 'o',
  'ù': 'u',
  'ú': 'u',
  'û': 'u',
  'ü': 'u',
  'ý': 'y',
  'ÿ': 'y',
};

/// Plain-ASCII file name part, as `asciiName` in src/ui/share.ts.
String asciiName(String value) {
  final folded = value.split('').map((c) {
    final lower = c.toLowerCase();
    final f = _folds[lower];
    if (f == null) return c;
    return c == lower ? f : f.toUpperCase();
  }).join();
  return folded
      .replaceAll(RegExp(r'[^A-Za-z0-9 ._()+-]+'), '-')
      .replaceAll(RegExp(r'-{2,}'), '-')
      .replaceAll(RegExp(r'^[\s.-]+|[\s.-]+$'), '');
}

/// Hint above the stock list (Stocks.tsx), shown while the search is empty.
String stockHint(String kind, {required bool filmEnabled, required bool scan}) {
  if (!filmEnabled && kind == 'paper') {
    return 'Film Off keeps exposure, develop and texture active. Film print LUTs work with this neutral negative; photographic paper requires a film stock.';
  }
  if (kind == 'film') {
    if (!filmEnabled) {
      return 'Film and paper are off. Camera and Lens adjustments remain active.';
    }
    return scan
        ? 'Scanning shows the film itself. Slides come out as positives; color negatives come out orange and inverted.'
        : 'Every negative is printed to a neutral grey, so films differ subtly: in color, contrast and grain. For a bigger change in look, try Paper.';
  }
  return scan
      ? 'Nothing is printed while Process is set to Scan. Set Process to Print above to use paper.'
      : 'The paper sets contrast, color and the depth of the blacks. Cinema print films give the strongest look.';
}

String formatBytes(int n) {
  if (n < 1024) return '$n B';
  if (n < 1024 * 1024) return '${(n / 1024).toStringAsFixed(1)} KB';
  return '${(n / (1024 * 1024)).toStringAsFixed(1)} MB';
}
