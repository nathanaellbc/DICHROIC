import 'package:flutter/services.dart';

class NativePhoto {
  const NativePhoto(this.textureId, this.width, this.height);
  final int textureId;
  final int width;
  final int height;
}

class ExposureEngine {
  static const _channel = MethodChannel('exposure/native');

  Future<NativePhoto> open(String path) async {
    final result = await _channel.invokeMapMethod<String, dynamic>('open', {
      'path': path,
    });
    if (result == null) throw StateError('Native engine returned no photo.');
    return NativePhoto(
      result['textureId'] as int,
      result['width'] as int,
      result['height'] as int,
    );
  }

  Future<void> render(double exposureEv) =>
      _channel.invokeMethod<void>('render', {'exposureEv': exposureEv});

  Future<String> export(double exposureEv) async {
    final path = await _channel.invokeMethod<String>('export', {
      'exposureEv': exposureEv,
    });
    if (path == null) throw StateError('Native export returned no file.');
    return path;
  }

  Future<void> close() => _channel.invokeMethod<void>('close');
}
