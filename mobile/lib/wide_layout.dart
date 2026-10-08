part of 'native_editor_screen.dart';

/// The web regular layout (Editor.tsx `WideLayout`), used on iPad in
/// landscape and on a phone held sideways: window toolbar, Stocks sidebar,
/// photo with a status bar, and the Parameters inspector.
extension _WideLayout on _NativeEditorScreenState {
  static const _hairline = Color(0x1f8e8e93);

  Widget _toolButton(
    String label,
    String glyph, {
    VoidCallback? onTap,
    bool selected = false,
  }) {
    if (useNativeControls) {
      return NativeButton(
        label: label,
        symbol: sfSymbol(glyph),
        style: 'plain',
        selected: selected,
        width: 36,
        height: 36,
        symbolSize: 15,
        onTap: onTap,
      );
    }
    return Press(
      label: label,
      plain: !selected,
      selected: selected,
      radius: 8,
      onTap: onTap,
      child: Glyph(glyph, size: 17, color: selected ? signalBlue : null),
    );
  }

  /// "Portra 400 › Portra Endura": each part opens its list in the sidebar.
  Widget _recipePath() {
    final s = stocks, p = controller.params;
    final film = s.filmEnabled
        ? s.info('film', p['film'] as String?)['name'] as String
        : 'Film Off';
    final paper = !s.filmEnabled && !Stocks.isPrintLut(p['paper'] as String?)
        ? 'Neutral negative'
        : s.scan
        ? 'Scanned'
        : s.info('paper', p['paper'] as String?)['name'] as String;
    Widget segment(String text, String kind, {bool second = false}) => Flexible(
      child: Tooltip(
        message: kind == 'film'
            ? '$film: show in Film list'
            : s.scan
            ? 'Scanned, no paper: show Paper list'
            : '$paper: show in Paper list',
        child: Material(
          color: const Color(0x14787880),
          borderRadius: BorderRadius.circular(7),
          child: InkWell(
            borderRadius: BorderRadius.circular(7),
            onTap: () => update(() {
              sidebarTab.value = kind;
              sidebarReveal++;
            }),
            child: Container(
              height: 24,
              padding: const EdgeInsets.symmetric(horizontal: 7),
              alignment: Alignment.center,
              child: Text(
                text,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  fontWeight: second ? FontWeight.w400 : FontWeight.w500,
                  color: second ? secondary : null,
                ),
              ),
            ),
          ),
        ),
      ),
    );
    return Semantics(
      label: 'Recipe',
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          segment(film, 'film'),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 2),
            child: Glyph('chevronRight', size: 12, color: secondary),
          ),
          segment(paper, 'paper', second: true),
        ],
      ),
    );
  }

  Widget _windowToolbar() {
    final photo = controller.photo != null, c = controller;
    return Container(
      height: 52,
      padding: const EdgeInsets.fromLTRB(16, 0, 10, 0),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: _hairline)),
      ),
      child: c.erasing
          ? const Row(
              children: [
                Text(
                  'Remove Object',
                  style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
                ),
                SizedBox(width: 10),
                Text(
                  'Original · grading paused',
                  style: TextStyle(fontSize: 13, color: secondary),
                ),
              ],
            )
          : Row(
              children: [
                ConstrainedBox(
                  constraints: const BoxConstraints(
                    minWidth: 120,
                    maxWidth: 380,
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    crossAxisAlignment: CrossAxisAlignment.baseline,
                    textBaseline: TextBaseline.alphabetic,
                    children: [
                      const Text(
                        'DICHROIC',
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 1.56,
                        ),
                      ),
                      const SizedBox(width: 10),
                      Flexible(
                        child: Text(
                          c.fileName ?? 'No photo',
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(
                            fontSize: 13,
                            color: secondary,
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(width: 6),
                _toolButton(
                  'Open Photo',
                  'open',
                  onTap: c.busy ? null : openPhoto,
                ),
                _toolButton(
                  'Close Photo',
                  'close',
                  onTap: photo && !c.busy ? closePhoto : null,
                ),
                Expanded(child: Center(child: photo ? _recipePath() : null)),
                _toolButton(
                  'Undo',
                  'undo',
                  onTap: c.canUndo && !c.busy ? c.undo : null,
                ),
                _toolButton(
                  'Redo',
                  'redo',
                  onTap: c.canRedo && !c.busy ? c.redo : null,
                ),
                Container(
                  width: 1,
                  height: 18,
                  margin: const EdgeInsets.symmetric(horizontal: 4),
                  color: _hairline,
                ),
                _toolButton(
                  'Before / After',
                  'compare',
                  selected: compare,
                  onTap: photo ? () => update(() => compare = !compare) : null,
                ),
                ListenableBuilder(
                  listenable: wideScopes,
                  builder: (context, _) => _toolButton(
                    'Scopes',
                    'scope',
                    selected: wideScopes.open,
                    onTap: photo ? toggleScopes : null,
                  ),
                ),
                _toolButton(
                  'Remove Object',
                  'erase',
                  onTap: photo && !c.busy ? startRemoval : null,
                ),
                ValueListenableBuilder<ThemeMode>(
                  valueListenable: appearance,
                  builder: (context, mode, _) => _toolButton(
                    'Appearance: ${appearanceLabels[mode]}',
                    const {
                      ThemeMode.system: 'themeSystem',
                      ThemeMode.light: 'themeLight',
                      ThemeMode.dark: 'themeDark',
                    }[mode]!,
                    onTap: cycleAppearance,
                  ),
                ),
                const SizedBox(width: 6),
                if (useNativeControls)
                  NativeButton(
                    label: 'Export',
                    title: 'Export',
                    symbol: 'square.and.arrow.up',
                    style: 'prominent',
                    height: 32,
                    symbolSize: 13,
                    fontSize: 13,
                    width: 92,
                    onTap: photo && !c.busy ? export : null,
                  )
                else
                  Press(
                    label: 'Export',
                    selected: true,
                    filled: true,
                    radius: 16,
                    onTap: photo && !c.busy ? export : null,
                    child: const Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Glyph('share', size: 14, color: Colors.white),
                        SizedBox(width: 6),
                        Text('Export', style: TextStyle(color: Colors.white)),
                      ],
                    ),
                  ),
              ],
            ),
    );
  }

  Widget _statusBar() {
    final c = controller, photo = c.photo;
    final out = c.params['outputColorSpace'] as String? ?? 'sRGB';
    const style = TextStyle(fontSize: 11, color: secondary);
    const dot = Text(
      '·',
      style: TextStyle(fontSize: 11, color: Color(0x668e8e93)),
    );
    return Container(
      height: 28,
      padding: const EdgeInsets.symmetric(horizontal: 12),
      decoration: const BoxDecoration(
        border: Border(top: BorderSide(color: _hairline)),
      ),
      child: DefaultTextStyle(
        style: style,
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
        child: Row(
          children: [
            Flexible(
              child: Text(
                photo == null
                    ? 'No photo open'
                    : 'Preview ${photo.width} × ${photo.height}',
                style: const TextStyle(
                  fontFeatures: [FontFeature.tabularFigures()],
                ),
              ),
            ),
            const SizedBox(width: 12),
            dot,
            const SizedBox(width: 12),
            Flexible(
              child: Text(
                c.erasing
                    ? 'Original · grading paused'
                    : '$out${out == 'sRGB' || out == 'Display P3' ? '' : ', shown without conversion'}',
              ),
            ),
            if (!c.erasing && c.rendering && photo != null) ...[
              const SizedBox(width: 12),
              dot,
              const SizedBox(width: 12),
              const Text(
                'Developing…',
                style: TextStyle(color: Color(0xff5cb8ff)),
              ),
            ],
            const Spacer(),
            const Flexible(child: Text('Developed on this device')),
          ],
        ),
      ),
    );
  }

  /// Small icon tabs with the edited dot (web `GroupTabs small`).
  Widget _inspectorTabs() {
    final groups = controller.groups;
    final index = groups.indexWhere((g) => g['id'] == groupId);
    return Container(
      padding: const EdgeInsets.fromLTRB(8, 6, 8, 6),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: _hairline)),
      ),
      child: useNativeControls
          ? NativeSegmented(
              items: [for (final g in groups) g['label'] as String],
              symbols: [for (final g in groups) sfSymbol(g['icon'] as String)],
              marked: [
                for (var i = 0; i < groups.length; i++)
                  if (groups[i]['modified'] == true) i,
              ],
              selected: index.clamp(0, groups.length),
              height: 28,
              onChanged: (i) =>
                  update(() => groupId = groups[i]['id'] as String),
            )
          : Row(
              mainAxisAlignment: MainAxisAlignment.spaceEvenly,
              children: [
                for (final g in groups)
                  Tooltip(
                    message: g['label'] as String,
                    child: InkWell(
                      onTap: () => update(() => groupId = g['id'] as String),
                      child: Container(
                        height: 32,
                        width: 36,
                        decoration: BoxDecoration(
                          border: Border(
                            bottom: BorderSide(
                              width: 2,
                              color: g['id'] == groupId
                                  ? signalBlue
                                  : Colors.transparent,
                            ),
                          ),
                        ),
                        child: Stack(
                          alignment: Alignment.center,
                          children: [
                            Glyph(
                              g['icon'] as String,
                              size: 17,
                              color: g['id'] == groupId
                                  ? signalBlue
                                  : secondary,
                            ),
                            if (g['modified'] == true)
                              const Positioned(
                                right: 4,
                                top: 4,
                                child: SizedBox.square(
                                  dimension: 5,
                                  child: DecoratedBox(
                                    decoration: BoxDecoration(
                                      color: signalBlue,
                                      shape: BoxShape.circle,
                                    ),
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
              ],
            ),
    );
  }

  Widget _inspector(BoxConstraints window) {
    final c = controller;
    if (c.erasing) {
      return SingleChildScrollView(
        physics: const BouncingScrollPhysics(),
        child: removalControls(),
      );
    }
    final group = c.groups.where((g) => g['id'] == groupId).firstOrNull;
    final tools = (group?['tools'] as List? ?? []).cast<Json>();
    final rows = <Widget>[];
    String? section;
    for (final tool in tools) {
      final next = tool['section'] as String?;
      if (next != null && next != section) {
        rows.add(
          Container(
            margin: const EdgeInsets.fromLTRB(12, 12, 12, 2),
            padding: const EdgeInsets.only(top: 10),
            constraints: const BoxConstraints(minHeight: 34),
            decoration: const BoxDecoration(
              border: Border(top: BorderSide(color: _hairline)),
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    next,
                    style: const TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
                if (next == 'White Balance')
                  TextButton(
                    onPressed: c.busy
                        ? null
                        : () => c.edit('fields', 'whiteBalance', {
                            'cameraWhiteBalanceK':
                                c.defaults['cameraWhiteBalanceK'],
                            'cameraTint': c.defaults['cameraTint'],
                          }),
                    child: const Text(
                      'Reset WB',
                      style: TextStyle(fontSize: 11),
                    ),
                  ),
              ],
            ),
          ),
        );
      } else if (rows.isNotEmpty && next == null) {
        rows.add(const Divider(height: 1, color: _hairline));
      }
      section = next;
      rows.add(
        InspectorRow(
          key: ValueKey(tool['id']),
          tool: tool,
          controller: c,
          sectioned: next != null,
        ),
      );
    }
    return Column(
      children: [
        _inspectorTabs(),
        Expanded(
          child: EditorScrollView(
            builder: (scroll) => SingleChildScrollView(
              key: ValueKey('inspector-$groupId'),
              controller: scroll,
              physics: const BouncingScrollPhysics(),
              padding: const EdgeInsets.only(bottom: 12),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SizedBox(
                    height: 36,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 12),
                      child: Align(
                        alignment: Alignment.centerLeft,
                        child: Text(
                          group?['label'] as String? ?? '',
                          style: const TextStyle(
                            fontSize: 17,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                    ),
                  ),
                  if (groupId == 'camera')
                    const Padding(
                      padding: EdgeInsets.fromLTRB(12, 0, 12, 4),
                      child: Text(
                        'Before film · WB relative to the decoded image.',
                        style: TextStyle(fontSize: 13, color: secondary),
                      ),
                    ),
                  ...rows,
                ],
              ),
            ),
          ),
        ),
        // Pinned under the rows; on short windows it scrolls rather than
        // pushing Reset All away.
        Flexible(
          flex: 2,
          child: ListenableBuilder(
            listenable: wideScopes,
            builder: (context, _) => c.photo != null && wideScopes.open
                ? SingleChildScrollView(
                    physics: const ClampingScrollPhysics(),
                    child: ScopePanel(
                      engine: c.engine,
                      prefs: wideScopes,
                      frame: c.frames,
                      window: window.biggest,
                    ),
                  )
                : const SizedBox.shrink(),
          ),
        ),
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
          decoration: const BoxDecoration(
            border: Border(top: BorderSide(color: _hairline)),
          ),
          alignment: Alignment.centerRight,
          child: OutlinedButton(
            onPressed: c.edited && !c.busy ? c.resetAll : null,
            style: OutlinedButton.styleFrom(
              shape: const StadiumBorder(),
              side: const BorderSide(color: Color(0x298e8e93)),
            ),
            child: const Text('Reset All'),
          ),
        ),
      ],
    );
  }

  /// The whole regular layout.
  Widget wideLayout(BoxConstraints window, {required bool phone}) {
    final c = controller, photo = c.photo != null;
    final inert = !photo || c.erasing;
    final sidebarWidth = phone ? 200.0 : 260.0;
    final inspectorWidth = phone ? 264.0 : 300.0;
    return Column(
      children: [
        _windowToolbar(),
        Expanded(
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Container(
                width: sidebarWidth,
                padding: const EdgeInsets.only(top: 10),
                decoration: const BoxDecoration(
                  border: Border(right: BorderSide(color: _hairline)),
                ),
                child: IgnorePointer(
                  ignoring: inert,
                  child: Opacity(
                    opacity: photo ? 1 : .6,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 8),
                      child: StockSheet(
                        controller: c,
                        dense: true,
                        tab: sidebarTab,
                        reveal: sidebarReveal,
                      ),
                    ),
                  ),
                ),
              ),
              Expanded(
                child: Column(
                  children: [
                    Expanded(
                      child: photo
                          ? photoView(compareButton: false)
                          : StartScreen(
                              onChoose: c.loading ? null : openPhoto,
                              regular: true,
                            ),
                    ),
                    _statusBar(),
                  ],
                ),
              ),
              Container(
                width: inspectorWidth,
                decoration: const BoxDecoration(
                  border: Border(left: BorderSide(color: _hairline)),
                ),
                child: IgnorePointer(
                  ignoring: !photo,
                  child: Opacity(
                    opacity: photo ? 1 : .6,
                    child: _inspector(window),
                  ),
                ),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

/// One tool as an inspector row (web `InspectorTool`): title with the
/// edited dot, value, reset, stepper or pop-up and switch in the header;
/// the slider, list button or note underneath.
class InspectorRow extends StatelessWidget {
  const InspectorRow({
    super.key,
    required this.tool,
    required this.controller,
    this.sectioned = false,
  });
  final Json tool;
  final NativeEditorController controller;

  /// Camera rows under a section header: tighter, without the slider note.
  final bool sectioned;

  static const _note = TextStyle(
    fontSize: 11,
    height: 14 / 11,
    color: secondary,
  );

  Widget _small(String label, String glyph, VoidCallback? onTap) => SizedBox(
    width: 26,
    height: 26,
    child: useNativeControls
        ? NativeButton(
            label: label,
            symbol: sfSymbol(glyph),
            style: 'plain',
            width: 26,
            height: 26,
            symbolSize: 11,
            onTap: onTap,
          )
        : IconButton(
            tooltip: label,
            padding: EdgeInsets.zero,
            iconSize: 13,
            onPressed: onTap,
            icon: Glyph(glyph, size: 13),
          ),
  );

  Widget _popUp(
    BuildContext context,
    String label,
    List<Json> options,
    String value,
    ValueChanged<String>? onPick,
  ) {
    final current =
        options.where((o) => o['value'] == value).firstOrNull?['label']
            as String? ??
        value;
    if (useNativeControls) {
      return SizedBox(
        height: 26,
        width: 140,
        child: NativeButton(
          label: label,
          title: current,
          symbol: 'chevron.up.chevron.down',
          symbolSize: 10,
          fontSize: 13,
          imageTrailing: true,
          height: 26,
          width: 140,
          menu: [
            for (final o in options)
              NativeMenuItem(
                id: o['value'] as String,
                title: o['label'] as String,
                section: o['group'] as String?,
                checked: o['value'] == value,
              ),
          ],
          onMenu: onPick,
        ),
      );
    }
    return TextButton(
      onPressed: onPick == null
          ? null
          : () => editorSheet<void>(
              context,
              OptionSheet(
                title: label,
                options: options,
                value: value,
                onSelect: onPick,
              ),
            ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(current, style: const TextStyle(fontSize: 13)),
          const SizedBox(width: 4),
          const Glyph('upDown', size: 12),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final c = controller, p = c.params, id = tool['id'] as String;
    final kind = tool['kind'] as String, title = tool['title'] as String;
    final enabled = !c.busy && tool['enabled'] != false;
    void fields(Json value) => c.edit('fields', id, value);
    final switchField = (kind == 'toggle' || kind == 'lens')
        ? tool['field'] as String
        : tool['enabledBy'] as String?;
    final options = (tool['options'] as List?)?.cast<Json>() ?? const [];
    final longChoice = kind == 'choice' && options.length > 10;
    final tint = tool['tint'] as String?;

    Widget? body;
    switch (kind) {
      case 'slider':
        final range = tool['range'] as Json;
        body = DetailSlider(
          value: (tool['position'] as num).toDouble(),
          min: (range['min'] as num).toDouble(),
          max: (range['max'] as num).toDouble(),
          step: (range['step'] as num).toDouble(),
          label: title,
          enabled: enabled,
          onStart: c.beginGesture,
          onEnd: c.endGesture,
          onChanged: (v) => c.edit('position', id, v),
          onReset: tool['defaultPosition'] == null
              ? null
              : () => c.edit(
                  'position',
                  id,
                  (tool['defaultPosition'] as num).toDouble(),
                ),
        );
      case 'stepper':
        body = Text(tool['hint'] as String? ?? '', style: _note);
      case 'choice':
        body = longChoice
            ? ListPress(
                label: '$title: ${tool['valueText']}. Change',
                onTap: enabled
                    ? () => editorSheet<void>(
                        context,
                        OptionSheet(
                          title: title,
                          options: options,
                          value: p[tool['field']] as String,
                          onSelect: (v) => c.edit('choice', id, v),
                        ),
                      )
                    : null,
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        tool['valueText'] as String,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13),
                      ),
                    ),
                    const Glyph('upDown', size: 14),
                  ],
                ),
              )
            : tool['note'] == null
            ? null
            : Text(tool['note'] as String, style: _note);
      case 'diffusion':
        final families = (c.catalog['diffusionFamilies'] as List).cast<Json>();
        final range =
            tool['strengthRange'] as Json? ??
            const {'min': 0, 'max': 2, 'step': .125};
        body = Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            Row(
              children: [
                const Expanded(child: Text('Filter', style: _note)),
                _popUp(
                  context,
                  '$title type',
                  families,
                  p[tool['familyField']] as String,
                  c.busy
                      ? null
                      : (v) => fields({
                          tool['familyField'] as String: v,
                          tool['enabledBy'] as String: true,
                          if ((p[tool['strengthField']] as num) <= 0)
                            tool['strengthField'] as String: .5,
                        }),
                ),
              ],
            ),
            DetailSlider(
              value: (p[tool['strengthField']] as num).toDouble(),
              min: (range['min'] as num).toDouble(),
              max: (range['max'] as num).toDouble(),
              step: (range['step'] as num).toDouble(),
              label: '$title strength',
              enabled: enabled,
              onStart: c.beginGesture,
              onEnd: c.endGesture,
              onChanged: (v) => fields({tool['strengthField'] as String: v}),
              onReset: () => fields({
                tool['strengthField'] as String: tool['defaultStrength'] ?? 0,
              }),
            ),
            if (tool['note'] != null)
              Text(tool['note'] as String, style: _note),
          ],
        );
      case 'lens':
        body = LensCard(tool: tool, controller: c);
      default:
        if (tool['note'] != null) {
          body = Text(tool['note'] as String, style: _note);
        }
    }

    return Opacity(
      opacity: kind == 'locked' ? .55 : 1,
      child: Padding(
        padding: sectioned
            ? const EdgeInsets.fromLTRB(12, 4, 12, 4)
            : const EdgeInsets.fromLTRB(12, 9, 12, 10),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          mainAxisSize: MainAxisSize.min,
          children: [
            ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 22),
              child: Row(
                children: [
                  if (tint != null) ...[
                    Container(
                      width: 7,
                      height: 7,
                      decoration: BoxDecoration(
                        color: Color(
                          int.parse('ff${tint.substring(1)}', radix: 16),
                        ),
                        borderRadius: BorderRadius.circular(2),
                      ),
                    ),
                    const SizedBox(width: 7),
                  ],
                  Flexible(
                    child: Tooltip(
                      message: kind == 'slider'
                          ? tool['note'] as String? ?? ''
                          : '',
                      child: Text(
                        title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                        ),
                      ),
                    ),
                  ),
                  if (tool['modified'] == true) ...[
                    const SizedBox(width: 7),
                    const SizedBox.square(
                      dimension: 5,
                      child: DecoratedBox(
                        decoration: BoxDecoration(
                          color: signalBlue,
                          shape: BoxShape.circle,
                        ),
                      ),
                    ),
                  ],
                  if (kind == 'locked') ...[
                    const SizedBox(width: 7),
                    const Glyph('lock', size: 12),
                  ],
                  const Spacer(),
                  if (kind == 'slider' ||
                      kind == 'diffusion' ||
                      kind == 'stepper')
                    Text(
                      kind == 'diffusion'
                          ? tool['strengthText'] as String? ?? ''
                          : tool['valueText'] as String,
                      style: const TextStyle(
                        fontSize: 13,
                        color: secondary,
                        fontFeatures: [FontFeature.tabularFigures()],
                      ),
                    ),
                  if (tool['resettable'] == true)
                    _small(
                      'Reset $title',
                      'reset',
                      c.busy ? null : () => c.edit('reset', id, null),
                    ),
                  if (kind == 'stepper') ...[
                    if (tool['field'] == 'grainSeed')
                      _small(
                        'Random grain pattern',
                        'shuffle',
                        enabled
                            ? () => fields({
                                'grainSeed': 1 + Random().nextInt(9999),
                              })
                            : null,
                      ),
                    _small(
                      'Decrease $title',
                      'minus',
                      enabled && tool['atMin'] != true
                          ? () => c.edit('step', id, -1)
                          : null,
                    ),
                    _small(
                      'Increase $title',
                      'plus',
                      enabled && tool['atMax'] != true
                          ? () => c.edit('step', id, 1)
                          : null,
                    ),
                  ],
                  if (kind == 'choice' && !longChoice)
                    _popUp(
                      context,
                      title,
                      options,
                      p[tool['field']] as String,
                      enabled ? (v) => c.edit('choice', id, v) : null,
                    ),
                  if (switchField != null)
                    Transform.scale(
                      scale: .8,
                      child: LightSwitch(
                        label: title,
                        value: p[switchField] == true,
                        onChanged:
                            c.busy ||
                                (kind == 'toggle' &&
                                    tool['field'] == 'inputCctfDecoding' &&
                                    tool['enabled'] == false)
                            ? null
                            : (v) => fields({
                                switchField: v,
                                if (v &&
                                    kind == 'diffusion' &&
                                    (p[tool['strengthField']] as num) <= 0)
                                  tool['strengthField'] as String: .5,
                              }),
                      ),
                    ),
                ],
              ),
            ),
            if (body != null)
              Padding(padding: const EdgeInsets.only(top: 6), child: body),
          ],
        ),
      ),
    );
  }
}
