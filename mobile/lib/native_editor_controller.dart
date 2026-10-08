import 'dart:async';
import 'dart:ui';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/foundation.dart';

typedef Json = Map<String, dynamic>;

/// Canonical host owns all photographic parameter rules. This controller
/// serializes edits, coalesces slider samples, and retains one render in flight.
class NativeEditorController extends ChangeNotifier {
  NativeEditorController(this.engine) {
    _events = engine.events.listen((event) {
      status = event['message'] as String?;
      _notify();
    }, onError: (Object _) {});
  }
  final ExposureEngine engine;
  NativePhoto? photo;
  Json catalog = {}, params = {};
  List<Json> groups = [];
  bool loading = false, exporting = false, rendering = false;
  String? error;
  String? status;
  StreamSubscription<Json>? _events;
  bool erasing = false, removing = false, removalReady = false;
  int _removalCursor = 0;
  final _pending = <String, Json>{};
  final List<Json> _undo = [], _redo = [];
  Json? _gestureBefore;
  Future<void>? _editing, _render;
  int _revision = 0, _rendered = -1, _generation = 0;
  bool _disposed = false;
  Json? _focusQueued;
  bool _focusWorking = false;
  NativeDetail? detail;
  bool detailRendering = false;
  Future<void>? _detailTask;
  ({Rect rect, int edge})? _detailQueued, _detailWish, _detailAttempt;
  int _detailHighWater = 0;
  int get revision => _revision;
  bool get canUndo => _undo.isNotEmpty;
  bool get canRedo => _redo.isNotEmpty;
  bool get busy => loading || exporting || removing;
  Json _snapshot() => {...params, '_retouchCursor': _removalCursor};

  void requestDetail(Rect rect, int longEdge) {
    if (photo == null || busy || erasing || rect.isEmpty) return;
    final sourceEdge =
        (photo!.sourceWidth ?? photo!.width) >
            (photo!.sourceHeight ?? photo!.height)
        ? photo!.sourceWidth ?? photo!.width
        : photo!.sourceHeight ?? photo!.height;
    final edge = longEdge.clamp(1, sourceEdge);
    if (edge <= 1600) return;
    if (edge < _detailHighWater && detail != null) return;
    if (edge > _detailHighWater) _detailHighWater = edge;
    final attempt = _detailAttempt;
    if (attempt != null &&
        attempt.edge >= _detailHighWater &&
        attempt.rect.left <= rect.left + 1e-6 &&
        attempt.rect.top <= rect.top + 1e-6 &&
        attempt.rect.right >= rect.right - 1e-6 &&
        attempt.rect.bottom >= rect.bottom - 1e-6) {
      return;
    }
    _detailWish = (rect: rect, edge: _detailHighWater);
    _detailQueued = _detailWish;
    _scheduleDetail();
  }

  void _invalidateDetail() {
    detail = null;
    _detailAttempt = null;
    _detailQueued = _detailWish;
  }

  void _scheduleDetail() {
    if (_disposed ||
        busy ||
        erasing ||
        rendering ||
        detailRendering ||
        _editing != null ||
        _detailQueued == null ||
        _rendered != _revision) {
      return;
    }
    _detailTask = _renderDetail();
  }

  Future<void> _renderDetail() async {
    final request = _detailQueued!;
    _detailQueued = null;
    final revision = _revision;
    detailRendering = true;
    try {
      final result = await engine.detail(
        Map.of(params),
        request.rect,
        request.edge,
      );
      if (!_disposed && revision == _revision) {
        detail = result;
        _detailAttempt = request;
      }
    } catch (e) {
      if (!_disposed) {
        error = e.toString();
        _detailAttempt = request;
      }
    } finally {
      detailRendering = false;
      _notify();
      if (_rendered != _revision) _scheduleRender();
      _scheduleDetail();
    }
  }

  Future<void> beginRemoval() async {
    if (busy || erasing || photo == null) return;
    loading = true;
    error = null;
    _notify();
    try {
      await _editing;
      await _render;
      await _detailTask;
      await engine.beginRemoval();
      detail = null;
      _detailQueued = null;
      erasing = true;
      removalReady = false;
    } catch (e) {
      error = e.toString();
    } finally {
      loading = false;
      _notify();
    }
  }

  Future<void> previewRemoval(Uint8List mask, int width, int height) async {
    if (busy || !erasing) return;
    removing = true;
    error = null;
    removalReady = false;
    _notify();
    try {
      await engine.previewRemoval(mask, width, height);
      removalReady = true;
    } catch (e) {
      error = e.toString();
    } finally {
      removing = false;
      _notify();
    }
  }

  Future<void> finishRemoval({required bool apply}) async {
    if (busy || !erasing || (apply && !removalReady)) return;
    removing = true;
    _notify();
    try {
      if (apply) {
        final before = _snapshot();
        _removalCursor = await engine.applyRemoval();
        _undo.add(before);
        _redo.clear();
        _trimHistory();
        _revision++;
      } else {
        await engine.cancelRemoval();
      }
      erasing = false;
      removalReady = false;
      _rendered = -1;
    } catch (e) {
      error = e.toString();
    } finally {
      removing = false;
      _notify();
      _scheduleRender();
    }
  }

