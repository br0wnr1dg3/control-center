import SwiftUI

/// One day at a time: what's on Chris's list that day, agents' work, and what got done.
struct DayView: View {
    @Bindable var store = BoardStore.shared

    var body: some View {
        let day = store.day
        let list = store.tasks(on: day)
        let mine = list.filter { $0.kind != .agent }
        let agents = list.filter { $0.kind == .agent }
        let done = store.done(on: day)

        ScrollView {
            VStack(alignment: .leading, spacing: 18) {

                if day == Day.today && !store.needsYou.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        SectionHeader(title: "Needs you", count: store.needsYou.count, color: .orange)
                        ForEach(store.needsYou) { NeedsYouCard(task: $0) }
                    }
                }

                group("For me", mine, empty: "Nothing for you \(day == Day.today ? "today" : "this day").")
                if !agents.isEmpty { group("Agents", agents) }
                if !done.isEmpty { group("Done", done) }
            }
            .padding(20)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .dropDestination(for: String.self) { items, _ in
            for id in TaskDrag.ids(items) {
                if let task = store.task(id) { store.schedule(task, on: day) }
            }
            return true
        }
        .navigationTitle(Day.title(day))
        .navigationSubtitle(Day.date(day).formatted(.dateTime.weekday(.wide).month(.wide).day()))
        .toolbar {
            ToolbarItemGroup {
                Button { store.day = Day.adding(-1, to: day) } label: { Image(systemName: "chevron.left") }
                Button("Today") { store.day = Day.today }.disabled(day == Day.today)
                Button { store.day = Day.adding(1, to: day) } label: { Image(systemName: "chevron.right") }
            }
        }
    }

    private func group(_ title: String, _ tasks: [BoardTask], empty: String? = nil) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            SectionHeader(title: title, count: tasks.count)
            if tasks.isEmpty, let empty {
                Text(empty).foregroundStyle(.secondary).padding(.vertical, 4)
            }
            ForEach(tasks) { TaskRow(task: $0) }
        }
    }
}

/// Week calendar. Drag tasks between days (or from Unscheduled) to plan ahead.
struct UpcomingView: View {
    @Bindable var store = BoardStore.shared

    private var days: [String] { (0..<7).map { Day.adding($0, to: store.weekStart) } }

    var body: some View {
        HStack(alignment: .top, spacing: 0) {
            HStack(alignment: .top, spacing: 8) {
                ForEach(days, id: \.self) { dayColumn($0) }
            }
            .padding(12)

            Divider()
            unscheduledTray
        }
        .navigationTitle(weekTitle)
        .toolbar {
            ToolbarItemGroup {
                Button { store.weekStart = Day.adding(-7, to: store.weekStart) } label: { Image(systemName: "chevron.left") }
                Button("This week") { store.weekStart = Day.weekStart(Day.today) }
                Button { store.weekStart = Day.adding(7, to: store.weekStart) } label: { Image(systemName: "chevron.right") }
            }
        }
    }

    private var unscheduledTray: some View {
            VStack(alignment: .leading, spacing: 6) {
                SectionHeader(title: "Unscheduled", count: store.unscheduled.count)
                Text("Drag onto a day").font(.caption).foregroundStyle(.tertiary)
                ScrollView {
                    VStack(spacing: 6) {
                        ForEach(store.unscheduled) { CalendarCard(task: $0) }
                    }
                }
            }
            .padding(12)
            .frame(width: 190)
            .dropDestination(for: String.self) { items, _ in
                for id in TaskDrag.ids(items) {
                    if let task = store.task(id) {
                        store.update(task, ["scheduled_on": NSNull(), "due": NSNull(), "today": false]) {
                            $0.scheduledOn = nil; $0.due = nil; $0.today = false
                        }
                    }
                }
                return true
            }
    }

    private var weekTitle: String {
        let start = Day.date(store.weekStart)
        return "Week of " + start.formatted(.dateTime.month(.wide).day())
    }

    private func dayColumn(_ day: String) -> some View {
        let isToday = day == Day.today
        let tasks = store.sorted(store.tasks.filter { $0.status.isOpen && $0.calendarDay == day })
            + store.done(on: day).filter { $0.calendarDay == day }

        return VStack(alignment: .leading, spacing: 6) {
            HStack {
                VStack(alignment: .leading, spacing: 0) {
                    Text(Day.date(day).formatted(.dateTime.weekday(.abbreviated)).uppercased())
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(isToday ? Color.accentColor : .secondary)
                    Text(Day.date(day).formatted(.dateTime.day()))
                        .font(.title3.weight(isToday ? .bold : .regular))
                        .foregroundStyle(isToday ? Color.accentColor : .primary)
                }
                Spacer()
                Button { store.compose(TaskDraft(scheduledOn: day)) } label: { Image(systemName: "plus") }
                    .buttonStyle(.borderless)
                    .help("New task on this day")
            }
            ScrollView {
                VStack(spacing: 6) {
                    ForEach(tasks) { CalendarCard(task: $0) }
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding(8)
        .frame(minWidth: 70, maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(isToday ? Color.accentColor.opacity(0.06) : Color.secondary.opacity(0.05),
                    in: RoundedRectangle(cornerRadius: 10))
        .dropDestination(for: String.self) { items, _ in
            for id in TaskDrag.ids(items) {
                if let task = store.task(id) { store.schedule(task, on: day) }
            }
            return true
        }
    }
}

struct CalendarCard: View {
    let task: BoardTask
    var store = BoardStore.shared

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            RoundedRectangle(cornerRadius: 2)
                .fill(task.project.map(ProjectColor.of) ?? Color.secondary.opacity(0.4))
                .frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                Text(task.title)
                    .font(.callout)
                    .strikethrough(task.status == .done)
                    .foregroundStyle(task.status == .done ? .secondary : .primary)
                    .lineLimit(3)
                HStack(spacing: 4) {
                    KindIcon(kind: task.kind)
                    PriorityIcon(priority: task.priorityLevel)
                    if task.scheduledOn == nil && task.due != nil {
                        Image(systemName: "flag.fill").font(.system(size: 9)).foregroundStyle(.red).help("Deadline")
                    }
                    Spacer(minLength: 0)
                    if task.status != .new && task.status != .ready { StatusPill(status: task.status) }
                }
            }
        }
        .padding(6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(store.selectedTaskId == task.id ? Color.accentColor.opacity(0.15) : Color(nsColor: .controlBackgroundColor),
                    in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.15)))
        .contentShape(Rectangle())
        .onTapGesture { store.open(task.id) }
        .draggable(task.key)
        .contextMenu { TaskMenu(task: task) }
    }
}
