import SwiftUI

struct InboxView: View {
    var store = BoardStore.shared
    @State private var showRead = false

    private var items: [InboxItem] { showRead ? store.inbox : store.inbox.filter(\.isUnread) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                plate

                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        SectionHeader(title: "Notifications", count: store.unreadCount)
                        Toggle("Show read", isOn: $showRead).toggleStyle(.checkbox).font(.caption)
                        Button("Mark all read") { store.markAllRead() }
                            .buttonStyle(.borderless)
                            .font(.caption)
                            .disabled(store.unreadCount == 0)
                    }
                    if items.isEmpty {
                        Text(showRead ? "Nothing here yet." : "You're all caught up.")
                            .foregroundStyle(.secondary)
                            .padding(.vertical, 8)
                    }
                    ForEach(items) { InboxRow(item: $0) }
                }
            }
            .padding(20)
        }
        .navigationTitle("Inbox")
    }

    /// Questions waiting on the owner and what's on their plate today, above the notification feed.
    @ViewBuilder private var plate: some View {
        if !store.needsYou.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                SectionHeader(title: "Waiting on you", count: store.needsYou.count, color: .orange)
                ForEach(store.needsYou) { NeedsYouCard(task: $0) }
            }
        }
        VStack(alignment: .leading, spacing: 2) {
            SectionHeader(title: "On your plate today", count: store.onYourPlate.count)
            if store.onYourPlate.isEmpty {
                Text("Nothing for you today.").foregroundStyle(.secondary).padding(.vertical, 4)
            }
            ForEach(store.onYourPlate) { TaskRow(task: $0) }
        }
    }
}

struct InboxRow: View {
    let item: InboxItem
    var store = BoardStore.shared

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: item.symbol)
                .foregroundStyle(item.color)
                .frame(width: 18)
                .padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(item.headline).fontWeight(item.isUnread ? .semibold : .regular)
                    Text("CC-\(item.task.id)").font(.caption).foregroundStyle(.tertiary)
                    Text(item.task.title).font(.callout).foregroundStyle(.secondary).lineLimit(1)
                }
                if item.kind == "comment" || item.kind == "question" || item.kind == "stalled" || (item.kind == "handoff" && item.body != item.task.title) {
                    Text(item.body)
                        .font(.callout)
                        .lineLimit(3)
                        .foregroundStyle(item.isUnread ? .primary : .secondary)
                }
            }
            Spacer()
            Text(item.createdAt.relativeTime).font(.caption).foregroundStyle(.tertiary)
            Circle()
                .fill(item.isUnread ? Color.accentColor : .clear)
                .frame(width: 7, height: 7)
                .padding(.top, 5)
        }
        .padding(10)
        .background(store.selectedTaskId == item.task.id ? Color.accentColor.opacity(0.12) : Color.secondary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture { store.open(item.task.id) }
        .contextMenu {
            Button(item.isUnread ? "Mark read" : "Open") {
                item.isUnread ? store.markRead(ids: [item.id]) : store.open(item.task.id)
            }
        }
    }
}
