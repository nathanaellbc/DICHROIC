import 'dart:async';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

typedef Json = Map<String, dynamic>;

/// Canonical host owns all photographic parameter rules. This controller
/// serializes edits, coalesces slider samples, and retains one render in flight.
class NativeEditorController extends ChangeNotifier {
  NativeEditorController(this.engine) {
    _events = engine.events.listen((event) {
      status = event['message'] as String?;
      if (event['total'] is int) {
        progressDone = event['done'] as int? ?? 0;
        progressTotal = event['total'] as int;
      }
      _depthStatus(status);
      _notify();
    }, onError: (Object _) {});
  }

  /// Toast pill, as on the web: shown for 2.2 s at the top of the editor.
  final toast = ValueNotifier<String?>(null);
  Timer? _toastTimer;
  void showToast(String text) {
    _toastTimer?.cancel();
    toast.value = text;
    _toastTimer = Timer(const Duration(milliseconds: 2200), () {
      toast.value = null;
    });
  }

  /// Export tiles developed so far, from the native progress events.
  int progressDone = 0, progressTotal = 0;

  /// Name of the opened file without its extension ("photo" when unknown).
  String sourceStem = 'photo';

  /// Lens blur depth map: 'idle', 'needs-download', 'working', 'ready' or
  /// 'error'. The model is downloaded only after the user taps Download.
  String depthState = 'idle';
  String depthPhase = 'Measuring depth';
  String? depthError;
  int depthBytes = 27258801;
  double depthSeconds = 0;
  bool _depthAllowed = false;
  DateTime? _depthStarted;

  void _depthStatus(String? message) {
    if (message == null || depthState == 'ready') return;
    if (message.startsWith('Preparing depth')) {
      depthState = 'working';
      depthPhase = 'Measuring depth';
      _depthStarted ??= DateTime.now();
    } else if (message.startsWith('Downloading depth')) {
      depthState = 'working';
      depthPhase = 'Downloading the depth model';
    }
  }

  void _resetDepth() {
    depthState = 'idle';
    depthError = null;
    _depthStarted = null;
  }

  /// Checks the model before lens blur renders; without it, asks first.
  Future<void> _checkDepth() async {
    if (params['lensBlurEnabled'] != true || depthState == 'ready') return;
    if (_depthAllowed) return;
    try {
      final model = await engine.depthModel();
      depthBytes = model.bytes;
      if (model.stored) {
        _depthAllowed = true;
      } else {
        depthState = 'needs-download';
      }
    } on Object {
      // Hosts without the native plugin (tests) treat the model as present.
      _depthAllowed = true;
    }
  }

  /// "Download" in the lens card: allows the one-time depth model download.
  void downloadDepth() {
    _depthAllowed = true;
    depthState = 'working';
    depthError = null;
    _rendered = -1;
    _notify();
    _scheduleRender();
  }

  /// Parameters sent to the renderer: lens blur waits for the depth model.
  Json get _renderParams => params['lensBlurEnabled'] == true && !_depthAllowed
      ? {...params, 'lensBlurEnabled': false}
      : Map.of(params);

  /// This file's defaults: the baseline with the decoder's input settings.
  Json get defaults => {
    ...Map<String, dynamic>.from(catalog['baseline'] as Map? ?? {}),
    if (photo != null && params.containsKey('inputColorSpace')) ...{
      'inputColorSpace': photo!.inputColorSpace,
      'inputCctfDecoding': photo!.encoding == 'encoded',
      'autoExposure': photo!.encoding == 'linear',
    },
  };

  /// Any setting differs from this file's defaults (web `isEdited`).
  bool get edited {
    if (photo == null) return false;
    final base = defaults;
    return params.entries.any(
      (e) => base.containsKey(e.key) && base[e.key] != e.value,
    );
  }

  final ExposureEngine engine;
  NativePhoto? photo;
  Json catalog = {}, params = {};
  List<Json> groups = [];
  bool loading = false, exporting = false, rendering = false;
  String? error;

  /// Alert title for [error] (web alert dialog), e.g. "Can’t Open “IMG_0001”".
  String errorTitle = 'Something Went Wrong';

