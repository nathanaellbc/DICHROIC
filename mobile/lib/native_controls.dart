import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Real UIKit controls (exposure_engine `NativeControls.swift`): built with the
/// iOS 26 SDK they are the system's Liquid Glass slider, switch, glass buttons,
/// pull-down menus and segmented control, with native gestures, haptics and
/// animations. Elsewhere (host tests, other platforms) and with
/// `--dart-define=DICHROIC_FLUTTER_CONTROLS=true`, the Flutter drawings in
/// `editor_widgets.dart` are used instead.
/// Tests force either path (the native one with a mocked platform-view channel).
@visibleForTesting
bool? debugNativeControlsOverride;

bool get useNativeControls =>
    debugNativeControlsOverride ??
    !kIsWeb &&
        Platform.isIOS &&
        !const bool.fromEnvironment('DICHROIC_FLUTTER_CONTROLS');

/// Lucide glyph names (assets/icons) -> SF Symbols, so native controls use
/// the system's own symbol set. Unknown names fall back to a circle natively.
const sfSymbols = <String, String>{
  'aperture': 'camera.aperture',
  'auto': 'a.circle',
  'blacks': 'circle.fill',
  'blades': 'hexagon',
  'camera': 'camera',
  'catEye': 'eye',
  'check': 'checkmark',
  'chevronDown': 'chevron.down',
  'chevronRight': 'chevron.right',
  'close': 'xmark',
  'compare': 'rectangle.split.2x1',
  'contrast': 'circle.lefthalf.filled',
  'couplers': 'circle.hexagongrid',
  'curvature': 'circle.dashed',
  'decode': 'function',
  'diffusion': 'camera.filters',
  'dot': 'circle.fill',
  'edge': 'square.split.diagonal',
  'enlargerFilter': 'lamp.ceiling',
  'erase': 'eraser',
  'exposure': 'sun.max',
  'flash': 'bolt',
  'focalLength': 'plus.magnifyingglass',
  'focus': 'viewfinder',
  'foreground': 'square.on.square',
  'format': 'film',
  'glare': 'sparkles',
  'grain': 'circle.grid.3x3.fill',
  'halation': 'sun.haze',
  'hdr': 'camera.metering.matrix',
  'highlights': 'sun.max.fill',
  'info': 'info.circle',
  'input': 'arrow.right.to.line',
  'layers': 'square.3.layers.3d',
  'lens': 'camera.aperture',
  'loader': 'hourglass',
  'lock': 'lock',
  'minus': 'minus',
  'more': 'ellipsis',
  'move': 'arrow.up.and.down.and.arrow.left.and.right',
  'nearSharp': 'arrow.forward.to.line',
  'negative': 'circle.righthalf.filled',
  'open': 'folder',
  'output': 'arrow.right.square',
  'photo': 'photo',
  'plus': 'plus',
  'print': 'printer',
  'process': 'arrow.left.arrow.right',
  'pushPull': 'arrow.up.arrow.down',
  'redo': 'arrow.uturn.forward',
  'reset': 'arrow.counterclockwise',
  'saturation': 'drop.halffull',
  'scope': 'scope',
  'search': 'magnifyingglass',
  'seed': 'dice',
  'shadows': 'moon',
  'share': 'square.and.arrow.up',
  'sharpen': 'triangle',
  'shuffle': 'shuffle',
  'spread': 'dot.radiowaves.left.and.right',
  'temperature': 'thermometer.medium',
  'tint': 'drop',
  'undo': 'arrow.uturn.backward',
  'upDown': 'chevron.up.chevron.down',
  'warning': 'exclamationmark.triangle',
  'whites': 'circle',
};

String sfSymbol(String glyph) => sfSymbols[glyph] ?? glyph;

/// One item of a native pull-down menu. Items with the same [section] are
/// shown together as an inline section.
class NativeMenuItem {
  const NativeMenuItem({
    required this.id,
    required this.title,
    this.subtitle,
    this.symbol,
    this.section,
    this.enabled = true,
    this.destructive = false,
    this.checked = false,
  });
  final String id, title;
  final String? subtitle, symbol, section;
  final bool enabled, destructive, checked;
  Map<String, Object?> toMap() => {
    'id': id,
    'title': title,
    'subtitle': ?subtitle,
    'symbol': ?symbol,
    'section': ?section,
    'enabled': enabled,
    'destructive': destructive,
    'checked': checked,
  };
}

bool _deepEquals(Object? a, Object? b) {
  if (a is Map && b is Map) {
    if (a.length != b.length) return false;
    for (final key in a.keys) {
      if (!b.containsKey(key) || !_deepEquals(a[key], b[key])) return false;
    }
    return true;
  }
  if (a is List && b is List) {
    if (a.length != b.length) return false;
    for (var i = 0; i < a.length; i += 1) {
      if (!_deepEquals(a[i], b[i])) return false;
    }
    return true;
  }
  return a == b;
}

