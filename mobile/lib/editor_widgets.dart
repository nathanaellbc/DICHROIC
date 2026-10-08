import 'dart:ui';
import 'package:flutter/material.dart';
import 'package:flutter_svg/flutter_svg.dart';
import 'native_controls.dart';

const signalBlue = Color(0xff0091ff);

/// iOS systemGray: the secondary label Apple uses in both light and dark mode.
const secondary = Color(0xff8e8e93);

/// Keep the requested thin 20% white thumb on iOS too. Material's Scrollbar
/// otherwise substitutes a Cupertino thumb and ignores ScrollbarTheme colors.
class EditorScrollView extends StatefulWidget {
  const EditorScrollView({super.key, required this.builder});
  final Widget Function(ScrollController) builder;
  @override
  State<EditorScrollView> createState() => _EditorScrollViewState();
}

class _EditorScrollViewState extends State<EditorScrollView> {
  final controller = ScrollController();
  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => RawScrollbar(
    controller: controller,
    thumbColor: Theme.of(context).colorScheme.onSurface.withValues(alpha: .2),
    thickness: 2,
    radius: const Radius.circular(2),
    child: widget.builder(controller),
  );
}

class Glyph extends StatelessWidget {
  const Glyph(this.name, {super.key, this.size = 22, this.color});
  final String name;
  final double size;

  /// Defaults to the theme's foreground (white in dark mode, black in light).
  final Color? color;
  @override
  Widget build(BuildContext context) => SvgPicture.asset(
    'assets/icons/$name.svg',
    width: size,
    height: size,
    colorFilter: ColorFilter.mode(
      color ?? Theme.of(context).colorScheme.onSurface,
      BlendMode.srcIn,
    ),
  );
}

class Glass extends StatelessWidget {
  const Glass({
    super.key,
    required this.child,
    this.radius = 20,
    this.blur = 20,
    this.padding = EdgeInsets.zero,
  });
  final Widget child;
  final double radius, blur;
  final EdgeInsetsGeometry padding;
  @override
  Widget build(BuildContext context) {
    if (useNativeControls) {
      // Native Liquid Glass behind the Flutter content: it also refracts the
      // native photo view, which BackdropFilter cannot sample.
      return Stack(
        children: [
          Positioned.fill(child: NativeGlassBackground(radius: radius)),
          Material(
            type: MaterialType.transparency,
            child: Padding(padding: padding, child: child),
          ),
        ],
      );
    }
    return _flutterGlass(context);
  }

  Widget _flutterGlass(BuildContext context) => ClipPath(
    clipper: ShapeBorderClipper(
      shape: RoundedSuperellipseBorder(
        borderRadius: BorderRadius.circular(radius),
      ),
    ),
    child: BackdropFilter(
      filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
      // Paint list backgrounds and ink above the glass tint, rather than on
      // the route's Material underneath this surface.
      child: Material(
        color: Theme.of(context).brightness == Brightness.dark
            ? const Color(0x941c1c1e)
            : const Color(0xb8f9f9fb),
        elevation: 0,
        child: Padding(padding: padding, child: child),
      ),
    ),
  );
}

class Press extends StatefulWidget {
  const Press({
    super.key,
    required this.child,
    required this.label,
    this.onTap,
    this.selected = false,
    this.plain = false,
    this.filled = false,
    this.edited = false,
    this.radius = 14,
  });
  final Widget child;
  final String label;
  final VoidCallback? onTap;
  final bool selected, plain, filled;

  /// Web tool chip: a 2 px inset blue ring when the tool is edited.
  final bool edited;
  final double radius;
  @override
  State<Press> createState() => _PressState();
}

class _PressState extends State<Press> {
  bool down = false;

