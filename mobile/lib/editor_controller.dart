import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/foundation.dart';

/// One render in flight; slider changes replace the pending value instead of queuing frames.
class EditorController extends ChangeNotifier {
  EditorController(this.engine);
  final ExposureEngine engine;
  NativePhoto? photo;
  double exposureEv = 0;
  bool loading = false;
  bool exporting = false;
  String? error;
  bool _rendering = false;
  bool _disposed = false;
  int _revision = 0;
  int _photoGeneration = 0;

  Future<void> open(String path) async {
    final generation = ++_photoGeneration;
    loading = true;
    error = null;
    _notify();
    try {
      final next = await engine.open(path);
      if (_disposed || generation != _photoGeneration) return;
      photo = next;
      exposureEv = 0;
      _revision++;
    } catch (e) {
      if (generation == _photoGeneration) error = e.toString();
    } finally {
      if (generation == _photoGeneration) {
        loading = false;
        _notify();
      }
    }
  }

  void setExposure(double value) {
    if (photo == null || loading || exporting) return;
    exposureEv = value.clamp(-5.0, 5.0).toDouble();
    _revision++;
    error = null;
    _notify();
    if (!_rendering) _drain();
  }

  Future<void> _drain() async {
    _rendering = true;
    try {
      while (!_disposed && photo != null && !loading && !exporting) {
        final revision = _revision;
        try {
          await engine.render(exposureEv);
        } catch (e) {
          error = e.toString();
          _notify();
          break;
        }
        if (revision == _revision) break;
      }
    } finally {
      _rendering = false;
    }
  }

  Future<String?> export() async {
    if (photo == null || exporting || loading) return null;
    exporting = true;
    error = null;
    _notify();
    try {
      return await engine.export(exposureEv);
    } catch (e) {
      error = e.toString();
      return null;
    } finally {
      exporting = false;
      _notify();
    }
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    _photoGeneration++;
    engine.close().catchError((Object _) {});
    super.dispose();
  }
}