/// A UIKit platform view with its own channel: parameters go down as
/// `update`, user actions come back as method calls.
class _PlatformControl extends StatefulWidget {
  const _PlatformControl({
    required this.viewType,
    required this.params,
    required this.onEvent,
    this.horizontalDrags = false,
    this.eager = false,
  });
  final String viewType;
  final Map<String, Object?> params;
  final void Function(String method, Object? value) onEvent;

  /// Claim horizontal drags (sliders, the tool strip) so an enclosing
  /// Flutter scroller or sheet does not steal them.
  final bool horizontalDrags;

  /// Take every touch at once (sliders, switches, steppers, segments): no
  /// arena delay before the native control reacts.
  final bool eager;
  @override
  State<_PlatformControl> createState() => _PlatformControlState();
}

class _PlatformControlState extends State<_PlatformControl> {
  MethodChannel? channel;
  Map<String, Object?>? sent;

  @override
  void didUpdateWidget(_PlatformControl old) {
    super.didUpdateWidget(old);
    final channel = this.channel;
    if (channel != null && !_deepEquals(sent, widget.params)) {
      sent = widget.params;
      channel.invokeMethod<void>('update', widget.params);
    }
  }

  @override
  void dispose() {
    channel?.setMethodCallHandler(null);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => UiKitView(
    viewType: widget.viewType,
    layoutDirection: TextDirection.ltr,
    creationParams: widget.params,
    creationParamsCodec: const StandardMessageCodec(),
    gestureRecognizers: widget.eager
        ? {Factory<EagerGestureRecognizer>(EagerGestureRecognizer.new)}
        : widget.horizontalDrags
        ? {
            Factory<HorizontalDragGestureRecognizer>(
              HorizontalDragGestureRecognizer.new,
            ),
          }
        : const <Factory<OneSequenceGestureRecognizer>>{},
    onPlatformViewCreated: (id) {
      sent = widget.params;
      channel = MethodChannel('dichroic/control/$id')
        ..setMethodCallHandler((call) async {
          if (mounted) widget.onEvent(call.method, call.arguments);
        });
      // Parameters may have changed between creation and this callback.
      if (!_deepEquals(sent, widget.params)) {
        sent = widget.params;
        channel!.invokeMethod<void>('update', widget.params);
      }
    },
  );
}

/// `UISlider`. Values are raw; the caller snaps them to its step.
class NativeSlider extends StatelessWidget {
  const NativeSlider({
    super.key,
    required this.value,
    required this.min,
    required this.max,
    required this.label,
    required this.onChanged,
    this.onStart,
    this.onEnd,
    this.onReset,
    this.enabled = true,
  });
  final double value, min, max;
  final String label;
  final ValueChanged<double> onChanged;
  final VoidCallback? onStart, onEnd;

  /// Double-tap on the slider: restore the default (web double-click).
  final VoidCallback? onReset;
  final bool enabled;
  @override
  Widget build(BuildContext context) => SizedBox(
    height: 44,
    child: _PlatformControl(
      viewType: 'dichroic/slider',
      eager: true,
      params: {
        'value': value,
        'min': min,
        'max': max,
        'enabled': enabled,
        'label': label,
      },
      onEvent: (method, v) {
        switch (method) {
          case 'start':
            onStart?.call();
          case 'change':
            onChanged((v as num).toDouble());
          case 'end':
            onEnd?.call();
          case 'reset':
            onReset?.call();
        }
      },
    ),
  );
}

/// `UISwitch`.
class NativeSwitch extends StatelessWidget {
  const NativeSwitch({
    super.key,
    required this.value,
    required this.onChanged,
    required this.label,
  });
  final bool value;
  final ValueChanged<bool>? onChanged;
  final String label;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: 63,
    height: 44,
    child: _PlatformControl(
      viewType: 'dichroic/switch',
      eager: true,
      params: {'value': value, 'enabled': onChanged != null, 'label': label},
      onEvent: (method, v) {
        if (method == 'change') onChanged?.call(v as bool);
      },
    ),
  );
}

/// `UIButton` with the iOS 26 glass configurations (`glass`, `prominent`,
/// `clear`, `plain`). With [menu] it opens a native pull-down menu instead
/// of calling [onTap].
class NativeButton extends StatelessWidget {
  const NativeButton({
    super.key,
    required this.label,
    this.symbol,
    this.title,
    this.subtitle,
    this.style = 'glass',
    this.selected = false,
    this.onTap,
    this.menu,
    this.onMenu,
    this.symbolSize = 17,
    this.fontSize = 15,
    this.imageTrailing = false,
    this.leadingAligned = false,
    this.width,
    this.height = 44,
  });
  final String label;
  final String? symbol, title, subtitle;
  final String style;
  final bool selected, imageTrailing, leadingAligned;
  final VoidCallback? onTap;
  final List<NativeMenuItem>? menu;
  final ValueChanged<String>? onMenu;
  final double symbolSize, fontSize;

