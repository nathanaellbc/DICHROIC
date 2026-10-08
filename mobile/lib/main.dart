import 'package:flutter/material.dart';
import 'editor_widgets.dart';
import 'native_editor_screen.dart';

void main() => runApp(const ExposureApp());

class ExposureApp extends StatelessWidget {
  const ExposureApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'DICHROIC',
    debugShowCheckedModeBanner: false,
    theme: dichroicTheme(),
    home: const NativeEditorScreen(),
  );
}

ThemeData dichroicTheme() => ThemeData(
  brightness: Brightness.dark,
  useMaterial3: true,
  scaffoldBackgroundColor: Colors.black,
  colorScheme: ColorScheme.fromSeed(
    seedColor: signalBlue,
    brightness: Brightness.dark,
  ),
  scrollbarTheme: ScrollbarThemeData(
    thumbColor: WidgetStateProperty.all(Colors.white.withValues(alpha: .2)),
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
