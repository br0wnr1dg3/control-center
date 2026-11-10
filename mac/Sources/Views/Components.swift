import SwiftUI

// MARK: - Small pieces

struct KindIcon: View {
    let kind: TaskKind

    var body: some View {
        Image(systemName: kind.symbol)
            .font(.system(size: 10, weight: .semibold))
            .foregroundStyle(kind == .agent ? Color.purple : Color.secondary)
            .frame(width: 14)
            .help(kind == .agent ? "Agent" : kind == .human ? "Me" : "Me or agent")
    }
}

struct StatusPill: View {
    let status: TaskStatus
    // A started task that has published and is waiting for the decision isn't "in progress" to a person.
    var awaitingReview = false

    init(status: TaskStatus) { self.status = status }
    init(task: BoardTask) {
        status = task.status
        awaitingReview = task.isAwaitingReview
    }

    private var color: Color { awaitingReview ? .teal : status.color }

    var body: some View {
        Text(awaitingReview ? "Awaiting review" : status.label)
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.15), in: Capsule())
            .foregroundStyle(color)
            .lineLimit(1)
            .fixedSize()
    }
}

struct PriorityIcon: View {
    let priority: Priority

    var body: some View {
        Group {
            switch priority {
            case .none: Image(systemName: "minus").foregroundStyle(.tertiary)
            case .urgent: Image(systemName: "exclamationmark.square.fill").foregroundStyle(.orange)
            case .high: Image(systemName: "cellularbars", variableValue: 1)
            case .medium: Image(systemName: "cellularbars", variableValue: 0.66)
            case .low: Image(systemName: "cellularbars", variableValue: 0.33)
            }
        }
        .font(.system(size: 10))
        .foregroundStyle(.secondary)
        .frame(width: 14)
        .help(priority.label)
    }
}

enum ProjectColor {
    private static let palette: [Color] = [.blue, .purple, .pink, .orange, .teal, .green, .indigo, .brown, .yellow, .red]

    static func of(_ project: String) -> Color {
        palette[abs(project.lowercased().unicodeScalars.reduce(0) { $0 &* 31 &+ Int($1.value) }) % palette.count]
    }
}

struct ProjectTag: View {
    let project: String

    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(ProjectColor.of(project)).frame(width: 7, height: 7)
            Text(project)
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .lineLimit(1)
        .fixedSize()
    }
}

struct LabelChip: View {
    let label: String
    var onRemove: (() -> Void)?

    var body: some View {
        HStack(spacing: 3) {
            Text(label)
            if let onRemove {
                Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)) }
                    .buttonStyle(.plain)
            }
        }
        .font(.caption)
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Color.secondary.opacity(0.12), in: Capsule())
        .lineLimit(1)
        .fixedSize()
    }
}

// MARK: - Drag and drop

/// Tasks drag as their "CC-<id>" key, so they can also be dropped as text anywhere.
enum TaskDrag {
    static func ids(_ items: [String]) -> [Int] {
        items.compactMap { Int($0.replacingOccurrences(of: "CC-", with: "")) }
    }
}

// MARK: - Task rows

/// List row used in Today, Upcoming and the popover.
struct WaitingBadge: View {
    let task: BoardTask

    var body: some View {
        Label(task.waitingLabel, systemImage: "hourglass")
            .font(.system(size: 10, weight: .medium))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.15), in: Capsule())
            .foregroundStyle(.secondary)
            .lineLimit(1)
            .fixedSize()
    }
}

/// One side of a dependency. The other task may be finished long ago and not loaded, so this draws from
/// its own details and only opens what the store has.
struct LinkedTaskRow: View {
    let task: BoardTask.LinkedTask
    var store = BoardStore.shared

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: task.kind == .agent ? "sparkles" : "circle.dashed")
                .foregroundStyle(task.kind == .agent ? Color.purple : Color.secondary)
                .frame(width: 16)
            Text(task.title)
                .strikethrough(task.status == .done || task.status == .cancelled)
                .foregroundStyle(task.status.isOpen ? .primary : .secondary)
                .lineLimit(1)
                .truncationMode(.tail)
            Spacer(minLength: 4)
            StatusPill(status: task.status)
            Text(task.key).font(.caption.monospacedDigit()).foregroundStyle(.tertiary).fixedSize()
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .contentShape(Rectangle())
        .onTapGesture { if store.task(task.id) != nil { store.open(task.id) } }
    }
}