  /// Fixed size; `null` width fills the incoming (bounded) width.
  final double? width;
  final double height;

  bool get enabled => menu != null ? onMenu != null : onTap != null;

  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    child: Tooltip(
      message: label,
      excludeFromSemantics: true,
      child: SizedBox(
        width: width,
        height: height,
        child: _PlatformControl(
          viewType: 'dichroic/button',
          params: {
            'label': label,
            'symbol': ?symbol,
            'title': ?title,
            'subtitle': ?subtitle,
            'style': style,
            'selected': selected,
            'enabled': enabled,
            'symbolSize': symbolSize,
            'fontSize': fontSize,
            'imagePlacement': imageTrailing ? 'trailing' : 'leading',
            'leadingAligned': leadingAligned,
            'menu': ?menu?.map((m) => m.toMap()).toList(),
          },
          onEvent: (method, v) {
            if (method == 'tap') onTap?.call();
            if (method == 'menu') onMenu?.call(v as String);
          },
        ),
      ),
    ),
  );
}

/// `UISegmentedControl` with text segments.
class NativeSegmented extends StatelessWidget {
  const NativeSegmented({
    super.key,
    required this.items,
    required this.selected,
    required this.onChanged,
    this.enabled = true,
    this.height = 36,
    this.symbols = const [],
    this.marked = const [],
  });
  final List<String> items;

  /// SF Symbols per segment (icon tabs); [items] become their labels.
  final List<String> symbols;

  /// Segments with the blue "edited" dot.
  final List<int> marked;
  final int selected;
  final ValueChanged<int> onChanged;
  final bool enabled;
  final double height;
  @override
  Widget build(BuildContext context) => SizedBox(
    height: height,
    child: _PlatformControl(
      viewType: 'dichroic/segmented',
      eager: true,
      params: {
        'items': items,
        'symbols': symbols,
        'marked': marked,
        'selected': selected,
        'enabled': enabled,
      },
      onEvent: (method, v) {
        if (method == 'change') onChanged(v as int);
      },
    ),
  );
}

/// `UIStepper` reporting -1 / +1; the caller owns the value.
class NativeStepper extends StatelessWidget {
  const NativeStepper({
    super.key,
    required this.label,
    required this.onStep,
    this.canDecrement = true,
    this.canIncrement = true,
    this.enabled = true,
  });
  final String label;
  final ValueChanged<int> onStep;
  final bool canDecrement, canIncrement, enabled;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: 110,
    height: 44,
    child: _PlatformControl(
      viewType: 'dichroic/stepper',
      eager: true,
      params: {
        'label': label,
        'enabled': enabled,
        'canDecrement': canDecrement,
        'canIncrement': canIncrement,
      },
      onEvent: (method, v) {
        if (method == 'step') onStep(v as int);
      },
    ),
  );
}

/// One tool in [NativeToolStrip].
class NativeTool {
  const NativeTool({
    required this.id,
    required this.title,
    required this.label,
    required this.glyph,
    this.modified = false,
    this.dimmed = false,
    this.locked = false,
  });
  final String id, title, label, glyph;
  final bool modified, dimmed, locked;
  Map<String, Object?> toMap() => {
    'id': id,
    'title': title,
    'label': label,
    'symbol': sfSymbol(glyph),
    'modified': modified,
    'dimmed': dimmed,
    'locked': locked,
  };
}

/// The tool row as ONE native horizontal scroller of icon buttons: native
/// scroll physics, and no platform view per tool.
class NativeToolStrip extends StatelessWidget {
  const NativeToolStrip({
    super.key,
    required this.tools,
    required this.selected,
    required this.onSelect,
    this.height = 76,
  });
  final List<NativeTool> tools;
  final String? selected;
  final ValueChanged<String> onSelect;
  final double height;
  @override
  Widget build(BuildContext context) => SizedBox(
    height: height,
    child: _PlatformControl(
      viewType: 'dichroic/toolstrip',
      horizontalDrags: true,
      params: {
        'items': tools.map((t) => t.toMap()).toList(),
        'selected': ?selected,
      },
      onEvent: (method, v) {
        if (method == 'select') onSelect(v as String);
      },
    ),
  );
}

/// Liquid Glass background (`UIGlassEffect`; a system material before
/// iOS 26). Native glass also refracts the native photo view underneath,
/// which Flutter's BackdropFilter cannot sample.
class NativeGlassBackground extends StatelessWidget {
  const NativeGlassBackground({
    super.key,
    required this.radius,
    this.topOnly = false,
  });
  final double radius;
  final bool topOnly;
  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: _PlatformControl(
      viewType: 'dichroic/glass',
      params: {'radius': radius, 'topOnly': topOnly},
      onEvent: (_, _) {},
    ),
  );
}
