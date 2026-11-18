import MetalKit
import UIKit
import WebKit

/// A standalone host for the iOS native-surface composition proof of concept (#1311). It builds the view
/// hierarchy wry builds for the app, a transparent `WKWebView` added to the window's view, and puts an
/// `MTKView` below it at the rectangle the page reports. It draws one colour: no terminal, no renderer,
/// and nothing here ships in the app. The UI test in `SurfacePocUITests` reads its state from the
/// accessibility element `surface-poc-state` and reads the pixels the simulator composites.

/// The surface's colour, `PocColor.surface` in the test target.
private let surfaceClear = MTLClearColor(red: 30.0 / 255, green: 200.0 / 255, blue: 80.0 / 255, alpha: 1)

/// A Metal view that counts the touches that reach it, to show which side of the stack receives them.
final class SurfaceView: MTKView {
    var onTouch: (() -> Void)?

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent?) {
        onTouch?()
        super.touchesBegan(touches, with: event)
    }
}

/// Clears the drawable to the surface colour, the stand-in for a terminal frame.
final class SurfaceRenderer: NSObject, MTKViewDelegate {
    private let queue: MTLCommandQueue
    private(set) var frames = 0

    init?(device: MTLDevice) {
        guard let queue = device.makeCommandQueue() else { return nil }
        self.queue = queue
    }

    func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {}

    func draw(in view: MTKView) {
        guard let pass = view.currentRenderPassDescriptor, let drawable = view.currentDrawable,
              let buffer = queue.makeCommandBuffer() else { return }
        buffer.makeRenderCommandEncoder(descriptor: pass)?.endEncoding()
        buffer.present(drawable)
        buffer.commit()
        frames += 1
    }
}

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        // What shows where neither the web view nor the surface draws: `PocColor.backdrop`.
        window.backgroundColor = UIColor(white: 32.0 / 255, alpha: 1)
        window.rootViewController = PocViewController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}

final class PocViewController: UIViewController, WKScriptMessageHandler {
    /// `above` puts the surface over the web view, the comparison that shows the checks can fail.
    private let above = ProcessInfo.processInfo.environment["LAZYSH_SURFACE_POC_ORDER"] == "above"
    private let device: MTLDevice?
    private let renderer: SurfaceRenderer?
    private let probe = UIView(frame: CGRect(x: 0, y: 0, width: 1, height: 1))
    private var web: WKWebView!
    private var surface: SurfaceView?
    private var anchor: CGRect?
    private var counters: [String: Int] = ["created": 0, "destroyed": 0, "skipped": 0, "places": 0,
                                           "domTaps": 0, "surfaceTouches": 0, "background": 0, "foreground": 0]
    /// The distinct sizes the surface has had, in order: each change after the first is one terminal resize.
    private var sizes: [[Double]] = []
    private var scrollY = 0.0
    private var viewport = [0.0, 0.0]
    /// What the page's `env(safe-area-inset-top)` and `env(safe-area-inset-left)` were at its last report.
    private var pageSafe = [0.0, 0.0]

    init() {
        let device = MTLCreateSystemDefaultDevice()
        self.device = device
        renderer = device.flatMap { SurfaceRenderer(device: $0) }
        super.init(nibName: nil, bundle: nil)
    }

