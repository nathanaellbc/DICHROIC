import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';

/// UIKit composites the profiled image in its native gamut. Pixel storage and
/// image updates stay in Swift; Dart only transforms a cached image surface.
class NativePreview extends StatelessWidget {
  const NativePreview({super.key, required this.textureId});
  final int textureId;
  @override
  Widget build(BuildContext context) {
    if (defaultTargetPlatform != TargetPlatform.iOS || kIsWeb) {
      return Texture(textureId: textureId, filterQuality: FilterQuality.medium);
    }
    return UiKitView(
      key: ValueKey(textureId),
      viewType: 'dichroic/preview',
      layoutDirection: TextDirection.ltr,
      hitTestBehavior: PlatformViewHitTestBehavior.transparent,
      creationParams: {'textureId': textureId},
      creationParamsCodec: const StandardMessageCodec(),
    );
  }
}