  Future<void> restartRemoval() async {
    if (busy || !erasing) return;
    removing = true;
    _notify();
    try {
      await engine.cancelRemoval();
      await engine.beginRemoval();
      removalReady = false;
    } catch (e) {
      error = e.toString();
    } finally {
      removing = false;
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  Future<void> previewFocus(double x, double y) async {
    _focusQueued = {...params, 'lensFocusX': x, 'lensFocusY': y};
    if (_focusWorking) return;
    _focusWorking = true;
    try {
      while (_focusQueued != null && !_disposed) {
        final next = _focusQueued!;
        _focusQueued = null;
        await engine.focusPreview(next);
      }
    } catch (e) {
      error = e.toString();
      _notify();
    } finally {
      _focusWorking = false;
    }
  }

  Future<void> _controls() async {
    groups = (await engine.controls(params)).cast<Json>();
  }

  Future<void> open(String path) async {
    if (busy) return;
    loading = true;
    error = null;
    _notify();
    final generation = ++_generation;
    try {
      await _editing;
      await _render;
      await _detailTask;
      _pending.clear();
      if (catalog.isEmpty) catalog = await engine.catalog();
      final next = await engine.open(path);
      if (_disposed || generation != _generation) return;
      photo = next;
      params = Map<String, dynamic>.from(catalog['baseline'] as Map);
      if (params.containsKey('inputColorSpace')) {
        params['inputColorSpace'] = next.inputColorSpace;
        params['inputCctfDecoding'] = next.encoding == 'encoded';
        params['autoExposure'] = next.encoding == 'linear';
      }
      _undo.clear();
      _redo.clear();
      _gestureBefore = null;
      _removalCursor = 0;
      detail = null;
      _detailQueued = null;
      _detailWish = null;
      _detailAttempt = null;
      _detailHighWater = 0;
      erasing = false;
      removalReady = false;
      _revision++;
      await _controls();
    } catch (e) {
      error = e.toString();
    } finally {
      loading = false;
      _notify();
    }
    if (photo != null && error == null) _scheduleRender();
  }

  void beginGesture() {
    _gestureBefore ??= _snapshot();
  }

  Future<void> endGesture() async {
    await _editing;
    final before = _gestureBefore;
    _gestureBefore = null;
    if (before != null && !mapEquals(before, _snapshot())) {
      _undo.add(before);
      _redo.clear();
      _trimHistory();
      _notify();
    }
  }

  void _trimHistory() {
    if (_undo.length > 80) _undo.removeAt(0);
  }

  Future<void> edit(String action, String id, Object? value) {
    if (photo == null || busy || erasing) return Future.value();
    // Each tool retains its newest value; updates to other tools are preserved.
    final key = '$action:$id';
    _pending[key] = {
      'action': action,
      'id': id,
      'value': value,
      'history': _gestureBefore == null,
    };
    return _editing ??= _drainEdits();
  }

  Future<void> _drainEdits() async {
    try {
      while (_pending.isNotEmpty && !_disposed) {
        final key = _pending.keys.first;
        final edit = _pending.remove(key)!;
        final before = _snapshot();
        final next = await engine.patch(
          params,
          edit['action'] as String,
          edit['id'] as String,
          edit['value'],
        );
        if (_disposed) return;
        if (!mapEquals(next, params)) {
          if (edit['history'] == true) {
            _undo.add(before);
            _redo.clear();
            _trimHistory();
          }
          params = next;
          _revision++;
          _invalidateDetail();
          error = null;
          await _controls();
          _notify();
          _scheduleRender();
        }
      }
    } catch (e) {
      _pending.clear();
      error = e.toString();
      _notify();
    } finally {
      _editing = null;
      _scheduleDetail();
    }
  }

  void _scheduleRender() {
    if (busy || erasing || _disposed || rendering || detailRendering) return;
    _render = _drainRender();
  }

  Future<void> _drainRender() async {
    rendering = true;
    _notify();
    try {
      while (!_disposed &&
          !busy &&
          !erasing &&
          photo != null &&
          _rendered != _revision) {
        final revision = _revision;
        await engine.develop(Map.of(params));
        _rendered = revision;
      }
    } catch (e) {
      error = e.toString();
    } finally {
      rendering = false;
      _notify();
      _scheduleDetail();
    }
  }

  Future<void> undo() async {
    if (busy || erasing) return;
    await _editing;
    if (_undo.isEmpty) return;
    _redo.add(_snapshot());
    await _restore(_undo.removeLast());
    _revision++;
    await _controls();
    _notify();
    _scheduleRender();
  }

  Future<void> redo() async {
    if (busy || erasing) return;
    await _editing;
    if (_redo.isEmpty) return;
    _undo.add(_snapshot());
    await _restore(_redo.removeLast());
    _revision++;
    await _controls();
    _notify();
    _scheduleRender();
  }

  Future<void> resetAll() => edit('fields', 'all', catalog['baseline']);
  Future<void> _restore(Json snapshot) async {
    final restored = Map<String, dynamic>.of(snapshot);
    final cursor = restored.remove('_retouchCursor') as int? ?? 0;
    if (_removalCursor != cursor) {
      await _render;
      await engine.restoreRemoval(cursor);
      _removalCursor = cursor;
    }
    params = restored;
    _invalidateDetail();
  }

  Future<String?> export({
    String format = 'png8',
    int? longEdge,
    double quality = 1,
    int? cubeSize,
  }) async {
    if (photo == null || busy || erasing) return null;
    exporting = true;
    error = null;
    _notify();
    try {
      await _editing;
      await _render;
      await _detailTask;
      if (cubeSize != null) {
        return await engine.exportCube(Map.of(params), cubeSize);
      }
      if (format == 'png8' && longEdge == null && quality == 1) {
        return await engine.developExport(Map.of(params));
      }
      return await engine.exportImage(
        Map.of(params),
        format: format,
        longEdge: longEdge,
        quality: quality,
      );
    } catch (e) {
      error = e.toString();
      return null;
    } finally {
      exporting = false;
      _notify();
      if (_rendered != _revision) _scheduleRender();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _events?.cancel();
    Future<void>(() async {
      await _editing;
      await _render;
      await _detailTask;
      await engine.close();
    }).catchError((Object _) {});
    super.dispose();
  }
}
