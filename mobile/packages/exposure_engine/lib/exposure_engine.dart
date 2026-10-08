import 'dart:convert';

import 'package:flutter/services.dart';

class NativePhoto {
  const NativePhoto(
    this.textureId,
    this.width,
    this.height, {
    this.originalTextureId,
    this.focusTextureId,
    this.inputColorSpace = 'sRGB',
    this.encoding = 'encoded',
    this.sourceWidth,
    this.sourceHeight,
  });
  final int textureId;
  final int width;
  final int height;
  final int? originalTextureId;
  final int? focusTextureId;
  final String inputColorSpace, encoding;
  final int? sourceWidth, sourceHeight;
}

class NativeDetail {
  NativeDetail(Map<String, dynamic> value)
    : textureId = value['textureId'] as int,
      originalTextureId = value['originalTextureId'] as int,
      longEdge = (value['fullWidth'] as int) > (value['fullHeight'] as int)
          ? value['fullWidth'] as int
          : value['fullHeight'] as int,
      rect = Rect.fromLTWH(
        (value['x'] as num) / (value['fullWidth'] as num),
        (value['y'] as num) / (value['fullHeight'] as num),
        (value['width'] as num) / (value['fullWidth'] as num),
        (value['height'] as num) / (value['fullHeight'] as num),
      );
  final int textureId, originalTextureId, longEdge;
  final Rect rect;
}

class ExposureEngine {
  static const _channel = MethodChannel('exposure/native');
  Future<String?> chooseFile() => _channel.invokeMethod<String>('chooseFile');
  Future<NativeDetail?> detail(
    Map<String, dynamic> params,
    Rect rect,
    int longEdge,
  ) async {
    final result = await _channel.invokeMapMethod<String, dynamic>('detail', {
      'params': params,
      'longEdge': longEdge,
      'rect': {
        'x': rect.left,
        'y': rect.top,
        'width': rect.width,
        'height': rect.height,
      },
    });
    return result == null ? null : NativeDetail(result);
  }

  Stream<Map<String, dynamic>> get events => const EventChannel(
    'exposure/status',
  ).receiveBroadcastStream().map((e) => Map<String, dynamic>.from(e as Map));
  Future<void> beginRemoval() => _channel.invokeMethod<void>('eraseBegin');
  Future<void> previewRemoval(Uint8List mask, int width, int height) =>
      _channel.invokeMethod<void>('erasePreview', {
        'mask': mask,
        'width': width,
        'height': height,
      });
  Future<int> applyRemoval() async =>
      await _channel.invokeMethod<int>('eraseApply') ?? 0;
  Future<void> cancelRemoval() => _channel.invokeMethod<void>('eraseCancel');
  Future<void> restoreRemoval(int cursor) =>
      _channel.invokeMethod<void>('eraseRestore', {'cursor': cursor});

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

  Future<String> exportImage(
    Map<String, dynamic> params, {
    required String format,
    int? longEdge,
    double quality = 1,
  }) async {
    final path = await _channel.invokeMethod<String>('developExport', {
      'params': params,
      'format': format,
      'longEdge': longEdge,
      'quality': quality,
    });
    if (path == null) throw StateError('Native export returned no file.');
    return path;
  }

  Future<String> exportCube(Map<String, dynamic> params, int size) async {
    final path = await _channel.invokeMethod<String>('cubeExport', {
      'params': params,
      'size': size,
    });
    if (path == null) throw StateError('Native LUT export returned no file.');
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
      inputColorSpace: result['inputColorSpace'] as String? ?? 'sRGB',
      encoding: result['encoding'] as String? ?? 'encoded',
      sourceWidth: result['sourceWidth'] as int?,
      sourceHeight: result['sourceHeight'] as int?,
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
  Future<void> cancelExport() => _channel.invokeMethod<void>('cancelExport');
  Future<String?> loadExportPreferences() =>
      _channel.invokeMethod<String>('loadExportPreferences');
  Future<void> saveExportPreferences(String json) =>
      _channel.invokeMethod<void>('saveExportPreferences', json);
}
