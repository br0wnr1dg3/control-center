import AppKit
import SwiftUI
import UserNotifications

@main
struct ControlCenterBoardApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    var body: some Scene {
        MenuBarExtra {
            PopoverView()
        } label: {
            MenuBarLabel()
        }
        .menuBarExtraStyle(.window)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var hotKey: HotKey?

    func applicationDidFinishLaunching(_ notification: Notification) {
        Notifier.requestPermission()
        if Bundle.main.bundleIdentifier != nil {
            UNUserNotificationCenter.current().delegate = self
        }
        hotKey = HotKey { QuickAddPanel.toggle() }
        BoardStore.shared.start()
        BoardWindow.show()
    }

    /// Clicking the Dock icon opens the board.
    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        BoardWindow.show()
        return true
    }

    /// controlcenter://board · controlcenter://quick-add · controlcenter://add?title=...&kind=agent&today=1&ready=1&date=2026-11-12&project=Content
    func application(_ application: NSApplication, open urls: [URL]) {
        if urls.contains(where: { $0.host == "board" }) { BoardWindow.show() }
        if urls.contains(where: { $0.host == "quick-add" }) { QuickAddPanel.toggle() }
        // controlcenter://task/12 opens CC-12.
        for url in urls where url.host == "task" {
            if let id = Int(url.lastPathComponent) {
                BoardStore.shared.open(id)
                BoardWindow.show()
            }
        }
        for url in urls where url.host == "add" {
            let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
            func value(_ name: String) -> String? { query.first { $0.name == name }?.value }
            guard let title = value("title") else { continue }
            BoardStore.shared.add(
                title: title,
                kind: TaskKind(rawValue: value("kind") ?? "") ?? .human,
                today: value("today") == "1",
                ready: value("ready") == "1",
                scheduledOn: value("date"),
                project: value("project")
            )
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler completionHandler: @escaping () -> Void) {
        DispatchQueue.main.async {
            BoardStore.shared.section = .inbox
            BoardWindow.show()
        }
        completionHandler()
    }
}

/// The board lives in a plain AppKit window so it can be opened from anywhere (notifications, hotkeys),
/// not just from inside a SwiftUI scene.
@MainActor
enum BoardWindow {
    private static var window: NSWindow?

    static func show() {
        if window == nil {
            let w = NSWindow(contentViewController: NSHostingController(rootView: MainWindow()))
            w.title = "Control Center"
            w.setContentSize(NSSize(width: 1440, height: 860))
            w.setFrameAutosaveName("ControlCenterMain")
            w.isReleasedWhenClosed = false
            w.center()
            window = w
        }
        NSApp.activate(ignoringOtherApps: true)
        window?.makeKeyAndOrderFront(nil)
    }
}

/// Floating quick-add box for the global hotkey.
@MainActor
enum QuickAddPanel {
    private static var panel: NSPanel?

    static func toggle() {
        if let panel, panel.isVisible {
            panel.orderOut(nil)
            return
        }
        let p = KeyPanel(
            contentRect: NSRect(x: 0, y: 0, width: 680, height: 300),
            styleMask: [.borderless, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        p.isOpaque = false
        p.backgroundColor = .clear
        p.hasShadow = true
        p.isMovableByWindowBackground = true
        p.isFloatingPanel = true
        p.level = .floating
        p.isReleasedWhenClosed = false
        p.contentViewController = NSHostingController(
            rootView: NewTaskComposer(initial: BoardStore.shared.defaults()) { QuickAddPanel.panel?.orderOut(nil) }
        )
        p.setContentSize(p.contentViewController!.view.fittingSize)
        p.center()
        panel = p
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }

    private final class KeyPanel: NSPanel {
        override var canBecomeKey: Bool { true }
        override func cancelOperation(_ sender: Any?) { orderOut(nil) }  // Esc closes

        /// Clicking off it (another app or window) closes it; its own pickers open in popovers, which keep it.
        override func resignKey() {
            super.resignKey()
            DispatchQueue.main.async { [weak self] in
                guard let self, self.isVisible else { return }
                let key = NSApp.keyWindow
                let ownPopover = key.map { $0 !== self && $0.className.contains("Popover") } ?? false
                if !NSApp.isActive || (key !== self && !ownPopover) { self.orderOut(nil) }
            }
        }
    }
}
