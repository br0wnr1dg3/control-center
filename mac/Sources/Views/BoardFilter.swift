import SwiftUI

/// Search text plus Linear-style "field is value" filters for the board.
struct BoardFilter: Equatable {
    enum DateRange: String, CaseIterable {
        case overdue, today, thisWeek, later, none

        var label: String {
            switch self {
            case .overdue: "Overdue"
            case .today: "Today"
            case .thisWeek: "This week"
            case .later: "Later"
            case .none: "No date"
            }
        }

        func matches(_ task: BoardTask) -> Bool {
            let today = Day.today
            if task.today && self == .today { return true }
            guard let day = task.calendarDay else { return self == .none && !task.today }
            switch self {
            case .overdue: return task.isOverdue
            case .today: return day == today || task.today
            case .thisWeek: return day >= today && day < Day.adding(7, to: Day.weekStart(today))
            case .later: return day >= Day.adding(7, to: Day.weekStart(today))
            case .none: return false
            }
        }
    }

    var query = ""
    var priorities: Set<Priority> = []
    var kinds: Set<TaskKind> = []
    var projects: Set<String> = []
    var labels: Set<String> = []
    var dates: Set<DateRange> = []

    var hasFilters: Bool { !priorities.isEmpty || !kinds.isEmpty || !projects.isEmpty || !labels.isEmpty || !dates.isEmpty }
    var isActive: Bool { hasFilters || !trimmedQuery.isEmpty }
    private var trimmedQuery: String { query.trimmingCharacters(in: .whitespaces) }

    func matches(_ task: BoardTask) -> Bool {
        if !priorities.isEmpty && !priorities.contains(task.priorityLevel) { return false }
        if !kinds.isEmpty && !kinds.contains(task.kind) { return false }
        if !projects.isEmpty && !projects.contains(task.project ?? "") { return false }
        if !labels.isEmpty && labels.isDisjoint(with: task.labels) { return false }
        if !dates.isEmpty && !dates.contains(where: { $0.matches(task) }) { return false }
        return matchesQuery(task)
    }

    /// Every word must appear somewhere: key, title, description, project or labels. "cc-12" or "12" finds the task by key.
    private func matchesQuery(_ task: BoardTask) -> Bool {
        let words = trimmedQuery.lowercased().split(separator: " ")
        guard !words.isEmpty else { return true }
        let haystack = ([task.key, task.title, task.description ?? "", task.project ?? ""] + task.labels)
            .joined(separator: " ").lowercased()
        return words.allSatisfy { word in
            if let id = Int(word), task.id == id { return true }
            return haystack.contains(word)
        }
    }
}

/// How cards are ordered within each column.
enum BoardSort: String, CaseIterable {
    case priority, date, due, created, updated

    var label: String {
        switch self {
        case .priority: "Priority"
        case .date: "Date"
        case .due: "Due date"
        case .created: "Created"
        case .updated: "Last updated"
        }
    }

    var hint: String {
        switch self {
        case .priority: "Urgent first, then manual order"
        case .date: "Soonest scheduled or due first"
        case .due: "Soonest deadline first"
        case .created: "Newest first"
        case .updated: "Most recent first"
        }
    }

    /// nil for .priority: the board keeps its own order (and Done by completion).
    func sort(_ list: [BoardTask]) -> [BoardTask]? {
        // Undated tasks go last; ties fall back to priority so the order stays stable.
        let tie: (BoardTask, BoardTask) -> Bool = { ($0.priorityLevel.rank, $0.id) < ($1.priorityLevel.rank, $1.id) }
        func byDay(_ key: @escaping (BoardTask) -> String?) -> [BoardTask] {
            list.sorted { a, b in
                switch (key(a), key(b)) {
                case let (x?, y?) where x != y: x < y
                case (_?, nil): true
                case (nil, _?): false
                default: tie(a, b)
                }
            }
        }
        switch self {
        case .priority: return nil
        case .date: return byDay { $0.today ? min($0.calendarDay ?? Day.today, Day.today) : $0.calendarDay }
        case .due: return byDay(\.due)
        case .created: return list.sorted { $0.id > $1.id }
        case .updated: return list.sorted { ($0.updatedAt ?? "", $0.id) > ($1.updatedAt ?? "", $1.id) }
        }
    }
}

/// The row above the board: search field, Filter menu, and a chip per active filter.
struct BoardFilterBar: View {
    @Bindable var store = BoardStore.shared
    let project: String?
    let shown: Int
    @FocusState private var searchFocused: Bool

