// voin.app: 로컬 서버(server.mjs)를 뒤에서 실행하고, 그 화면을 앱 창에 띄운다.
// 브라우저 없이 Dock/응용 프로그램에서 실행하기 위한 껍데기다.

import AppKit
import Carbon.HIToolbox
import UniformTypeIdentifiers
import WebKit

let port = 4310

// 화면 언어: 시스템 언어 중 한국어·일본어·영어 첫 번째, 없으면 영어 (lib/i18n.mjs pickLang과 같은 규칙)
let appLang: String = Locale.preferredLanguages.lazy.map { String($0.prefix(2)).lowercased() }.first { ["ko", "ja", "en"].contains($0) } ?? "en"

// 앱(메뉴·알림) 글: 한국어 원문 → 지금 언어. 사전에 없으면 원문
func L(_ ko: String) -> String { appLang == "ko" ? ko : (L10N[appLang]?[ko] ?? ko) }
// {name} 자리표시를 채운다: 예) "녹음 중 · {time}"에 ["time": "03:12"]
func L(_ ko: String, _ vars: [String: String]) -> String {
    vars.reduce(L(ko)) { $0.replacingOccurrences(of: "{\($1.key)}", with: $1.value) }
}
let L10N: [String: [String: String]] = [
    "en": [
        "모델을 불러오는 중입니다…": "Loading model…",
        "처음 실행할 때 10초 정도 걸립니다.": "The first launch takes about 10 seconds.",
        "서버를 시작하지 못했습니다": "Couldn't start the server",
        "서버가 종료되었습니다": "The server quit",
        "서버가 응답하지 않습니다": "The server isn't responding",
        "자세한 내용: {path}": "Details: {path}",
        "앱 리소스 폴더를 찾지 못했습니다.": "Couldn't find the app's resources folder.",
        "앱 안의 서버 파일이 없습니다. 앱을 다시 설치하세요.": "The app's server files are missing. Please reinstall the app.",
        "받아쓸 녹음 파일을 고르세요": "Choose a recording to transcribe",
        "선택": "Choose",
        "정리 중": "Processing",
        "받아쓰기 모델 확인 중…": "Checking transcription model…",
        "대기 중": "Ready",
        "받아쓰기 모델 불러오는 중…": "Loading transcription model…",
        "받은 파일 확인 중…": "Verifying downloaded files…",
        "받아쓰기 모델 내려받는 중 {percent}%": "Downloading transcription model {percent}%",
        "내려받기 취소": "Cancel download",
        "받아쓰기 모델 내려받기 멈춤": "Transcription model download paused",
        "받아쓰기 모델 없음": "No transcription model",
        "받아쓰기 모델 이어 받기": "Resume transcription model download",
        "받아쓰기 모델 내려받기 ({size}MB)": "Download transcription model ({size}MB)",
        "받아쓰기 모델 문제 있음": "Transcription model problem",
        "받아쓰기 모델 다시 받기": "Download transcription model again",
        "녹음 중 · {time}": "Recording · {time}",
        "저장하는 중…": "Saving…",
        "녹음 중지": "Stop recording",
        "녹음 시작": "Start recording",
        "받아쓰기 모델": "Transcription model",
        "말로 작업하기": "Voice task",
        "아무 앱에 받아쓰기": "Dictate into any app",
        "녹음 파일 불러오기…": "Import recording…",
        "저장 폴더 열기": "Open save folder",
        "voin 창 열기": "Open voin window",
        "설정…": "Settings…",
        "voin 종료": "Quit voin",
        "voin에 관하여": "About voin",
        "voin 숨기기": "Hide voin",
        "파일": "File",
        "새 회의 녹음": "New meeting recording",
        "녹음 시작/중지": "Start/stop recording",
        "창 닫기": "Close window",
        "편집": "Edit",
        "실행 취소": "Undo",
        "잘라내기": "Cut",
        "복사": "Copy",
        "붙여넣기": "Paste",
        "전체 선택": "Select all",
        "지원하지 않는 키입니다.": "This key isn't supported.",
        "지원하지 않는 수식키입니다.": "This modifier key isn't supported.",
        "이미 다른 곳에서 쓰는 단축키입니다. 다른 조합을 고르세요.": "This shortcut is already in use elsewhere. Choose a different combination.",
        "단축키를 등록하지 못했습니다 ({status}).": "Couldn't register the shortcut ({status}).",
        "클립보드에 넣었습니다 · ⌘V로 붙여넣으세요 (자동 붙여넣기는 손쉬운 사용 권한에서 voin을 켜면 됩니다)": "Copied to clipboard · Press ⌘V to paste (to paste automatically, turn on voin in Accessibility permissions)",
        "붙여넣었습니다": "Pasted",
    ],
    "ja": [
        "모델을 불러오는 중입니다…": "モデルを読み込んでいます…",
        "처음 실행할 때 10초 정도 걸립니다.": "初回の起動には10秒ほどかかります。",
        "서버를 시작하지 못했습니다": "サーバーを起動できませんでした",
        "서버가 종료되었습니다": "サーバーが終了しました",
        "서버가 응답하지 않습니다": "サーバーが応答しません",
        "자세한 내용: {path}": "詳細：{path}",
        "앱 리소스 폴더를 찾지 못했습니다.": "アプリのリソースフォルダが見つかりませんでした。",
        "앱 안의 서버 파일이 없습니다. 앱을 다시 설치하세요.": "アプリ内のサーバーファイルがありません。アプリを再インストールしてください。",
        "받아쓸 녹음 파일을 고르세요": "文字起こしする録音ファイルを選んでください",
        "선택": "選択",
        "정리 중": "整理中",
        "받아쓰기 모델 확인 중…": "文字起こしモデルを確認中…",
        "대기 중": "待機中",
        "받아쓰기 모델 불러오는 중…": "文字起こしモデルを読み込み中…",
        "받은 파일 확인 중…": "ダウンロードしたファイルを確認中…",
        "받아쓰기 모델 내려받는 중 {percent}%": "文字起こしモデルをダウンロード中 {percent}%",
        "내려받기 취소": "ダウンロードをキャンセル",
        "받아쓰기 모델 내려받기 멈춤": "文字起こしモデルのダウンロード一時停止",
        "받아쓰기 모델 없음": "文字起こしモデルなし",
        "받아쓰기 모델 이어 받기": "文字起こしモデルのダウンロードを再開",
        "받아쓰기 모델 내려받기 ({size}MB)": "文字起こしモデルをダウンロード（{size}MB）",
        "받아쓰기 모델 문제 있음": "文字起こしモデルに問題があります",
        "받아쓰기 모델 다시 받기": "文字起こしモデルを再ダウンロード",
        "녹음 중 · {time}": "録音中 · {time}",
        "저장하는 중…": "保存中…",
        "녹음 중지": "録音を停止",
        "녹음 시작": "録音を開始",
        "받아쓰기 모델": "文字起こしモデル",
        "말로 작업하기": "音声タスク",
        "아무 앱에 받아쓰기": "どのアプリにも口述入力",
        "녹음 파일 불러오기…": "録音ファイルを読み込む…",
        "저장 폴더 열기": "保存フォルダを開く",
        "voin 창 열기": "voin ウインドウを開く",
        "설정…": "設定…",
        "voin 종료": "voin を終了",
        "voin에 관하여": "voin について",
        "voin 숨기기": "voin を隠す",
        "파일": "ファイル",
        "새 회의 녹음": "新しい会議を録音",
        "녹음 시작/중지": "録音を開始/停止",
        "창 닫기": "ウインドウを閉じる",
        "편집": "編集",
        "실행 취소": "取り消す",
        "잘라내기": "カット",
        "복사": "コピー",
        "붙여넣기": "ペースト",
        "전체 선택": "すべてを選択",
        "지원하지 않는 키입니다.": "このキーには対応していません。",
        "지원하지 않는 수식키입니다.": "この修飾キーには対応していません。",
        "이미 다른 곳에서 쓰는 단축키입니다. 다른 조합을 고르세요.": "このショートカットはすでに他で使われています。別の組み合わせを選んでください。",
        "단축키를 등록하지 못했습니다 ({status}).": "ショートカットを登録できませんでした（{status}）。",
        "클립보드에 넣었습니다 · ⌘V로 붙여넣으세요 (자동 붙여넣기는 손쉬운 사용 권한에서 voin을 켜면 됩니다)": "クリップボードにコピーしました · ⌘V で貼り付けてください（自動で貼り付けるには、アクセシビリティの権限で voin をオンにしてください）",
        "붙여넣었습니다": "貼り付けました",
    ],
]
let appURL = URL(string: "http://localhost:\(port)")!

