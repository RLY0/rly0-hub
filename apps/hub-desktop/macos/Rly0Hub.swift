import AppKit
import WebKit
import Darwin

let pageURL = URL(string: "rly0-hub://local/index.html")!

func isHubPage(_ url: URL?) -> Bool {
    guard let url = url else { return false }
    return url.scheme == pageURL.scheme && url.host == pageURL.host
        && url.path == pageURL.path && url.query == nil
        && url.user == nil && url.password == nil && url.port == nil
}

final class LocalResources: NSObject, WKURLSchemeHandler {
    let root: URL
    let types = ["html": "text/html", "js": "text/javascript", "css": "text/css",
                 "svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
                 "jpeg": "image/jpeg", "woff2": "font/woff2"]

    init(root: URL) {
        self.root = root.resolvingSymlinksInPath().standardizedFileURL
    }

    func webView(_ webView: WKWebView, start urlSchemeTask: WKURLSchemeTask) {
        guard let url = urlSchemeTask.request.url,
              url.scheme == pageURL.scheme, url.host == pageURL.host,
              url.port == nil, url.user == nil, url.password == nil,
              urlSchemeTask.request.httpMethod == "GET",
              let decoded = URLComponents(url: url, resolvingAgainstBaseURL: false)?.percentEncodedPath.removingPercentEncoding,
              !decoded.contains("\0"), !decoded.contains("\\") else {
            urlSchemeTask.didFailWithError(URLError(.noPermissionsToReadFile))
            return
        }
        let file = root.appendingPathComponent(decoded.trimmingCharacters(in: CharacterSet(charactersIn: "/")))
            .resolvingSymlinksInPath().standardizedFileURL
        guard file.path.hasPrefix(root.path + "/"), let mime = types[file.pathExtension.lowercased()],
              let data = try? Data(contentsOf: file) else {
            urlSchemeTask.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        urlSchemeTask.didReceive(URLResponse(url: url, mimeType: mime,
                                            expectedContentLength: data.count,
                                            textEncodingName: mime.hasPrefix("text/") ? "utf-8" : nil))
        urlSchemeTask.didReceive(data)
        urlSchemeTask.didFinish()
    }

    func webView(_ webView: WKWebView, stop urlSchemeTask: WKURLSchemeTask) {}
}

final class HubDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate,
                         WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var webview: WKWebView!
    var worker: Process?
    var input: FileHandle?
    var output: FileHandle?
    var ready = false
    var failed = false
    var loaded = false
    var exiting = false
    var pending = Set<String>()
    var zoom = 1.1
    var lockDescriptor: Int32 = -1
    let steps = [0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6]
    let readQueue = DispatchQueue(label: "com.rly0.hub.macos-dev.stdout")
    var buffer = Data()
    let resources = Bundle.main.resourceURL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            let devHome = FileManager.default.homeDirectoryForCurrentUser
                .appendingPathComponent(".rly0-hub-macos-dev", isDirectory: true)
            try FileManager.default.createDirectory(at: devHome, withIntermediateDirectories: true,
                                                     attributes: [.posixPermissions: 0o700])
            lockDescriptor = open(devHome.appendingPathComponent("shell.lock").path,
                                  O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard lockDescriptor >= 0, flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else {
                throw NSError(domain: "HUB_ALREADY_RUNNING", code: 1)
            }
            makeMenu()
            try makeWindow()
            try startWorker(home: devHome)
        } catch {
            let alert = NSAlert()
            alert.messageText = "RLY/0 Hub 开发版未能启动"
            alert.informativeText = "请检查开发包是否完整，并确认没有重复打开。"
            alert.runModal()
            NSApp.terminate(nil)
        }
    }

    func makeMenu() {
        let menu = NSMenu()
        let item = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "打开 RLY/0 Hub", action: #selector(showWindow), keyEquivalent: "0")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 RLY/0 Hub", action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        item.submenu = appMenu
        menu.addItem(item)
        NSApp.mainMenu = menu
    }

    func makeWindow() throws {
        let controller = WKUserContentController()
        let bridge = try String(contentsOf: resources.appendingPathComponent("mac-bridge.js"),
                                encoding: .utf8)
        controller.addUserScript(WKUserScript(source: bridge, injectionTime: .atDocumentStart,
                                              forMainFrameOnly: true))
        controller.add(self, name: "rly0Hub")
        let configuration = WKWebViewConfiguration()
        configuration.userContentController = controller
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(
            LocalResources(root: resources.appendingPathComponent("app/hub-ui")),
            forURLScheme: "rly0-hub")
        webview = WKWebView(frame: .zero, configuration: configuration)
        webview.navigationDelegate = self
        webview.uiDelegate = self
        webview.pageZoom = zoom
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "RLY/0 Hub · macOS 开发版"
        window.minSize = NSSize(width: 760, height: 560)
        window.contentView = webview
        window.delegate = self
        window.center()
        let rules = """
        [{"trigger":{"url-filter":"^https?://"},"action":{"type":"block"}}]
        """
        WKContentRuleListStore.default().compileContentRuleList(forIdentifier: "rly0-hub-local-only",
                                                               encodedContentRuleList: rules) { list, _ in
            guard let list = list else {
                NSApp.terminate(nil)
                return
            }
            controller.add(list)
            self.webview.load(URLRequest(url: pageURL))
            if !CommandLine.arguments.contains("--background") { self.showWindow() }
        }
    }

    func startWorker(home: URL) throws {
        let process = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        process.executableURL = resources.appendingPathComponent("runtime/node")
        process.arguments = [resources.appendingPathComponent("app/hub-service.mjs").path]
        process.currentDirectoryURL = resources
        process.environment = [
            "HOME": home.path,
            "PATH": "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin",
            "LANG": "en_US.UTF-8",
            "TMPDIR": NSTemporaryDirectory(),
            "CODEX_HOME": home.appendingPathComponent("codex").path,
            "CLAUDE_CONFIG_DIR": home.appendingPathComponent("claude").path,
            "CODEXHOST_DATA_DIR": home.appendingPathComponent("data").path,
            "RLY0_CORE_DATA": home.appendingPathComponent("core").path,
            "RLY0_HUB_INSTALL_ROOT": resources.path,
            "RLY0_SKIP_LEGACY_IMPORT": "1",
        ]
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice
        input = stdinPipe.fileHandleForWriting
        output = stdoutPipe.fileHandleForReading
        output?.readabilityHandler = { handle in
            let data = handle.availableData
            self.readQueue.async { self.receive(data) }
        }
        process.terminationHandler = { _ in
            DispatchQueue.main.async { self.serviceStopped() }
        }
        worker = process
        try process.run()
    }

    func receive(_ data: Data) {
        guard !data.isEmpty else {
            DispatchQueue.main.async { self.serviceStopped() }
            return
        }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            guard line.count <= 1_048_576,
                  let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
                DispatchQueue.main.async { self.serviceStopped() }
                return
            }
            DispatchQueue.main.async { self.serviceMessage(message) }
        }
        if buffer.count > 1_048_576 {
            buffer.removeAll()
            DispatchQueue.main.async { self.serviceStopped() }
        }
    }

    func serviceMessage(_ message: [String: Any]) {
        guard !failed, !exiting else { return }
        if message["event"] as? String == "ready" {
            ready = true
            if loaded { post(["event": "ready"]) }
        } else if let id = message["id"] as? String, pending.remove(id) != nil {
            post(message)
        }
    }

    func serviceStopped() {
        guard !failed, !exiting else { return }
        failed = true
        ready = false
        output?.readabilityHandler = nil
        try? input?.close()
        if worker?.isRunning == true { worker?.terminate() }
        let ids = pending
        pending.removeAll()
        for id in ids { replyError(id, "SERVICE_UNAVAILABLE") }
        if loaded { post(["event": "ready"]) }
    }

    func post(_ message: [String: Any]) {
        guard loaded, !exiting, let data = try? JSONSerialization.data(withJSONObject: message) else { return }
        let encoded = data.base64EncodedString()
        webview.evaluateJavaScript("window.__rly0HubReceive(JSON.parse(new TextDecoder().decode(Uint8Array.from(atob('\(encoded)'), c => c.charCodeAt(0)))))",
                                   completionHandler: nil)
    }

    func replyError(_ id: String, _ code: String) {
        post(["id": id, "error": ["code": -32000, "message": code]])
    }

    func userContentController(_ userContentController: WKUserContentController,
                               didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame, isHubPage(message.frameInfo.request.url),
              let request = message.body as? [String: Any],
              let id = request["id"] as? String,
              id.range(of: "^w[0-9]{1,12}$", options: .regularExpression) != nil,
              let method = request["method"] as? String,
              method.range(of: "^[a-z]+(\\.[a-zA-Z]+){1,2}$", options: .regularExpression) != nil,
              let params = request["params"] as? [String: Any],
              let data = try? JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params]),
              data.count <= 65536, !pending.contains(id) else { return }
        if method == "window.zoomGet" || method == "window.zoomSet" {
            if method == "window.zoomSet", let next = params["zoom"] as? Double, next.isFinite {
                zoom = max(0.8, min(1.6, (next * 100).rounded() / 100))
                webview.pageZoom = zoom
            }
            post(["id": id, "result": ["zoom": zoom, "steps": steps]])
            return
        }
        if method == "window.capture" { replyError(id, "CAPTURE_UNSUPPORTED"); return }
        guard ready, !failed, worker?.isRunning == true, let input = input else {
            replyError(id, failed ? "SERVICE_UNAVAILABLE" : "SERVICE_STARTING")
            return
        }
        guard pending.count < 256 else { replyError(id, "HUB_BUSY"); return }
        pending.insert(id)
        do {
            var line = data
            line.append(10)
            try input.write(contentsOf: line)
        } catch { serviceStopped() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true
                        && isHubPage(navigationAction.request.url) ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        if ready || failed { post(["event": "ready"]) }
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }

    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
                 decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(.deny)
    }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool { sender.orderOut(nil); return false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        exiting = true
        output?.readabilityHandler = nil
        try? input?.close()
        if worker?.isRunning == true { worker?.terminate() }
        if lockDescriptor >= 0 { close(lockDescriptor) }
    }
}

signal(SIGPIPE, SIG_IGN)
let app = NSApplication.shared
let delegate = HubDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
