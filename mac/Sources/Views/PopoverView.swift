import SwiftUI

/// Menu bar popover: a compact Today with inline answers.
struct PopoverView: View {
    var store = BoardStore.shared
    @State private var launchAtLogin = LoginItem.isEnabled

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                Text(Date.now, format: .dateTime.weekday(.wide).month().day()).font(.headline)
                Spacer()
                if store.unreadCount > 0 {
                    Button { open(.inbox) } label: {
                        Label("\(store.unreadCount) unread", systemImage: "tray.fill")
                    }
                    .buttonStyle(.borderless)
                    .font(.caption)
                }
            }
            .padding(14)

            QuickAddView()
                .padding(.horizontal, 14)
                .padding(.bottom, 10)
            Divider()

            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if let error = store.lastError {
                        Label(error, systemImage: "exclamationmark.triangle").font(.caption).foregroundStyle(.red)
                    }
                    if !store.needsYou.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            SectionHeader(title: "Needs you", count: store.needsYou.count, color: .orange)
                            ForEach(store.needsYou) { NeedsYouCard(task: $0, compact: true) }
                        }
                    }
                    let today = store.tasks(on: Day.today)
                    VStack(alignment: .leading, spacing: 2) {
                        SectionHeader(title: "Today", count: today.filter { $0.kind != .agent }.count)
                        if today.isEmpty {
                            Text("Nothing on today.").foregroundStyle(.secondary).font(.callout)
                        }
                        ForEach(today) { task in
                            TaskRow(task: task).simultaneousGesture(TapGesture().onEnded { BoardWindow.show() })
                        }
                    }
                }
                .padding(14)
            }
            .frame(maxHeight: 480)

            Divider()
            HStack(spacing: 12) {
                Button("Open Control Center") { open(.today) }
                Toggle("Open at login", isOn: $launchAtLogin)
                    .toggleStyle(.checkbox)
                    .onChange(of: launchAtLogin) { _, on in LoginItem.set(on) }
                Spacer()
                Button("Quit") { NSApp.terminate(nil) }
            }
            .buttonStyle(.borderless)
            .font(.callout)
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
        }
        .frame(width: 400)
        .task { await store.refresh() }
    }

    private func open(_ section: Section) {
        store.section = section
        BoardWindow.show()
    }
}

struct MenuBarLabel: View {
    var store = BoardStore.shared

    var body: some View {
        if !store.needsYou.isEmpty {
            Label("\(store.needsYou.count)", systemImage: "exclamationmark.bubble.fill")
        } else if store.unreadCount > 0 {
            Label("\(store.unreadCount)", systemImage: "tray.full.fill")
        } else {
            Image(systemName: "square.grid.2x2")
        }
    }
}