// 서버(/api/status)가 알려 주는 상태: 메뉴 막대 아이콘과 메뉴가 이 값으로 그려진다.
// 앱 창이 안 보이면 웹 화면이 멈추므로 화면이 아니라 서버에 1초마다 직접 묻는다.
struct WebState: Decodable {
    struct Model: Decodable {
        var state: String
        var paused: Bool?
        var received: Double?
        var total: Double?
        var verifying: Bool?
        var sizeMB: Int?
        var canDownload: Bool?
    }
    var recording = false
    var startedAt: Double?
    var processing: String?
    var model: Model?
    var busy: Bool { processing != nil }
}

// 제목줄이 없는 창: 웹 화면이 알려 준 자리(막대 가운데 등)를 누르고 끌면 창이 움직인다.
// 그 자리는 클릭도 받는다(모델이 없을 때 막대 가운데 = 설정 열기): 움직이지 않고 떼면 클릭으로 웹에 넘긴다
final class VoinWebView: WKWebView {
    var dragRects: [NSRect] = [] // 웹 좌표 (왼쪽 위가 0,0)
    override func mouseDown(with event: NSEvent) {
        let p = convert(event.locationInWindow, from: nil)
        let point = NSPoint(x: p.x, y: isFlipped ? p.y : bounds.height - p.y)
        guard let window, dragRects.contains(where: { $0.contains(point) }) else { return super.mouseDown(with: event) }
        let next = window.nextEvent(matching: [.leftMouseUp, .leftMouseDragged])
        if next?.type == .leftMouseDragged { return window.performDrag(with: event) }
        super.mouseDown(with: event)
        if let up = next { super.mouseUp(with: up) }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate, WKNavigationDelegate, WKScriptMessageHandler, NSMenuDelegate {
    var window: NSWindow!
    var webView: VoinWebView!
    // 배경: 창 전체를 유리 한 장으로 (막대와 판이 한 덩어리로 보이게). 웹 화면은 투명하게 그 위에 얹고,
    // 판 부분은 웹 쪽에서 옅게 덮어 글을 읽기 쉽게 한다.
    // Liquid Glass는 macOS 26부터. 그 전 macOS에서는 반투명 재질을 둥글게 잘라 대신한다
    let cornerRadius: CGFloat = 22
    lazy var glass: NSView = {
        if #available(macOS 26.0, *) {
            let view = NSGlassEffectView()
            view.cornerRadius = cornerRadius
            return view
        }
        let view = NSVisualEffectView()
        view.material = .popover
        view.blendingMode = .behindWindow
        view.state = .active
        view.wantsLayer = true
        view.layer?.cornerRadius = cornerRadius
        view.layer?.masksToBounds = true
        return view
    }()
    var server: Process?
    var statusItem: NSStatusItem?
    var webState = WebState()
    var hotkey = HotKey(id: 1)
    var hotkeyString = ""
    var agentKey = HotKey(id: 2)
    var agentKeyString = ""
    var dictateKey = HotKey(id: 3)
    var dictateKeyString = ""
    let paster: TextPaster = MacPaster()
    var statusTimer: Timer?
    let barHeight: CGFloat = 56 // 웹 화면의 막대 높이와 같게
    // 판을 끌어서 맞춘 길이: 다음에 열 때와 앱을 다시 켰을 때도 그 길이로
    var expandedHeight: CGFloat = {
        let saved = UserDefaults.standard.double(forKey: "panelHeight")
        return saved > 0 ? CGFloat(saved) : 560
    }() {
        didSet { UserDefaults.standard.set(Double(expandedHeight), forKey: "panelHeight") }
    }
    let logURL = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Logs/voin.log")

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        let config = WKWebViewConfiguration()
        config.mediaTypesRequiringUserActionForPlayback = []
        config.userContentController.add(self, name: "pickFolder")
        config.userContentController.add(self, name: "native")
        webView = VoinWebView(frame: .zero, configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        webView.uiDelegate = self
        webView.navigationDelegate = self

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 520, height: barHeight),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
        window.title = "voin"
        // Spotlight처럼 막대 하나: 제목줄·신호등 버튼 없이, 창 전체를 유리·재질로 (⌘W로 닫는다)
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        for kind in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { window.standardWindowButton(kind)?.isHidden = true }
        window.isOpaque = false
        window.backgroundColor = .clear
        window.isReleasedWhenClosed = false // 창을 닫아도 녹음·단축키·메뉴 막대는 계속 동작한다
        let root = NSView()
        for view in [glass, webView!] as [NSView] {
            view.frame = root.bounds
            view.autoresizingMask = [.width, .height]
            root.addSubview(view)
        }
        window.contentView = root
        NotificationCenter.default.addObserver(forName: NSWindow.didResizeNotification, object: window, queue: .main) { [weak self] _ in self?.layoutBackground() }
        window.contentMinSize = NSSize(width: 420, height: barHeight)
        window.contentMaxSize = NSSize(width: 10000, height: barHeight)
        window.setFrameAutosaveName("VoinBar")
        if !window.setFrameUsingName("VoinBar") { window.center() }
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        setupStatusItem()
        statusTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.pollStatus() }
        hotkey.onPress = { [weak self] in self?.toggleRecording() }
        agentKey.onPress = { [weak self] in self?.agentTalk() }
        dictateKey.onPress = { [weak self] in self?.dictate() }

