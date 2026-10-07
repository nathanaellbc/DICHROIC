import 'dart:convert';

import 'package:flutter/services.dart';

class NativePhoto {
  const NativePhoto(
    this.textureId,
    this.width,
    this.height, {
    this.originalTextureId,
    this.focusTextureId,
  });
  final int textureId;
  final int width;
  final int height;
  final int? originalTextureId;
  final int? focusTextureId;
}

class ExposureEngine {
  static const _channel = MethodChannel('exposure/native');

  Future<Map<String, dynamic>> catalog() async {
    final json = await _channel.invokeMethod<String>('catalog');
    if (json == null) throw StateError('Native catalog is missing.');
    return jsonDecode(json) as Map<String, dynamic>;
  }

  Future<List<dynamic>> controls(Map<String, dynamic> params) async {
    final json = await _channel.invokeMethod<String>('controls', {
      'params': params,
    });
    if (json == null) throw StateError('Native controls are missing.');
    return jsonDecode(json) as List<dynamic>;
  }

  Future<Map<String, dynamic>> patch(
    Map<String, dynamic> params,
    String action,
    String id,
    Object? value,
  ) async {
    final json = await _channel.invokeMethod<String>('patch', {
      'params': params,
      'action': action,
      'id': id,
      'value': value,
    });
    if (json == null) throw StateError('Native control update is missing.');
    return jsonDecode(json) as Map<String, dynamic>;
  }

  Future<void> develop(Map<String, dynamic> params) =>
      _channel.invokeMethod<void>('develop', {'params': params});

  Future<String> developExport(Map<String, dynamic> params) async {
    final path = await _channel.invokeMethod<String>('developExport', {
      'params': params,
    });
    if (path == null) throw StateError('Native export returned no file.');
    return path;
  }

  Future<NativePhoto> open(String path) async {
    final result = await _channel.invokeMapMethod<String, dynamic>('open', {
      'path': path,
    });
    if (result == null) throw StateError('Native engine returned no photo.');
    return NativePhoto(
      result['textureId'] as int,
      result['width'] as int,
      result['height'] as int,
      originalTextureId: result['originalTextureId'] as int?,
      focusTextureId: result['focusTextureId'] as int?,
    );
  }

  Future<void> render(double exposureEv) =>
      _channel.invokeMethod<void>('render', {'exposureEv': exposureEv});

  Future<void> focusPreview(Map<String, dynamic> params) =>
      _channel.invokeMethod<void>('focusPreview', {'params': params});

  Future<String> export(double exposureEv) async {
    final path = await _channel.invokeMethod<String>('export', {
      'exposureEv': exposureEv,
    });
    if (path == null) throw StateError('Native export returned no file.');
    return path;
  }

  Future<void> close() => _channel.invokeMethod<void>('close');
}
