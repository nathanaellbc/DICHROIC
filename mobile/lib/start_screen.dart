import 'dart:ui';
import 'package:flutter/material.dart';

/// Empty state, as the web `DropZone` (src/ui/screens/Start.tsx): a two-tone
/// title fading in word by word, one breathing blue glow, "Choose Photo".
class StartScreen extends StatefulWidget {
  const StartScreen({
    super.key,
    required this.onChoose,
    this.compactLandscape = false,
  });
  final VoidCallback? onChoose;

  /// Short landscape window: description and footnote hidden, top aligned.
  final bool compactLandscape;
  @override
  State<StartScreen> createState() => _StartScreenState();
}

class _StartScreenState extends State<StartScreen>
    with TickerProviderStateMixin {
  late final intro = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1400),
  )..forward();
  late final glow = AnimationController(
    vsync: this,
    duration: const Duration(seconds: 14),
  );
  bool down = false;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (MediaQuery.disableAnimationsOf(context)) {
      intro.value = 1;
      glow.stop();
    } else if (!glow.isAnimating) {
      glow.repeat(reverse: true);
    }
  }

  @override
  void dispose() {
    intro.dispose();
    glow.dispose();
    super.dispose();
  }

  /// One word: rises 8 px out of an 8 px blur over 0.7 s.
  Widget _word(String word, double delay, TextStyle style) {
    final curve = CurvedAnimation(
      parent: intro,
      curve: Interval(
        delay / 1.4,
        ((delay + .7) / 1.4).clamp(0, 1),
        curve: const Cubic(.22, 1, .36, 1),
      ),
    );
    return AnimatedBuilder(
      animation: curve,
      builder: (context, child) {
        final t = curve.value, blur = 8 * (1 - t);
        return Opacity(
          opacity: t,
          child: Transform.translate(
            offset: Offset(0, 8 * (1 - t)),
            child: blur < .05
                ? child
                : ImageFiltered(
                    imageFilter: ImageFilter.blur(sigmaX: blur, sigmaY: blur),
                    child: child,
                  ),
          ),
        );
      },
      child: Text(word, style: style),
    );
  }

  Widget _line(String text, double delay, TextStyle style) {
    final words = text.split(' ');
    return Wrap(
      alignment: WrapAlignment.center,
      spacing: style.fontSize! * .26,
      children: [
        for (var i = 0; i < words.length; i++)
          _word(words[i], delay + i * .06, style),
      ],
    );
  }

  /// Staggered rise of the description, button and footnote.
  Widget _rise(int index, Widget child) {
    final start = .05 + index * .09;
    final curve = CurvedAnimation(
      parent: intro,
      curve: Interval(
        start / 1.4,
        ((start + .7) / 1.4).clamp(0, 1),
        curve: const Cubic(.22, 1, .36, 1),
      ),
    );
    return AnimatedBuilder(
      animation: curve,
      builder: (context, child) => Opacity(
        opacity: curve.value,
        child: Transform.translate(
          offset: Offset(0, 8 * (1 - curve.value)),
          child: child,
        ),
      ),
      child: child,
    );
  }

  @override
  Widget build(BuildContext context) {
    final dark = Theme.of(context).brightness == Brightness.dark;
    final width = MediaQuery.sizeOf(context).width;
    final size = (width * .096).clamp(34.0, 56.0);
    final title = TextStyle(
      fontSize: size,
      height: 1.07,
      letterSpacing: -.028 * size,
      fontWeight: FontWeight.w600,
      color: dark ? const Color(0xfff5f5f7) : const Color(0xff1d1d1f),
    );
    final short = widget.compactLandscape;
    return Stack(
      fit: StackFit.expand,
      children: [
        // One faint blue glow, breathing over 14 s.
        AnimatedBuilder(
          animation: glow,
          builder: (context, _) {
            final t = Curves.easeInOut.transform(glow.value);
            return IgnorePointer(
              child: Opacity(
                opacity: (.7 + .3 * t) * .9,
                child: Align(
                  alignment: Alignment(-.04 + .08 * t, .16 - .06 * t),
                  child: Transform.scale(
                    scale: 1 + .08 * t,
                    child: ImageFiltered(
                      imageFilter: ImageFilter.blur(sigmaX: 40, sigmaY: 40),
                      child: SizedBox(
                        width: (width * 1.4).clamp(0, 900),
                        height: (width * 1.4).clamp(0, 900) / 1.6,
                        child: const DecoratedBox(
                          decoration: BoxDecoration(
                            gradient: RadialGradient(
                              center: Alignment(-.16, 0),
                              radius: .5,
                              colors: [Color(0x380070e0), Color(0x000070e0)],
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
          },
        ),
        SingleChildScrollView(
          padding: EdgeInsets.fromLTRB(28, short ? 56 : 72, 28, 28),
          child: ConstrainedBox(
            constraints: BoxConstraints(
              minHeight: short ? 0 : MediaQuery.sizeOf(context).height - 260,
            ),
            child: Column(
              mainAxisAlignment: short
                  ? MainAxisAlignment.start
                  : MainAxisAlignment.center,
              children: [
                ConstrainedBox(
                  constraints: BoxConstraints(maxWidth: size * 12),
                  child: Column(
                    children: [
                      _line('Develop your photo', 0, title),
                      _line(
                        'on real film.',
                        .18,
                        title.copyWith(color: const Color(0xff86868b)),
                      ),
                    ],
                  ),
                ),
                if (!short)
                  _rise(
                    0,
                    Padding(
                      padding: const EdgeInsets.only(top: 18),
                      child: ConstrainedBox(
                        constraints: const BoxConstraints(maxWidth: 510),
                        child: Text(
                          'Spectral simulation of real film and print stocks, right on this device.',
                          textAlign: TextAlign.center,
                          style: TextStyle(
                            fontSize: 17,
                            height: 1.47,
                            letterSpacing: -.17,
                            color: dark
                                ? const Color(0xffa1a1a6)
                                : const Color(0xff6e6e73),
                          ),
                        ),
                      ),
                    ),
                  ),
                _rise(
                  1,
                  Padding(
                    padding: EdgeInsets.only(top: short ? 20 : 32),
                    child: Semantics(
                      button: true,
                      label: 'Choose Photo',
                      child: GestureDetector(
                        onTapDown: (_) => setState(() => down = true),
                        onTapCancel: () => setState(() => down = false),
                        onTapUp: (_) => setState(() => down = false),
                        onTap: widget.onChoose,
                        child: AnimatedScale(
                          scale: down ? .94 : 1,
                          duration: const Duration(milliseconds: 80),
                          child: Opacity(
                            opacity: widget.onChoose == null ? .5 : 1,
                            child: Container(
                              height: 48,
                              padding: const EdgeInsets.symmetric(
                                horizontal: 26,
                              ),
                              alignment: Alignment.center,
                              decoration: const ShapeDecoration(
                                color: Color(0xff0071e3),
                                shape: StadiumBorder(),
                              ),
                              child: const Text(
                                'Choose Photo',
                                style: TextStyle(
                                  color: Colors.white,
                                  fontSize: 17,
                                  fontWeight: FontWeight.w500,
                                  letterSpacing: -.17,
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
                if (!short)
                  _rise(
                    2,
                    const Padding(
                      padding: EdgeInsets.only(top: 44),
                      child: Text(
                        'RAW, JPEG, PNG, TIFF and OpenEXR. Nothing is uploaded.',
                        textAlign: TextAlign.center,
                        style: TextStyle(
                          fontSize: 12,
                          height: 1.4,
                          color: Color(0xff6e6e73),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ],
    );
  }
}