struct TaskRow: View {
    let task: BoardTask
    var showDate = false
    var compact = false
    var hideProject: String? = nil  // skip the tag when it matches the surrounding context
    var store = BoardStore.shared
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 8) {
            if task.kind == .agent {
                Image(systemName: "sparkles").foregroundStyle(.purple).frame(width: 16)
            } else {
                Button { task.status == .done ? store.setStatus(task, .ready) : store.complete(task) } label: {
                    Image(systemName: task.status == .done ? "checkmark.circle.fill" : "circle")
                        .foregroundStyle(task.status == .done ? Color.green : Color.secondary)
                }
                .buttonStyle(.plain)
                .frame(width: 16)
            }
            PriorityIcon(priority: task.priorityLevel)

            Text(task.title)
                .strikethrough(task.status == .done)
                .foregroundStyle(task.status == .done ? .secondary : .primary)
                .lineLimit(1)
                .truncationMode(.tail)

            Spacer(minLength: 4)

            if !compact {
                ForEach(task.labels.prefix(2), id: \.self) { LabelChip(label: $0) }
                if let project = task.project, project != hideProject { ProjectTag(project: project) }
            }
            Group {
                if showDate, let day = task.calendarDay {
                    Text(Day.shortTitle(day)).font(.caption).foregroundStyle(.secondary)
                }
                if task.isOverdue {
                    Text("Overdue").font(.caption).foregroundStyle(.red)
                }
            }
            .lineLimit(1)
            .fixedSize()
            if task.kind == .agent && task.status == .in_progress && Cmux.isInstalled && hovering {
                Button("Open session") { Cmux.openSession(taskId: task.id) }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            if task.isWaiting { WaitingBadge(task: task) }
            if task.kind == .agent || task.status == .new {
                StatusPill(task: task)
            }
            Text(task.key).font(.caption.monospacedDigit()).foregroundStyle(.tertiary).fixedSize()
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(store.selectedTaskId == task.id ? Color.accentColor.opacity(0.15) : .clear,
                    in: RoundedRectangle(cornerRadius: 6))
        .contentShape(Rectangle())
        .onTapGesture { store.open(task.id) }
        .onHover { hovering = $0 }
        .draggable(task.key)
        .contextMenu { TaskMenu(task: task) }
    }
}

struct TaskMenu: View {
    let task: BoardTask
    var store = BoardStore.shared

    var body: some View {
        Button("Open") { store.open(task.id) }
        if task.status.isOpen {
            Button("Complete") { store.complete(task) }
            Menu("Status") {
                ForEach(TaskStatus.allCases, id: \.self) { status in
                    Button(status.label) { store.setStatus(task, status) }
                }
            }
            Menu("Priority") {
                ForEach(Priority.allCases, id: \.self) { p in
                    Button(p.label) { store.update(task, ["priority": p.rawValue]) { $0.priority = p.rawValue } }
                }
            }
            Menu("Schedule") {
                Button("Today") { store.schedule(task, on: Day.today) }
                Button("Tomorrow") { store.schedule(task, on: Day.adding(1, to: Day.today)) }
                Button("Next week") { store.schedule(task, on: Day.adding(7, to: Day.weekStart(Day.today))) }
                if task.scheduledOn != nil {
                    Button("Unschedule") { store.schedule(task, on: nil) }
                }
            }
            Menu("Assign") {
                ForEach(TaskKind.allCases, id: \.self) { kind in
                    Button(kind.label) { store.update(task, ["kind": kind.rawValue]) { $0.kind = kind } }
                }
            }
            if task.kind == .agent && task.status == .in_progress && Cmux.isInstalled {
                Button("Open Claude session") { Cmux.openSession(taskId: task.id) }
            }
            Divider()
            Button("Cancel task", role: .destructive) { store.setStatus(task, .cancelled) }
        } else {
            Button("Reopen") { store.setStatus(task, .ready) }
        }
        Divider()
        Button("Copy \(task.key)") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(task.key, forType: .string)
        }
    }
}