    var body: some View {
        HStack(spacing: 8) {
            searchField
            if store.boardFilter.hasFilters {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) { chips }
                }
            }
            Spacer(minLength: 0)
            if store.boardFilter.isActive {
                Text("\(shown) task\(shown == 1 ? "" : "s")").font(.caption).foregroundStyle(.secondary)
                Button("Clear") { store.boardFilter = BoardFilter() }
                    .buttonStyle(.borderless)
                    .font(.caption)
            }
            filterMenu
            sortMenu
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        // ⌘F focuses search, like most Mac apps; Escape clears it.
        .background {
            Button("") { searchFocused = true }.keyboardShortcut("f", modifiers: .command).hidden()
        }
    }

    private var searchField: some View {
        HStack(spacing: 5) {
            Image(systemName: "magnifyingglass").foregroundStyle(.secondary).font(.system(size: 11))
            TextField("Search tasks", text: $store.boardFilter.query)
                .textFieldStyle(.plain)
                .focused($searchFocused)
                .onExitCommand { store.boardFilter.query = ""; searchFocused = false }
            if !store.boardFilter.query.isEmpty {
                Button { store.boardFilter.query = "" } label: {
                    Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
            }
        }
        .font(.callout)
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .frame(width: 240)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 7))
        .overlay(RoundedRectangle(cornerRadius: 7).stroke(searchFocused ? Color.accentColor.opacity(0.6) : .clear))
    }

    private var filterMenu: some View {
        Menu {
            Menu { priorityItems } label: { Label("Priority", systemImage: "cellularbars") }
            Menu { kindItems } label: { Label("Who", systemImage: "person") }
            Menu { dateItems } label: { Label("Date", systemImage: "calendar") }
            if project == nil {
                Menu { projectItems } label: { Label("Project", systemImage: "square.stack") }
            }
            Menu { labelItems } label: { Label("Label", systemImage: "tag") }
                .disabled(store.allLabels.isEmpty)
        } label: {
            Label("Filter", systemImage: "line.3.horizontal.decrease")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
    }

    private var sortMenu: some View {
        Menu {
            Picker("Sort by", selection: $store.boardSort) {
                ForEach(BoardSort.allCases, id: \.self) { sort in
                    Text(sort.label).help(sort.hint).tag(sort)
                }
            }
            .pickerStyle(.inline)
        } label: {
            Label(store.boardSort == .priority ? "Sort" : store.boardSort.label, systemImage: "arrow.up.arrow.down")
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .help("Sort cards: \(store.boardSort.hint.lowercased())")
    }

    // Toggle buttons keep each menu's choices independent; a ✓ marks what's on.

    @ViewBuilder private var priorityItems: some View {
        ForEach([Priority.urgent, .high, .medium, .low, .none], id: \.self) { p in
            toggle(p.label, on: store.boardFilter.priorities.contains(p)) { store.boardFilter.priorities.toggle(p) }
        }
    }

    @ViewBuilder private var kindItems: some View {
        ForEach(TaskKind.allCases, id: \.self) { k in
            toggle(k.label, on: store.boardFilter.kinds.contains(k)) { store.boardFilter.kinds.toggle(k) }
        }
    }

    @ViewBuilder private var dateItems: some View {
        ForEach(BoardFilter.DateRange.allCases, id: \.self) { d in
            toggle(d.label, on: store.boardFilter.dates.contains(d)) { store.boardFilter.dates.toggle(d) }
        }
    }

    @ViewBuilder private var projectItems: some View {
        ForEach(store.projects, id: \.self) { p in
            toggle(p, on: store.boardFilter.projects.contains(p)) { store.boardFilter.projects.toggle(p) }
        }
        toggle("No project", on: store.boardFilter.projects.contains("")) { store.boardFilter.projects.toggle("") }
    }

    @ViewBuilder private var labelItems: some View {
        ForEach(store.allLabels, id: \.self) { l in
            toggle(l, on: store.boardFilter.labels.contains(l)) { store.boardFilter.labels.toggle(l) }
        }
    }

    private func toggle(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            if on { Label(title, systemImage: "checkmark") } else { Text(title) }
        }
    }

    @ViewBuilder private var chips: some View {
        let f = store.boardFilter
        if !f.priorities.isEmpty {
            FilterChip(field: "Priority", values: f.priorities.sorted { $0.rank < $1.rank }.map(\.label),
                       menu: { priorityItems }, onRemove: { store.boardFilter.priorities = [] })
        }
        if !f.kinds.isEmpty {
            FilterChip(field: "Who", values: TaskKind.allCases.filter(f.kinds.contains).map(\.label),
                       menu: { kindItems }, onRemove: { store.boardFilter.kinds = [] })
        }
        if !f.dates.isEmpty {
            FilterChip(field: "Date", values: BoardFilter.DateRange.allCases.filter(f.dates.contains).map(\.label),
                       menu: { dateItems }, onRemove: { store.boardFilter.dates = [] })
        }
        if project == nil && !f.projects.isEmpty {
            FilterChip(field: "Project", values: f.projects.sorted().map { $0.isEmpty ? "No project" : $0 },
                       menu: { projectItems }, onRemove: { store.boardFilter.projects = [] })
        }
        if !f.labels.isEmpty {
            FilterChip(field: "Label", values: f.labels.sorted(),
                       menu: { labelItems }, onRemove: { store.boardFilter.labels = [] })
        }
    }
}

/// "Priority is Urgent, High ×": click the values to change them, × to drop the filter.
private struct FilterChip<Items: View>: View {
    let field: String
    let values: [String]
    @ViewBuilder let menu: () -> Items
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 0) {
            Text(field).foregroundStyle(.secondary).padding(.leading, 8).padding(.trailing, 4)
            Text(values.count == 1 ? "is" : "is any of").foregroundStyle(.tertiary).padding(.trailing, 4)
            Menu {
                menu()
            } label: {
                Text(values.count <= 2 ? values.joined(separator: ", ") : "\(values.count) values")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            Divider().frame(height: 14).padding(.leading, 6)
            Button(action: onRemove) {
                Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundStyle(.secondary)
                    .frame(width: 22, height: 20)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Remove filter")
        }
        .font(.caption)
        .padding(.vertical, 2)
        .background(Color.secondary.opacity(0.1), in: RoundedRectangle(cornerRadius: 6))
        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Color.secondary.opacity(0.2)))
        .fixedSize()
    }
}

private extension Set {
    mutating func toggle(_ element: Element) {
        if contains(element) { remove(element) } else { insert(element) }
    }
}
