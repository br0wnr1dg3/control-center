import SwiftUI

/// Status columns. Drag cards between columns to change status.
struct BoardView: View {
    let project: String?
    var store = BoardStore.shared
    @State private var dropTarget: TaskStatus?

    private let columns: [TaskStatus] = [.new, .ready, .in_progress, .needs_you, .done]

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .top, spacing: 10) {
                ForEach(columns, id: \.self) { column($0) }
            }
            .padding(12)
        }
        .navigationTitle(project ?? "Board")
    }

    private func column(_ status: TaskStatus) -> some View {
        let tasks = store.column(status, project: project)
        return VStack(alignment: .leading, spacing: 8) {
            HStack {
                StatusPill(status: status)
                Text("\(tasks.count)").font(.caption).foregroundStyle(.secondary)
                Spacer()
            }
            ScrollView {
                VStack(spacing: 8) {
                    ForEach(tasks) { BoardCard(task: $0) }
                }
            }
        }
        .padding(10)
        .frame(minWidth: 160, maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(Color.secondary.opacity(dropTarget == status ? 0.16 : 0.06), in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(status.color.opacity(dropTarget == status ? 0.6 : 0)))
        .dropDestination(for: String.self) { items, _ in
            for id in TaskDrag.ids(items) {
                if let task = store.task(id) { store.setStatus(task, status) }
            }
            return true
        } isTargeted: { dropTarget = $0 ? status : (dropTarget == status ? nil : dropTarget) }
    }
}

struct BoardCard: View {
    let task: BoardTask
    var store = BoardStore.shared

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Text(task.key).font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                Spacer()
                PriorityIcon(priority: task.priorityLevel)
                KindIcon(kind: task.kind)
            }
            Text(task.title)
                .strikethrough(task.status == .done)
                .fixedSize(horizontal: false, vertical: true)
            if task.status == .needs_you, let q = task.question {
                Text(q).font(.caption).foregroundStyle(.orange).lineLimit(3)
            }
            if !task.labels.isEmpty || task.project != nil || task.calendarDay != nil {
                HStack(spacing: 6) {
                    if let project = task.project { ProjectTag(project: project) }
                    ForEach(task.labels.prefix(2), id: \.self) { LabelChip(label: $0) }
                    Spacer(minLength: 0)
                    if let day = task.calendarDay {
                        Text(Day.title(day)).font(.caption).foregroundStyle(task.isOverdue ? .red : .secondary)
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color(nsColor: .controlBackgroundColor), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8)
            .stroke(store.selectedTaskId == task.id ? Color.accentColor : Color.secondary.opacity(0.15)))
        .contentShape(Rectangle())
        .onTapGesture { store.open(task.id) }
        .draggable(task.key) {
            Text(task.title).padding(8).background(.background, in: RoundedRectangle(cornerRadius: 6))
        }
        .contextMenu { TaskMenu(task: task) }
    }
}