/// Answer box for a task an agent is blocked on.
struct NeedsYouCard: View {
    let task: BoardTask
    var compact = false
    var store = BoardStore.shared
    @State private var answer = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(.orange)
                Text(task.title).fontWeight(.medium).lineLimit(1)
                Spacer()
                Text(task.key).font(.caption).foregroundStyle(.secondary)
            }
            // Questions are often the agent's last message, so render its Markdown.
            MarkdownView(text: task.question ?? "Waiting on you.", size: 13, selectable: true)
                .fixedSize(horizontal: false, vertical: true)
            HStack {
                TextField("Answer…", text: $answer, axis: .vertical)
                    .textFieldStyle(.roundedBorder)
                    .lineLimit(1...4)
                    .onSubmit(send)
                Button("Send", action: send)
                    .disabled(answer.trimmingCharacters(in: .whitespaces).isEmpty)
                if Cmux.isInstalled && task.sessionId != nil {
                    Button { Cmux.openSession(taskId: task.id) } label: { Image(systemName: "terminal") }
                        .help("Open the Claude session")
                }
                Button { store.dismissQuestion(task) } label: { Image(systemName: "xmark") }
                    .help("Not needed: back to In progress and out of your inbox")
            }
        }
        .padding(compact ? 8 : 10)
        .background(Color.orange.opacity(0.1), in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color.orange.opacity(0.35)))
        .contentShape(Rectangle())
        .onTapGesture { store.open(task.id) }
        .contextMenu { TaskMenu(task: task) }
    }

    private func send() {
        store.answer(task, with: answer)
        answer = ""
    }
}

// MARK: - Quick add

struct QuickAddView: View {
    var store = BoardStore.shared
    var scheduledOn: String?
    var autofocus = false
    var onAdded: () -> Void = {}

    @State private var title = ""
    @State private var kind: TaskKind = .human
    @State private var today = true
    @State private var runNow = false
    @State private var project = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            TextField(scheduledOn.map { "Add a task for \(Day.title($0))…" } ?? "Add a task…", text: $title)
                .textFieldStyle(.roundedBorder)
                .focused($focused)
                .onSubmit(add)
            HStack(spacing: 10) {
                Picker("", selection: $kind) {
                    Label("Me", systemImage: TaskKind.human.symbol).tag(TaskKind.human)
                    Label("Agent", systemImage: TaskKind.agent.symbol).tag(TaskKind.agent)
                }
                .pickerStyle(.segmented)
                .labelsHidden()
                .fixedSize()
                if scheduledOn == nil {
                    Toggle("Today", isOn: $today)
                }
                if kind == .agent {
                    Toggle(scheduledOn == nil ? "Run now" : "Approve", isOn: $runNow)
                        .help("Agent tasks only run once they're ready (and on their scheduled day).")
                }
                TextField("Project", text: $project)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 110)
                Spacer()
            }
            .toggleStyle(.checkbox)
            .font(.callout)
        }
        .onAppear { if autofocus { focused = true } }
    }

    private func add() {
        let ready = kind == .agent ? runNow : (scheduledOn != nil || today)
        store.add(title: title, kind: kind, today: scheduledOn == nil && today, ready: ready,
                  scheduledOn: scheduledOn, project: project.isEmpty ? nil : project)
        title = ""
        onAdded()
    }
}

struct SectionHeader: View {
    let title: String
    var count: Int?
    var color: Color = .secondary

    var body: some View {
        HStack(spacing: 6) {
            Text(title.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(color)
            if let count { Text("\(count)").font(.caption).foregroundStyle(.tertiary) }
            Spacer()
        }
    }
}

/// A relative timestamp ("now", "5m", "2h") that keeps itself current. Plain text would freeze at
/// whatever it said when the view last rendered, so a row from last night could still read "now".
struct RelativeTime: View {
    let timestamp: String

    var body: some View {
        TimelineView(.everyMinute) { context in
            Text(timestamp.relativeTime(now: context.date))
        }
    }
}