    required init?(coder: NSCoder) { fatalError("not used") }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        let configuration = WKWebViewConfiguration()
        configuration.userContentController.add(self, name: "poc")
        // The setup of wry 0.57.1 on iOS: not opaque, a clear background, flexible size, no bounce, added to the window's view.
        web = WKWebView(frame: view.bounds, configuration: configuration)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        web.scrollView.bounces = false
        view.addSubview(web)
        probe.isAccessibilityElement = true
        probe.accessibilityIdentifier = "surface-poc-state"
        view.addSubview(probe)
        makeSurface()
        let center = NotificationCenter.default
        center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in self?.count("background") }
        center.addObserver(forName: UIApplication.willEnterForegroundNotification, object: nil, queue: .main) { [weak self] _ in self?.count("foreground") }
        // The app is still in the background state during willEnterForeground, where drawing is refused.
        center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.redraw() }
        web.loadHTMLString(surfacePocPage, baseURL: nil)
    }

    /// `env(safe-area-inset-*)` changes without any DOM event, so the page is asked to measure again (run 44377130533 placed
    /// the surface 62 points above its anchor after a launch that laid the page out before the insets arrived).
    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        web?.evaluateJavaScript("window.pocSchedule && window.pocSchedule()")
        publish()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        publish()
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let body = message.body as? [String: Any], let type = body["type"] as? String else { return }
        let numbers = body.compactMapValues { ($0 as? NSNumber)?.doubleValue }
        switch type {
        case "anchor":
            guard let x = numbers["x"], let y = numbers["y"], let width = numbers["width"], let height = numbers["height"] else { return }
            anchor = CGRect(x: x, y: y, width: width, height: height)
            scrollY = numbers["scrollY"] ?? 0
            viewport = [numbers["viewportWidth"] ?? 0, numbers["viewportHeight"] ?? 0]
            pageSafe = [numbers["safeTop"] ?? 0, numbers["safeLeft"] ?? 0]
            counters["places", default: 0] += 1
            place()
        case "tap": count("domTaps")
        case "remove":
            surface?.removeFromSuperview()
            surface = nil
            count("destroyed")
        case "recreate":
            makeSurface()
            place()
        default: break
        }
    }

    /// The web view is a sibling of the surface in the same parent, as wry's is, so page coordinates are view coordinates.
    private func place() {
        defer { publish() }
        guard let surface, let anchor else { return }
        surface.frame = anchor
        let size = [Double(anchor.width), Double(anchor.height)]
        if sizes.last != size { sizes.append(size) }
        redraw()
    }

    private func makeSurface() {
        guard surface == nil else { return }
        let metal = SurfaceView(frame: .zero, device: device)
        metal.clearColor = surfaceClear
        metal.isPaused = true
        metal.enableSetNeedsDisplay = false
        metal.delegate = renderer
        metal.onTouch = { [weak self] in self?.count("surfaceTouches") }
        // Without a Metal device (the state records it) the view still takes part in the composition, with a flat layer.
        if device == nil { metal.backgroundColor = UIColor(red: 30.0 / 255, green: 200.0 / 255, blue: 80.0 / 255, alpha: 1) }
        if above { view.addSubview(metal) } else { view.insertSubview(metal, belowSubview: web) }
        view.bringSubviewToFront(probe)
        surface = metal
        count("created")
    }

    /// A frame is drawn only on a request, and never while the app is in the background, where Metal work is not allowed.
    private func redraw() {
        guard let surface, surface.bounds.width > 0 else { return }
        guard UIApplication.shared.applicationState != .background else { return count("skipped") }
        surface.layoutIfNeeded()
        surface.draw()
        publish()
    }

    private func count(_ key: String) {
        counters[key, default: 0] += 1
        publish()
    }

    private func publish() {
        func rect(_ value: CGRect) -> [String: Double] {
            ["x": value.minX, "y": value.minY, "width": value.width, "height": value.height]
        }
        let insets = view.safeAreaInsets
        var state: [String: Any] = counters.mapValues { $0 }
        state["metal"] = device != nil
        state["device"] = device?.name ?? "none"
        state["order"] = above ? "above" : "below"
        state["frames"] = renderer?.frames ?? 0
        if let surface { state["surface"] = rect(surface.frame) } else { state["surface"] = NSNull() }
        state["sizes"] = sizes
        state["scrollY"] = scrollY
        state["viewport"] = viewport
        state["pageSafe"] = pageSafe
        state["safe"] = ["top": Double(insets.top), "left": Double(insets.left), "bottom": Double(insets.bottom), "right": Double(insets.right)]
        if JSONSerialization.isValidJSONObject(state), let data = try? JSONSerialization.data(withJSONObject: state, options: [.sortedKeys]) {
            probe.accessibilityLabel = String(data: data, encoding: .utf8)
        }
    }
}
