import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// Appearance chosen in the editor menu: system, light or dark. Stored
/// natively (UserDefaults), which also sets the window's interface style so
/// the native UIKit controls follow the same choice as the Flutter theme.
final appearance = ValueNotifier<ThemeMode>(ThemeMode.system);

const _channel = MethodChannel('exposure/native');

const appearanceLabels = {
  ThemeMode.system: 'System',
  ThemeMode.light: 'Light',
  ThemeMode.dark: 'Dark',
};

Future<void> loadAppearance() async {
  try {
    final stored = await _channel.invokeMethod<String>('loadAppearance');
    appearance.value = ThemeMode.values.firstWhere(
      (mode) => mode.name == stored,
      orElse: () => ThemeMode.system,
    );
  } on MissingPluginException {
    // Host tests and other platforms: follow the system.
  } on PlatformException {
    // Unreadable preference: follow the system.
  }
}

Future<void> setAppearance(ThemeMode mode) async {
  appearance.value = mode;
  try {
    await _channel.invokeMethod<void>('saveAppearance', mode.name);
  } on MissingPluginException {
    // Not persisted outside iOS.
  } on PlatformException {
    // The choice still applies for this session.
  }
}
