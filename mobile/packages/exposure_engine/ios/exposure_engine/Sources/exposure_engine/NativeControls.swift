import Flutter
import UIKit

/// Real UIKit controls for the Flutter editor. Built with the iOS 26 SDK they
/// are the system's own Liquid Glass controls (slider thumb, switch, glass
/// buttons, pull-down menus, segmented control) with their native gestures,
/// haptics and animations; on older SDKs/OS versions the classic styles apply.
///
/// Every control is a platform view with its own method channel
/// `dichroic/control/<viewId>`: Dart sends `update` with the full parameter
/// map, the view sends events (`tap`, `change`, `start`, `end`, `step`,
/// `menu`, `select`).
enum NativeControls {
    static func register(with registrar: FlutterPluginRegistrar) {
        let messenger = registrar.messenger()
        let kinds: [(String, (ControlArgs) -> ControlView)] = [
            ("dichroic/slider", { SliderControl($0) }),
            ("dichroic/switch", { SwitchControl($0) }),
            ("dichroic/button", { ButtonControl($0) }),
            ("dichroic/segmented", { SegmentedControl($0) }),
            ("dichroic/stepper", { StepperControl($0) }),
            ("dichroic/toolstrip", { ToolStripControl($0) }),
            ("dichroic/glass", { GlassControl($0) }),
        ]
        for (id, make) in kinds {
            registrar.register(ControlFactory(messenger: messenger, make: make), withId: id)
        }
    }
}

let signalBlue = UIColor(red: 0, green: 0x91 / 255.0, blue: 1, alpha: 1)

struct ControlArgs {
    let frame: CGRect
    let params: [String: Any]
    let channel: FlutterMethodChannel
}

/// Base class: owns the container view and the channel, routes `update`.
class ControlView: NSObject, FlutterPlatformView {
    let container: UIView
    let channel: FlutterMethodChannel

    init(_ args: ControlArgs) {
        container = UIView(frame: args.frame)
        container.backgroundColor = .clear
        channel = args.channel
        super.init()
        channel.setMethodCallHandler { [weak self] call, result in
            if call.method == "update", let params = call.arguments as? [String: Any] {
                self?.apply(params)
            }
            result(nil)
        }
    }

    func view() -> UIView { container }

    /// Applies the full parameter map (initial creation and every update).
    func apply(_ params: [String: Any]) {}

    func send(_ method: String, _ value: Any? = nil) {
        channel.invokeMethod(method, arguments: value)
    }

    /// Pins `child` to the container's edges.
    func fill(_ child: UIView) {
        child.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(child)
        NSLayoutConstraint.activate([
            child.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            child.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            child.topAnchor.constraint(equalTo: container.topAnchor),
            child.bottomAnchor.constraint(equalTo: container.bottomAnchor),
        ])
    }
}

private final class ControlFactory: NSObject, FlutterPlatformViewFactory {
    private let messenger: FlutterBinaryMessenger
    private let make: (ControlArgs) -> ControlView

    init(messenger: FlutterBinaryMessenger, make: @escaping (ControlArgs) -> ControlView) {
        self.messenger = messenger
        self.make = make
        super.init()
    }

    func create(withFrame frame: CGRect, viewIdentifier viewId: Int64, arguments args: Any?) -> FlutterPlatformView {
        let channel = FlutterMethodChannel(name: "dichroic/control/\(viewId)", binaryMessenger: messenger)
        let params = args as? [String: Any] ?? [:]
        let control = make(ControlArgs(frame: frame, params: params, channel: channel))
        control.apply(params)
        return control
    }

    func createArgsCodec() -> FlutterMessageCodec & NSObjectProtocol {
        FlutterStandardMessageCodec.sharedInstance()
    }
}

// MARK: - Parameter helpers

private extension Dictionary where Key == String, Value == Any {
    func double(_ key: String) -> Double? { (self[key] as? NSNumber)?.doubleValue }
    func bool(_ key: String) -> Bool? { (self[key] as? NSNumber)?.boolValue }
    func int(_ key: String) -> Int? { (self[key] as? NSNumber)?.intValue }
    func string(_ key: String) -> String? { self[key] as? String }
}

