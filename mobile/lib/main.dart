import 'dart:io';
import 'dart:ui';
import 'package:exposure_engine/exposure_engine.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:share_plus/share_plus.dart';
import 'editor_controller.dart';

void main() => runApp(const ExposureApp());

class ExposureApp extends StatelessWidget {
  const ExposureApp({super.key});
  @override
  Widget build(BuildContext context) => MaterialApp(
    title: 'Exposure',
    debugShowCheckedModeBanner: false,
    theme: ThemeData(
      brightness: Brightness.dark,
      useMaterial3: true,
      scaffoldBackgroundColor: const Color(0xff090909),
      colorScheme: ColorScheme.fromSeed(
        seedColor: const Color(0xff3d9dff),
        brightness: Brightness.dark,
      ),
    ),
    home: const EditorScreen(),
  );
}

class EditorScreen extends StatefulWidget {
  const EditorScreen({super.key});
  @override
  State<EditorScreen> createState() => _EditorScreenState();
}

class _EditorScreenState extends State<EditorScreen> {
  final controller = EditorController(ExposureEngine());
  final picker = ImagePicker();

  @override
  void dispose() {
    controller.dispose();
    super.dispose();
  }

  Future<void> _pick() async {
    try {
      final file = await picker.pickImage(
        source: ImageSource.gallery,
        requestFullMetadata: false,
      );
      if (file != null && mounted) await controller.open(file.path);
    } catch (e) {
      if (mounted)
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Could not open photo: $e')));
    }
  }

  Future<void> _export() async {
    await showModalBottomSheet<void>(
      context: context,
      backgroundColor: const Color(0xff171717),
      showDragHandle: true,
      builder: (sheetContext) => ListenableBuilder(
        listenable: controller,
        builder: (context, _) => SafeArea(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Export photo',
                  style: Theme.of(context).textTheme.titleLarge,
                ),
                const SizedBox(height: 8),
                const Text(
                  'Original resolution · PNG · 8-bit sRGB',
                  style: TextStyle(color: Colors.white60),
                ),
                const SizedBox(height: 24),
                SizedBox(
                  width: double.infinity,
                  child: FilledButton(
                    onPressed: controller.exporting
                        ? null
                        : () async {
                            final path = await controller.export();
                            if (path == null) return;
                            if (!sheetContext.mounted || !context.mounted) {
                              if (await File(path).exists())
                                await File(path).delete();
                              return;
                            }
                            final box =
                                context.findRenderObject() as RenderBox?;
                            try {
                              await SharePlus.instance.share(
                                ShareParams(
                                  files: [XFile(path)],
                                  sharePositionOrigin: box == null
                                      ? null
                                      : box.localToGlobal(Offset.zero) &
                                            box.size,
                                ),
                              );
                            } catch (e) {
                              if (mounted)
                                ScaffoldMessenger.of(this.context).showSnackBar(
                                  SnackBar(
                                    content: Text('Could not share photo: $e'),
                                  ),
                                );
                            } finally {
                              if (await File(path).exists())
                                await File(path).delete();
                            }
                          },
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 12),
                      child: Text(
                        controller.exporting
                            ? 'Developing…'
                            : 'Develop & Share',
                      ),
                    ),
                  ),
                ),
                if (controller.error != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 12),
                    child: Text(
                      controller.error!,
                      style: const TextStyle(color: Colors.redAccent),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      final photo = controller.photo;
      return Scaffold(
        body: Stack(
          children: [
            Positioned.fill(
              child: photo == null
                  ? Center(
                      child: Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(
                            Icons.camera_outlined,
                            size: 46,
                            color: Colors.white54,
                          ),
                          const SizedBox(height: 20),
                          const Text(
                            'A little more light.',
                            style: TextStyle(
                              fontSize: 25,
                              fontWeight: FontWeight.w500,
                            ),
                          ),
                          const SizedBox(height: 24),
                          FilledButton.icon(
                            onPressed: controller.loading ? null : _pick,
                            icon: const Icon(
                              Icons.add_photo_alternate_outlined,
                            ),
                            label: const Text('Open photo'),
                          ),
                        ],
                      ),
                    )
                  : SafeArea(
                      child: Padding(
                        padding: const EdgeInsets.fromLTRB(0, 72, 0, 156),
                        child: Center(
                          child: AspectRatio(
                            aspectRatio: photo.width / photo.height,
                            child: Texture(textureId: photo.textureId),
                          ),
                        ),
                      ),
                    ),
            ),
            SafeArea(
              child: Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 20,
                  vertical: 12,
                ),
                child: Row(
                  children: [
                    const Text(
                      'EXPOSURE',
                      style: TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w700,
                        letterSpacing: 2,
                      ),
                    ),
                    const Spacer(),
                    if (photo != null)
                      IconButton(
                        tooltip: 'Open another photo',
                        onPressed: controller.loading || controller.exporting
                            ? null
                            : _pick,
                        icon: const Icon(Icons.add_photo_alternate_outlined),
                      ),
                    if (photo != null)
                      IconButton(
                        tooltip: 'Export',
                        onPressed: controller.loading || controller.exporting
                            ? null
                            : _export,
                        icon: const Icon(Icons.ios_share),
                      ),
                  ],
                ),
              ),
            ),
            if (photo != null)
              Positioned(
                left: 0,
                right: 0,
                bottom: 0,
                child: ClipRRect(
                  borderRadius: const BorderRadius.vertical(
                    top: Radius.circular(24),
                  ),
                  child: BackdropFilter(
                    filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
                    child: ColoredBox(
                      color: const Color(0xcc151515),
                      child: SafeArea(
                        top: false,
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(24, 22, 24, 20),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Row(
                                children: [
                                  const Text(
                                    'Exposure',
                                    style: TextStyle(
                                      fontSize: 16,
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  const Spacer(),
                                  Text(
                                    '${controller.exposureEv >= 0 ? '+' : ''}${controller.exposureEv.toStringAsFixed(2)} EV',
                                    style: const TextStyle(
                                      color: Colors.white60,
                                    ),
                                  ),
                                ],
                              ),
                              Slider(
                                value: controller.exposureEv,
                                min: -5,
                                max: 5,
                                onChanged:
                                    controller.loading || controller.exporting
                                    ? null
                                    : controller.setExposure,
                              ),
                              if (controller.error != null)
                                Text(
                                  controller.error!,
                                  style: const TextStyle(
                                    color: Colors.redAccent,
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            if (controller.loading)
              const Positioned.fill(
                child: ColoredBox(
                  color: Color(0x66000000),
                  child: Center(child: CircularProgressIndicator()),
                ),
              ),
          ],
        ),
      );
    },
  );
}
