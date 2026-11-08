import AppKit
import WebKit
import Darwin
import UserNotifications

let pageURL = URL(string: "rly0-hub://local/index.html")!

func isHubPage(_ url: URL?) -> Bool {
    guard let url = url else { return false }
    return url.scheme == pageURL.scheme && url.host == pageURL.host
        && url.path == pageURL.path && url.query == nil
        && url.user == nil && url.password == nil && url.port == nil
}

final class HubWebView: WKWebView {
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        guard event.type == .keyDown, let window = window, window.isKeyWindow,
              let focused = window.firstResponder as? NSView,
              focused === self || focused.isDescendant(of: self) else {
            return super.performKeyEquivalent(with: event)
        }
        let key = event.charactersIgnoringModifiers?.lowercased()
        let action: Selector?
        if modifiers == [.control] {
            switch key {
            case "a": action = #selector(NSText.selectAll(_:))
            case "c": action = #selector(NSText.copy(_:))
            case "x": action = #selector(NSText.cut(_:))
            case "v": action = #selector(NSText.paste(_:))
            case "z": action = NSSelectorFromString("undo:")
            default: action = nil
            }
        } else if modifiers == [.control, .shift] && key == "z" {
            action = NSSelectorFromString("redo:")
        } else {
            action = nil
        }
        // Compatibility stays inside the focused Hub web view; standard responder
        // actions preserve paste validation and never change global key mappings.
        if let action = action, NSApp.sendAction(action, to: nil, from: self) { return true }
        return super.performKeyEquivalent(with: event)
    }
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
                         WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler,
                         UNUserNotificationCenterDelegate {
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
    // Every start opens at the standard interface size (100%), like the Windows Hub.
    var zoom = 1.0
    var lockDescriptor: Int32 = -1
    var devMode = false
    var serviceHome: URL!
    var servicePath = ""
    var restarts = 0
    var restarting = false
    var internalSequence = 0
    var internalReplies: [String: ([String: Any]?) -> Void] = [:]
    var alertTimer: Timer?
    let steps = [0.8, 0.9, 1.0, 1.1, 1.25, 1.4, 1.6]
    let readQueue = DispatchQueue(label: "com.rly0.hub.macos.stdout")
    var buffer = Data()
    let resources = Bundle.main.resourceURL!

    func applicationDidFinishLaunching(_ notification: Notification) {
        do {
            // Default: the real HOME (~/.codex, ~/.rly0-hub), like the Windows Hub.
            // RLY0_HUB_MACOS_DEV_HOME=1 keeps the old isolated development HOME.
            let fm = FileManager.default
            let realHome = fm.homeDirectoryForCurrentUser
            devMode = ProcessInfo.processInfo.environment["RLY0_HUB_MACOS_DEV_HOME"] == "1"
            // The lock lives on the internal disk: ~/.rly0-hub may be a symlink to an external
            // volume, and touching it from the main thread would block on the macOS
            // removable-volume permission prompt before the window exists.
            let devHome = realHome.appendingPathComponent(".rly0-hub-macos-dev", isDirectory: true)
            let lockDir = devMode ? devHome
                : realHome.appendingPathComponent("Library/Application Support/RLY0 Hub", isDirectory: true)
            try fm.createDirectory(at: lockDir, withIntermediateDirectories: true,
                                   attributes: [.posixPermissions: 0o700])
            lockDescriptor = open(lockDir.appendingPathComponent("hub-shell-macos.lock").path,
                                  O_CREAT | O_RDWR | O_NOFOLLOW, 0o600)
            guard lockDescriptor >= 0, flock(lockDescriptor, LOCK_EX | LOCK_NB) == 0 else {
                throw NSError(domain: "HUB_ALREADY_RUNNING", code: 1)
            }
            makeMenu()
            try makeWindow()
            // Clicks on notices shown before this launch also arrive here.
            UNUserNotificationCenter.current().delegate = self
            serviceHome = devMode ? devHome : realHome
            // The login shell's PATH (agent CLIs from npm, Homebrew, nvm...) is read off the main
            // thread; the service starts once it is known, the page waits on "后台正在启动".
            let home = realHome
            DispatchQueue.global(qos: .userInitiated).async {
                let path = Self.searchPath(home: home, runtime: self.resources.appendingPathComponent("runtime").path)
                DispatchQueue.main.async {
                    self.servicePath = path
                    do { try self.startWorker() } catch { self.cannotStart() }
                }
            }
        } catch {
            cannotStart()
        }
    }

    func cannotStart() {
        let alert = NSAlert()
        alert.messageText = "RLY/0 Hub 未能启动"
        alert.informativeText = "可能已经打开了一个 RLY/0 Hub（看 Dock），或安装包不完整。"
        alert.runModal()
        NSApp.terminate(nil)
    }

    /// PATH for the service: folders listed in `~/Library/Application Support/RLY0 Hub/extra-path`
    /// (one absolute path per line; tools no shell profile adds, e.g. on an external volume), then
    /// what a Terminal window gets (GUI apps start with a minimal one), then the usual install
    /// folders; the bundled Node comes last so the user's own tools win.
    static func searchPath(home: URL, runtime: String) -> String {
        let fallback = ["\(home.path)/.local/bin", "/opt/homebrew/bin", "/usr/local/bin",
                        "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
        let listed = home.appendingPathComponent("Library/Application Support/RLY0 Hub/extra-path")
        let extra = ((try? String(contentsOf: listed, encoding: .utf8)) ?? "")
            .components(separatedBy: .newlines)
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { $0.hasPrefix("/") && !$0.contains(":") }
        var entries = extra
        for directory in loginShellPath(home: home) ?? fallback where !entries.contains(directory) {
            entries.append(directory)
        }
        for directory in fallback where !entries.contains(directory) { entries.append(directory) }
        entries.removeAll { $0 == runtime }
        entries.append(runtime)
        return entries.joined(separator: ":")
    }

    static func loginShellPath(home: URL) -> [String]? {
        guard let record = getpwuid(getuid()), let raw = record.pointee.pw_shell else { return nil }
        let shell = String(cString: raw)
        guard shell.hasPrefix("/"), FileManager.default.isExecutableFile(atPath: shell) else { return nil }
        let process = Process()
        let pipe = Pipe()
        process.executableURL = URL(fileURLWithPath: shell)
        process.arguments = ["-ilc", "printf '\\n__RLY0_HUB_PATH__%s\\n' \"$PATH\""]
        process.standardInput = FileHandle.nullDevice
        process.standardOutput = pipe
        process.standardError = FileHandle.nullDevice
        process.environment = ["HOME": home.path, "USER": NSUserName(), "SHELL": shell,
                               "PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8"]
        // Done at the marker line or end of output, whichever comes first: a profile may start
        // something in the background that keeps the pipe open long after the shell exited.
        var output = Data()
        let lock = NSLock()
        let done = DispatchSemaphore(value: 0)
        let marker = Data("__RLY0_HUB_PATH__".utf8)
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            lock.lock()
            if output.count < 1_048_576 { output.append(chunk) }
            let complete = output.range(of: marker).map { output[$0.upperBound...].contains(10) } ?? false
            lock.unlock()
            if chunk.isEmpty || complete { done.signal() }
        }
        do { try process.run() } catch { return nil }
        // A shell profile that hangs (prompts, network) must not keep the Hub from starting.
        let finished = done.wait(timeout: .now() + 5) == .success
        pipe.fileHandleForReading.readabilityHandler = nil
        try? pipe.fileHandleForReading.close()
        // An interactive shell ignores SIGTERM; one still running is ended for good.
        if process.isRunning { kill(process.processIdentifier, SIGKILL) }
        guard finished else { return nil }
        lock.lock(); let collected = output; lock.unlock()
        guard let text = String(data: collected, encoding: .utf8),
              let line = text.components(separatedBy: "\n").last(where: { $0.hasPrefix("__RLY0_HUB_PATH__") })
        else { return nil }
        let entries = line.dropFirst("__RLY0_HUB_PATH__".count).split(separator: ":").map(String.init)
            .filter { $0.hasPrefix("/") }
        return entries.isEmpty ? nil : entries
    }

    func makeMenu() {
        let menu = NSMenu()
        let item = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "打开 RLY/0 Hub", action: #selector(showWindow), keyEquivalent: "0")
            .target = self
        appMenu.addItem(withTitle: "设置…", action: #selector(openSettings), keyEquivalent: ",")
            .target = self
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 RLY/0 Hub", action: #selector(NSApplication.hide(_:)),
                        keyEquivalent: "h")
        appMenu.addItem(withTitle: "隐藏其他", action: #selector(NSApplication.hideOtherApplications(_:)),
                        keyEquivalent: "h").keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(withTitle: "全部显示", action: #selector(NSApplication.unhideAllApplications(_:)),
                        keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 RLY/0 Hub", action: #selector(NSApplication.terminate(_:)),
                        keyEquivalent: "q")
        item.submenu = appMenu
        menu.addItem(item)
        // Standard responder-chain actions also work in WKWebView's text/password fields.
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        func addEditCommand(_ title: String, _ action: Selector, _ key: String,
                            shifted: Bool = false) {
            let command = editMenu.addItem(withTitle: title, action: action, keyEquivalent: key)
            command.keyEquivalentModifierMask = shifted ? [.command, .shift] : [.command]
        }
        addEditCommand("撤销", NSSelectorFromString("undo:"), "z")
        addEditCommand("重做", NSSelectorFromString("redo:"), "z", shifted: true)
        editMenu.addItem(.separator())
        addEditCommand("剪切", #selector(NSText.cut(_:)), "x")
        addEditCommand("复制", #selector(NSText.copy(_:)), "c")
        addEditCommand("粘贴", #selector(NSText.paste(_:)), "v")
        addEditCommand("全选", #selector(NSText.selectAll(_:)), "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        // 「前往」: same as the Windows tray's page shortcuts (shell "navigate" event).
        let goItem = NSMenuItem()
        let goMenu = NSMenu(title: "前往")
        for (index, entry) in navPages.enumerated() {
            let page = goMenu.addItem(withTitle: entry.1, action: #selector(navigateFromMenu(_:)),
                                      keyEquivalent: index < 9 ? String(index + 1) : "")
            page.target = self
            page.representedObject = entry.0
        }
        goMenu.addItem(.separator())
        goMenu.addItem(withTitle: "重新载入页面", action: #selector(reloadPage), keyEquivalent: "r")
            .target = self
        goItem.submenu = goMenu
        menu.addItem(goItem)
        // 「窗口」: ⌘W only hides the window (like its close button), the Hub keeps running.
        let windowItem = NSMenuItem()
        let windowMenu = NSMenu(title: "窗口")
        windowMenu.addItem(withTitle: "最小化", action: #selector(NSWindow.performMiniaturize(_:)),
                           keyEquivalent: "m")
        windowMenu.addItem(withTitle: "缩放", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(.separator())
        windowMenu.addItem(withTitle: "关闭窗口", action: #selector(NSWindow.performClose(_:)),
                           keyEquivalent: "w")
        windowItem.submenu = windowMenu
        menu.addItem(windowItem)
        NSApp.windowsMenu = windowMenu
        // Local automation (screenshots/tests): only whitelisted page names, nothing else.
        DistributedNotificationCenter.default().addObserver(
            forName: Notification.Name("com.rly0.hub.navigate"), object: nil, queue: .main) { note in
            if let page = note.object as? String { self.navigate(page) }
        }
        NSApp.mainMenu = menu
    }

    let navPages = [("home", "首页"), ("accounts", "账号"), ("relays", "中转站"),
                    ("agents", "AI 助手"), ("bridge", "打通设置"), ("maintenance", "维护工具"),
                    ("settings", "设置")]

    @objc func navigateFromMenu(_ sender: NSMenuItem) {
        if let page = sender.representedObject as? String { navigate(page) }
    }

    @objc func openSettings() { navigate("settings") }

    /// The page starts over; replies still owed to the old page are dropped, its ids restart at w1.
    @objc func reloadPage() {
        showWindow()
        loaded = false
        pending.removeAll()
        webview.load(URLRequest(url: pageURL))
    }

    /// Pages Codex asks for (`--page <name>` at launch, or the navigate notification): same list
    /// as RLY0_HUB_PAGES in shared-contracts and Program.Pages in the Windows Rly0Hub.cs.
    let codexPages: Set<String> = ["home", "maintenance", "remote", "usage", "updates", "agents",
                                   "accounts", "relays", "threads", "mcp", "skills", "general",
                                   "support", "sessions"]
    /// Asked for before the page finished loading; sent once it has.
    var pendingPage: String?

    func navigate(_ page: String) {
        guard navPages.contains(where: { $0.0 == page }) || codexPages.contains(page) else { return }
        showWindow()
        // hub-ui only accepts its own navigable names (NAVIGABLE in hub-ui/app.js): 设置 opens
        // on 通用, 打通设置 on its 概览.
        let target = ["settings": "general"][page] ?? page
        guard loaded else { pendingPage = target; return }
        post(["event": "navigate", "page": target])
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
        webview = HubWebView(frame: .zero, configuration: configuration)
        webview.navigationDelegate = self
        webview.uiDelegate = self
        webview.pageZoom = zoom
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1240, height: 820),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = devMode ? "RLY/0 Hub · macOS 开发版" : "RLY/0 Hub"
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
            // Opened from Codex on a page: `open -a "RLY0 Hub.app" --args --page <name>`.
            let args = CommandLine.arguments
            if let at = args.firstIndex(of: "--page"), at + 1 < args.count { self.navigate(args[at + 1]) }
        }
    }

    func startWorker() throws {
        let home: URL = serviceHome
        ready = false
        failed = false
        buffer.removeAll()
        let process = Process()
        let stdinPipe = Pipe()
        let stdoutPipe = Pipe()
        process.executableURL = resources.appendingPathComponent("runtime/node")
        process.arguments = [resources.appendingPathComponent("app/hub-service.mjs").path]
        process.currentDirectoryURL = resources
        let inherited = ProcessInfo.processInfo.environment
        var env: [String: String] = [
            "HOME": home.path,
            "USER": NSUserName(),
            "PATH": servicePath,
            "LANG": "en_US.UTF-8",
            "TMPDIR": NSTemporaryDirectory(),
            "RLY0_HUB_INSTALL_ROOT": resources.path,
            "RLY0_SKIP_LEGACY_IMPORT": "1",
        ]
        if devMode {
            env["CODEX_HOME"] = home.appendingPathComponent("codex").path
            env["CLAUDE_CONFIG_DIR"] = home.appendingPathComponent("claude").path
            env["CODEXHOST_DATA_DIR"] = home.appendingPathComponent("data").path
            env["RLY0_CORE_DATA"] = home.appendingPathComponent("core").path
        } else {
            // Real data: ~/.codex and ~/.rly0-hub (either may be a symlink). Pass through
            // explicit overrides the user set, e.g. a Mac rly0-core build via RLY0_CORE_PATH.
            for key in ["CODEX_HOME", "CODEXHOST_DATA_DIR", "RLY0_CORE_PATH", "CODEXHOST_PKG",
                        "CODEXHOST_NODE", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY"] {
                if let value = inherited[key], !value.isEmpty { env[key] = value }
            }
        }
        process.environment = env
        process.standardInput = stdinPipe
        process.standardOutput = stdoutPipe
        process.standardError = FileHandle.nullDevice
        input = stdinPipe.fileHandleForWriting
        output = stdoutPipe.fileHandleForReading
        output?.readabilityHandler = { [weak process] handle in
            let data = handle.availableData
            self.readQueue.async { if self.worker === process { self.receive(data, from: process) } }
        }
        process.terminationHandler = { stopped in
            DispatchQueue.main.async { if self.worker === stopped { self.serviceStopped() } }
        }
        worker = process
        try process.run()
    }

    /// Output of `process`; whatever reaches the main thread after a restart is the old service's
    /// and is dropped there.
    func receive(_ data: Data, from process: Process?) {
        let stop = { DispatchQueue.main.async { if self.worker === process { self.serviceStopped() } } }
        guard !data.isEmpty else { return stop() }
        buffer.append(data)
        while let newline = buffer.firstIndex(of: 10) {
            let line = Data(buffer[..<newline])
            buffer.removeSubrange(...newline)
            guard line.count <= 1_048_576,
                  let message = (try? JSONSerialization.jsonObject(with: line)) as? [String: Any] else {
                return stop()
            }
            DispatchQueue.main.async { if self.worker === process { self.serviceMessage(message) } }
        }
        if buffer.count > 1_048_576 {
            buffer.removeAll()
            stop()
        }
    }

    func serviceMessage(_ message: [String: Any]) {
        guard !failed, !restarting, !exiting else { return }
        let event = message["event"] as? String
        if event == "ready" {
            ready = true
            if loaded { post(["event": "ready"]) }
            startAlertChecks()
        } else if event == "quota" || event == "balance" {
            // Pushed numbers (a reply's quota, a relay balance), forwarded like the Windows shell.
            post(message)
        } else if let id = message["id"] as? String, let reply = internalReplies.removeValue(forKey: id) {
            reply(message["result"] as? [String: Any])
        } else if let id = message["id"] as? String, pending.remove(id) != nil {
            post(message)
        }
    }

    func serviceStopped() {
        guard !failed, !restarting, !exiting else { return }
        ready = false
        output?.readabilityHandler = nil
        try? input?.close()
        let old = worker
        // Like the Windows shell: the service is restarted up to three times; meanwhile the page
        // gets SERVICE_STARTING, and SERVICE_UNAVAILABLE only once it stays down.
        let restart = restarts < 3
        if restart {
            restarts += 1
            restarting = true
        } else {
            failed = true
        }
        let ids = pending
        pending.removeAll()
        for id in ids { replyError(id, restart ? "SERVICE_STARTING" : "SERVICE_UNAVAILABLE") }
        let waiting = internalReplies
        internalReplies.removeAll()
        for (_, reply) in waiting { reply(nil) }
        guard restart else {
            if old?.isRunning == true { old?.terminate() }
            if loaded { post(["event": "ready"]) }
            return
        }
        // The old service, and the rly0-core it started (which stops once its input closes), must
        // be gone before a new one starts on the same data and proxy port.
        DispatchQueue.global(qos: .userInitiated).async {
            if let old = old, old.isRunning {
                old.terminate()
                let deadline = Date().addingTimeInterval(5)
                while old.isRunning && Date() < deadline { usleep(100_000) }
                if old.isRunning { kill(old.processIdentifier, SIGKILL) }
            }
            usleep(1_500_000)
            DispatchQueue.main.async {
                guard !self.exiting else { return }
                self.restarting = false
                do { try self.startWorker() } catch {
                    self.failed = true
                    if self.loaded { self.post(["event": "ready"]) }
                }
            }
        }
    }

    /// A shell-side request (alerts, notification actions); the reply never reaches the page.
    func sendInternal(_ method: String, _ params: [String: Any] = [:],
                      _ reply: (([String: Any]?) -> Void)? = nil) {
        guard ready, !failed, worker?.isRunning == true, let input = input else { reply?(nil); return }
        internalSequence += 1
        let id = "t\(internalSequence)"
        internalReplies[id] = reply ?? { _ in }
        guard var line = try? JSONSerialization.data(withJSONObject: ["id": id, "method": method, "params": params])
        else { internalReplies.removeValue(forKey: id); reply?(nil); return }
        line.append(10)
        do { try input.write(contentsOf: line) } catch { serviceStopped() }
    }

    /// 提醒 (balance, quota) and automatic account switching run inside `alerts.check`, which the
    /// Windows tray calls a minute after start and then every five minutes; same here.
    func startAlertChecks() {
        guard alertTimer == nil else { return }
        alertTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: false) { [weak self] _ in
            self?.checkAlerts()
            self?.alertTimer = Timer.scheduledTimer(withTimeInterval: 300, repeats: true) { _ in
                self?.checkAlerts()
            }
        }
    }

    func checkAlerts() {
        sendInternal("alerts.check") { result in
            guard let alerts = result?["alerts"] as? [[String: Any]], !alerts.isEmpty else { return }
            self.notify(alerts.map { alert in
                var info: [String: String] = [:]
                if let action = alert["action"] as? String, ["recharge", "open", "switch"].contains(action) {
                    info["action"] = action
                }
                if let account = alert["accountId"] as? String,
                   account.range(of: "^[0-9a-f]{12}$", options: .regularExpression) != nil {
                    info["accountId"] = account
                }
                if let agent = alert["agent"] as? String, ["claude", "grok"].contains(agent) { info["agent"] = agent }
                info["at"] = String(Int(Date().timeIntervalSince1970))
                return (alert["title"] as? String ?? "RLY/0 Hub 提醒", alert["body"] as? String ?? "", info)
            })
        }
    }

    func notify(_ notices: [(String, String, [String: String])]) {
        let center = UNUserNotificationCenter.current()
        center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
            guard granted else { return }
            for (title, body, info) in notices {
                let content = UNMutableNotificationContent()
                content.title = title
                content.body = body
                content.userInfo = info
                center.add(UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil))
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        DispatchQueue.main.async { self.performNoticeAction(info) }
        completionHandler()
    }

    /// Clicking a notice does what the Windows balloon does. One left in Notification Center for a
    /// while, or clicked before the service is up, only opens the window: switching an account or
    /// restarting Codex may no longer be what is wanted.
    func performNoticeAction(_ info: [AnyHashable: Any]) {
        let at = (info["at"] as? String).flatMap(Double.init) ?? 0
        guard ready, Date().timeIntervalSince1970 - at < 15 * 60 else { showWindow(); return }
        let action = info["action"] as? String
        let account = info["accountId"] as? String
        let agent = info["agent"] as? String
        if action == "recharge" {
            sendInternal("links.open", ["target": "recharge"])
        } else if action == "switch", let account = account, let agent = agent {
            // Claude / Grok: the credential new requests use; a running reply finishes first.
            sendInternal("agents.autoSwitch.apply", ["agent": agent, "id": account]) { result in
                let ok = result?["switched"] as? Bool == true
                let later = result?["deferred"] as? Bool == true
                self.notify([("RLY/0 Hub", ok ? "已切换账号，新的请求就用它。"
                              : later ? "等当前回复结束后就切换。" : "切换没有成功，请在 Hub 的账号页重试。", [:])])
            }
        } else if action == "switch", let account = account {
            sendInternal("accounts.switchAndRestart", ["id": account]) { result in
                let ok = result?["switched"] as? Bool == true
                let hot = ok && result?["reloaded"] is String
                self.notify([("RLY/0 Hub", !ok ? "切换没有成功，请在 Hub 的账号页重试。"
                              : hot ? "已切换账号，Codex 不用重启。" : "已切换账号，Codex 正在重启。", [:])])
            }
        } else {
            showWindow()
        }
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
              !pending.contains(id) else { return }
        // Answered at once (the page would otherwise wait for its 180 s timeout).
        guard data.count <= 65536 else { replyError(id, "REQUEST_TOO_LARGE"); return }
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
        if let page = pendingPage {
            pendingPage = nil
            post(["event": "navigate", "page": page])
        }
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
        post(["event": "visibility", "visible": true])
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        sender.orderOut(nil)
        // Like the Windows tray: a hidden window stops live quota refreshes until shown again.
        post(["event": "visibility", "visible": false])
        return false
    }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        showWindow()
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        exiting = true
        alertTimer?.invalidate()
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