        showMessage(L("모델을 불러오는 중입니다…"), detail: L("처음 실행할 때 10초 정도 걸립니다."))
        Task { await startServerAndLoad() }
    }

    func startServerAndLoad() async {
        // 터미널에서 npm start로 이미 띄워 둔 서버가 있으면 그대로 쓴다
        if await serverResponds() == false {
            do { try launchServer() } catch {
                showMessage(L("서버를 시작하지 못했습니다"), detail: error.localizedDescription)
                return
            }
            for _ in 0..<120 {
                if await serverResponds() { break }
                if server?.isRunning == false {
                    showMessage(L("서버가 종료되었습니다"), detail: L("자세한 내용: {path}", ["path": logURL.path]))
                    return
                }
                try? await Task.sleep(nanoseconds: 500_000_000)
            }
        }
        if await serverResponds() {
            // 앱을 새 버전으로 바꿨을 때 예전 화면이 남지 않도록 캐시를 비우고 항상 서버에서 새로 받는다
            await WKWebsiteDataStore.default().removeData(
                ofTypes: [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache], modifiedSince: .distantPast)
            await MainActor.run {
                _ = webView.load(URLRequest(url: appURL, cachePolicy: .reloadIgnoringLocalAndRemoteCacheData))
            }
        } else {
            showMessage(L("서버가 응답하지 않습니다"), detail: L("자세한 내용: {path}", ["path": logURL.path]))
        }
    }

    func serverResponds() async -> Bool {
        var request = URLRequest(url: appURL.appendingPathComponent("api/meetings"))
        request.timeoutInterval = 1
        guard let (_, response) = try? await URLSession.shared.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func launchServer() throws {
        // 서버 코드와 Node.js는 앱 안에 함께 들어 있다 (Contents/Resources/app, Contents/Resources/bin/node)
        guard let resources = Bundle.main.resourcePath else { throw AppError(L("앱 리소스 폴더를 찾지 못했습니다.")) }
        let appDir = resources + "/app"
        let node = resources + "/bin/node"
        guard FileManager.default.fileExists(atPath: appDir + "/server.mjs"), FileManager.default.isExecutableFile(atPath: node)
        else { throw AppError(L("앱 안의 서버 파일이 없습니다. 앱을 다시 설치하세요.")) }

        // 로그는 실행할 때마다 지우지 않고 이어 쓴다 (문제가 난 회의의 기록이 남도록). 5MB가 넘으면 새로 시작한다.
        let size = (try? FileManager.default.attributesOfItem(atPath: logURL.path)[.size] as? Int) ?? 0
        if size == 0 || size > 5_000_000 { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        let log = try FileHandle(forWritingTo: logURL)
        log.seekToEndOfFile()
        log.write("\n===== 앱 시작 \(Date().formatted(date: .numeric, time: .standard)) =====\n".data(using: .utf8)!)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        // --use-system-ca: 회사망처럼 HTTPS를 재서명하는 곳에서도 맥 키체인의 인증서로 모델을 내려받는다
        process.arguments = ["--use-system-ca", "server.mjs"]
        process.currentDirectoryURL = URL(fileURLWithPath: appDir)
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        env["VOIN_LANG"] = appLang // 서버가 보내는 안내·오류도 화면과 같은 언어로
        env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
        process.environment = env
        process.standardOutput = log
        process.standardError = log
        try process.run()
        server = process
    }

    func showMessage(_ title: String, detail: String) {
        let html = """
            <html><body style="font:15px -apple-system;display:flex;height:100vh;margin:0;align-items:center;
            justify-content:center;flex-direction:column;color:#555;background:transparent">
            <h2 style="color:#1d1d1f;font-weight:600">\(title)</h2><p>\(detail)</p></body></html>
            """
        DispatchQueue.main.async { self.webView.loadHTMLString(html, baseURL: nil) }
    }

    // 웹 화면이 마이크를 요청하면 허용한다 (이 앱의 로컬 화면에만 해당)
    func webView(
        _ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
        initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType,
        decisionHandler: @escaping (WKPermissionDecision) -> Void
    ) {
        decisionHandler(origin.host == "localhost" ? .grant : .deny)
    }

    // obsidian:// 같은 외부 링크는 해당 앱으로 연다
    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        if let url = navigationAction.request.url, let scheme = url.scheme, !["http", "https", "about", "blob", "data"].contains(scheme) {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // 웹 화면의 <input type=file>: macOS에서는 앱이 직접 파일 선택 창을 띄워야 한다
    func webView(
        _ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.allowedContentTypes = [.audio]
        panel.message = L("받아쓸 녹음 파일을 고르세요")
        panel.beginSheetModal(for: window) { completionHandler($0 == .OK ? panel.urls : nil) }
    }

    // 설정 화면의 "폴더 선택…": 고른 경로를 웹 화면의 folderPicked(대상, 경로)로 돌려준다
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        if message.name == "native" { return handleNative(message.body as? String ?? "") }
        guard message.name == "pickFolder", let target = message.body as? String else { return }
        let panel = NSOpenPanel()
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.prompt = L("선택")
        panel.beginSheetModal(for: window) { response in
            guard response == .OK, let path = panel.url?.path else { return }
            // 경로에 따옴표·한글이 있어도 안전하도록 JSON 배열로 넘긴다
            guard let data = try? JSONSerialization.data(withJSONObject: [target, path]),
                let json = String(data: data, encoding: .utf8)
            else { return }
            self.webView.evaluateJavaScript("window.folderPicked(...\(json))")
        }
    }

    // 웹 화면 → 앱: 상태(state), 단축키(hotkey), 메뉴 막대 아이콘 표시(menuBarIcon)
    func handleNative(_ body: String) {
        guard let data = body.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let type = json["type"] as? String
        else { return }
        switch type {
        case "state":
            pollStatus() // 녹음 시작·종료를 누른 직후 바로 반영되도록
        case "hotkey":
            hotkeyString = json["hotkey"] as? String ?? ""
            let error = hotkey.register(hotkeyString)
            let args = (try? JSONSerialization.data(withJSONObject: [error == nil, error ?? ""])).flatMap { String(data: $0, encoding: .utf8) } ?? "[true,\"\"]"
            webView.evaluateJavaScript("window.hotkeyResult?.(...\(args))")
        case "hotkey2":
            agentKeyString = json["hotkey"] as? String ?? ""
            _ = agentKey.register(agentKeyString)
        case "hotkey3":
            dictateKeyString = json["hotkey"] as? String ?? ""
            _ = dictateKey.register(dictateKeyString)
        case "paste":
            // 받아쓰기(⌥D) 결과를 지금 앞에 있는 앱에 붙여넣는다. 결과(성공/권한 없음)는 막대에 표시
            let result = paster.paste(json["text"] as? String ?? "")
            let args = (try? JSONSerialization.data(withJSONObject: [result.ok, result.message])).flatMap { String(data: $0, encoding: .utf8) } ?? "[true,\"\"]"
            webView.evaluateJavaScript("window.pasteResult?.(...\(args))")
        case "symbols":
            let wanted = (json["symbols"] as? [[String: Any]] ?? []).compactMap { item -> (String, CGFloat)? in
                guard let name = item["name"] as? String else { return nil }
                return (name, CGFloat((item["size"] as? NSNumber)?.doubleValue ?? 15))
            }
            var map: [String: [String: Any]] = [:]
            for (name, size) in wanted { if let image = symbolImage(name, size: size) { map["\(name)@\(Int(size))"] = image } }
            if let data = try? JSONSerialization.data(withJSONObject: map), let text = String(data: data, encoding: .utf8) {
                webView.evaluateJavaScript("window.applySymbols(\(text))")
            }
        case "dragRegions":
            webView.dragRects = (json["rects"] as? [[String: Double]] ?? []).map { NSRect(x: $0["x"] ?? 0, y: $0["y"] ?? 0, width: $0["w"] ?? 0, height: $0["h"] ?? 0) }
        case "panel":
            setPanel(json["open"] as? Bool ?? false, fit: (json["fit"] as? NSNumber).map { CGFloat($0.doubleValue) })
        case "menuBarIcon":
            statusItem?.isVisible = json["visible"] as? Bool ?? true
        default: break
        }
    }

    // 판이 열리면 창을 늘리고, 닫히면 막대 높이로 줄인다. 막대는 화면에서 제자리에 둔다:
    // 아래에 자리가 있으면 아래로(윗변 고정), 화면 아래쪽이라 모자라면 위로(아랫변 고정, 판이 막대 위에 생김)
    var panelUp = false
    var fitted = false // 지금 판이 내용에 맞춘 높이인가 (이때 높이는 사용자 높이로 기억하지 않는다)
    // fit: 내용이 적은 판(폴더 고르기·녹음 전)은 내용 높이만큼만 연다. 없으면 사용자가 늘려 둔 높이
    func setPanel(_ open: Bool, fit: CGFloat? = nil) {
        let content = window.contentRect(forFrameRect: window.frame)
        if !fitted && content.height > barHeight + 80 { expandedHeight = content.height } // 사용자가 늘려 둔 높이를 기억
        let height = open ? (fit ?? max(expandedHeight, 420)) : barHeight
        fitted = open && fit != nil
        guard abs(content.height - height) > 1 else { return }
        let screen = (window.screen ?? NSScreen.main)?.visibleFrame ?? .zero
        if open {
            let roomBelow = content.maxY - screen.minY
            let roomAbove = screen.maxY - content.minY
            panelUp = roomBelow < height && roomAbove > roomBelow
            webView.evaluateJavaScript("document.body.classList.toggle('panel-up', \(panelUp))")
        }
        window.contentMinSize = NSSize(width: 420, height: open ? min(320, height) : barHeight)
        window.contentMaxSize = NSSize(width: 10000, height: open ? 10000 : barHeight)
        let y = panelUp ? content.minY : content.maxY - height
        let target = NSRect(x: content.minX, y: y, width: content.width, height: height)
        window.setFrame(window.frameRect(forContentRect: target), display: true, animate: true)
        if !open { panelUp = false }
        layoutBackground()
    }

    // SF Symbols 하나를 2배 해상도 PNG(검정+투명)로 그려 data URL로 돌려준다. 웹은 이것을 마스크로 쓴다
    // "mic+hammer.fill"처럼 + 로 이으면 앞 기호에 뒤 기호를 오른쪽 아래 배지로 붙인다 (배지 둘레는 파내서 겹치지 않게)
    func symbolShape(_ name: String, size: CGFloat) -> NSImage? {
        let parts = name.split(separator: "+").map(String.init)
        func sf(_ n: String, _ s: CGFloat, _ w: NSFont.Weight) -> NSImage? {
            NSImage(systemSymbolName: n, accessibilityDescription: nil)?.withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: s, weight: w))
        }
        // 막대에서 또렷하게: 기본 굵기를 medium으로 (작은 아이콘은 regular)
        let weight: NSFont.Weight = size >= 16 ? .medium : .regular
        guard let base = sf(parts[0], size, weight) else { return nil }
        guard parts.count > 1, let badge = sf(parts[1], size * 0.62, .bold) else { return base }
        let canvas = NSSize(width: base.size.width + badge.size.width * 0.45, height: base.size.height + badge.size.height * 0.15)
        let image = NSImage(size: canvas)
        image.lockFocus()
        base.draw(at: NSPoint(x: 0, y: canvas.height - base.size.height), from: .zero, operation: .sourceOver, fraction: 1)
        let spot = NSRect(x: canvas.width - badge.size.width, y: 0, width: badge.size.width, height: badge.size.height)
        let gap = size / 16 * 1.5
        for dx in stride(from: -gap, through: gap, by: gap / 2) {
            for dy in stride(from: -gap, through: gap, by: gap / 2) { badge.draw(in: spot.offsetBy(dx: dx, dy: dy), from: .zero, operation: .destinationOut, fraction: 1) }
        }
        badge.draw(in: spot, from: .zero, operation: .sourceOver, fraction: 1)
        image.unlockFocus()
        return image
    }

    func symbolImage(_ name: String, size: CGFloat) -> [String: Any]? {
        guard let image = symbolShape(name, size: size) else { return nil }
        let scale: CGFloat = 2
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: Int(ceil(image.size.width * scale)), pixelsHigh: Int(ceil(image.size.height * scale)),
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return nil }
        rep.size = image.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        image.draw(in: NSRect(origin: .zero, size: image.size))
        NSGraphicsContext.restoreGraphicsState()
        guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
        return ["url": "data:image/png;base64," + png.base64EncodedString(), "w": Double(image.size.width), "h": Double(image.size.height)]
    }

    // 유리는 창 전체를 덮는다 (크기는 autoresizing). 모양이 바뀌면 그림자만 다시 계산
    func layoutBackground() {
        window.invalidateShadow()
    }

    func callWeb(_ function: String) { webView.evaluateJavaScript("window.app?.\(function)()") }

    @objc func showWindow() {
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }
    @objc func newMeeting() { showWindow(); callWeb("newMeeting") }
    @objc func importFile() { showWindow(); callWeb("importFile") }
    @objc func openSettings() { showWindow(); callWeb("openSettings") }
    // 앱이 앞에 있을 때는 전역 단축키와 메뉴 단축키가 함께 눌려 두 번 들어온다: 0.7초 안의 두 번째는 무시한다
    var lastToggle = Date.distantPast
    @objc func toggleRecording() {
        guard Date().timeIntervalSince(lastToggle) > 0.7 else { return }
        lastToggle = Date()
        // 창이 닫혀 있으면 화면이 마이크를 받지 못한다: 녹음을 시작할 때는 창을 (지금 쓰는 앱을 가리지 않게) 뒤에 띄운다
        if !webState.recording && !window.isVisible {
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.callWeb("toggleRecording") }
        } else {
            callWeb("toggleRecording")
        }
    }
    @objc func modelAction() { callWeb("modelAction") }

    // 말로 작업하기(⌥V): 녹음처럼 닫힌 창은 마이크를 못 받으니 창을 뒤에 띄운 뒤 듣기 시작
    @objc func agentTalk() {
        guard Date().timeIntervalSince(lastToggle) > 0.7 else { return }
        lastToggle = Date()
        if !window.isVisible {
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.callWeb("agentTalk") }
        } else {
            callWeb("agentTalk")
        }
    }
    // 아무 앱에 받아쓰기(⌥D): 창을 띄우되 활성화하지 않아(orderFrontRegardless) 지금 쓰던 앱이 앞에 남고,
    // 다시 누르면 받아쓴 글이 그 앱에 붙는다. 처음 누를 때 손쉬운 사용 권한을 미리 묻는다(붙여넣기 때 필요)
    @objc func dictate() {
        guard Date().timeIntervalSince(lastToggle) > 0.4 else { return }
        lastToggle = Date()
        paster.prepare()
        if !window.isVisible {
            window.orderFrontRegardless()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { self.callWeb("dictateToggle") }
        } else {
            callWeb("dictateToggle")
        }
    }
    @objc func openFolder() { callWeb("openFolder") }

    // ───────── 메뉴 막대 아이콘 ─────────

    func setupStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.image = NSImage(systemSymbolName: "waveform", accessibilityDescription: "voin")
        item.button?.imagePosition = .imageLeading
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item
    }

    func pollStatus() {
        var request = URLRequest(url: appURL.appendingPathComponent("api/status"))
        request.timeoutInterval = 1
        URLSession.shared.dataTask(with: request) { data, _, _ in
            guard let data, let state = try? JSONDecoder().decode(WebState.self, from: data) else { return }
            DispatchQueue.main.async {
                self.webState = state
                self.updateStatusItem()
            }
        }.resume()
    }

    func elapsedText() -> String? {
        guard webState.recording, let startedAt = webState.startedAt else { return nil }
        let s = max(0, Int(Date().timeIntervalSince1970 - startedAt / 1000))
        return String(format: "%02d:%02d:%02d", s / 3600, s / 60 % 60, s % 60)
    }

    // 녹음 중에는 빨간 아이콘과 경과 시간, 정리 중에는 모래시계와 진행률을 보여 준다
    func updateStatusItem() {
        guard let button = statusItem?.button else { return }
        let recording = webState.recording
        let processing = !recording ? webState.processing : nil
        let symbol = recording ? "record.circle.fill" : processing != nil ? "hourglass" : "waveform"
        let image = NSImage(systemSymbolName: symbol, accessibilityDescription: "voin")
        // 빨강은 녹음 점 아이콘에만 쓴다. 글자와 다른 아이콘은 메뉴 막대 기본 색(밝기·배경에 맞춰 바뀜)을 따른다
        if recording, let red = image?.withSymbolConfiguration(.init(paletteColors: [.systemRed])) {
            red.isTemplate = false
            button.image = red
        } else {
            image?.isTemplate = true
            button.image = image
        }
        button.contentTintColor = nil
        if let processing {
            // "화자별로 정리 중… (마이크) 45%"에서 숫자만 꺼내 짧게 보여 준다
            let percent = processing.range(of: #"\d+%"#, options: .regularExpression).map { " \(processing[$0])" } ?? ""
            button.title = " " + L("정리 중") + percent
        } else {
            button.title = elapsedText().map { " \($0)" } ?? ""
        }
    }

    func modelMenuText() -> (status: String, action: String?) {
        guard let model = webState.model else { return (L("받아쓰기 모델 확인 중…"), nil) }
        switch model.state {
        case "ready": return (L("대기 중"), nil)
        case "loading": return (L("받아쓰기 모델 불러오는 중…"), nil)
        case "downloading":
            if model.verifying == true { return (L("받은 파일 확인 중…"), nil) }
            let percent = Int((model.received ?? 0) / max(model.total ?? 1, 1) * 100)
            return (L("받아쓰기 모델 내려받는 중 {percent}%", ["percent": "\(percent)"]), L("내려받기 취소"))
        case "missing":
            return (model.paused == true ? L("받아쓰기 모델 내려받기 멈춤") : L("받아쓰기 모델 없음"),
                model.paused == true ? L("받아쓰기 모델 이어 받기") : L("받아쓰기 모델 내려받기 ({size}MB)", ["size": "\(model.sizeMB ?? 751)"]))
        default: return (L("받아쓰기 모델 문제 있음"), model.canDownload == true ? L("받아쓰기 모델 다시 받기") : nil)
        }
    }

    struct InstalledModel { let id: String; let name: String; let active: Bool }

    // 로컬 서버에서 받아 둔 모델 목록을 읽는다 (같은 맥 안이라 바로 응답한다)
    func installedModels() -> [InstalledModel] {
        guard let data = try? Data(contentsOf: appURL.appendingPathComponent("api/models")),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let models = json["models"] as? [[String: Any]]
        else { return [] }
        return models.compactMap { m in
            guard m["installed"] as? Bool == true, let id = m["id"] as? String, let name = m["name"] as? String else { return nil }
            return InstalledModel(id: id, name: name, active: m["active"] as? Bool == true)
        }
    }

    @objc func useModel(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        var request = URLRequest(url: appURL.appendingPathComponent("api/models/\(id)/use"))
        request.httpMethod = "POST"
        URLSession.shared.dataTask(with: request).resume()
    }

    // 메뉴를 열 때마다 지금 상태로 다시 그린다
    func menuNeedsUpdate(_ menu: NSMenu) {
        menu.removeAllItems()
        let (modelStatus, modelActionTitle) = modelMenuText()
        let status = elapsedText().map { L("녹음 중 · {time}", ["time": $0]) } ?? webState.processing ?? (webState.busy ? L("저장하는 중…") : modelStatus)
        let header = menu.addItem(withTitle: status, action: nil, keyEquivalent: "")
        header.isEnabled = false

        let ready = webState.model?.state == "ready" && !webState.busy
        let record = menu.addItem(withTitle: webState.recording ? L("녹음 중지") : L("녹음 시작"), action: #selector(toggleRecording), keyEquivalent: "")
        record.target = self
        record.isEnabled = webState.recording || ready
        HotKey.describe(hotkeyString, on: record)
        if let modelActionTitle {
            menu.addItem(withTitle: modelActionTitle, action: #selector(modelAction), keyEquivalent: "").target = self
        }
        // 받아 둔 모델끼리 바꾸기 (녹음 중에는 바꿀 수 없다)
        let installed = installedModels()
        if installed.count > 1 {
            let item = menu.addItem(withTitle: L("받아쓰기 모델"), action: nil, keyEquivalent: "")
            let sub = NSMenu()
            for model in installed {
                let choice = sub.addItem(withTitle: model.name, action: #selector(useModel(_:)), keyEquivalent: "")
                choice.target = self
                choice.representedObject = model.id
                choice.state = model.active ? .on : .off
                choice.isEnabled = !webState.recording && !webState.busy
            }
            item.submenu = sub
        }
        menu.addItem(.separator())
        let talk = menu.addItem(withTitle: L("말로 작업하기"), action: #selector(agentTalk), keyEquivalent: "")
        talk.target = self
        talk.isEnabled = !webState.recording && webState.model?.state == "ready"
        HotKey.describe(agentKeyString, on: talk)
        let dictateItem = menu.addItem(withTitle: L("아무 앱에 받아쓰기"), action: #selector(dictate), keyEquivalent: "")
        dictateItem.target = self
        dictateItem.isEnabled = !webState.recording && webState.model?.state == "ready"
        HotKey.describe(dictateKeyString, on: dictateItem)
        let importItem = menu.addItem(withTitle: L("녹음 파일 불러오기…"), action: #selector(importFile), keyEquivalent: "")
        importItem.target = self
        importItem.isEnabled = ready && !webState.recording
        menu.addItem(withTitle: L("저장 폴더 열기"), action: #selector(openFolder), keyEquivalent: "").target = self
        menu.addItem(.separator())
        menu.addItem(withTitle: L("voin 창 열기"), action: #selector(showWindow), keyEquivalent: "").target = self
        let settings = menu.addItem(withTitle: L("설정…"), action: #selector(openSettings), keyEquivalent: "")
        settings.target = self
        settings.isEnabled = !webState.recording
        menu.addItem(.separator())
        menu.addItem(withTitle: L("voin 종료"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "")
    }

    // 메뉴 막대와 단축키를 계속 쓸 수 있도록, 창을 닫아도 앱은 끝나지 않는다. Dock 아이콘을 누르면 창이 다시 열린다.
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { showWindow() }
        return true
    }

    // 종료 시 서버에 SIGTERM → 서버가 녹음 중이던 회의를 저장한 뒤 끝난다
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        guard let server, server.isRunning else { return .terminateNow }
        server.terminate()
        DispatchQueue.global().async {
            let deadline = Date().addingTimeInterval(10)
            while server.isRunning && Date() < deadline { usleep(100_000) }
            DispatchQueue.main.async { NSApp.reply(toApplicationShouldTerminate: true) }
        }
        return .terminateLater
    }

    func buildMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        main.addItem(appItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: L("voin에 관하여"), action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L("설정…"), action: #selector(openSettings), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: L("voin 숨기기"), action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(withTitle: L("voin 종료"), action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        let fileItem = NSMenuItem()
        main.addItem(fileItem)
        let fileMenu = NSMenu(title: L("파일"))
        fileMenu.addItem(withTitle: L("새 회의 녹음"), action: #selector(newMeeting), keyEquivalent: "n")
        fileMenu.addItem(withTitle: L("녹음 파일 불러오기…"), action: #selector(importFile), keyEquivalent: "o")
        fileMenu.addItem(withTitle: L("녹음 시작/중지"), action: #selector(toggleRecording), keyEquivalent: "r")
        fileMenu.addItem(withTitle: L("말로 작업하기"), action: #selector(agentTalk), keyEquivalent: "")
        fileMenu.addItem(.separator())
        fileMenu.addItem(withTitle: L("창 닫기"), action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        fileItem.submenu = fileMenu
        // 복사/붙여넣기 단축키가 웹 화면에서 동작하려면 편집 메뉴가 필요하다
        let editItem = NSMenuItem()
        main.addItem(editItem)
        let editMenu = NSMenu(title: L("편집"))
        editMenu.addItem(withTitle: L("실행 취소"), action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: L("잘라내기"), action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: L("복사"), action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: L("붙여넣기"), action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: L("전체 선택"), action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        NSApp.mainMenu = main
    }
}

// 전역 단축키: 다른 앱을 쓰는 중에도 눌리도록 Carbon RegisterEventHotKey를 쓴다 (손쉬운 사용 권한 필요 없음)
final class HotKey {
    var onPress: (() -> Void)?
    private var ref: EventHotKeyRef?
    private let id: UInt32
    private static var handlerInstalled = false
    // 단축키가 여러 개(녹음 ⌥R, 말로 작업 ⌥V)라 눌린 단축키의 번호로 찾아 부른다
    static var registry: [UInt32: HotKey] = [:]

    init(id: UInt32) {
        self.id = id
    }

    static let keyCodes: [String: Int] = {
        var map: [String: Int] = [
            "KeyA": kVK_ANSI_A, "KeyB": kVK_ANSI_B, "KeyC": kVK_ANSI_C, "KeyD": kVK_ANSI_D, "KeyE": kVK_ANSI_E,
            "KeyF": kVK_ANSI_F, "KeyG": kVK_ANSI_G, "KeyH": kVK_ANSI_H, "KeyI": kVK_ANSI_I, "KeyJ": kVK_ANSI_J,
            "KeyK": kVK_ANSI_K, "KeyL": kVK_ANSI_L, "KeyM": kVK_ANSI_M, "KeyN": kVK_ANSI_N, "KeyO": kVK_ANSI_O,
            "KeyP": kVK_ANSI_P, "KeyQ": kVK_ANSI_Q, "KeyR": kVK_ANSI_R, "KeyS": kVK_ANSI_S, "KeyT": kVK_ANSI_T,
            "KeyU": kVK_ANSI_U, "KeyV": kVK_ANSI_V, "KeyW": kVK_ANSI_W, "KeyX": kVK_ANSI_X, "KeyY": kVK_ANSI_Y,
            "KeyZ": kVK_ANSI_Z, "Digit0": kVK_ANSI_0, "Digit1": kVK_ANSI_1, "Digit2": kVK_ANSI_2, "Digit3": kVK_ANSI_3,
            "Digit4": kVK_ANSI_4, "Digit5": kVK_ANSI_5, "Digit6": kVK_ANSI_6, "Digit7": kVK_ANSI_7, "Digit8": kVK_ANSI_8,
            "Digit9": kVK_ANSI_9, "Space": kVK_Space,
        ]
        let fKeys = [kVK_F1, kVK_F2, kVK_F3, kVK_F4, kVK_F5, kVK_F6, kVK_F7, kVK_F8, kVK_F9, kVK_F10, kVK_F11, kVK_F12]
        for (i, code) in fKeys.enumerated() { map["F\(i + 1)"] = code }
        return map
    }()

    // "alt+shift+cmd+KeyR" 같은 문자열을 등록한다. 실패하면 이유를, 성공하면 nil을 돌려준다.
    func register(_ text: String) -> String? {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
        guard !text.isEmpty else { return nil }
        var parts = text.split(separator: "+").map(String.init)
        guard let code = parts.popLast(), let keyCode = Self.keyCodes[code] else { return L("지원하지 않는 키입니다.") }
        var modifiers = 0
        for part in parts {
            switch part {
            case "cmd": modifiers |= cmdKey
            case "alt": modifiers |= optionKey
            case "ctrl": modifiers |= controlKey
            case "shift": modifiers |= shiftKey
            default: return L("지원하지 않는 수식키입니다.")
            }
        }
        Self.installHandler()
        Self.registry[id] = self
        let hotKeyID = EventHotKeyID(signature: OSType(0x4D4E_4F54), id: id) // 'MNOT'
        let status = RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), hotKeyID, GetApplicationEventTarget(), 0, &ref)
        if status == noErr { return nil }
        return status == eventHotKeyExistsErr ? L("이미 다른 곳에서 쓰는 단축키입니다. 다른 조합을 고르세요.") : L("단축키를 등록하지 못했습니다 ({status}).", ["status": "\(status)"])
    }

    private static func installHandler() {
        guard !handlerInstalled else { return }
        handlerInstalled = true
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ in
            var pressed = EventHotKeyID()
            GetEventParameter(
                event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                MemoryLayout<EventHotKeyID>.size, nil, &pressed)
            let id = pressed.id
            DispatchQueue.main.async { HotKey.registry[id]?.onPress?() }
            return noErr
        }, 1, &spec, nil, nil)
    }

    // 메뉴 항목 옆에 단축키를 표시만 한다 (실제 동작은 전역 단축키가 맡는다)
    static func describe(_ text: String, on item: NSMenuItem) {
        var parts = text.split(separator: "+").map(String.init)
        guard let code = parts.popLast(), code.hasPrefix("Key") || code.hasPrefix("Digit") else { return }
        item.keyEquivalent = code.replacingOccurrences(of: "Key", with: "").replacingOccurrences(of: "Digit", with: "").lowercased()
        var mask: NSEvent.ModifierFlags = []
        if parts.contains("cmd") { mask.insert(.command) }
        if parts.contains("alt") { mask.insert(.option) }
        if parts.contains("ctrl") { mask.insert(.control) }
        if parts.contains("shift") { mask.insert(.shift) }
        item.keyEquivalentModifierMask = mask
    }
}

// ───────── 붙여넣기 (플랫폼 경계) ─────────
// 받아쓴 글을 지금 앞에 있는 앱의 커서 자리에 넣는다. 플랫폼마다 이 프로토콜만 구현하면 된다
// (Windows라면 클립보드 + SendInput(Ctrl+V)).
protocol TextPaster {
    func prepare() // 권한이 필요하면 미리 묻는다
    func paste(_ text: String) -> (ok: Bool, message: String)
}

// macOS: 클립보드(NSPasteboard)에 넣고 CGEvent로 ⌘V를 보낸 뒤, 잠시 후 원래 클립보드를 되돌린다.
// ⌘V를 보내려면 손쉬운 사용 권한이 필요하다. 없으면 클립보드에만 넣고(되돌리지 않음) 권한을 안내한다.
final class MacPaster: TextPaster {
    private var asked = false

    func prepare() {
        guard !asked, !AXIsProcessTrusted() else { return }
        asked = true
        // 시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용 에 voin을 켜 달라는 시스템 창을 띄운다
        let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(options)
    }

    func paste(_ text: String) -> (ok: Bool, message: String) {
        guard !text.isEmpty else { return (true, "") }
        let board = NSPasteboard.general
        guard AXIsProcessTrusted() else {
            board.clearContents()
            board.setString(text, forType: .string)
            prepare()
            return (false, L("클립보드에 넣었습니다 · ⌘V로 붙여넣으세요 (자동 붙여넣기는 손쉬운 사용 권한에서 voin을 켜면 됩니다)"))
        }
        let saved = Self.snapshot(board)
        board.clearContents()
        board.setString(text, forType: .string)
        let ours = board.changeCount
        Self.sendCommandV()
        // 붙여넣는 앱이 클립보드를 읽을 시간을 준 뒤 되돌린다. 그사이 사용자가 다른 걸 복사했으면 건드리지 않는다
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            guard board.changeCount == ours else { return }
            board.clearContents()
            if !saved.isEmpty { board.writeObjects(saved) }
        }
        return (true, L("붙여넣었습니다"))
    }

    // 클립보드 항목을 형식별로 복사해 둔다 (NSPasteboardItem은 클립보드가 바뀌면 못 쓰게 되므로 새로 만든다)
    private static func snapshot(_ board: NSPasteboard) -> [NSPasteboardItem] {
        (board.pasteboardItems ?? []).map { item in
            let copy = NSPasteboardItem()
            for type in item.types {
                if let data = item.data(forType: type) { copy.setData(data, forType: type) }
            }
            return copy
        }
    }

    // ⌘V: 단축키(⌥D)의 수식키가 섞이지 않도록 Command만 지정한다
    private static func sendCommandV() {
        let source = CGEventSource(stateID: .combinedSessionState)
        let key = CGKeyCode(kVK_ANSI_V)
        let down = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: true)
        let up = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: false)
        down?.flags = .maskCommand
        up?.flags = .maskCommand
        down?.post(tap: .cghidEventTap)
        up?.post(tap: .cghidEventTap)
    }
}

struct AppError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