  /// File being opened, for the "Opening …" card.
  String? openingName;
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
  bool _exportCancelled = false;
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
    final cachedArea = _detailAttempt?.rect;
    if (edge < _detailHighWater &&
        detail != null &&
        cachedArea != null &&
        rect.left <= cachedArea.left + 1e-6 &&
        rect.top <= cachedArea.top + 1e-6 &&
        rect.right >= cachedArea.right - 1e-6 &&
        rect.bottom >= cachedArea.bottom - 1e-6) {
      // Pure zoom-out retains the current high-resolution overlay. Panning to
      // another area still requests new detail at the retained resolution.
      return;
    }
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
      removalStatus = 'Brush over the object, then choose Remove.';
      removalError = null;
    } catch (e) {
      error = e.toString();
    } finally {
      loading = false;
      _notify();
    }
  }

  /// Remove Object status and error lines (web Remove.tsx).
  String removalStatus = '';
  String? removalError;
  bool get canUndoRemoval => _removalCursor > 0;

  String _message(Object e) =>
      e is PlatformException ? e.message ?? e.code : e.toString();

  /// Apply keeps the previewed removal and stays in Remove Object.
  Future<void> applyRemoval() async {
    if (busy || !erasing || !removalReady) return;
    removalStatus = 'Applying removal…';
    removalError = null;
    await finishRemoval(apply: true);
    await _render;
    await beginRemoval();
    removalStatus = 'Applied. Film and export use the retouched photo.';
    _notify();
  }

  /// "Undo remove": steps back over the last applied removal.
  Future<void> undoRemoval() async {
    if (busy || !erasing || removalReady || !canUndoRemoval) return;
    removing = true;
    removalStatus = 'Undoing removal…';
    removalError = null;
    _notify();
    try {
      await engine.cancelRemoval();
      final before = _snapshot();
      await engine.restoreRemoval(_removalCursor - 1);
      _removalCursor--;
      _resetDepth();
      _undo.add(before);
      _redo.clear();
      _trimHistory();
      _revision++;
      _rendered = -1;
      await engine.beginRemoval();
      removalStatus = 'Removal undone.';
    } catch (e) {
      removalError = _message(e);
    } finally {
      removing = false;
      _notify();
    }
  }

  Future<void> previewRemoval(Uint8List mask, int width, int height) async {
    if (busy || !erasing) return;
    removing = true;
    removalError = null;
    removalStatus = 'Preparing the selected area…';
    removalReady = false;
    _notify();
    try {
      await engine.previewRemoval(mask, width, height);
      removalReady = true;
      removalStatus = 'Preview ready. Apply to keep this removal.';
    } catch (e) {
      removalError = _message(e);
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
        _resetDepth();
        _undo.add(before);
        _redo.clear();
        _trimHistory();
        _revision++;
      } else {
        await engine.cancelRemoval();
      }
      erasing = false;
      removalReady = false;
      _invalidateDetail();
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
      removalStatus = 'Brush over the object, then choose Remove.';
    } catch (e) {
      removalError = _message(e);
    } finally {
      removing = false;
      _notify();
    }
  }

  /// The alert was dismissed.
  void clearError() {
    error = null;
    errorTitle = 'Something Went Wrong';
    _notify();
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
    final aspect = photo == null || photo!.height == 0
        ? 1.5
        : photo!.width / photo!.height;
    groups = (await engine.controls({
      ...params,
      'viewAspect': aspect,
    })).cast<Json>();
  }

  Future<void> open(String path) async {
    if (busy) return;
    loading = true;
    openingName = stemOf(path);
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
      sourceStem = stemOf(path);
      // As on the web: film, paper, adjustments and lens settings carry over
      // to the next photo; input color space, auto exposure and the focus
      // point belong to the file.
      params = params.isEmpty
          ? Map<String, dynamic>.from(catalog['baseline'] as Map)
          : Map.of(params);
      if (params.containsKey('inputColorSpace')) {
        params['inputColorSpace'] = next.inputColorSpace;
        params['inputCctfDecoding'] = next.encoding == 'encoded';
        params['autoExposure'] = next.encoding == 'linear';
      }
      if (params.containsKey('lensFocusX')) {
        params['lensFocusX'] = .5;
        params['lensFocusY'] = .5;
      }
      _resetDepth();
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
      errorTitle = 'Can’t Open “${stemOf(path)}”';
      error = e is PlatformException ? e.message ?? e.code : e.toString();
    } finally {
      loading = false;
      openingName = null;
      _notify();
    }
    if (photo != null && error == null) {
      await _checkDepth();
      _notify();
      _scheduleRender();
    }
  }

  /// Closes the photo and releases the renderer (web "Close Photo"). The
  /// look stays for the next photo.
  Future<void> closePhoto() async {
    if (busy || photo == null) return;
    loading = true;
    _notify();
    try {
      await _editing;
      await _render;
      await _detailTask;
      await engine.close();
    } catch (e) {
      error = e.toString();
    } finally {
      photo = null;
      groups = [];
      _undo.clear();
      _redo.clear();
      _gestureBefore = null;
      _removalCursor = 0;
      erasing = false;
      removalReady = false;
      detail = null;
      _detailQueued = null;
      _detailWish = null;
      _detailAttempt = null;
      _detailHighWater = 0;
      status = null;
      _resetDepth();
      _revision++;
      _rendered = -1;
      loading = false;
      _notify();
    }
  }

  /// File stem for export names; picker copies carry the original after "--".
  static String stemOf(String path) {
    var name = path.split('/').last.split(r'\').last;
    final dot = name.lastIndexOf('.');
    if (dot > 0) name = name.substring(0, dot);
    if (name.startsWith('Dichroic-import-')) {
      final mark = name.indexOf('--');
      name = mark < 0 ? '' : name.substring(mark + 2);
    }
    return name.trim().isEmpty ? 'photo' : name.trim();
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
          final lensOn =
              next['lensBlurEnabled'] == true &&
              params['lensBlurEnabled'] != true;
          params = next;
          _revision++;
          _invalidateDetail();
          error = null;
          if (lensOn) await _checkDepth();
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
        final depth = params['lensBlurEnabled'] == true && _depthAllowed;
        try {
          await engine.develop(_renderParams);
        } catch (e) {
          if (depth && depthState != 'ready') {
            depthState = 'error';
            depthError = e is PlatformException ? e.message : e.toString();
          }
          rethrow;
        }
        if (depth && depthState != 'ready') {
          depthState = 'ready';
          depthSeconds = _depthStarted == null
              ? 0
              : DateTime.now().difference(_depthStarted!).inMilliseconds / 1000;
        }
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

  Future<void> undo() => _history(_undo, _redo);

  Future<void> redo() => _history(_redo, _undo);

  Future<void> _history(List<Json> from, List<Json> to) async {
    if (busy || erasing) return;
    loading = true;
    error = null;
    _notify();
    try {
      await _editing;
      await _render;
      await _detailTask;
      if (from.isEmpty) return;
      final before = _snapshot();
      await _restore(from.last);
      from.removeLast();
      to.add(before);
      _revision++;
      await _controls();
    } catch (e) {
      error = e.toString();
    } finally {
      loading = false;
      _notify();
      _scheduleRender();
    }
  }

  Future<void> resetAll() => edit('fields', 'all', {
    ...Map<String, dynamic>.from(catalog['baseline'] as Map),
    if (params.containsKey('inputColorSpace')) ...{
      'inputColorSpace': photo!.inputColorSpace,
      'inputCctfDecoding': photo!.encoding == 'encoded',
      'autoExposure': photo!.encoding == 'linear',
    },
  });
  Future<void> _restore(Json snapshot) async {
    final restored = Map<String, dynamic>.of(snapshot);
    final cursor = restored.remove('_retouchCursor') as int? ?? 0;
    if (_removalCursor != cursor) {
      await _render;
      await engine.restoreRemoval(cursor);
      _removalCursor = cursor;
      _resetDepth();
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
    _exportCancelled = false;
    exportError = null;
    progressDone = 0;
    progressTotal = 0;
    _notify();
    try {
      await _editing;
      await _render;
      await _detailTask;
      if (_exportCancelled) return null;
      if (cubeSize != null) {
        return await engine.exportCube(_renderParams, cubeSize);
      }
      if (format == 'png8' && longEdge == null && quality == 1) {
        return await engine.developExport(_renderParams);
      }
      return await engine.exportImage(
        _renderParams,
        format: format,
        longEdge: longEdge,
        quality: quality,
      );
    } catch (e) {
      // Shown inside the export sheet, as on the web; never an alert.
      if (!_exportCancelled) {
        exportError = e is PlatformException
            ? e.message ?? e.code
            : e.toString();
      }
      return null;
    } finally {
      // Progress messages ("Developing…") end with the export.
      status = null;
      exporting = false;
      _notify();
      if (_rendered != _revision) _scheduleRender();
    }
  }

  /// The last export's technical error, shown under the sheet's message.
  String? exportError;

  Future<void> cancelExport() async {
    if (!exporting) return;
    _exportCancelled = true;
    status = 'Stopping…';
    _notify();
    await engine.cancelExport();
  }

  @override
  void dispose() {
    _disposed = true;
    _generation++;
    _events?.cancel();
    _toastTimer?.cancel();
    toast.dispose();
    Future<void>(() async {
      await _editing;
      await _render;
      await _detailTask;
      await engine.close();
    }).catchError((Object _) {});
    super.dispose();
  }
}