  /// Native `UIButton` for a glyph or a plain text label; other content
  /// (rows of text and icons) stays a Flutter press.
  Widget? _native(BuildContext context) {
    if (!useNativeControls) return null;
    final child = widget.child;
    String? symbol, title;
    if (child is Glyph) {
      symbol = sfSymbol(child.name);
    } else if (child is Text && child.data != null) {
      title = child.data;
    } else {
      return null;
    }
    final style = widget.selected && widget.filled
        ? 'prominent'
        : widget.plain
        ? 'plain'
        : 'glass';
    return LayoutBuilder(
      builder: (context, constraints) {
        double width;
        if (constraints.hasTightWidth) {
          width = constraints.maxWidth;
        } else if (title == null) {
          width = 44;
        } else {
          final painter = TextPainter(
            text: TextSpan(
              text: title,
              style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
            textDirection: TextDirection.ltr,
          )..layout();
          width = (painter.width + 36).clamp(44, constraints.maxWidth);
        }
        return NativeButton(
          label: widget.label,
          symbol: symbol,
          title: title,
          style: style,
          selected: widget.selected && !widget.filled,
          onTap: widget.onTap,
          symbolSize: child is Glyph ? (child.size * .8) : 17,
          width: width,
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) =>
      _native(context) ??
      Semantics(
        button: true,
        label: widget.label,
        selected: widget.selected,
        enabled: widget.onTap != null,
        child: Tooltip(
          message: widget.label,
          child: GestureDetector(
            onTapDown: widget.onTap == null
                ? null
                : (_) => setState(() => down = true),
            onTapCancel: () => setState(() => down = false),
            onTapUp: (_) => setState(() => down = false),
            onTap: widget.onTap,
            child: AnimatedScale(
              scale: down ? .94 : 1,
              duration: const Duration(milliseconds: 120),
              child: Opacity(
                opacity: widget.onTap == null ? .35 : 1,
                child: Container(
                  constraints: const BoxConstraints(
                    minWidth: 44,
                    minHeight: 44,
                  ),
                  padding: const EdgeInsets.symmetric(horizontal: 10),
                  decoration: ShapeDecoration(
                    shape: RoundedSuperellipseBorder(
                      borderRadius: BorderRadius.circular(widget.radius),
                      side: widget.selected && !widget.filled
                          ? const BorderSide(color: signalBlue, width: 1.5)
                          : widget.edited
                          ? const BorderSide(color: signalBlue, width: 2)
                          : BorderSide.none,
                    ),
                    color: widget.selected
                        ? widget.filled
                              ? const Color(0xb30070e0)
                              : const Color(0x200091ff)
                        : widget.plain
                        ? Colors.transparent
                        : const Color(0x14787880),
                  ),
                  alignment: Alignment.center,
                  child: widget.child,
                ),
              ),
            ),
          ),
        ),
      );
}

class LightSwitch extends StatelessWidget {
  const LightSwitch({
    super.key,
    required this.value,
    required this.onChanged,
    required this.label,
  });
  final bool value;
  final ValueChanged<bool>? onChanged;
  final String label;
  @override
  Widget build(BuildContext context) => useNativeControls
      ? NativeSwitch(value: value, onChanged: onChanged, label: label)
      : Semantics(
          label: label,
          toggled: value,
          enabled: onChanged != null,
          onTap: onChanged == null ? null : () => onChanged!(!value),
          child: GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: onChanged == null ? null : () => onChanged!(!value),
            onHorizontalDragEnd: onChanged == null
                ? null
                : (details) {
                    final velocity = details.primaryVelocity ?? 0;
                    if (velocity.abs() > 40) onChanged!(velocity > 0);
                  },
            child: SizedBox(
              width: 44,
              height: 44,
              child: Center(
                child: AnimatedContainer(
                  duration: MediaQuery.disableAnimationsOf(context)
                      ? Duration.zero
                      : const Duration(milliseconds: 160),
                  width: 28,
                  height: 16,
                  padding: const EdgeInsets.all(2),
                  decoration: BoxDecoration(
                    color: value
                        ? signalBlue.withValues(alpha: .7)
                        : const Color(0x47787880),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: AnimatedAlign(
                    duration: MediaQuery.disableAnimationsOf(context)
                        ? Duration.zero
                        : const Duration(milliseconds: 160),
                    curve: Curves.easeOutCubic,
                    alignment: value
                        ? Alignment.centerRight
                        : Alignment.centerLeft,
                    child: const SizedBox(
                      width: 12,
                      height: 12,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        );
}

class DetailSlider extends StatefulWidget {
  const DetailSlider({
    super.key,
    required this.value,
    required this.min,
    required this.max,
    required this.step,
    required this.onChanged,
    this.onStart,
    this.onEnd,
    required this.label,
    this.enabled = true,
    this.onReset,
  });
  final double value, min, max, step;
  final ValueChanged<double> onChanged;
  final VoidCallback? onStart, onEnd;

  /// Double-tap restores the default, like double-click on the web slider.
  final VoidCallback? onReset;
  final String label;
  final bool enabled;
  @override
  State<DetailSlider> createState() => _DetailSliderState();
}

class _DetailSliderState extends State<DetailSlider> {
  double? dragging;

  double snap(double v) =>
      (widget.min + ((v - widget.min) / widget.step).round() * widget.step)
          .clamp(widget.min, widget.max);

  @override
  Widget build(BuildContext context) {
    if (useNativeControls) {
      return NativeSlider(
        value: widget.value.clamp(widget.min, widget.max),
        min: widget.min,
        max: widget.max,
        label: widget.label,
        enabled: widget.enabled,
        onReset: widget.enabled ? widget.onReset : null,
        onStart: widget.onStart,
        onEnd: () {
          dragging = null;
          widget.onEnd?.call();
        },
        onChanged: (v) {
          final snapped = snap(v);
          if (snapped != dragging) {
            dragging = snapped;
            widget.onChanged(snapped);
          }
        },
      );
    }
    return GestureDetector(
      onDoubleTap: widget.enabled ? widget.onReset : null,
      child: _flutterSlider(),
    );
  }

  Widget _flutterSlider() => SliderTheme(
    data: SliderTheme.of(context).copyWith(
      trackHeight: 3,
      activeTrackColor: signalBlue.withValues(alpha: .7),
      inactiveTrackColor: const Color(0x47787880),
      thumbColor: Colors.white,
      thumbShape: const RoundSliderThumbShape(enabledThumbRadius: 6),
      overlayShape: const RoundSliderOverlayShape(overlayRadius: 18),
      padding: const EdgeInsets.symmetric(horizontal: 12),
    ),
    child: Slider(
      semanticFormatterCallback: (v) => '${widget.label}: $v',
      value: (dragging ?? widget.value).clamp(widget.min, widget.max),
      min: widget.min,
      max: widget.max,
      onChangeStart: widget.enabled
          ? (v) {
              setState(() => dragging = v);
              widget.onStart?.call();
            }
          : null,
      onChangeEnd: widget.enabled
          ? (_) {
              setState(() => dragging = null);
              widget.onEnd?.call();
            }
          : null,
      onChanged: widget.enabled
          ? (v) {
              final snapped =
                  (widget.min +
                          ((v - widget.min) / widget.step).round() *
                              widget.step)
                      .clamp(widget.min, widget.max);
              setState(() => dragging = snapped);
              widget.onChanged(snapped);
            }
          : null,
    ),
  );
}

Future<T?> editorSheet<T>(
  BuildContext context,
  Widget child, {
  double fraction = .84,
  double blur = 16,
}) => showModalBottomSheet<T>(
  context: context,
  isScrollControlled: true,
  backgroundColor: Colors.transparent,
  barrierColor: Colors.black.withValues(alpha: .25),
  builder: (context) => BackdropFilter(
    filter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
    child: Padding(
      padding: EdgeInsets.only(
        left: 8,
        right: 8,
        bottom: MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SizedBox(
        height: MediaQuery.sizeOf(context).height * fraction,
        child: Glass(
          radius: 28,
          padding: const EdgeInsets.all(16),
          child: SafeArea(top: false, child: child),
        ),
      ),
    ),
  ),
);

/// A row of option capsules (web `OptionRow`); the chosen one is centred.
class OptionRow extends StatefulWidget {
  const OptionRow({
    super.key,
    required this.label,
    required this.options,
    required this.value,
    required this.onChanged,
  });
  final String label, value;
  final List<Map<String, dynamic>> options;
  final ValueChanged<String>? onChanged;
  @override
  State<OptionRow> createState() => _OptionRowState();
}

class _OptionRowState extends State<OptionRow> {
  final keys = <String, GlobalKey>{};

  void _reveal() => WidgetsBinding.instance.addPostFrameCallback((_) {
    final target = keys[widget.value]?.currentContext;
    if (target != null && mounted) {
      Scrollable.ensureVisible(
        target,
        alignment: .5,
        duration: MediaQuery.disableAnimationsOf(context)
            ? Duration.zero
            : const Duration(milliseconds: 260),
        curve: Curves.easeOutCubic,
      );
    }
  });

  @override
  void initState() {
    super.initState();
    _reveal();
  }

  @override
  void didUpdateWidget(OptionRow old) {
    super.didUpdateWidget(old);
    if (old.value != widget.value) _reveal();
  }

  @override
  Widget build(BuildContext context) => Semantics(
    label: widget.label,
    container: true,
    child: SizedBox(
      height: 48,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        physics: const BouncingScrollPhysics(
          parent: AlwaysScrollableScrollPhysics(),
        ),
        itemCount: widget.options.length,
        separatorBuilder: (_, _) => const SizedBox(width: 6),
        itemBuilder: (context, i) {
          final o = widget.options[i];
          final value = o['value'] as String;
          return Center(
            key: keys.putIfAbsent(value, GlobalKey.new),
            child: Press(
              label: o['label'] as String,
              selected: value == widget.value,
              radius: 22,
              onTap: widget.onChanged == null
                  ? null
                  : () => widget.onChanged!(value),
              child: Text(o['label'] as String),
            ),
          );
        },
      ),
    ),
  );
}

/// Full-width capsule button with arbitrary content (web `.capsule`).
class ListPress extends StatelessWidget {
  const ListPress({
    super.key,
    required this.label,
    required this.child,
    this.onTap,
  });
  final String label;
  final Widget child;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    label: label,
    enabled: onTap != null,
    child: Opacity(
      opacity: onTap == null ? .35 : 1,
      child: Material(
        color: const Color(0x24787880),
        shape: const StadiumBorder(),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Container(
            constraints: const BoxConstraints(minHeight: 44),
            padding: const EdgeInsets.symmetric(horizontal: 16),
            alignment: Alignment.centerLeft,
            child: child,
          ),
        ),
      ),
    ),
  );
}
