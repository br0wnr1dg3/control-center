import SwiftUI

/// One inbox row: everything new on a task, newest first.
struct InboxThread: Identifiable, Equatable {
    let items: [InboxItem]

    var id: Int { task.id }
    var task: InboxItem.TaskRef { latest.task }
    var latest: InboxItem { items[0] }
    var isUnread: Bool { items.contains(where: \.isUnread) }
    var unreadCount: Int { items.filter(\.isUnread).count }
}

/// Things to react to, Linear-style: a list of tasks with something new on the left, the selected
/// task on the right. Opening a row marks it read; E archives (marks read), U marks unread.
struct InboxView: View {
    @Bindable var store = BoardStore.shared
    @State private var showAll = false
    @FocusState private var listFocused: Bool

    private var threads: [InboxThread] {
        let all = store.inboxThreads
        // Keep the open row visible after it's read, so it doesn't jump out from under you.
        return showAll ? all : all.filter { $0.isUnread || $0.id == store.selectedTaskId }
    }

    var body: some View {
        HStack(spacing: 0) {
            list
                .frame(width: 360)
            Divider()
            detail
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .navigationTitle("Inbox")
        .toolbar {
            ToolbarItemGroup {
                Picker("", selection: $showAll) {
                    Text("Unread").tag(false)
                    Text("All").tag(true)
                }
                .pickerStyle(.segmented)
                .fixedSize()
                Button("Mark all read") { store.markAllRead() }
                    .disabled(store.unreadCount == 0)
            }
        }
        .onAppear {
            selectFirstIfNone()
            listFocused = true
        }
        .onChange(of: threads.first?.id) { _, _ in selectFirstIfNone() }
    }

    // MARK: List

    private var list: some View {
        Group {
            if threads.isEmpty {
                VStack(spacing: 10) {
                    Image(systemName: "tray").font(.system(size: 34)).foregroundStyle(.tertiary)
                    Text("You're all caught up").font(.headline)
                    Text(showAll ? "Nothing here yet." : "New questions, reviews and hand-offs land here.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(30)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                List(selection: Binding(get: { store.selectedTaskId }, set: { id in if let id { store.open(id) } })) {
                    ForEach(threads) { thread in
                        InboxThreadRow(thread: thread)
                            .tag(thread.id)
                            .contextMenu {
                                Button("Archive") { archive(thread) }
                                Button("Mark unread") { store.markUnread(thread) }
                            }
                    }
                }
                .listStyle(.inset)
                .focused($listFocused)
                .onKeyPress("e") { selectedThread.map(archive); return .handled }
                .onKeyPress("u") { selectedThread.map(store.markUnread); return .handled }
            }
        }
    }

    private func selectFirstIfNone() {
        if store.selectedTaskId == nil, let first = threads.first { store.open(first.id) }
    }

    private var selectedThread: InboxThread? { threads.first { $0.id == store.selectedTaskId } }

    /// Archive and move to the next row, like Linear.
    private func archive(_ thread: InboxThread) {
        let rows = threads
        let next = rows.firstIndex(of: thread).flatMap { i in rows.indices.contains(i + 1) ? rows[i + 1] : (i > 0 ? rows[i - 1] : nil) }
        store.archive(thread)
        if thread.id == store.selectedTaskId { store.selectedTaskId = next?.id }
    }

    // MARK: Detail

    @ViewBuilder private var detail: some View {
        if let task = store.selectedTask {
            TaskPage(task: task, embedded: true)
                .id(task.id)
        } else if let thread = selectedThread {
            // Finished long ago, so not loaded on the board: show what happened.
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    Text("CC-\(thread.task.id) · \(thread.task.title)").font(.title3.weight(.semibold))
                    ForEach(thread.items) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.headline).font(.callout.weight(.medium))
                            MarkdownView(text: item.body, size: 13, selectable: true)
                        }
                    }
                }
                .padding(30)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        } else {
            VStack(spacing: 8) {
                Image(systemName: "rectangle.on.rectangle").font(.system(size: 30)).foregroundStyle(.tertiary)
                Text("Select a notification").foregroundStyle(.secondary)
                Text("↑↓ to move · E to archive · U to mark unread").font(.caption).foregroundStyle(.tertiary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }
}

struct InboxThreadRow: View {
    let thread: InboxThread

    var body: some View {
        let item = thread.latest
        HStack(alignment: .top, spacing: 10) {
            Circle()
                .fill(thread.isUnread ? Color.accentColor : .clear)
                .frame(width: 7, height: 7)
                .padding(.top, 6)
            Image(systemName: item.symbol)
                .foregroundStyle(item.color)
                .frame(width: 18)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text("CC-\(thread.task.id)").font(.caption.monospacedDigit()).foregroundStyle(.tertiary)
                    Text(thread.task.title)
                        .fontWeight(thread.isUnread ? .semibold : .regular)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(item.createdAt.relativeTime).font(.caption).foregroundStyle(.tertiary).fixedSize()
                }
                HStack(spacing: 4) {
                    Text(item.headline).foregroundStyle(item.color)
                    if let snippet = snippet(item) { Text("· \(snippet)").foregroundStyle(.secondary) }
                    if thread.unreadCount > 1 { Text("+\(thread.unreadCount - 1)").foregroundStyle(.tertiary) }
                }
                .font(.caption)
                .lineLimit(1)
            }
        }
        .padding(.vertical, 4)
    }

    private func snippet(_ item: InboxItem) -> String? {
        guard item.body != item.task.title else { return nil }
        var text = item.body.replacingOccurrences(of: "\n", with: " ")
        // Review decisions start with what the headline already says.
        for prefix in ["Changes requested on ", "Approved "] where text.hasPrefix(prefix) {
            text.removeFirst(prefix.count)
        }
        return text
    }
}
