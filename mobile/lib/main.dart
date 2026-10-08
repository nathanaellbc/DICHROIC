import 'package:flutter/material.dart';
import 'appearance.dart';
import 'editor_widgets.dart';
import 'native_editor_screen.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  loadAppearance();
  runApp(const ExposureApp());
}

class ExposureApp extends StatelessWidget {
  const ExposureApp({super.key});
  @override
  Widget build(BuildContext context) => ValueListenableBuilder<ThemeMode>(
    valueListenable: appearance,
    builder: (context, mode, _) => MaterialApp(
      title: 'DICHROIC',
      debugShowCheckedModeBanner: false,
      theme: dichroicTheme(Brightness.light),
      darkTheme: dichroicTheme(),
      themeMode: mode,
      home: const NativeEditorScreen(),
    ),
  );
}

/// Dark by default (tests and existing callers); the app follows the system.
ThemeData dichroicTheme([Brightness brightness = Brightness.dark]) => ThemeData(
  brightness: brightness,
  useMaterial3: true,
  scaffoldBackgroundColor: brightness == Brightness.dark
      ? Colors.black
      : const Color(0xfff2f2f7),
  colorScheme: ColorScheme.fromSeed(
    seedColor: signalBlue,
    brightness: brightness,
    surface: brightness == Brightness.dark ? Colors.black : Colors.white,
    onSurface: brightness == Brightness.dark ? Colors.white : Colors.black,
  ),
  scrollbarTheme: ScrollbarThemeData(
    thumbColor: WidgetStateProperty.all(
      (brightness == Brightness.dark ? Colors.white : Colors.black).withValues(
        alpha: .2,
      ),
    ),
    thickness: WidgetStateProperty.all(2),
    radius: const Radius.circular(2),
  ),
  inputDecorationTheme: InputDecorationTheme(
    filled: true,
    fillColor: const Color(0x47787880),
    hintStyle: const TextStyle(color: secondary),
    contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
    border: InputBorder.none,
  ),
);
