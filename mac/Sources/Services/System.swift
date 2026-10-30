import AppKit
import Carbon.HIToolbox
import ServiceManagement
import UserNotifications

// MARK: - Notifications

enum Notifier {
    private static var available: Bool { Bundle.main.bundleIdentifier != nil }

    static func requestPermission() {
        guard available else { return }
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
    }

    static func send(id: String, title: String, body: String) {
        guard available else { return }
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}

// MARK: - Global hotkey (⌃⌥Space)

final class HotKey {
    private static var action: (() -> Void)?
    private var ref: EventHotKeyRef?

    init(keyCode: Int = kVK_Space, modifiers: Int = controlKey | optionKey, action: @escaping () -> Void) {
        HotKey.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { HotKey.action?() }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x4343_4254), id: 1) // "CCBT"
        RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), id, GetApplicationEventTarget(), 0, &ref)
    }
}

// MARK: - cmux (jump to an agent's session)

enum Cmux {
    private static let bin = "/Applications/cmux.app/Contents/Resources/bin/cmux"

    static var isInstalled: Bool { FileManager.default.isExecutableFile(atPath: bin) }

    /// The runner names each task's workspace "CC-<id> <title>".
    static func openSession(taskId: Int) {
        DispatchQueue.global().async {
            guard let list = run(["list-workspaces"]),
                  let line = list.split(separator: "\n").first(where: { $0.contains("CC-\(taskId) ") }),
                  let ref = line.split(separator: " ").first(where: { $0.hasPrefix("workspace:") })
            else { return }
            _ = run(["select-workspace", "--workspace", String(ref)])
            DispatchQueue.main.async {
                NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/cmux.app"))
            }
        }
    }

    private static func run(_ args: [String]) -> String? {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: bin)
        process.arguments = args
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        guard (try? process.run()) != nil else { return nil }
        process.waitUntilExit()
        return String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    }
}

// MARK: - Launch at login

enum LoginItem {
    static var isEnabled: Bool { SMAppService.mainApp.status == .enabled }

    static func set(_ enabled: Bool) {
        try? enabled ? SMAppService.mainApp.register() : SMAppService.mainApp.unregister()
    }
}