func symbolImage(_ name: String?, size: CGFloat, weight: UIImage.SymbolWeight = .semibold) -> UIImage? {
    guard let name, !name.isEmpty else { return nil }
    let config = UIImage.SymbolConfiguration(pointSize: size, weight: weight)
    return UIImage(systemName: name, withConfiguration: config)
        ?? UIImage(systemName: "circle", withConfiguration: config)
}

/// iOS 26 glass button configurations, compiled only with the iOS 26 SDK
/// (Swift 6.2); otherwise the classic configurations.
private func buttonConfiguration(style: String) -> UIButton.Configuration {
    #if compiler(>=6.2)
    if #available(iOS 26.0, *) {
        switch style {
        case "prominent": return .prominentGlass()
        case "plain": return .plain()
        case "clear": return .clearGlass()
        default: return .glass()
        }
    }
    #endif
    switch style {
    case "prominent": return .filled()
    case "plain", "clear": return .plain()
    default: return .gray()
    }
}

// MARK: - Slider

private final class SliderControl: ControlView {
    private let slider = UISlider()
    private var tracking = false

    override init(_ args: ControlArgs) {
        super.init(args)
        slider.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(slider)
        NSLayoutConstraint.activate([
            slider.leadingAnchor.constraint(equalTo: container.leadingAnchor),
            slider.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            slider.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        slider.minimumTrackTintColor = signalBlue
        slider.isContinuous = true
        slider.addTarget(self, action: #selector(began), for: .touchDown)
        slider.addTarget(self, action: #selector(changed), for: .valueChanged)
        slider.addTarget(self, action: #selector(ended), for: [.touchUpInside, .touchUpOutside, .touchCancel])
        // Double-tap restores the default, like double-click on the web slider.
        let reset = UITapGestureRecognizer(target: self, action: #selector(resetTapped))
        reset.numberOfTapsRequired = 2
        reset.cancelsTouchesInView = false
        slider.addGestureRecognizer(reset)
    }

    @objc private func resetTapped() {
        guard slider.isEnabled else { return }
        tracking = false
        send("reset")
    }

    override func apply(_ p: [String: Any]) {
        if let min = p.double("min") { slider.minimumValue = Float(min) }
        if let max = p.double("max") { slider.maximumValue = Float(max) }
        slider.isEnabled = p.bool("enabled") ?? true
        slider.accessibilityLabel = p.string("label")
        // While the finger is down the slider owns its value; Dart's snapped
        // echo would make the thumb stutter.
        if !tracking, let value = p.double("value") { slider.setValue(Float(value), animated: false) }
    }

    @objc private func began() {
        tracking = true
        send("start")
    }

    @objc private func changed() { send("change", Double(slider.value)) }

    @objc private func ended() {
        tracking = false
        send("end", Double(slider.value))
    }
}

// MARK: - Switch

private final class SwitchControl: ControlView {
    private let toggle = UISwitch()

    override init(_ args: ControlArgs) {
        super.init(args)
        toggle.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(toggle)
        NSLayoutConstraint.activate([
            toggle.centerXAnchor.constraint(equalTo: container.centerXAnchor),
            toggle.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        toggle.onTintColor = signalBlue
        toggle.addTarget(self, action: #selector(changed), for: .valueChanged)
    }

    override func apply(_ p: [String: Any]) {
        toggle.isEnabled = p.bool("enabled") ?? true
        toggle.accessibilityLabel = p.string("label")
        if let value = p.bool("value"), value != toggle.isOn { toggle.setOn(value, animated: true) }
    }

    @objc private func changed() { send("change", toggle.isOn) }
}

// MARK: - Button (optionally a pull-down menu)

private final class ButtonControl: ControlView {
    private let button = UIButton(type: .system)

    override init(_ args: ControlArgs) {
        super.init(args)
        fill(button)
        button.addAction(UIAction { [weak self] _ in self?.send("tap") }, for: .primaryActionTriggered)
    }

    override func apply(_ p: [String: Any]) {
        let selected = p.bool("selected") ?? false
        let style = p.string("style") ?? "glass"
        var config = buttonConfiguration(style: selected && style == "glass" ? "prominent" : style)
        let size = CGFloat(p.double("symbolSize") ?? 17)
        config.image = symbolImage(p.string("symbol"), size: size)
        config.imagePadding = 6
        config.imagePlacement = p.string("imagePlacement") == "trailing" ? .trailing : .leading
        if let title = p.string("title"), !title.isEmpty {
            var attributes = AttributeContainer()
            attributes.font = UIFont.systemFont(ofSize: CGFloat(p.double("fontSize") ?? 15), weight: .semibold)
            config.attributedTitle = AttributedString(title, attributes: attributes)
        } else {
            config.attributedTitle = nil
        }
        if let subtitle = p.string("subtitle"), !subtitle.isEmpty {
            var attributes = AttributeContainer()
            attributes.font = UIFont.systemFont(ofSize: 11, weight: .regular)
            config.attributedSubtitle = AttributedString(subtitle, attributes: attributes)
            config.titleAlignment = .leading
        } else {
            config.attributedSubtitle = nil
        }
        config.titleLineBreakMode = .byTruncatingTail
        config.cornerStyle = .capsule
        // Follows light/dark mode: white in dark, black in light.
        if style != "prominent" && !selected { config.baseForegroundColor = .label }
        if p.bool("leadingAligned") == true {
            button.contentHorizontalAlignment = .leading
            config.contentInsets = NSDirectionalEdgeInsets(top: 4, leading: 14, bottom: 4, trailing: 12)
        }
        button.configuration = config
        button.tintColor = signalBlue
        button.isEnabled = p.bool("enabled") ?? true
        button.accessibilityLabel = p.string("label")
        button.accessibilityTraits = selected ? [.button, .selected] : .button

        if let items = p["menu"] as? [[String: Any]], !items.isEmpty {
            button.menu = menu(items)
            button.showsMenuAsPrimaryAction = true
        } else {
            button.menu = nil
            button.showsMenuAsPrimaryAction = false
        }
    }

    /// Items grouped by `section` into inline sections, in first-seen order.
    private func menu(_ items: [[String: Any]]) -> UIMenu {
        var order: [String] = []
        var sections: [String: [UIMenuElement]] = [:]
        for item in items {
            let id = item.string("id") ?? ""
            var attributes: UIMenuElement.Attributes = []
            if item.bool("enabled") == false { attributes.insert(.disabled) }
            if item.bool("destructive") == true { attributes.insert(.destructive) }
            let action = UIAction(
                title: item.string("title") ?? id,
                subtitle: item.string("subtitle"),
                image: symbolImage(item.string("symbol"), size: 17, weight: .regular),
                attributes: attributes,
                state: item.bool("checked") == true ? .on : .off
            ) { [weak self] _ in self?.send("menu", id) }
            let section = item.string("section") ?? ""
            if sections[section] == nil { order.append(section) }
            sections[section, default: []].append(action)
        }
        if order.count == 1 { return UIMenu(children: sections[order[0]] ?? []) }
        return UIMenu(children: order.map { UIMenu(title: $0, options: .displayInline, children: sections[$0] ?? []) })
    }
}

// MARK: - Segmented control

private final class SegmentedControl: ControlView {
    private let segmented = UISegmentedControl()
    private var titles: [String] = []

    override init(_ args: ControlArgs) {
        super.init(args)
        fill(segmented)
        segmented.addTarget(self, action: #selector(changed), for: .valueChanged)
    }

    override func apply(_ p: [String: Any]) {
        let next = p["items"] as? [String] ?? []
        let symbols = p["symbols"] as? [String] ?? []
        let marked = Set(p["marked"] as? [Int] ?? [])
        // Icon tabs (web GroupTabs): SF Symbol per segment, with the blue
        // "edited" dot drawn into the image.
        let key = next + symbols + marked.sorted().map(String.init)
        if key != titles {
            titles = key
            segmented.removeAllSegments()
            for (i, title) in next.enumerated() {
                if i < symbols.count, let image = Self.tabImage(symbols[i], dot: marked.contains(i)) {
                    image.accessibilityLabel = title
                    segmented.insertSegment(with: image, at: i, animated: false)
                } else {
                    segmented.insertSegment(withTitle: title, at: i, animated: false)
                }
            }
        }
        segmented.isEnabled = p.bool("enabled") ?? true
        let selected = p.int("selected") ?? 0
        if segmented.selectedSegmentIndex != selected { segmented.selectedSegmentIndex = selected }
    }

    @objc private func changed() { send("change", segmented.selectedSegmentIndex) }

    private static func tabImage(_ name: String, dot: Bool) -> UIImage? {
        let config = UIImage.SymbolConfiguration(pointSize: 17, weight: .medium)
        guard let symbol = UIImage(systemName: name, withConfiguration: config) else { return nil }
        guard dot else { return symbol }
        let size = CGSize(width: symbol.size.width + 8, height: symbol.size.height + 4)
        let image = UIGraphicsImageRenderer(size: size).image { _ in
            symbol.withTintColor(.label).draw(at: CGPoint(x: 0, y: 4))
            signalBlue.setFill()
            UIBezierPath(ovalIn: CGRect(x: size.width - 5, y: 0, width: 5, height: 5)).fill()
        }
        return image.withRenderingMode(.alwaysOriginal)
    }
}

// MARK: - Stepper (reports -1 / +1 steps; Dart owns the value)

private final class StepperControl: ControlView {
    private let stepper = UIStepper()

    override init(_ args: ControlArgs) {
        super.init(args)
        stepper.translatesAutoresizingMaskIntoConstraints = false
        container.addSubview(stepper)
        NSLayoutConstraint.activate([
            stepper.trailingAnchor.constraint(equalTo: container.trailingAnchor),
            stepper.centerYAnchor.constraint(equalTo: container.centerYAnchor),
        ])
        stepper.stepValue = 1
        stepper.value = 0
        stepper.autorepeat = true
        stepper.addTarget(self, action: #selector(changed), for: .valueChanged)
    }

    override func apply(_ p: [String: Any]) {
        stepper.isEnabled = p.bool("enabled") ?? true
        stepper.accessibilityLabel = p.string("label")
        // The value rests at 0; the bounds enable or disable each half.
        stepper.minimumValue = (p.bool("canDecrement") ?? true) ? -1 : 0
        stepper.maximumValue = (p.bool("canIncrement") ?? true) ? 1 : 0
        stepper.value = 0
    }

    @objc private func changed() {
        let step = stepper.value > 0 ? 1 : -1
        stepper.value = 0
        send("step", step)
    }
}

// MARK: - Tool strip: one native horizontal scroller of icon buttons

private final class ToolStripControl: ControlView {
    private let scroll = UIScrollView()
    private let stack = UIStackView()
    private var ids: [String] = []
    private var buttons: [String: UIButton] = [:]
    private var dots: [String: UIView] = [:]
    private var selected = ""

    override init(_ args: ControlArgs) {
        super.init(args)
        fill(scroll)
        scroll.showsHorizontalScrollIndicator = false
        scroll.alwaysBounceHorizontal = true
        stack.axis = .horizontal
        stack.spacing = 4
        stack.translatesAutoresizingMaskIntoConstraints = false
        scroll.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: scroll.contentLayoutGuide.leadingAnchor, constant: 8),
            stack.trailingAnchor.constraint(equalTo: scroll.contentLayoutGuide.trailingAnchor, constant: -8),
            stack.topAnchor.constraint(equalTo: scroll.contentLayoutGuide.topAnchor),
            stack.bottomAnchor.constraint(equalTo: scroll.contentLayoutGuide.bottomAnchor),
            stack.heightAnchor.constraint(equalTo: scroll.frameLayoutGuide.heightAnchor),
        ])
    }

    override func apply(_ p: [String: Any]) {
        let items = p["items"] as? [[String: Any]] ?? []
        let nextIds = items.map { $0.string("id") ?? "" }
        if nextIds != ids {
            ids = nextIds
            buttons = [:]
            dots = [:]
            stack.arrangedSubviews.forEach { $0.removeFromSuperview() }
            for item in items { add(item) }
        }
        let nextSelected = p.string("selected") ?? ""
        for item in items {
            let id = item.string("id") ?? ""
            style(buttons[id], item: item, selected: id == nextSelected)
            dots[id]?.isHidden = item.bool("modified") != true
        }
        if nextSelected != selected {
            selected = nextSelected
            if let button = buttons[selected] {
                DispatchQueue.main.async { [weak self] in
                    guard let self else { return }
                    let frame = button.convert(button.bounds, to: self.scroll).insetBy(dx: -24, dy: 0)
                    self.scroll.scrollRectToVisible(frame, animated: true)
                }
            }
        }
    }

    private func add(_ item: [String: Any]) {
        let id = item.string("id") ?? ""
        let button = UIButton(type: .system)
        button.translatesAutoresizingMaskIntoConstraints = false
        button.widthAnchor.constraint(equalToConstant: 64).isActive = true
        button.addAction(UIAction { [weak self] _ in self?.send("select", id) }, for: .primaryActionTriggered)
        let dot = UIView()
        dot.backgroundColor = signalBlue
        dot.layer.cornerRadius = 2.5
        dot.isUserInteractionEnabled = false
        dot.translatesAutoresizingMaskIntoConstraints = false
        button.addSubview(dot)
        NSLayoutConstraint.activate([
            dot.widthAnchor.constraint(equalToConstant: 5),
            dot.heightAnchor.constraint(equalToConstant: 5),
            dot.topAnchor.constraint(equalTo: button.topAnchor, constant: 8),
            dot.trailingAnchor.constraint(equalTo: button.trailingAnchor, constant: -10),
        ])
        stack.addArrangedSubview(button)
        buttons[id] = button
        dots[id] = dot
    }

    private func style(_ button: UIButton?, item: [String: Any], selected: Bool) {
        guard let button else { return }
        var config = selected ? buttonConfiguration(style: "glass") : UIButton.Configuration.plain()
        config.image = symbolImage(item.string("symbol"), size: 19, weight: .regular)
        config.imagePlacement = .top
        config.imagePadding = 5
        var attributes = AttributeContainer()
        attributes.font = UIFont.systemFont(ofSize: 11, weight: selected ? .semibold : .regular)
        config.attributedTitle = AttributedString(item.string("label") ?? "", attributes: attributes)
        config.titleLineBreakMode = .byTruncatingTail
        // Web chips: blue when selected, dimmed when the tool is off or unusable.
        config.baseForegroundColor = selected ? signalBlue : item.bool("dimmed") == true ? .tertiaryLabel : .secondaryLabel
        if item.bool("locked") == true { config.image = symbolImage("lock.fill", size: 19, weight: .regular) }
        config.contentInsets = NSDirectionalEdgeInsets(top: 8, leading: 2, bottom: 6, trailing: 2)
        config.cornerStyle = .large
        button.configuration = config
        button.accessibilityLabel = item.string("title")
        button.accessibilityTraits = selected ? [.button, .selected] : .button
    }
}

// MARK: - Glass background (Liquid Glass on iOS 26, system material before)

private final class GlassControl: ControlView {
    private let effectView: UIVisualEffectView

    override init(_ args: ControlArgs) {
        var effect: UIVisualEffect = UIBlurEffect(style: .systemThinMaterialDark)
        #if compiler(>=6.2)
        if #available(iOS 26.0, *) { effect = UIGlassEffect(style: .regular) }
        #endif
        effectView = UIVisualEffectView(effect: effect)
        super.init(args)
        fill(effectView)
        container.isUserInteractionEnabled = false
        effectView.layer.cornerCurve = .continuous
        effectView.clipsToBounds = true
    }

    override func apply(_ p: [String: Any]) {
        effectView.layer.cornerRadius = CGFloat(p.double("radius") ?? 20)
        // Bottom-attached panels round only their top corners.
        if p.bool("topOnly") == true {
            effectView.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner]
        } else {
            effectView.layer.maskedCorners = [.layerMinXMinYCorner, .layerMaxXMinYCorner, .layerMinXMaxYCorner, .layerMaxXMaxYCorner]
        }
    }
}
